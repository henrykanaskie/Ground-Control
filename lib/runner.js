/**
 * Ground Control Run: one button that gets a project running.
 *
 * Every other feature looks at a project or talks about it. This one starts
 * it, which for most projects is not one command but four: make a virtualenv,
 * install the dependencies, copy `.env.example`, then start the thing, on a
 * port nothing else is using. This module works out that list from the files
 * in the folder, shows it before anything runs, runs it, and when a step fails
 * reads the output for the failures that have a known cure and applies the
 * cure itself (a busy port, dependencies that were never installed, a peer
 * dependency conflict, a missing Python module) before giving up.
 *
 * Three rules hold everywhere in here:
 *
 *   1. Commands come from the project's own files, never from a request. A
 *      caller picks *which* detected start command to use by index; it cannot
 *      hand in a command line. Every command is an argv array run without a
 *      shell, so nothing in a filename or a script name is ever interpreted.
 *   2. Everything runs inside the project folder. Setup writes only where the
 *      project's own tooling writes (`node_modules`, `.venv`, a copied `.env`
 *      that did not exist), and the plan says so before you press Run.
 *   3. Every child runs in its own process group, so Stop reaches the whole
 *      tree (`npm` → `node` → `vite` → esbuild), and the shutdown hook in
 *      server.js stops them all when Ground Control goes down. Their pids are
 *      written down, so a server that was `kill -9`ed still has its dev
 *      servers stopped on the next start rather than left holding ports.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { isIgnoredDir, toISO } from './util.js';

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** Runs alive at once across every project. Each one is a dev server. */
const MAX_RUNS = 6;
/** One setup step (an install) may take this long before it is stopped. */
const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
/** Log lines kept per run. The tail is what matters for a diagnosis. */
const LOG_MAX_LINES = 3000;
const LINE_MAX = 2000;
/** Automatic fixes tried in one run before it stops and says what it saw. */
const MAX_AUTO_FIXES = 4;
const SIGKILL_GRACE_MS = 4000;
const FLUSH_MS = 150;

const IS_WIN = process.platform === 'win32';

/* ------------------------------------------------------------------ *
 * Finding tools
 *
 * The macOS app is launched by Finder with almost no PATH, and the tools a
 * project needs often live where only an interactive shell knows to look
 * (nvm, pyenv, cargo, bun). So the search path is the server's own PATH, plus
 * the login shell's PATH asked for once, plus the usual install locations.
 * ------------------------------------------------------------------ */

let loginPathCache = null;

function loginShellPath() {
  if (loginPathCache !== null) return loginPathCache;
  loginPathCache = '';
  if (IS_WIN || process.env.GROUND_CONTROL_NO_LOGIN_SHELL) return loginPathCache;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  try {
    // A marker either side, because an interactive shell's rc files are free
    // to print banners and we only want the one line.
    const r = spawnSync(shell, ['-ilc', 'printf "__GC_PATH__%s__GC_PATH__" "$PATH"'], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /__GC_PATH__(.*?)__GC_PATH__/s.exec(r.stdout || '');
    if (m) loginPathCache = m[1];
  } catch { /* the login shell is a bonus, not a requirement */ }
  return loginPathCache;
}

function nvmBins(home) {
  const base = path.join(home, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(base).filter((v) => /^v\d/.test(v));
    versions.sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
    return versions.map((v) => path.join(base, v, 'bin'));
  } catch { return []; }
}

/** Every directory a tool might be in, in the order it should be looked for. */
function searchDirs() {
  const home = os.homedir();
  const dirs = []
    .concat(String(process.env.PATH || '').split(path.delimiter))
    .concat(loginShellPath().split(path.delimiter))
    .concat([
      path.dirname(process.execPath),          // the node running Ground Control
      '/opt/homebrew/bin', '/usr/local/bin',
      path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'),
      path.join(home, 'go', 'bin'), path.join(home, '.bun', 'bin'),
      path.join(home, '.volta', 'bin'), path.join(home, '.deno', 'bin'),
      path.join(home, '.pyenv', 'shims'), path.join(home, '.asdf', 'shims'),
    ])
    .concat(nvmBins(home))
    .concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  const seen = new Set();
  return dirs.filter((d) => d && !seen.has(d) && seen.add(d));
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** Absolute path of a tool, or null. A path containing a slash is taken as-is. */
function which(name, dirs = searchDirs()) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) return isExecutable(name) ? name : null;
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

/** The environment a project's commands run in: yours, with a PATH that finds things. */
function runEnv(extra) {
  const env = Object.assign({}, process.env);
  env.PATH = searchDirs().join(path.delimiter);
  // Colour codes are stripped from the log anyway; asking for none keeps
  // progress bars from redrawing one line four hundred times.
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  env.npm_config_color = 'false';
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.PYTHONUNBUFFERED = '1';
  delete env.GROUND_CONTROL_HOST_APP;
  return Object.assign(env, extra || {});
}

/** How to get a tool that is not installed. Shown, never run. */
const INSTALL_HINTS = {
  node: 'Install Node.js from nodejs.org, or `brew install node`.',
  npm: 'npm ships with Node.js: install Node from nodejs.org, or `brew install node`.',
  npx: 'npx ships with Node.js: install Node from nodejs.org.',
  pnpm: 'Run `corepack enable`, or `npm install -g pnpm`.',
  yarn: 'Run `corepack enable`, or `npm install -g yarn`.',
  bun: 'Install Bun from bun.sh, or `brew install oven-sh/bun/bun`.',
  deno: 'Install Deno from deno.com, or `brew install deno`.',
  python3: 'Install Python from python.org, or `brew install python`.',
  cargo: 'Install Rust with rustup from rustup.rs.',
  go: 'Install Go from go.dev, or `brew install go`.',
  swift: 'Install Xcode or the Xcode Command Line Tools: `xcode-select --install`.',
  ruby: 'Install Ruby with `brew install ruby`.',
  bundle: 'Run `gem install bundler`.',
  make: 'Install the Xcode Command Line Tools: `xcode-select --install`.',
  docker: 'Install Docker Desktop from docker.com and start it.',
  open: 'Opening an Xcode project needs macOS.',
  gradle: 'Install Gradle with `brew install gradle`, or add a Gradle wrapper (gradlew) to the project.',
  mvn: 'Install Maven with `brew install maven`.',
  java: 'Install a JDK with `brew install openjdk`.',
  flutter: 'Install Flutter from flutter.dev, or `brew install --cask flutter`.',
  xcodebuild: 'Install Xcode from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app`.',
};

/**
 * One click instead of a terminal: the Homebrew formula for each tool Run can
 * install when it is missing. Fixed here, never taken from a request, and
 * only ever offered (the person presses the button), never run on its own.
 */
const BREW_INSTALL = {
  node: ['node'], npm: ['node'], npx: ['node'], python3: ['python'], go: ['go'],
  cargo: ['rust'], deno: ['deno'], bun: ['oven-sh/bun/bun'], ruby: ['ruby'],
  pnpm: ['pnpm'], yarn: ['yarn'], flutter: ['--cask', 'flutter'], docker: ['--cask', 'docker'],
  gradle: ['gradle'], mvn: ['maven'], java: ['openjdk'],
};
/** Tools that come with Apple's Command Line Tools, installed through its own dialog. */
const CLT_TOOLS = new Set(['make', 'swift', 'git', 'clang', 'cc']);

/** How this machine could install `tool` with one click, or null. */
function installerFor(tool) {
  if (process.platform === 'darwin' && CLT_TOOLS.has(tool)) return { tool, via: 'xcode-select', argv: ['xcode-select', '--install'], label: 'Install the Command Line Tools' };
  if (BREW_INSTALL[tool] && which('brew')) return { tool, via: 'brew', argv: ['brew', 'install'].concat(BREW_INSTALL[tool]), label: `Install ${tool} with Homebrew` };
  return null;
}

/* ------------------------------------------------------------------ *
 * Small file helpers
 * ------------------------------------------------------------------ */

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function readText(p, max = 256 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}
function readJSON(p) { const t = readText(p); if (!t) return null; try { return JSON.parse(t); } catch { return null; } }

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function venvPython(dir, venvName) {
  return IS_WIN ? path.join(dir, venvName, 'Scripts', 'python.exe') : path.join(dir, venvName, 'bin', 'python');
}

/* ------------------------------------------------------------------ *
 * Detection
 *
 * `detectService(dir)` reads one folder and returns what it takes to run it,
 * or null. A step is `{ id, label, argv, why }`; a start option is the same
 * plus `portHint`. Nothing here runs anything.
 * ------------------------------------------------------------------ */

const NODE_START_PRIORITY = ['dev', 'start', 'serve', 'develop', 'preview', 'watch'];
const NODE_NOT_A_START = /^(pre|post)|^(test|lint|format|fmt|prettier|typecheck|check|clean|prepare|release|publish|deploy|build|setup|install|ci|bootstrap)(:|$)/;

/** Default ports of the dev servers people actually use, for the port check. */
function portFromScript(body) {
  const s = String(body || '');
  const explicit = /(?:--port[= ]|-p\s+|PORT=)(\d{2,5})\b/.exec(s);
  if (explicit) return Number(explicit[1]);
  if (/\bvite\b/.test(s)) return 5173;
  if (/\bastro\b/.test(s)) return 4321;
  if (/\b(next|nuxt|react-scripts|remix|gatsby)\b/.test(s)) return /gatsby/.test(s) ? 8000 : 3000;
  if (/\bng serve\b/.test(s)) return 4200;
  return null;
}

/** Scripts that pass `--port` through to a dev server that understands it. */
function scriptTakesPortFlag(body) {
  return /\b(vite|next|astro|nuxt|svelte-kit|webpack-dev-server|webpack serve|ng serve|remix|serve)\b|--port\b/.test(String(body || ''))
    || /\bnode\s+\S*server\.js\b/.test(String(body || ''));
}

function nodePackageManager(dir, pkg) {
  const declared = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (declared && ['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  if (exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** Why node_modules needs (re)installing, or null when it looks current. */
function nodeInstallReason(dir, pkg) {
  const deps = Object.keys((pkg && pkg.dependencies) || {}).length
    + Object.keys((pkg && pkg.devDependencies) || {}).length;
  if (!deps) return null;
  if (exists(path.join(dir, '.pnp.cjs'))) return null;          // Yarn Plug'n'Play: no node_modules
  const nm = path.join(dir, 'node_modules');
  if (!exists(nm)) return 'node_modules is missing, so nothing has been installed yet';
  const markers = ['.package-lock.json', '.modules.yaml', '.yarn-integrity', '.yarn-state.yml']
    .map((m) => mtime(path.join(nm, m))).filter(Boolean);
  const installedAt = markers.length ? Math.max(...markers) : mtime(nm);
  const lock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']
    .map((f) => mtime(path.join(dir, f)));
  const changedAt = Math.max(mtime(path.join(dir, 'package.json')), ...lock);
  if (changedAt > installedAt + 1000) return 'package.json or the lockfile changed since the last install';
  return null;
}

function nodeInstallArgv(pm) {
  if (pm === 'yarn') return ['yarn', 'install'];
  if (pm === 'pnpm') return ['pnpm', 'install'];
  if (pm === 'bun') return ['bun', 'install'];
  return ['npm', 'install'];
}

function nodeScriptArgv(pm, name) {
  if (pm === 'yarn') return ['yarn', name];
  if (pm === 'bun') return ['bun', 'run', name];
  return [pm, 'run', name];
}

/** What a package.json script does when it runs: serves a page, or prints. */
function nodeScriptMode(name, body) {
  const b = String(body || '');
  if (/\belectron\b/.test(b)) return 'app';
  if (portFromScript(b) || /\b(vite|next (dev|start)|nuxt|astro|remix|gatsby|svelte-kit|webpack serve|webpack-dev-server|parcel|http-server|live-server|serve)\b/.test(b)) return 'browser';
  if (/^(dev|start|serve|server|preview|develop|watch|ui)$/.test(name)) return 'browser';
  return 'terminal';
}

function detectNode(dir) {
  const pkg = readJSON(path.join(dir, 'package.json'));
  if (!pkg) return null;
  const pm = nodePackageManager(dir, pkg);
  const setup = [];
  const why = nodeInstallReason(dir, pkg);
  if (why) setup.push({ id: 'install', label: 'Install dependencies', argv: nodeInstallArgv(pm), why, consent: true });

  const starts = [];
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const names = Object.keys(scripts).filter((n) => !NODE_NOT_A_START.test(n));
  names.sort((a, b) => {
    const ia = NODE_START_PRIORITY.indexOf(a); const ib = NODE_START_PRIORITY.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const n of names) {
    starts.push({
      id: 'script:' + n,
      label: nodeScriptArgv(pm, n).join(' '),
      argv: nodeScriptArgv(pm, n),
      why: String(scripts[n]).slice(0, 200),
      portHint: portFromScript(scripts[n]),
      portFlag: scriptTakesPortFlag(scripts[n]) ? 'npm' : null,
      mode: nodeScriptMode(n, scripts[n]),
    });
  }
  if (!starts.length) {
    const main = [pkg.main, 'server.js', 'index.js', 'app.js', 'main.js', 'src/index.js']
      .find((f) => f && exists(path.join(dir, f)));
    if (main) starts.push({ id: 'main', label: `node ${main}`, argv: ['node', main], why: 'the package entry file', mode: /server/.test(main) ? 'browser' : 'terminal' });
  }

  // A desktop app beats its web half: an Electron or Tauri project's `dev`
  // script often serves only the renderer, which is not the thing you run.
  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  let appKind = null;
  if (deps['@tauri-apps/cli'] && scripts.tauri) {
    appKind = 'tauri';
    starts.unshift({ id: 'tauri', label: nodeScriptArgv(pm, 'tauri').concat('dev').join(' '),
      argv: nodeScriptArgv(pm, 'tauri').concat('dev'), why: 'a Tauri app: builds it and opens its window', opensWindow: true, mode: 'app' });
  } else if (deps.electron) {
    const i = starts.findIndex((st) => /\belectron\b/.test(st.why || ''));
    if (i > 0) starts.unshift(starts.splice(i, 1)[0]);
    if (i !== -1) { appKind = 'electron'; Object.assign(starts[0], { opensWindow: true, mode: 'app', why: `an Electron app: opens its own window (${starts[0].why})` }); }
  } else if (deps.expo) {
    // An Expo app is a phone app; its web build is the option, not the default.
    appKind = 'expo';
    const run = (args) => (pm === 'npm' ? ['npx'] : pm === 'bun' ? ['bunx'] : [pm]).concat(['expo', 'start'], args);
    const ex = [];
    if (process.platform === 'darwin') ex.push({ id: 'expo-ios', label: run(['--ios']).join(' '), argv: run(['--ios']), mode: 'simulator', opensWindow: true, why: 'an Expo app: starts the bundler and opens it in the iOS Simulator' });
    ex.push({ id: 'expo-android', label: run(['--android']).join(' '), argv: run(['--android']), mode: 'simulator', opensWindow: true, why: 'opens it in an Android emulator (needs Android Studio)' });
    if (deps['react-native-web']) ex.push({ id: 'expo-web', label: run(['--web']).join(' '), argv: run(['--web']), mode: 'browser', portHint: 8081, why: 'the web version, in your browser' });
    const rest = starts.filter((st) => !/\bexpo start\b/.test(st.why || ''));
    starts.length = 0;
    starts.push(...ex, ...rest);
  } else if (deps['react-native']) {
    appKind = 'react-native';
    const x = pm === 'npm' ? ['npx'] : [pm];
    if (process.platform === 'darwin' && exists(path.join(dir, 'ios'))) starts.unshift({ id: 'rn-ios', label: x.concat(['react-native', 'run-ios']).join(' '), argv: x.concat(['react-native', 'run-ios']), mode: 'simulator', opensWindow: true, why: 'a React Native app: builds it and opens it in the iOS Simulator' });
    if (exists(path.join(dir, 'android'))) starts.splice(process.platform === 'darwin' ? 1 : 0, 0, { id: 'rn-android', label: x.concat(['react-native', 'run-android']).join(' '), argv: x.concat(['react-native', 'run-android']), mode: 'simulator', opensWindow: true, why: 'builds it and opens it in an Android emulator' });
  }
  const stack = { tauri: `Tauri app (${pm})`, electron: `Electron app (${pm})`, expo: `Expo app (${pm})`, 'react-native': `React Native app (${pm})` }[appKind] || `Node (${pm})`;
  return { stack, kind: 'node', appKind, pm, setup, starts, installStep: { id: 'install', label: 'Install dependencies', argv: nodeInstallArgv(pm), consent: true } };
}

/** Packages whose import name is not their install name. */
const PY_MODULE_TO_PACKAGE = {
  cv2: 'opencv-python', PIL: 'Pillow', yaml: 'PyYAML', sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4', dotenv: 'python-dotenv', jwt: 'PyJWT', dateutil: 'python-dateutil',
  serial: 'pyserial', usb: 'pyusb', Crypto: 'pycryptodome', magic: 'python-magic',
  docx: 'python-docx', pptx: 'python-pptx', telegram: 'python-telegram-bot', discord: 'discord.py',
  google: 'google-api-python-client', attr: 'attrs', OpenSSL: 'pyOpenSSL', gi: 'PyGObject',
};

/** A Python file that opens a window of its own rather than printing. */
const PY_GUI_RE = /^\s*(?:import|from)\s+(tkinter|customtkinter|pygame|PyQt5|PyQt6|PySide2|PySide6|kivy|wx|pyglet|arcade|webview|dearpygui|toga|ursina|panda3d|flet)\b/m;

function pyMode(src, fallback = 'terminal') {
  return PY_GUI_RE.test(src || '') ? 'app' : fallback;
}

function detectPython(dir, parent = null) {
  const has = (f) => exists(path.join(dir, f));
  const markers = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'manage.py',
    'main.py', 'app.py', 'run.py', 'server.py', 'bot.py', 'streamlit_app.py'];
  let rootFiles = [];
  try { rootFiles = fs.readdirSync(dir); } catch { /* unreadable */ }
  const pyFiles = rootFiles.filter((f) => f.endsWith('.py'));
  const notebooks = rootFiles.filter((f) => f.endsWith('.ipynb'));
  if (!markers.some(has) && !pyFiles.length && !notebooks.length) return null;

  // A service in app/ often shares the virtualenv and requirements at the
  // root (its own launcher says `../.venv/bin/python`), so the parent folder
  // is looked in before a second environment is made beside the first.
  const findVenv = (d) => ['.venv', 'venv', 'env'].find((v) => exists(venvPython(d, v)));
  const reqNames = ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt'];
  const ownReq = reqNames.find(has) || (has('pyproject.toml') || has('setup.py') ? 'pyproject' : null);
  const parentReq = parent ? reqNames.find((f) => exists(path.join(parent, f))) : null;
  let home = dir;
  if (!findVenv(dir) && parent && (findVenv(parent) || (!ownReq && parentReq))) home = parent;
  const venvName = path.relative(dir, path.join(home, findVenv(home) || '.venv')) || '.venv';
  const py = venvPython(dir, venvName);
  const venvExists = exists(py);
  const stamp = path.join(dir, venvName, '.ground-control-installed');
  const setup = [];

  if (!venvExists) {
    setup.push({
      id: 'venv', label: `Create a virtual environment in ${venvName}/`,
      argv: ['python3', '-m', 'venv', venvName],
      why: 'so packages install for this project only, never into your system Python', consent: true,
    });
  }

  let installStep = null;
  let installWhy = null;
  const reqFile = reqNames.find(has) || (home === parent && !ownReq && parentReq ? path.relative(dir, path.join(parent, parentReq)) : null);
  const pyproject = readText(path.join(dir, 'pyproject.toml')) || '';
  if (reqFile) {
    installStep = { id: 'install', label: 'Install requirements', argv: [py, '-m', 'pip', 'install', '-r', reqFile], touch: stamp, consent: true };
    if (!venvExists || !exists(stamp)) installWhy = 'the requirements have not been installed into the environment yet';
    else if (mtime(path.join(dir, reqFile)) > mtime(stamp)) installWhy = `${reqFile} changed since the last install`;
  } else if (has('setup.py') || (/^\s*\[build-system\]/m.test(pyproject) && /^\s*\[(?:project|tool\.poetry)\]/m.test(pyproject))) {
    installStep = { id: 'install', label: 'Install the project and its dependencies', argv: [py, '-m', 'pip', 'install', '-e', '.'], touch: stamp, consent: true };
    if (!venvExists || !exists(stamp)) installWhy = 'the project has not been installed into the environment yet';
    else if (mtime(path.join(dir, 'pyproject.toml')) > mtime(stamp)) installWhy = 'pyproject.toml changed since the last install';
  }
  if (installStep && installWhy) setup.push(Object.assign({}, installStep, { why: installWhy }));

  const starts = [];
  if (has('manage.py')) {
    starts.push({ id: 'django', label: 'python manage.py runserver', argv: [py, 'manage.py', 'runserver'], why: 'a Django project', portHint: 8000, portFlag: 'django', mode: 'browser' });
  }
  const scriptsBlock = /^\s*\[project\.scripts\]\s*\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(pyproject);
  if (scriptsBlock) {
    for (const m of scriptsBlock[1].matchAll(/^\s*["']?([\w.-]+)["']?\s*=/gm)) {
      const bin = IS_WIN ? path.join(dir, venvName, 'Scripts', m[1] + '.exe') : path.join(dir, venvName, 'bin', m[1]);
      starts.push({ id: 'script:' + m[1], label: m[1], argv: [bin], why: 'declared in pyproject.toml [project.scripts]', needsSetup: true });
    }
  }
  for (const f of ['main.py', 'app.py', 'streamlit_app.py', 'run.py', 'server.py', 'bot.py']) {
    if (!has(f)) continue;
    const src = readText(path.join(dir, f)) || '';
    const mod = f.replace(/\.py$/, '');
    if (/\bimport\s+streamlit\b|\bfrom\s+streamlit\b/.test(src)) {
      starts.push({ id: 'streamlit:' + f, label: `streamlit run ${f}`, argv: [py, '-m', 'streamlit', 'run', f], why: 'a Streamlit app', portHint: 8501, portFlag: 'streamlit', mode: 'browser' });
      continue;
    }
    const fastapi = /^(\w+)\s*=\s*FastAPI\(/m.exec(src);
    if (fastapi && !/uvicorn\.run\(/.test(src)) {
      starts.push({ id: 'uvicorn:' + f, label: `uvicorn ${mod}:${fastapi[1]} --reload`, argv: [py, '-m', 'uvicorn', `${mod}:${fastapi[1]}`, '--reload'], why: 'a FastAPI app', portHint: 8000, portFlag: 'uvicorn', mode: 'browser' });
      continue;
    }
    const flask = /^(\w+)\s*=\s*Flask\(/m.exec(src);
    if (flask && !/\.run\(/.test(src)) {
      starts.push({ id: 'flask:' + f, label: `flask --app ${mod} run`, argv: [py, '-m', 'flask', '--app', mod, 'run'], why: 'a Flask app', portHint: 5000, portFlag: 'flask', mode: 'browser' });
      continue;
    }
    const web = /\.run\(/.test(src) && /Flask\(/.test(src) ? 5000 : /uvicorn\.run\(/.test(src) ? 8000 : null;
    const mode = pyMode(src, web ? 'browser' : 'terminal');
    starts.push({ id: 'py:' + f, label: `python ${f}`, argv: [py, f], portHint: web, mode, opensWindow: mode === 'app',
      why: (f === 'main.py' || f === 'app.py' ? 'the entry file' : 'a runnable file at the root') + (mode === 'app' ? ', which opens its own window' : '') });
  }
  if (!starts.length) {
    try {
      for (const d of fs.readdirSync(dir)) {
        if (isIgnoredDir(d) || d.startsWith('.')) continue;
        if (exists(path.join(dir, d, '__main__.py'))) {
          starts.push({ id: 'module:' + d, label: `python -m ${d}`, argv: [py, '-m', d], why: `${d}/ has a __main__.py` });
        }
      }
    } catch { /* unreadable: no module starts */ }
  }
  // Any other script at the root: the ones with a __main__ guard first, since
  // that is a file written to be run. Most small projects are exactly this.
  const named = new Set(['main.py', 'app.py', 'streamlit_app.py', 'run.py', 'server.py', 'bot.py'].filter(has));
  const NOT_A_SCRIPT = /^(setup|conftest|__init__|manage)\.py$|^test_|_test\.py$/;
  const scripts = pyFiles.filter((f) => !NOT_A_SCRIPT.test(f) && !named.has(f))
    .map((f) => ({ f, src: readText(path.join(dir, f)) || '' }))
    .map((x) => ({ ...x, guard: /if\s+__name__\s*==\s*['"]__main__['"]/.test(x.src) }))
    .sort((a, b) => Number(b.guard) - Number(a.guard) || a.f.localeCompare(b.f))
    .slice(0, 8);
  for (const x of scripts) {
    const mode = pyMode(x.src, /\.run\(/.test(x.src) && /Flask\(/.test(x.src) ? 'browser' : 'terminal');
    starts.push({ id: 'py:' + x.f, label: `python ${x.f}`, argv: [py, x.f], mode, opensWindow: mode === 'app',
      why: (x.guard ? 'a script written to be run (it has a __main__ guard)' : 'a Python file at the root') + (mode === 'app' ? ', which opens its own window' : ''),
      portHint: /\.run\(/.test(x.src) && /Flask\(/.test(x.src) ? 5000 : null });
  }
  if (notebooks.length) {
    const lab = IS_WIN ? path.join(dir, venvName, 'Scripts', 'jupyter-lab.exe') : path.join(dir, venvName, 'bin', 'jupyter-lab');
    starts.push({ id: 'jupyter', label: 'jupyter lab', argv: [py, '-m', 'jupyterlab', '--no-browser'],
      why: `opens the notebook${notebooks.length > 1 ? 's' : ''} (${notebooks.slice(0, 3).join(', ')}) in JupyterLab`, portHint: 8888, mode: 'browser',
      pre: exists(lab) ? [] : [{ id: 'jupyter-install', label: 'Install JupyterLab into the virtualenv', argv: [py, '-m', 'pip', 'install', 'jupyterlab'], why: 'notebooks need it, and it goes into this project only', consent: true }] });
  }
  // `weak`: found only by a stray .py file, so a Cargo.toml or go.mod beside
  // it is the real project and wins (see detectService).
  return { weak: !markers.some(has) && !notebooks.length, stack: notebooks.length && !pyFiles.length ? 'Jupyter notebooks' : 'Python', kind: 'python', python: py, venvName, setup, starts, installStep };
}

/** Where Xcode builds go: a cache outside the project, one folder per project. */
function derivedDataFor(dir) {
  const h = createHash('sha1').update(dir).digest('hex').slice(0, 12);
  return path.join(os.homedir(), 'Library', 'Caches', 'GroundControl', 'DerivedData', `${path.basename(dir)}-${h}`);
}

/**
 * An Xcode project, built and launched rather than just opened. macOS apps
 * only: an iOS app needs a Simulator and a device choice, so it still opens in
 * Xcode, and says so. `opts` exists so tests can stand in for xcodebuild.
 */
function detectXcode(dir, opts = {}) {
  const platform = opts.platform || process.platform;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const ws = entries.find((f) => f.endsWith('.xcworkspace'));
  const proj = entries.find((f) => f.endsWith('.xcodeproj'));
  const target = ws || proj;
  if (!target) return null;
  const openStart = { id: 'xcode-open', label: `open ${target}`, argv: ['open', target], why: 'opens it in Xcode, to run it from there', opensWindow: true, mode: 'editor' };
  const pbx = proj ? readText(path.join(dir, proj, 'project.pbxproj'), 4 * 1024 * 1024) || '' : '';
  const ios = /SDKROOT = iphoneos/.test(pbx) && !/SDKROOT = macosx/.test(pbx);
  const stack = ios ? 'Xcode (iOS app)' : 'Xcode (macOS app)';
  if (platform !== 'darwin') {
    openStart.why = 'an Xcode project (building one needs macOS)';
    return { stack, kind: 'xcode', setup: [], starts: [openStart] };
  }
  const flag = ws ? '-workspace' : '-project';
  let list = opts.listJson || null;
  if (!list) {
    try {
      const r = spawnSync(which('xcodebuild') || 'xcodebuild', ['-list', '-json', flag, target], { cwd: dir, encoding: 'utf8', timeout: 20000 });
      list = JSON.parse(r.stdout || 'null');
    } catch { list = null; }
  }
  const info = list && (list.workspace || list.project);
  const schemes = (info && Array.isArray(info.schemes) ? info.schemes : []).filter((x) => typeof x === 'string');
  const base = target.replace(/\.(xcworkspace|xcodeproj)$/, '');
  const scheme = schemes.find((x) => x === base) || schemes.find((x) => !/tests?$/i.test(x) && !/widget|extension/i.test(x)) || schemes[0];
  if (!scheme) return { stack, kind: 'xcode', setup: [], starts: [openStart] };
  const dd = derivedDataFor(dir);
  const build = (extra, label) => ({ id: 'xcodebuild', label, argv: ['xcodebuild', flag, target, '-scheme', scheme, '-configuration', 'Debug'].concat(extra, ['-derivedDataPath', dd, 'build']),
    why: 'compiles it with Xcode, into a cache folder outside the project' });
  if (ios) {
    return {
      stack, kind: 'xcode', derivedData: dd, setup: [],
      starts: [{ id: 'ios-sim', label: `Run ${scheme} in the iOS Simulator`, builtin: 'ios-sim', argv: [`${scheme}.app`], mode: 'simulator', opensWindow: true,
        productsDir: path.join(dd, 'Build', 'Products', 'Debug-iphonesimulator'),
        why: 'builds it, opens an iPhone in the Simulator, installs the app there and launches it. Stop quits it.',
        pre: [build(['-destination', 'generic/platform=iOS Simulator'], `Build ${scheme} for the Simulator`)] }, openStart],
    };
  }
  return {
    stack, kind: 'xcode', derivedData: dd, setup: [],
    starts: [{ id: 'xcode-app', label: `Launch ${scheme}`, builtin: 'app-binary', argv: [`${scheme}.app`], mode: 'app',
      productsDir: path.join(dd, 'Build', 'Products', 'Debug'), why: 'runs the app it just built, so Stop quits it', opensWindow: true,
      pre: [build([], `Build ${scheme}`)] }, openStart],
  };
}

/* ------------------------------------------------------------------ *
 * A Mac app around the project: a build script that makes `X.app`, or the
 * `X.app` itself. Projects like this (a native window around a local
 * server) are meant to be opened as the app, so the app is the default and
 * the server in a browser is the alternative.
 * ------------------------------------------------------------------ */

const APP_BUILD_SCRIPTS = ['build-app.sh', 'build_app.sh', 'app/build.sh', 'scripts/build-app.sh', 'scripts/build_app.sh', 'macos/build.sh', 'mac/build.sh'];
const APP_BUNDLE_DIRS = ['', 'app/build', 'build', 'dist', 'out', 'release', 'app', 'macos/build'];

function bundleExecutable(appPath) {
  const plist = readText(path.join(appPath, 'Contents', 'Info.plist')) || '';
  const named = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  const dir = path.join(appPath, 'Contents', 'MacOS');
  const exe = named ? path.join(dir, named[1]) : (() => { try { return path.join(dir, fs.readdirSync(dir)[0]); } catch { return null; } })();
  return exe && isExecutable(exe) ? exe : null;
}

/** Every `Name.app` in the usual output folders, newest first. */
function findBundles(dir, name = null) {
  const out = [];
  for (const d of APP_BUNDLE_DIRS) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, d)); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.app') || (name && f !== name + '.app')) continue;
      const p = path.join(dir, d, f);
      if (exists(path.join(p, 'Contents', 'Info.plist'))) out.push({ path: p, at: mtime(bundleExecutable(p) || p) });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Newest change to the project's own files, so a stale build is rebuilt. Cheap: shallow, capped. */
function newestSource(dir) {
  let newest = 0;
  let seen = 0;
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > 4000) return;
      if (e.name.startsWith('.') || e.name.endsWith('.app')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3 && !isIgnoredDir(e.name) && !/^(build|dist|out|release|DerivedData)$/.test(e.name)) walk(p, depth + 1);
      } else if (e.isFile()) newest = Math.max(newest, mtime(p));
    }
  };
  walk(dir, 0);
  return newest;
}

function detectMacBundle(dir, opts = {}) {
  if ((opts.platform || process.platform) !== 'darwin') return null;
  const script = APP_BUILD_SCRIPTS.find((f) => exists(path.join(dir, f)));
  const text = script ? readText(path.join(dir, script)) || '' : '';
  let name = null;
  if (text) {
    const m = /^\s*(?:readonly\s+)?APP_NAME=["']?([\w .-]+?)["']?\s*$/m.exec(text) || /([A-Z][\w-]*)\.app\b/.exec(text);
    if (m) name = m[1];
  }
  let bundles = findBundles(dir, name);
  // A build script that names no app, and no app on disk: not one of these.
  if (!name && !bundles.length) return null;
  if (!script && bundles.length > 1) bundles = bundles.slice(0, 1);
  if (!name) name = path.basename(bundles[0].path, '.app');
  const builtAt = bundles.length ? bundles[0].at : 0;
  const pre = [];
  if (script && (!builtAt || newestSource(dir) > builtAt + 2000)) {
    // `--no-install` where the script offers it, so the build stays in the project.
    const argv = ['bash', script].concat(/--no-install\b/.test(text) ? ['--no-install'] : []);
    pre.push({ id: 'build-app', label: `Build ${name}.app`, argv,
      why: builtAt ? `the project changed since ${name}.app was last built` : `${name}.app has not been built yet`,
      builds: true });
  }
  return {
    id: 'mac-app', label: `Open ${name}.app`, builtin: 'app-bundle', appName: name, argv: [`${name}.app`],
    mode: 'app', opensWindow: true, pre,
    why: script ? `the Mac app this project builds with ${script}, in its own window. Stop quits it.` : `the Mac app in this folder, in its own window. Stop quits it.`,
  };
}

function detectFlutter(dir) {
  const spec = readText(path.join(dir, 'pubspec.yaml'));
  if (!spec || !/^\s*flutter\s*:/m.test(spec)) return null;
  const starts = [];
  if (process.platform === 'darwin' && exists(path.join(dir, 'macos'))) starts.push({ id: 'flutter-macos', label: 'flutter run -d macos', argv: ['flutter', 'run', '-d', 'macos'], why: 'runs it as a macOS app', opensWindow: true, mode: 'app' });
  if (process.platform === 'darwin' && exists(path.join(dir, 'ios'))) starts.push({ id: 'flutter-ios', label: 'flutter run -d iPhone', argv: ['flutter', 'run', '-d', 'iPhone'], why: 'runs it in the iOS Simulator (start a Simulator first if none is open)', opensWindow: true, mode: 'simulator' });
  if (exists(path.join(dir, 'web'))) starts.push({ id: 'flutter-web', label: 'flutter run -d chrome', argv: ['flutter', 'run', '-d', 'chrome'], why: 'the web version, in Chrome', opensWindow: true, mode: 'browser' });
  starts.push({ id: 'flutter', label: 'flutter run', argv: ['flutter', 'run'], why: 'runs it on the first available device' });
  return { stack: 'Flutter', kind: 'flutter', setup: [{ id: 'pub', label: 'Get packages', argv: ['flutter', 'pub', 'get'], why: 'fetches the packages pubspec.yaml lists', consent: true }], starts };
}

/** A target whose sources import a UI framework opens a window. */
function swiftTargetIsApp(dir, target) {
  for (const base of [path.join(dir, 'Sources', target), path.join(dir, target)]) {
    let files = [];
    try { files = fs.readdirSync(base, { recursive: true }).filter((f) => String(f).endsWith('.swift')).slice(0, 40); } catch { continue; }
    if (files.some((f) => /^\s*import\s+(SwiftUI|AppKit|Cocoa|SpriteKit|MetalKit)\b/m.test(readText(path.join(base, String(f))) || ''))) return true;
  }
  return false;
}

function detectSwiftPackage(dir) {
  const text = readText(path.join(dir, 'Package.swift')) || '';
  const exes = [];
  for (const m of text.matchAll(/\.executable\(\s*name:\s*"([^"]+)"\s*,\s*targets:\s*\[\s*"([^"]+)"/g)) exes.push({ name: m[1], target: m[2] });
  if (!exes.length) for (const m of text.matchAll(/\.executableTarget\(\s*name:\s*"([^"]+)"/g)) exes.push({ name: m[1], target: m[1] });
  const starts = exes.map((e) => {
    const app = swiftTargetIsApp(dir, e.target);
    return { id: 'swift:' + e.name, label: `swift run ${e.name}`, argv: ['swift', 'run', e.name], mode: app ? 'app' : 'terminal', opensWindow: app,
      why: app ? `builds and opens ${e.name}, a Mac app (Stop quits it)` : `builds and runs the ${e.name} executable` };
  }).sort((a, b) => Number(b.opensWindow) - Number(a.opensWindow));
  if (starts.length <= 1 && !starts.some((st) => st.opensWindow)) {
    starts.length = 0;
    starts.push({ id: 'swift', label: 'swift run', argv: ['swift', 'run'], why: 'Swift Package Manager builds and runs the executable' });
  }
  return { stack: starts.some((st) => st.opensWindow) ? 'Swift (Mac app)' : 'Swift', kind: 'swift', setup: [], starts };
}

function detectSimple(dir) {
  const has = (f) => exists(path.join(dir, f));
  const flutter = detectFlutter(dir);
  if (flutter) return flutter;
  if (has('Cargo.toml')) {
    return { stack: 'Rust', kind: 'rust', setup: [], starts: [{ id: 'cargo', label: 'cargo run', argv: ['cargo', 'run'], why: 'Cargo builds and runs the default binary' }] };
  }
  if (has('go.mod')) {
    const starts = [];
    const rootMain = (() => {
      try { return fs.readdirSync(dir).some((f) => f.endsWith('.go') && /^package\s+main\b/m.test(readText(path.join(dir, f)) || '')); } catch { return false; }
    })();
    if (rootMain) starts.push({ id: 'go', label: 'go run .', argv: ['go', 'run', '.'], why: 'package main at the root' });
    try {
      for (const c of fs.readdirSync(path.join(dir, 'cmd'))) {
        if (exists(path.join(dir, 'cmd', c, 'main.go'))) starts.push({ id: 'go:' + c, label: `go run ./cmd/${c}`, argv: ['go', 'run', `./cmd/${c}`], why: `cmd/${c}/main.go` });
      }
    } catch { /* no cmd/ */ }
    if (!starts.length) starts.push({ id: 'gobuild', label: 'go build ./...', argv: ['go', 'build', './...'], why: 'no main package found, so this only builds', mode: 'build' });
    return { stack: 'Go', kind: 'go', setup: [], starts };
  }
  if (has('Package.swift')) return detectSwiftPackage(dir);
  if (has('deno.json') || has('deno.jsonc')) {
    const conf = readJSON(path.join(dir, 'deno.json')) || {};
    const tasks = Object.keys(conf.tasks || {});
    tasks.sort((a, b) => (NODE_START_PRIORITY.indexOf(a) + 100) % 100 - (NODE_START_PRIORITY.indexOf(b) + 100) % 100);
    const starts = tasks.map((t) => ({ id: 'deno:' + t, label: `deno task ${t}`, argv: ['deno', 'task', t], why: String(conf.tasks[t]).slice(0, 200) }));
    if (starts.length) return { stack: 'Deno', kind: 'deno', setup: [], starts };
  }
  if (has('Gemfile')) {
    const setup = [{ id: 'install', label: 'Install gems', argv: ['bundle', 'install'], why: 'Bundler checks the Gemfile and installs anything missing', consent: true }];
    const starts = [];
    if (has('bin/rails')) starts.push({ id: 'rails', label: 'bin/rails server', argv: ['bin/rails', 'server'], why: 'a Rails app', portHint: 3000, portFlag: 'rails', mode: 'browser' });
    else if (has('config.ru')) starts.push({ id: 'rackup', label: 'bundle exec rackup', argv: ['bundle', 'exec', 'rackup'], why: 'a Rack app', mode: 'browser' });
    for (const f of ['main.rb', 'app.rb']) if (has(f)) starts.push({ id: 'rb:' + f, label: `ruby ${f}`, argv: ['bundle', 'exec', 'ruby', f], why: 'the entry file' });
    if (starts.length) return { stack: 'Ruby', kind: 'ruby', setup, starts, installStep: setup[0] };
  }
  return null;
}

function detectJava(dir) {
  const has = (f) => exists(path.join(dir, f));
  const gradle = readText(path.join(dir, 'build.gradle')) || readText(path.join(dir, 'build.gradle.kts'));
  if (gradle != null) {
    const tool = has('gradlew') ? './gradlew' : 'gradle';
    const task = /org\.springframework\.boot/.test(gradle) ? 'bootRun' : 'run';
    return { stack: 'Java (Gradle)', kind: 'java', setup: [], starts: [{ id: 'gradle', label: `${tool} ${task}`, argv: [tool, task],
      why: task === 'bootRun' ? 'a Spring Boot app' : 'Gradle\'s run task', portHint: task === 'bootRun' ? 8080 : null }] };
  }
  const pom = readText(path.join(dir, 'pom.xml'));
  if (pom != null) {
    const tool = has('mvnw') ? './mvnw' : 'mvn';
    if (/spring-boot/.test(pom)) return { stack: 'Java (Maven)', kind: 'java', setup: [], starts: [{ id: 'mvn-boot', label: `${tool} spring-boot:run`, argv: [tool, 'spring-boot:run'], why: 'a Spring Boot app', portHint: 8080, mode: 'browser' }] };
    if (/exec-maven-plugin/.test(pom)) return { stack: 'Java (Maven)', kind: 'java', setup: [], starts: [{ id: 'mvn-exec', label: `${tool} compile exec:java`, argv: [tool, 'compile', 'exec:java'], why: 'the exec plugin in pom.xml' }] };
    return { stack: 'Java (Maven)', kind: 'java', setup: [], starts: [{ id: 'mvn', label: `${tool} package`, argv: [tool, 'package'], why: 'builds it (pom.xml declares no way to run it)', mode: 'build' }] };
  }
  return null;
}

function makeTargets(dir) {
  return Object.keys(makeRecipes(dir));
}

/** The run-like targets and the commands under each, `{ run: 'swift run app' }`. */
function makeRecipes(dir) {
  const text = readText(path.join(dir, 'Makefile')) || readText(path.join(dir, 'makefile'));
  if (!text) return {};
  const found = {};
  for (const m of text.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)[^\n]*\n((?:\t[^\n]*\n?)*)/gm)) found[m[1]] = m[2].replace(/^\t@?/gm, '').trim();
  const out = {};
  for (const t of ['run', 'dev', 'start', 'serve', 'up']) if (t in found) out[t] = found[t];
  return out;
}

/** The author's own launcher: `./run.sh`, `./start.sh`. */
const LAUNCHERS = ['run.sh', 'start.sh', 'run_dev.sh', 'dev.sh', 'launch.sh', 'serve.sh'];
function launcherStarts(dir) {
  return LAUNCHERS.filter((f) => exists(path.join(dir, f))).map((f) => {
    const text = readText(path.join(dir, f)) || '';
    const port = portFromScript(text) || (/uvicorn|runserver/.test(text) ? 8000 : null);
    const web = port || /\b(uvicorn|http\.server|runserver|flask run|streamlit|npm run (dev|start)|next dev|vite|serve)\b|server/.test(text);
    return { id: 'sh:' + f, label: `./${f}`, argv: ['bash', f], portHint: port, mode: web ? 'browser' : 'terminal',
      why: `the project's own launcher script${/npm (run )?(setup|install|ci)\b|pip install/.test(text) ? ' (it may install dependencies by itself, without asking)' : ''}` };
  });
}

/**
 * What pressing Run ends with, per start command. It decides what the panel
 * promises ("opens as a Mac app" vs "opens in your browser") and is the axis
 * the person chooses along when a project can be run more than one way.
 */
const MODES = {
  app: 'Desktop app',
  simulator: 'Simulator',
  browser: 'In the browser',
  terminal: 'In the panel',
  editor: 'In Xcode',
  build: 'Build only',
};
function modeOf(st, svc = {}) {
  if (st.mode && MODES[st.mode]) return st.mode;
  if (st.opensWindow) return 'app';
  if (st.portHint || svc.kind === 'static') return 'browser';
  return 'terminal';
}

/** One folder → one runnable service, or null. */
function detectService(dir, parent = null) {
  // A package.json that only holds prettier must not hide the main.py beside
  // it, so the first detector that found a way to START the folder wins.
  const found = [detectNode, (d) => detectPython(d, parent), detectSimple].map((f) => f(dir)).filter(Boolean);
  let svc = found.find((c) => c.starts.length && !c.weak) || found.find((c) => c.starts.length) || found[0] || null;

  // A Makefile `run`/`dev` target is the author telling you how they run it.
  // It runs whatever it wraps, so it opens a window when that does.
  const recipes = makeRecipes(dir);
  const targets = Object.keys(recipes);
  if (targets.length) {
    const mk = targets.map((t) => {
      const inner = svc && svc.starts.find((st) => recipes[t].includes(st.argv.join(' ')));
      return { id: 'make:' + t, label: `make ${t}`, argv: ['make', t], why: `a target in the Makefile (${recipes[t].split('\n')[0].slice(0, 80)})`,
        mode: inner ? modeOf(inner) : undefined, opensWindow: inner ? inner.opensWindow : undefined, portHint: inner ? inner.portHint : portFromScript(recipes[t]) };
    });
    if (!svc) svc = { stack: 'Make', kind: 'make', setup: [], starts: mk };
    else if (svc.kind !== 'node') svc.starts = mk.concat(svc.starts);
    else svc.starts = svc.starts.concat(mk);
  }

  // The author's launcher script: first unless the package manager already
  // says how to start it.
  const launch = launcherStarts(dir);
  if (launch.length) {
    if (!svc) svc = { stack: 'Shell script', kind: 'shell', setup: [], starts: launch };
    else if (svc.kind === 'node' && svc.starts.length) svc.starts = svc.starts.concat(launch);
    else svc.starts = launch.concat(svc.starts);
  }

  // A Mac app wrapped around the project is the thing you run; its server in
  // a browser stays one choice away.
  const mac = detectMacBundle(dir);
  if (mac) {
    if (!svc) svc = { stack: 'Mac app', kind: 'macapp', setup: [], starts: [mac] };
    else { svc.starts.unshift(mac); svc.stack = `Mac app (${svc.stack})`; }
  }

  if (!svc || !svc.starts.length) {
    const xcode = detectXcode(dir);
    if (xcode) svc = Object.assign(xcode, { setup: (svc && svc.setup) || [] });
  }

  if (!svc || !svc.starts.length) {
    if (exists(path.join(dir, 'docker-compose.yml')) || exists(path.join(dir, 'compose.yaml')) || exists(path.join(dir, 'docker-compose.yaml'))) {
      svc = { stack: 'Docker Compose', kind: 'docker', setup: [], starts: [{ id: 'compose', label: 'docker compose up', argv: ['docker', 'compose', 'up'], why: 'a Compose file', mode: 'browser' }] };
    }
  }

  if (!svc || !svc.starts.length) {
    const java = detectJava(dir);
    if (java) svc = java;
  }

  if (!svc || !svc.starts.length) {
    const site = ['', 'public', 'docs', 'site', 'src', 'www', 'dist'].find((d) => exists(path.join(dir, d, 'index.html')));
    if (site !== undefined) {
      const argv = site ? ['python3', '-m', 'http.server', '8000', '-d', site] : ['python3', '-m', 'http.server', '8000'];
      svc = { stack: 'Static site', kind: 'static', setup: [], starts: [{ id: 'static', label: argv.join(' '), argv,
        why: `serves ${site ? site + '/' : 'the folder'} so index.html opens in your browser`, portHint: 8000, portFlag: site ? 'static-dir' : 'positional', mode: 'browser' }] };
    }
  }

  if (!svc || !svc.starts.length) {
    if (exists(path.join(dir, 'Makefile')) || exists(path.join(dir, 'makefile'))) {
      svc = { stack: 'Make', kind: 'make', setup: [], starts: [{ id: 'make', label: 'make', argv: ['make'], why: 'builds it (the Makefile has no run target, so this builds and stops)', mode: 'build' }] };
    }
  }

  if (!svc || !svc.starts.length) return null;

  // A missing .env is the most common reason a freshly cloned app dies on
  // start. Copying the example is safe: it never overwrites, and it is the
  // first thing the project's own README would tell you to do.
  const example = ['.env.example', '.env.sample', '.env.template', '.env.dist'].find((f) => exists(path.join(dir, f)));
  if (example && !exists(path.join(dir, '.env'))) {
    svc.setup.unshift({ id: 'env', label: `Copy ${example} to .env`, builtin: 'copy', from: example, to: '.env', why: 'the app expects a .env and there is none; check its values afterwards' });
  }
  return svc;
}

/** Subfolders worth looking in when the root has nothing runnable. */
const SERVICE_DIR_ORDER = ['backend', 'server', 'api', 'frontend', 'client', 'web', 'app', 'ui', 'site'];

/**
 * The whole plan for a project: one service for most, several for the
 * `frontend/` + `backend/` layout where nothing at the root starts it.
 */
function detectPlan(projectPath) {
  const services = [];
  const root = detectService(projectPath);
  if (root) {
    services.push(Object.assign({ name: path.basename(projectPath), dir: '' }, root));
  } else {
    let subs = [];
    try {
      subs = fs.readdirSync(projectPath, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !isIgnoredDir(d.name))
        .map((d) => d.name);
    } catch { /* unreadable */ }
    subs.sort((a, b) => {
      const ia = SERVICE_DIR_ORDER.indexOf(a.toLowerCase()); const ib = SERVICE_DIR_ORDER.indexOf(b.toLowerCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    for (const s of subs) {
      const svc = detectService(path.join(projectPath, s), projectPath);
      // A static index.html in a docs/ folder is not the app.
      if (svc && svc.kind !== 'static' && svc.kind !== 'xcode') services.push(Object.assign({ name: s, dir: s }, svc));
      if (services.length >= 3) break;
    }
  }
  for (const s of services) {
    s.startIndex = 0;
    s.id = s.dir || '.';
    for (const st of s.starts) st.mode = modeOf(st, s);
  }
  const plan = { projectPath, services, checks: [], ok: services.length > 0 };
  if (!plan.ok) {
    plan.checks.push({ level: 'error', text: 'Nothing in this folder says how to start it: no package.json, Python entry file, Cargo.toml, go.mod, Makefile run target, or index.html.' });
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * Preflight: what can be checked before anything runs
 * ------------------------------------------------------------------ */

function nodeVersion(dirs) {
  const node = which('node', dirs);
  if (!node) return null;
  try {
    const r = spawnSync(node, ['--version'], { encoding: 'utf8', timeout: 3000 });
    return String(r.stdout || '').trim().replace(/^v/, '') || null;
  } catch { return null; }
}

/** Minimum major version a simple `engines.node` range asks for, or null. */
function engineMinimum(range) {
  const m = /(?:>=|\^|~)?\s*v?(\d+)(?:\.(\d+))?/.exec(String(range || ''));
  return m ? Number(m[1]) : null;
}

/** Can this port be bound on this address right now? `host` undefined is the wildcard. */
function canBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/**
 * Is something already on this port? Both addresses are tried, because the
 * platforms disagree: Linux refuses a wildcard bind when 127.0.0.1 is taken
 * and the other way round, but macOS allows both, so a check of 127.0.0.1
 * alone misses a dev server listening on every address (Node's default).
 */
async function portInUse(port) {
  if (!port) return false;
  return !(await canBind(port, undefined)) || !(await canBind(port, '127.0.0.1'));
}

async function freePort(start = 3001) {
  for (let p = start; p < start + 200 && p < 65536; p++) {
    if (!(await portInUse(p))) return p;
  }
  return 0;   // let the app ask the OS; better than reporting a busy port as free
}

/**
 * Fill `plan.checks` with what is wrong before you press Run, fixing what can
 * be fixed by choosing differently (a missing pnpm with corepack present is
 * rewritten to go through corepack) and saying plainly what cannot.
 */
async function preflight(plan) {
  const dirs = searchDirs();
  const missing = new Set();
  for (const svc of plan.services) {
    const cwd = path.join(plan.projectPath, svc.dir);
    const prefix = plan.services.length > 1 ? `${svc.name}: ` : '';
    const chosen = svc.starts[svc.startIndex] || svc.starts[0];
    const steps = svc.setup.concat(chosen ? (chosen.pre || []).concat([chosen]) : []);
    for (const step of steps) {
      if (!step.argv || step.builtin) continue;
      const tool = step.argv[0];
      if (path.isAbsolute(tool) || tool.includes('/')) continue;   // created by an earlier step
      if (which(tool, dirs)) continue;
      if ((tool === 'pnpm' || tool === 'yarn') && which('corepack', dirs)) {
        for (const s of svc.setup.concat(svc.starts)) if (s.argv && s.argv[0] === tool) s.argv = ['corepack'].concat(s.argv);
        if (svc.installStep && svc.installStep.argv[0] === tool) svc.installStep.argv = ['corepack'].concat(svc.installStep.argv);
        plan.checks.push({ level: 'ok', text: `${prefix}${tool} isn't installed globally, so it will run through corepack, which ships with Node.` });
        continue;
      }
      if (missing.has(tool)) continue;
      missing.add(tool);
      const inst = installerFor(tool);
      plan.checks.push(inst
        ? { level: 'warn', text: `${prefix}\`${tool}\` is not installed. Run will stop and ask before installing it (${inst.via === 'brew' ? 'with Homebrew' : "with Apple's installer"}).`, install: { tool, label: inst.label } }
        : { level: 'error', text: `${prefix}\`${tool}\` is not installed (or not on any PATH Ground Control can see).`, hint: INSTALL_HINTS[tool] || null });
    }

    if (svc.kind === 'node') {
      const pkg = readJSON(path.join(cwd, 'package.json')) || {};
      const want = engineMinimum(pkg.engines && pkg.engines.node);
      const have = nodeVersion(dirs);
      if (want && have && Number(have.split('.')[0]) < want) {
        plan.checks.push({ level: 'warn', text: `${prefix}package.json asks for Node ${pkg.engines.node} and this machine has ${have}.`, hint: 'Install a newer Node (nodejs.org, `brew upgrade node`, or `nvm install ' + want + '`).' });
      }
    }
    if (svc.kind === 'python' && !exists(svc.python)) {
      const pv = path.join(cwd, '.python-version');
      if (exists(pv)) {
        plan.checks.push({ level: 'ok', text: `${prefix}.python-version pins ${String(readText(pv) || '').trim()}; the virtualenv is made with whatever \`python3\` resolves to.` });
      }
    }
    const start = svc.starts[svc.startIndex] || svc.starts[0];
    if (start && start.portHint && await portInUse(start.portHint)) {
      plan.checks.push({ level: 'warn', text: `${prefix}port ${start.portHint} is already in use. If the app fails to bind it, Run moves it to a free port automatically.` });
    }
    for (const s of svc.setup) {
      if (s.builtin === 'copy') plan.checks.push({ level: 'warn', text: `${prefix}there is no .env, so ${s.from} will be copied to .env. Fill in any real values it needs.` });
    }
  }
  plan.ok = plan.services.length > 0 && !plan.checks.some((c) => c.level === 'error');
  return plan;
}

/* ------------------------------------------------------------------ *
 * Diagnosis: reading a failure for something that can be fixed
 *
 * `diagnose(text, ctx)` → `{ key, title, detail, hint?, fix? }` or null.
 * `fix` is a description of a change the runner knows how to make; it is
 * applied at most once per key per run, so a cure that did not work is never
 * applied in a loop.
 * ------------------------------------------------------------------ */

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

function diagnose(text, ctx = {}) {
  const t = stripAnsi(text || '');
  const step = ctx.step || {};
  const svc = ctx.service || {};

  if (ctx.spawnError && ctx.spawnError.code === 'ENOENT') {
    const tool = path.basename(step.argv ? step.argv[0] : '');
    const inst = installerFor(tool);
    return { key: 'missing:' + tool, title: `\`${tool}\` is not installed`, detail: `The step needs \`${tool}\` and it is not on any PATH Ground Control can see.`,
      hint: inst ? null : INSTALL_HINTS[tool] || null, needs: inst ? 'click' : 'you', install: inst ? { tool, label: inst.label } : null,
      why: inst ? null : 'Installing software on your Mac is your decision, and there is no package manager here Run can use for it.' };
  }

  let m = /EADDRINUSE[^\n]*?(?::|port\s*)(\d{2,5})|EADDRINUSE|address already in use|That port is already in use|Port (\d{2,5}) is (?:already )?in use|port (\d{2,5}) is already (?:in use|allocated)/i.exec(t);
  if (m && step.kind === 'start') {
    const port = Number(m[1] || m[2] || m[3]) || null;
    return {
      key: 'port', title: port ? `Port ${port} is already in use` : 'The port is already in use',
      detail: 'Something else on this machine is listening on the port this app wants, often another copy of it.',
      fix: { type: 'port', port },
    };
  }

  if (svc.kind === 'node' && step.id === 'install' && /ERESOLVE|could not resolve dependency|conflicting peer dependency/i.test(t)
      && !(step.argv || []).includes('--legacy-peer-deps') && (step.argv || []).includes('npm')) {
    return {
      key: 'legacy-peer-deps', title: 'npm refused a peer dependency conflict',
      detail: 'Two packages ask for incompatible versions of a third. npm 7+ refuses; the projects that were written against older npm install fine with --legacy-peer-deps.',
      fix: { type: 'install-flag', flag: '--legacy-peer-deps' },
    };
  }

  if (svc.kind === 'node' && step.kind === 'start'
      && (/Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package|command not found|: not found|is not recognized as an internal|MODULE_NOT_FOUND/i.test(t))) {
    m = /Cannot find (?:module|package) '([^']+)'/.exec(t) || /(?:sh: |^)([\w@./-]+): (?:command )?not found/m.exec(t);
    const what = m ? m[1] : null;
    const local = what && !what.startsWith('.') && !what.startsWith('/');
    if (local || !what) {
      return {
        key: 'install:' + svc.id, title: what ? `\`${what}\` is not installed` : 'A dependency is missing',
        detail: 'The app reached for a package that is not in node_modules.',
        cure: 'Installing the dependencies usually cures it.',
        fix: svc.installStep ? { type: 'install' } : null,
        hint: svc.installStep ? null : 'Run the package manager\'s install command in this folder.',
        ifStill: local && what
          ? `It is still missing after a fresh install, so it is probably not listed in package.json. Add it with \`${svc.pm === 'yarn' ? 'yarn add' : (svc.pm || 'npm') + ' install'} ${what.startsWith('@') ? what.split('/').slice(0, 2).join('/') : what.split('/')[0]}\`, then Run again.`
          : null,
      };
    }
  }

  if (svc.kind === 'python' && step.id === 'install' && (step.argv || []).includes('-r')
      && /Failed building wheel|metadata-generation-failed|subprocess-exited-with-error|No matching distribution found|Could not find a version that satisfies|ResolutionImpossible|requires a different Python/i.test(t)) {
    return {
      key: 'loosen-pins', title: 'The pinned versions don\'t install on this Python',
      detail: 'requirements.txt asks for exact versions, and at least one has no build for the Python on this machine. That is common with projects written a few years ago.',
      fix: { type: 'loosen-pins' },
      ifStill: 'Even the newest versions of these packages would not install. One may no longer exist, or need a system library.',
    };
  }

  m = /ModuleNotFoundError: No module named '([\w.]+)'|ImportError: No module named ([\w.]+)/.exec(t);
  if (m && svc.kind === 'python') {
    const mod = (m[1] || m[2]).split('.')[0];
    const pkg = PY_MODULE_TO_PACKAGE[mod] || mod;
    if (svc.installStep && !ctx.installedThisRun) {
      return { key: 'install:' + svc.id, title: `Python can't find \`${mod}\``, detail: 'The project\'s requirements are not installed in its environment yet.', fix: { type: 'install' } };
    }
    return {
      key: 'pip:' + pkg, title: `Python can't find \`${mod}\``,
      detail: `\`${mod}\` is imported but not installed${svc.installStep ? ', and it is not in the requirements either' : ''}. Installing \`${pkg}\` into the project's virtualenv.`,
      fix: { type: 'pip', pkg },
      hint: `If that is the fix, add \`${pkg}\` to requirements.txt so the next clone has it.`,
      ifStill: `Installing \`${pkg}\` did not help, so the package that provides \`${mod}\` has a different name. Search PyPI for it, add it to requirements.txt, then Run again.`,
    };
  }

  if (svc.kind === 'python' && (/externally-managed-environment/.test(t)
      || /bad interpreter|No such file or directory.*\/(?:\.venv|venv|env)\/bin\/python|dyld.*Library not loaded.*[Pp]ython/.test(t))) {
    return { key: 'venv-broken', title: 'The virtualenv is broken',
      detail: 'It points at a Python that was upgraded, moved or removed after the environment was made.',
      fix: { type: 'rebuild-venv' } };
  }
  m = /The engine "node" is incompatible|requires (?:a )?Node(?:\.js)? (?:version )?([>=^~\d. ]+)|Unsupported engine/i.exec(t);
  if (m) {
    return { key: 'node-version', title: 'This project wants a different Node version', detail: m[0], hint: 'Install the version it asks for (nodejs.org, or `nvm install` in the project folder), then Run again.' };
  }
  if (/linker [`']cc[`'] not found|xcrun: error: invalid active developer path/.test(t)) {
    return { key: 'xcode-clt', title: 'The C toolchain is missing', detail: 'Compiling needs Apple\'s Command Line Tools.', needs: 'click',
      install: { tool: 'make', label: 'Install the Command Line Tools' }, hint: 'macOS shows its own installer window; when it finishes, press Run again.' };
  }
  if (/Cannot connect to the Docker daemon|docker daemon is not running|error during connect/i.test(t)) {
    return { key: 'docker-down', title: 'Docker is not running', detail: 'The Docker command is installed but its engine is not up.',
      fix: process.platform === 'darwin' ? { type: 'start-docker' } : null, hint: process.platform === 'darwin' ? null : 'Start the Docker service, then Run again.',
      needs: process.platform === 'darwin' ? undefined : 'you', needsIfStill: 'you', ifStill: 'Docker Desktop did not come up within two minutes. Open it yourself, wait for it to say it is running, then Run again.' };
  }
  m = /ECONNREFUSED[^\n]*?:(5432|3306|27017|6379|5672|9200)\b|connection to server .* port (5432)|Can't connect to MySQL server|Error: Redis connection to/i.exec(t);
  if (m) {
    const port = m[1] || m[2];
    const name = { 5432: 'PostgreSQL', 3306: 'MySQL', 27017: 'MongoDB', 6379: 'Redis', 5672: 'RabbitMQ', 9200: 'Elasticsearch' }[port] || 'a database';
    return { key: 'db-down', title: `The app can't reach ${name}`, detail: `It expects ${name} to be running${port ? ` on port ${port}` : ''} and nothing answered.`,
      fix: { type: 'start-service', name, port: Number(port) || null },
      needsIfStill: 'you', whyIfStill: 'Run only starts a database that is already installed; installing one is your decision.',
      ifStill: `${name} is not installed here, or not in a form Run can start. Install it (for example \`brew install ${name === 'PostgreSQL' ? 'postgresql' : name.toLowerCase()}\`) or add it to the project's docker compose file, then Run again.` };
  }
  m = /KeyError: '([A-Z][A-Z0-9_]+)'|Missing (?:required )?environment variable:? [`'"]?([A-Z][A-Z0-9_]+)|([A-Z][A-Z0-9_]+) (?:is not set|environment variable is (?:not set|required|missing))/.exec(t);
  if (m) {
    const v = m[1] || m[2] || m[3];
    return { key: 'env:' + v, title: `\`${v}\` is not set`, detail: `The app reads the environment variable \`${v}\` and it has no value.`,
      hint: `Add \`${v}=…\` to the project's .env file, then Run again.`, needs: 'you',
      why: 'Its value is yours to supply (often a key or password), so nothing can fill it in for you.' };
  }
  m = /((?:\.\/|\/)?[\w./-]+): Permission denied|(?:EACCES|Permission denied)[^\n]*?((?:\.\/|\/)[\w./-]+)/.exec(t);
  if (m) {
    const file = m[1] || m[2];
    const abs = ctx.cwd ? path.resolve(ctx.cwd, file) : null;
    const inside = abs && ctx.root && (abs === ctx.root || abs.startsWith(ctx.root + path.sep)) && exists(abs);
    return { key: 'perm', title: `\`${file}\` is not executable`, detail: m[0],
      fix: inside ? { type: 'chmod', file: abs } : null,
      hint: inside ? null : `Run \`chmod +x ${file}\` in the project folder, then Run again.` };
  }
  return null;
}

/** Give a start command a different port, in whatever way that tool takes one. */
function withPort(start, port) {
  const s = Object.assign({}, start, { env: Object.assign({}, start.env || {}, { PORT: String(port) }) });
  const argv = start.argv.slice();
  switch (start.portFlag) {
    case 'npm': s.argv = argv.concat(argv.includes('--') ? [] : ['--'], ['--port', String(port)]); break;
    case 'django': s.argv = argv.concat([String(port)]); break;
    case 'uvicorn': case 'flask': s.argv = argv.concat(['--port', String(port)]); break;
    case 'streamlit': s.argv = argv.concat(['--server.port', String(port)]); break;
    case 'rails': s.argv = argv.concat(['-p', String(port)]); break;
    case 'positional': s.argv = argv.slice(0, -1).concat([String(port)]); break;
    case 'static-dir': s.argv = argv.map((a, i) => (i === 3 ? String(port) : a)); break;
    default: s.argv = argv;
  }
  s.portHint = port;
  return s;
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

const runs = new Map();          // projectId -> Run
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let storeFile = null;
const livePids = new Map();      // pid -> { argv, cwd }

let runSeq = 0;

function setStoreFile(file) { storeFile = file || null; }
function storePathFor(sourcesFile) { return path.join(path.dirname(sourcesFile), 'runs.json'); }

function persistPids() {
  if (!storeFile) return;
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const list = [...livePids.entries()].map(([pid, v]) => ({ pid, argv: v.argv, cwd: v.cwd }));
    fs.writeFileSync(storeFile, JSON.stringify({ pids: list }, null, 2));
  } catch { /* best effort: losing this only matters after a kill -9 */ }
}

/**
 * Stop the dev servers a `kill -9`ed Ground Control left behind. A pid is only
 * signalled when it still leads its own process group (the runner made it so)
 * and its command line still matches what was started, so a reused pid is
 * never touched.
 */
function reapOrphans() {
  if (!storeFile || IS_WIN) return 0;
  let data;
  try { data = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return 0; }
  let reaped = 0;
  for (const rec of (data && Array.isArray(data.pids) ? data.pids : [])) {
    const pid = Number(rec.pid);
    if (!Number.isInteger(pid) || pid <= 1 || !Array.isArray(rec.argv)) continue;
    try {
      const r = spawnSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
      const line = String(r.stdout || '').trim();
      if (!line) continue;
      const [pgid, ...cmd] = line.split(/\s+/);
      const command = cmd.join(' ');
      const tail = rec.argv.slice(1).join(' ');
      const head = path.basename(String(rec.argv[0] || ''));
      if (Number(pgid) !== pid) continue;
      if (tail ? !command.includes(tail) : !command.includes(head)) continue;
      process.kill(-pid, 'SIGTERM');
      reaped += 1;
    } catch { /* gone, or not ours */ }
  }
  livePids.clear();
  persistPids();
  return reaped;
}

function get(projectId) { return runs.get(projectId) || null; }

function activeCount() {
  let n = 0;
  for (const r of runs.values()) if (!isTerminal(r.state)) n += 1;
  return n;
}

function isTerminal(state) { return state === 'done' || state === 'failed' || state === 'stopped'; }

function subscribe(projectId, fn) {
  emitter.on(projectId, fn);
  return () => emitter.off(projectId, fn);
}

/** Every listener gets the run and the event; log lines are coalesced. */
function emit(run, event, payload) { emitter.emit(run.projectId, event, run, payload); }

function pushLog(run, source, chunk, stream) {
  const text = stripAnsi(chunk);
  const carryKey = source + '|' + stream;
  const pending = (run._carry.get(carryKey) || '') + text;
  const parts = pending.split('\n');
  run._carry.set(carryKey, parts.pop());
  for (const raw of parts) addLine(run, source, raw, stream);
  // A prompt or a progress line without a newline still deserves to be seen:
  // "Enter your name: " waits for an answer and never ends its line.
  const rest = run._carry.get(carryKey);
  if (rest && rest.length > 400) { addLine(run, source, rest, stream); run._carry.set(carryKey, ''); return; }
  if (rest) {
    clearTimeout(run._promptTimers && run._promptTimers.get(carryKey));
    if (!run._promptTimers) run._promptTimers = new Map();
    const t = setTimeout(() => {
      const r = run._carry.get(carryKey);
      if (r) { addLine(run, source, r, stream); run._carry.set(carryKey, ''); }
    }, 300);
    if (t.unref) t.unref();
    run._promptTimers.set(carryKey, t);
  }
}

/** Type a line into the running program. Returns false when nothing is listening. */
function sendInput(projectId, text) {
  const run = runs.get(projectId);
  if (!run || isTerminal(run.state)) return false;
  const step = run.steps.find((s) => s.kind === 'start' && s.state === 'running');
  const child = step && run._children.get(step.key);
  if (!child || !child.stdin || child.stdin.destroyed) return false;
  const line = String(text == null ? '' : text).replace(/\r?\n$/, '').slice(0, 4000);
  try { child.stdin.write(line + '\n'); } catch { return false; }
  addLine(run, sourceName(run, step), '› ' + line, 'in');
  return true;
}

function flushCarry(run, source) {
  for (const stream of ['out', 'err', 'sys']) {
    const k = source + '|' + stream;
    const rest = run._carry.get(k);
    if (rest) { addLine(run, source, rest, stream); run._carry.set(k, ''); }
  }
}

const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.local)(?::\d{2,5})?(?:\/[^\s'"`<>)\]]*)?/gi;
const LISTEN_RE = /(?:listening|running|serving|started|available|ready)\b[^\n]{0,40}?\bport\s*:?\s*(\d{2,5})\b/i;

function addLine(run, source, raw, stream) {
  let line = raw.length > LINE_MAX ? raw.slice(0, LINE_MAX) + '…' : raw;
  if (!line.trim() && stream !== 'sys') return;
  const entry = { n: ++run._lineSeq, s: source, t: stream, l: line };
  run.log.push(entry);
  if (run.log.length > LOG_MAX_LINES) run.log.splice(0, run.log.length - LOG_MAX_LINES);
  run._pending.push(entry);

  if (stream !== 'sys') {
    const found = [];
    for (const m of line.matchAll(URL_RE)) found.push(m[0]);
    const lm = LISTEN_RE.exec(line);
    if (!found.length && lm) found.push(`http://localhost:${lm[1]}`);
    for (let u of found) {
      u = u.replace(/\/\/(?:0\.0\.0\.0|\[::\]|\[::1\]|127\.0\.0\.1)/, '//localhost').replace(/[.,;:]+$/, '');
      if (!run.urls.includes(u) && run.urls.length < 4) {
        run.urls.push(u);
        scheduleState(run);
        if (run.urls.length === 1) watchReady(run, u);
      }
    }
  }
  if (!run._flushTimer) {
    run._flushTimer = setTimeout(() => {
      run._flushTimer = null;
      const lines = run._pending.splice(0);
      if (lines.length) emit(run, 'log', lines);
    }, FLUSH_MS);
    if (run._flushTimer.unref) run._flushTimer.unref();
  }
}

function sys(run, source, text) { addLine(run, source, text, 'sys'); }

function scheduleState(run) {
  // Lines still waiting to be sent go first: a client closes its stream on a
  // finished state, and the program's last words must not arrive after that.
  if (run._pending.length) {
    if (run._flushTimer) { clearTimeout(run._flushTimer); run._flushTimer = null; }
    emit(run, 'log', run._pending.splice(0));
  }
  emit(run, 'state', toJSON(run));
}

function displayArgv(argv, cwd) {
  return argv.map((a) => {
    let s = a;
    if (path.isAbsolute(s) && s.startsWith(cwd + path.sep)) s = path.relative(cwd, s);
    return /^[\w@%+=:,./-]+$/.test(s) ? s : JSON.stringify(s);
  }).join(' ');
}

/**
 * Start a run. `choices` maps a service id to the index of the start command
 * the person picked; anything that is not a valid index falls back to the
 * detected default. Commands are never taken from the caller.
 */
async function start(project, { choices = {}, open = false, install = null, autoAgent = false, autoInstall = false } = {}) {
  if (!project || !project.id || !project.path) throw Object.assign(new Error('a project is required'), { status: 400 });
  const prev = runs.get(project.id);
  if (prev && !isTerminal(prev.state)) await stopAndWait(prev, 'restarted');
  if (activeCount() >= MAX_RUNS) {
    throw Object.assign(new Error(`${MAX_RUNS} projects are already running. Stop one first.`), { status: 429 });
  }

  const plan = detectPlan(project.path);
  for (const svc of plan.services) {
    const idx = Number(choices && choices[svc.id]);
    if (Number.isInteger(idx) && idx >= 0 && idx < svc.starts.length) svc.startIndex = idx;
  }
  // "Install X and run": a fixed installer for a tool the plan says is
  // missing. The caller names the tool; the command comes from the table.
  let installer = null;
  if (install) {
    installer = installerFor(String(install));
    if (!installer) throw Object.assign(new Error(`Run cannot install \`${install}\` on this machine.`), { status: 400 });
  }
  await preflight(plan);
  // Tools the plan found missing that Run knows how to install: each becomes
  // the first step, and the run pauses on it to ask. The one named by an
  // "Install X" button was asked already, by the button.
  const tools = [];
  for (const c of plan.checks) if (c.install && !tools.some((t) => t.tool === c.install.tool)) tools.push(installerFor(c.install.tool));
  if (installer && !tools.some((t) => t && t.tool === installer.tool)) tools.unshift(installer);

  runSeq += 1;
  const run = {
    id: 'run_' + runSeq.toString(36) + Math.random().toString(36).slice(2, 6),
    projectId: project.id,
    projectPath: project.path,
    plan,
    state: 'setup',
    startedAt: Date.now(),
    endedAt: null,
    steps: [],
    urls: [],
    log: [],
    fixes: [],
    diagnosis: null,
    _lineSeq: 0, _pending: [], _flushTimer: null, _carry: new Map(),
    _children: new Map(), _stopping: false, _applied: new Set(), _installed: new Set(),
    // A desktop app must never also open a browser tab at whatever its
    // server prints: only a run whose chosen start is a web page opens one.
    openOnReady: Boolean(open) && plan.services.some((svc) => modeOf(svc.starts[svc.startIndex] || {}, svc) === 'browser'), autoAgent: Boolean(autoAgent), autoInstall: Boolean(autoInstall), choices, readyUrl: null, opened: false,
    ask: null, _askResolve: null,
  };
  runs.set(project.id, run);

  if (!plan.ok) {
    const err = plan.checks.find((c) => c.level === 'error');
    run.state = 'failed';
    run.endedAt = Date.now();
    run.diagnosis = { title: 'This project can\'t be started yet', detail: err ? err.text : 'Nothing runnable was found.', hint: err ? err.hint : null };
    scheduleState(run);
    return run;
  }

  for (const t of tools) {
    if (!t) continue;
    const rec = stepRecord(run, plan.services[0], { id: 'install-tool', tool: t.tool, via: t.via, label: t.label, argv: t.argv, consent: true,
      why: t.via === 'brew' ? `\`${t.tool}\` is not installed, and the project needs it` : 'macOS shows its installer window; finish it, then Run again' }, 'setup');
    if (installer && t.tool === installer.tool) rec._approved = true;
    run.steps.push(rec);
  }
  for (const svc of plan.services) {
    for (const s of svc.setup) run.steps.push(stepRecord(run, svc, s, 'setup'));
    for (const s of (svc.starts[svc.startIndex] || {}).pre || []) run.steps.push(stepRecord(run, svc, s, 'setup'));
  }
  for (const svc of plan.services) {
    run.steps.push(stepRecord(run, svc, svc.starts[svc.startIndex], 'start'));
  }
  scheduleState(run);
  drive(run).then(() => { if (run._stopping) finish(run, 'stopped'); }).catch((err) => finish(run, 'failed', { title: 'Run stopped on an internal error', detail: String(err && err.message || err) }));
  return run;
}

function stepRecord(run, svc, def, kind) {
  const cwd = path.join(run.projectPath, svc.dir);
  return {
    key: `${svc.id}:${kind}:${def.id}:${run.steps.length}`,
    service: svc.id, serviceName: svc.name, kind,
    def: Object.assign({ kind }, def),
    label: def.label,
    display: def.builtin === 'copy' ? `cp ${def.from} ${def.to}` : displayArgv(def.argv, cwd),
    cwd,
    state: 'pending', exitCode: null, startedAt: null, endedAt: null, why: def.why || null,
  };
}

async function drive(run) {
  // Setup steps one at a time, in order. A failure is diagnosed and, where a
  // cure is known, cured and retried before the run gives up.
  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i];
    if (step.kind !== 'setup' || step.state === 'done' || step.state === 'skipped') continue;
    if (run._stopping) return;
    const r = await gatedSetup(run, step);
    if (run._stopping || r === 'stop') return;
    if (r === 'failed') {
      const retry = await troubleshoot(run, step);
      if (retry === 'retry') { i -= 1; continue; }
      return;
    }
  }
  if (run._stopping) return;
  run.state = 'running';
  scheduleState(run);
  const starts = run.steps.filter((s) => s.kind === 'start');
  for (const s of starts) launchStart(run, s);
}

function serviceOf(run, step) { return run.plan.services.find((s) => s.id === step.service); }

/**
 * A setup step, run only once the person has said yes when it installs
 * something. Resolves 'ok', 'failed', 'skipped' (they said try without it)
 * or 'stop'.
 */
async function gatedSetup(run, step) {
  // "Without asking" covers installs inside the project; a tool on the Mac always asks.
  const skipAsk = run.autoInstall && describeInstall(run, step).scope === 'project';
  if (step.def.consent && !step._approved && !skipAsk) {
    const answer = await askConsent(run, step);
    if (answer === 'stop' || run._stopping) return 'stop';
    if (answer === 'skip') return 'skipped';
  }
  return (await runSetupStep(run, step)) ? 'ok' : 'failed';
}

/**
 * Pause the run and ask about every install still waiting in it, at once:
 * one question, not one per step. The answer applies to all of them.
 */
function askConsent(run, step) {
  const group = run.steps.filter((s) => s.kind === 'setup' && s.state === 'pending' && s.def.consent && !s._approved
    && !(run.autoInstall && describeInstall(run, s).scope === 'project'));
  if (!group.includes(step)) group.unshift(step);
  return new Promise((resolve) => {
    const before = run.state;
    run.ask = { id: 'ask_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: toISO(Date.now()),
      items: group.map((s) => describeInstall(run, s)) };
    run.state = 'waiting';
    sys(run, '', `Paused before installing: ${group.map((s) => s.label).join(', ')}. Waiting for your answer.`);
    run._askResolve = (answer) => {
      run._askResolve = null;
      run.ask = null;
      for (const s of group) {
        if (answer === 'approve') s._approved = true;
        else if (answer === 'skip') { s.state = 'skipped'; s._declined = true; }
      }
      if (!run._stopping) run.state = before === 'waiting' ? 'setup' : before;
      scheduleState(run);
      resolve(answer);
    };
    scheduleState(run);
  });
}

/** The person's answer to the question a paused run is asking. */
function answer(projectId, { id, answer: a } = {}) {
  const run = runs.get(projectId);
  if (!run || !run.ask || !run._askResolve) throw Object.assign(new Error('this run is not waiting for an answer'), { status: 409 });
  if (id && id !== run.ask.id) throw Object.assign(new Error('that question was already answered'), { status: 409 });
  if (!['approve', 'skip', 'stop'].includes(a)) throw Object.assign(new Error('answer must be approve, skip or stop'), { status: 400 });
  if (a === 'stop') { stop(projectId, 'you chose not to install'); return run; }
  sys(run, '', a === 'approve' ? 'Approved. Installing, then carrying on.' : 'Skipped the install. Trying without it.');
  run._askResolve(a);
  return run;
}

/* ------------------------------------------------------------------ *
 * Saying what an install will do, before it does it
 * ------------------------------------------------------------------ */

function listedPackages(cwd, step, svc) {
  const argv = step.def.argv || [];
  if (svc.kind === 'node' && step.def.id === 'install') {
    const pkg = readJSON(path.join(cwd, 'package.json')) || {};
    return { deps: Object.keys(pkg.dependencies || {}), dev: Object.keys(pkg.devDependencies || {}) };
  }
  const r = argv.indexOf('-r');
  if (r !== -1) {
    const file = path.isAbsolute(argv[r + 1]) ? argv[r + 1] : path.join(cwd, argv[r + 1]);
    const names = (readText(file) || '').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim())
      .filter((l) => l && !l.startsWith('-')).map((l) => l.split(/[\s;=<>!~\[]/)[0]).filter(Boolean);
    return { deps: names, dev: [] };
  }
  if (argv.includes('-e')) {
    const t = readText(path.join(cwd, 'pyproject.toml')) || '';
    const block = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(t);
    const names = block ? [...block[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((m) => m[1]) : [];
    return { deps: names, dev: [] };
  }
  if (step.def.id === 'install' && svc.kind === 'ruby') {
    const names = [...(readText(path.join(cwd, 'Gemfile')) || '').matchAll(/^\s*gem\s+["']([\w.-]+)/gm)].map((m) => m[1]);
    return { deps: names, dev: [] };
  }
  return { deps: [], dev: [] };
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many || one + 's'}`; }

/**
 * Everything the question shows about one install: the state it is fixing,
 * what it will download and where it puts it, whether anything outside the
 * project changes, and how to undo it.
 */
function describeInstall(run, step) {
  const svc = serviceOf(run, step) || {};
  const cwd = step.cwd;
  const where = svc.dir ? `${svc.dir}/` : 'the project folder';
  const id = step.def.id;
  const item = { key: step.key, title: step.label, command: step.display, service: svc.dir || svc.name || '',
    now: step.why || null, does: [], scope: 'project', undo: null, packages: [], count: 0 };
  if (run._lastFailure && (step._declined || step.why === 'added by troubleshooting')) item.now = `You skipped this before, and then it failed: ${run._lastFailure}.`;
  const venv = svc.venvName || '.venv';

  if (id === 'install-tool') {
    item.scope = 'machine';
    if (step.def.via === 'brew') {
      const formula = step.def.argv.slice(2).join(' ');
      const prefix = (which('brew') || '').replace(/\/bin\/brew$/, '') || 'Homebrew\'s folder';
      item.now = `\`${step.def.tool}\` is not installed on this Mac, so the project cannot start.`;
      item.does = [`Homebrew downloads ${formula} and installs it under ${prefix}.`,
        `It is then on this Mac for every project and terminal, not only this one.`,
        'Usually takes a minute or two. Its progress shows in the log.'];
      item.undo = `brew uninstall ${formula.replace(/^--cask\s+/, '')}`;
    } else {
      item.now = 'The C compiler and build tools Apple ships separately are not installed.';
      item.does = ["macOS opens its own installer for the Command Line Tools (compilers, make, git), about 1 GB.",
        'Finish it in that window, then press Run again.'];
    }
    return item;
  }
  if (id === 'venv' || /^Rebuild /.test(step.label)) {
    let pv = '';
    try { pv = String(spawnSync(which('python3') || 'python3', ['--version'], { encoding: 'utf8', timeout: 3000 }).stdout || '').trim(); } catch { /* unknown */ }
    item.now = item.now || `There is no virtual environment for ${where} yet.`;
    item.does = [`Creates ${venv}/ with ${pv || 'python3'}: a private copy of Python just for this project.`,
      'Packages then install into it, never into your system Python.'];
    item.undo = `delete ${venv}/`;
    return item;
  }
  if (/^pip:/.test(id)) {
    const pkg = id.slice(4);
    item.packages = [pkg];
    item.count = 1;
    item.now = run._lastFailure ? `It failed: ${run._lastFailure}.` : item.now;
    item.does = [`pip downloads ${pkg} from PyPI and installs it into ${venv}/.`,
      `It is not in the project's requirements, so add it there if this fixes it.`];
    item.undo = `${venv}/bin/pip uninstall ${pkg}`;
    return item;
  }
  if (id === 'jupyter-install') {
    item.packages = ['jupyterlab'];
    item.count = 1;
    item.now = 'JupyterLab is not installed in this project, and the notebooks need it to open.';
    item.does = [`pip installs JupyterLab and its dependencies (roughly 100 MB) into ${venv}/.`];
    item.undo = `delete ${venv}/ or uninstall jupyterlab from it`;
    return item;
  }
  const { deps, dev } = listedPackages(cwd, step, svc);
  item.packages = deps.concat(dev).slice(0, 40);
  item.count = deps.length + dev.length;
  if (svc.kind === 'node') {
    const lock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].find((f) => exists(path.join(cwd, f)));
    item.does = [`${svc.pm || 'npm'} downloads the ${plural(item.count, 'package')} package.json lists${dev.length ? ` (${deps.length} for the app, ${dev.length} for development)` : ''}, plus what they depend on, from the npm registry.`,
      `They go into ${where === 'the project folder' ? '' : where}node_modules/. Nothing outside ${where} changes.`,
      lock ? `Versions come from ${lock}, so you get exactly what the author had.` : 'There is no lockfile, so it takes the newest versions package.json allows and writes one.'];
    if ((step.def.argv || []).includes('--legacy-peer-deps')) item.does.push('It uses --legacy-peer-deps, because a strict install refused a version conflict between packages.');
    item.undo = `delete ${where === 'the project folder' ? '' : where}node_modules/`;
  } else if (svc.kind === 'python') {
    const r = (step.def.argv || []).indexOf('-r');
    const src = r !== -1 ? path.basename(String(step.def.argv[r + 1])) : 'pyproject.toml';
    item.does = [`pip downloads the ${plural(item.count, 'package')} ${step.def.loosened ? 'from requirements.txt' : 'listed in ' + src}, with their own dependencies, from PyPI.`,
      `They go into ${venv}/. Your system Python and other projects are not touched.`];
    if (step.def.loosened) item.does.push('The pinned versions would not install on this Python, so this takes the newest version of each instead. requirements.txt itself is not changed.');
    if ((step.def.argv || []).includes('-e')) item.does.push('The project itself is installed in editable mode, so its own commands work and your edits apply without reinstalling.');
    item.undo = `delete ${venv}/`;
  } else if (svc.kind === 'ruby') {
    item.scope = 'machine';
    item.does = [`Bundler installs the ${plural(item.count, 'gem')} the Gemfile lists that are missing.`,
      "They go into your Ruby's gem folder, which other Ruby projects on this Mac share."];
  } else if (svc.kind === 'flutter') {
    item.scope = 'machine';
    item.does = ["Flutter downloads the packages pubspec.yaml lists into its shared cache (~/.pub-cache), and links them into the project."];
  } else {
    item.does = [`Runs \`${step.display}\` in ${where}.`];
  }
  return item;
}

function sourceName(run, step) { return run.plan.services.length > 1 ? step.serviceName : ''; }

function runSetupStep(run, step) {
  return new Promise((resolve) => {
    step.state = 'running';
    step.startedAt = Date.now();
    step.exitCode = null;
    step._fromLine = run._lineSeq;
    scheduleState(run);
    const src = sourceName(run, step);
    sys(run, src, `$ ${step.display}`);

    if (step.def.builtin === 'copy') {
      try {
        fs.copyFileSync(path.join(step.cwd, step.def.from), path.join(step.cwd, step.def.to), fs.constants.COPYFILE_EXCL);
        sys(run, src, `Copied ${step.def.from} to ${step.def.to}.`);
        step.state = 'done';
      } catch (err) {
        if (err && err.code === 'EEXIST') { sys(run, src, `${step.def.to} already exists, left as it is.`); step.state = 'done'; }
        else { sys(run, src, `Could not copy: ${err && err.message}`); step.state = 'failed'; }
      }
      step.endedAt = Date.now();
      scheduleState(run);
      return resolve(step.state === 'done');
    }

    const child = spawnStep(run, step, (code, signal, spawnErr) => {
      clearTimeout(timer);
      step.endedAt = Date.now();
      step.exitCode = code;
      step._spawnError = spawnErr || null;
      flushCarry(run, src);
      if (run._stopping) { step.state = 'stopped'; scheduleState(run); return resolve(false); }
      if (code === 0 && !spawnErr) {
        step.state = 'done';
        if (step.def.touch) { try { fs.writeFileSync(step.def.touch, new Date().toISOString() + '\n'); } catch { /* stamp is a convenience */ } }
        if (step.def.id === 'install') run._installed.add(step.service);
        sys(run, src, `✓ ${step.label} (${((step.endedAt - step.startedAt) / 1000).toFixed(1)}s)`);
      } else {
        step.state = 'failed';
        sys(run, src, spawnErr ? `✗ could not start: ${spawnErr.message}` : `✗ ${step.label} exited with ${signal || 'code ' + code}`);
      }
      scheduleState(run);
      resolve(step.state === 'done');
    });
    const timer = setTimeout(() => {
      sys(run, src, `${step.label} took longer than ${SETUP_TIMEOUT_MS / 60000} minutes and was stopped.`);
      killChild(child, 'SIGTERM');
    }, SETUP_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
}

function spawnStep(run, step, onExit) {
  const src = sourceName(run, step);
  const dirs = searchDirs();
  const argv = step.def.argv;
  // `bin/rails` is relative to the project, not to wherever the server runs.
  const tool = argv[0].includes('/') && !path.isAbsolute(argv[0]) ? path.join(step.cwd, argv[0]) : argv[0];
  const exe = which(tool, dirs);
  if (!exe) {
    const err = Object.assign(new Error(`${argv[0]} is not installed`), { code: 'ENOENT' });
    setImmediate(() => onExit(null, null, err));
    return null;
  }
  let child;
  try {
    child = spawn(exe, argv.slice(1), {
      cwd: step.cwd,
      env: runEnv(step.def.env),
      // A start step can be typed into (programs that ask questions with
      // input()); setup steps never wait on a keyboard.
      stdio: [step.kind === 'start' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: !IS_WIN,              // its own process group, so Stop reaches the tree
      windowsHide: true,
      shell: IS_WIN && /\.(cmd|bat)$/i.test(exe),
    });
  } catch (err) {
    setImmediate(() => onExit(null, null, err));
    return null;
  }
  step.pid = child.pid || null;
  if (child.pid) { livePids.set(child.pid, { argv, cwd: step.cwd }); persistPids(); }
  run._children.set(step.key, child);
  let done = false;
  const end = (code, signal, err) => {
    if (done) return;
    done = true;
    run._children.delete(step.key);
    if (child.pid) { livePids.delete(child.pid); persistPids(); }
    onExit(code, signal, err);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => pushLog(run, src, c, 'out'));
  child.stderr.on('data', (c) => pushLog(run, src, c, 'err'));
  child.on('error', (err) => end(null, null, err));
  child.on('close', (code, signal) => end(code, signal, null));
  return child;
}

function killChild(child, signal) {
  if (!child || !child.pid) return;
  try { if (!IS_WIN) process.kill(-child.pid, signal); else child.kill(signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}

function launchStart(run, step) {
  step.state = 'running';
  step.startedAt = Date.now();
  step.endedAt = null;
  step.exitCode = null;
  step._fromLine = run._lineSeq;
  const src = sourceName(run, step);
  if (step.def.builtin === 'app-binary') {
    const exe = builtAppBinary(step.def.productsDir);
    if (!exe) {
      step.state = 'failed';
      step.endedAt = Date.now();
      sys(run, src, `✗ the build finished but no .app was found in ${step.def.productsDir}`);
      run._stopping = true;
      stopChildren(run);
      finish(run, 'failed', { title: 'The build produced no app', detail: 'Xcode reported success, but the Debug products folder has no .app in it. The scheme may build a library or a command-line tool.', needs: 'agent', step: step.label });
      return;
    }
    step.def = Object.assign({}, step.def, { argv: [exe] });
    step.display = displayArgv(step.def.argv, step.cwd);
  }
  if (step.def.builtin === 'app-bundle') {
    // Its executable, not `open X.app`: `open` returns at once, and then Stop
    // would have nothing to quit.
    const b = findBundles(step.cwd, step.def.appName)[0];
    const exe = b && bundleExecutable(b.path);
    if (!exe) return failStart(run, step, `${step.def.appName}.app was not found`, `No ${step.def.appName}.app with a runnable executable is in ${APP_BUNDLE_DIRS.filter(Boolean).join(', ')} or the project folder. The build script may put it somewhere else.`);
    step.def = Object.assign({}, step.def, { argv: [exe] });
    step.display = `open ${path.relative(step.cwd, b.path) || b.path}`;
  }
  if (step.def.builtin === 'ios-sim' && !step.def.ready) {
    sys(run, src, `$ ${step.label}`);
    scheduleState(run);
    prepareSimulator(run, step).then((ok) => { if (ok && !run._stopping) launchStart(run, step); })
      .catch((err) => failStart(run, step, 'The Simulator could not be prepared', String((err && err.message) || err)));
    return;
  }
  sys(run, src, `$ ${step.display}`);
  scheduleState(run);
  watchPort(run, step);
  spawnStep(run, step, async (code, signal, spawnErr) => {
    step.endedAt = Date.now();
    step.exitCode = code;
    step._spawnError = spawnErr || null;
    flushCarry(run, src);
    if (run._stopping) { step.state = 'stopped'; return settleIfAllDone(run); }
    if (code === 0 && !spawnErr) {
      step.state = 'done';
      sys(run, src, step.def.opensApp ? `✓ opened.` : `✓ ${step.label} finished.`);
      return settleIfAllDone(run);
    }
    step.state = 'failed';
    sys(run, src, spawnErr ? `✗ could not start: ${spawnErr.message}` : `✗ ${step.label} exited with ${signal || 'code ' + code}`);
    scheduleState(run);
    const retry = await troubleshoot(run, step);
    if (retry === 'retry' && !run._stopping) {
      // Any setup the fix inserted runs first, then this start again.
      let s;
      while (!run._stopping && (s = run.steps.find((x) => x.kind === 'setup' && x.state === 'pending'))) {
        const r = await gatedSetup(run, s);
        if (run._stopping || r === 'stop') break;
        if (r === 'failed' && await troubleshoot(run, s) !== 'retry') return;
      }
      if (run._stopping) return finish(run, 'stopped');
      launchStart(run, step);
    }
  });
}

function failStart(run, step, title, detail) {
  step.state = 'failed';
  step.endedAt = Date.now();
  sys(run, sourceName(run, step), `✗ ${title}`);
  run._stopping = true;
  stopChildren(run);
  finish(run, 'failed', { title, detail, needs: 'agent', step: step.label });
}

/**
 * The iOS app it just built, into a Simulator: pick an iPhone (one already
 * booted, else the first available), boot it, bring the Simulator window up,
 * install, and turn the start step into `simctl launch --console-pty`, which
 * stays attached and streams the app's output, so Stop ends it.
 */
async function prepareSimulator(run, step) {
  const src = sourceName(run, step);
  let apps = [];
  try { apps = fs.readdirSync(step.def.productsDir).filter((f) => f.endsWith('.app')); } catch { /* none */ }
  const app = apps.map((f) => path.join(step.def.productsDir, f)).find((p) => exists(path.join(p, 'Info.plist')));
  if (!app) { failStart(run, step, 'The build produced no app', `Xcode reported success, but ${step.def.productsDir} has no .app in it.`); return false; }
  const plist = readText(path.join(app, 'Info.plist')) || '';
  let bundleId = (/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist) || [])[1];
  if (!bundleId) {
    // A built Info.plist is usually binary; plutil reads either kind.
    const r = await quiet(run, step, ['plutil', '-extract', 'CFBundleIdentifier', 'raw', path.join(app, 'Info.plist')], 5000, true);
    bundleId = r.code === 0 ? r.out.trim() : null;
  }
  if (!bundleId) { failStart(run, step, 'The app has no bundle identifier', `Could not read CFBundleIdentifier from ${path.basename(app)}/Info.plist.`); return false; }

  const list = await quiet(run, step, ['xcrun', 'simctl', 'list', 'devices', 'available', '-j'], 30000, true);
  let devices = [];
  try {
    const j = JSON.parse(list.out);
    devices = Object.entries(j.devices || {}).filter(([rt]) => /iOS/i.test(rt)).flatMap(([, d]) => d);
  } catch { /* no simulators, or no Xcode */ }
  const dev = devices.find((d) => d.state === 'Booted' && /iPhone/.test(d.name)) || devices.find((d) => /iPhone/.test(d.name) && !/Pro Max|Plus/.test(d.name)) || devices[0];
  if (!dev) {
    failStart(run, step, 'There is no iOS Simulator to run it in', 'Xcode has no iPhone simulators installed. Open Xcode, go to Settings, Components, and download an iOS Simulator runtime, then Run again.');
    run.diagnosis.needs = 'you';
    run.diagnosis.why = 'The Simulator runtime is a multi-gigabyte download that only Xcode can install.';
    scheduleState(run);
    return false;
  }
  if (dev.state !== 'Booted') {
    sys(run, src, `Starting the ${dev.name} simulator…`);
    await quiet(run, step, ['xcrun', 'simctl', 'boot', dev.udid], 120000, true);
  }
  await quiet(run, step, ['open', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', dev.udid], 15000, true);
  if (run._stopping) return false;
  sys(run, src, `Installing ${path.basename(app)} on ${dev.name}…`);
  const inst = await quiet(run, step, ['xcrun', 'simctl', 'install', dev.udid, app], 120000);
  if (inst.code !== 0) { failStart(run, step, 'The app would not install in the Simulator', `\`simctl install\` exited with ${inst.code}. Its output is above.`); return false; }
  step.def = Object.assign({}, step.def, { ready: true,
    argv: ['xcrun', 'simctl', 'launch', '--console-pty', '--terminate-running-process', dev.udid, bundleId],
    onStop: ['xcrun', 'simctl', 'terminate', dev.udid, bundleId] });
  step.display = `simctl launch ${dev.name} ${bundleId}`;
  return true;
}

/** The executable inside the first .app a build produced, or null. */
function builtAppBinary(productsDir) {
  let apps = [];
  try { apps = fs.readdirSync(productsDir).filter((f) => f.endsWith('.app')); } catch { return null; }
  for (const app of apps) {
    const plist = readText(path.join(productsDir, app, 'Contents', 'Info.plist')) || '';
    const named = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    const dir = path.join(productsDir, app, 'Contents', 'MacOS');
    const exe = named ? path.join(dir, named[1]) : (() => { try { return path.join(dir, fs.readdirSync(dir)[0]); } catch { return null; } })();
    if (exe && isExecutable(exe)) return exe;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Readiness: "running" means it answers, not that it printed an address
 * ------------------------------------------------------------------ */

let opener = null;
/** server.js hands in how to open a page on this machine; tests leave it unset. */
function setOpener(fn) { opener = typeof fn === 'function' ? fn : null; }

function localUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    return ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname) ? x.toString() : null;
  } catch { return null; }
}

function probe(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    let req;
    try {
      req = lib.get(url, { timeout: 1500, rejectUnauthorized: false }, (res) => { res.resume(); resolve(true); });
    } catch { return resolve(false); }
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Watch an address until it answers, then mark the run ready and (if asked)
 * open it once. A watcher gives up the moment its address is no longer the
 * run's, so the busy port another server holds is never mistaken for ours.
 */
function watchReady(run, url) {
  const u = localUrl(url);
  if (!u || run._watching === u) return;
  run._watching = u;
  const until = Date.now() + 120000;
  const tick = async () => {
    if (isTerminal(run.state) || run._watching !== u || !run.urls.includes(url)) return;
    if (await probe(u)) {
      if (isTerminal(run.state) || run._watching !== u) return;
      run.readyUrl = url;
      if (run.openOnReady && !run.opened && opener) {
        run.opened = true;
        try { opener(u); sys(run, '', `Opened ${url} in your browser.`); } catch { /* opening is a convenience */ }
      }
      scheduleState(run);
      return;
    }
    if (Date.now() < until) { const t = setTimeout(tick, 600); if (t.unref) t.unref(); }
  };
  tick();
}

/**
 * Some servers never print their address. If the start command's port was
 * free before launch and starts answering after, that is this app.
 */
async function watchPort(run, step) {
  const port = Number(step.def.portHint);
  if (!port || step.def.opensWindow) return;
  if (await portInUse(port)) return;          // someone else's: never claim it
  const runId = run.id;
  const until = Date.now() + 120000;
  while (Date.now() < until && !isTerminal(run.state) && step.state === 'running' && run.id === runId) {
    if (run.urls.length) return;
    if (await portInUse(port)) {
      if (!run.urls.length) { run.urls.push(`http://localhost:${port}/`); scheduleState(run); watchReady(run, run.urls[0]); }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function settleIfAllDone(run) {
  const starts = run.steps.filter((s) => s.kind === 'start');
  if (starts.some((s) => s.state === 'running' || s.state === 'pending')) return scheduleState(run);
  if (run._stopping) return finish(run, 'stopped');
  if (starts.every((s) => s.state === 'done')) return finish(run, 'done');
  return finish(run, 'failed', run.diagnosis);
}

/**
 * A step failed. Read its output for a known cause; if the cause has a cure
 * that has not been tried this run, apply it and return 'retry'. Otherwise end
 * the run with the diagnosis, so the person sees what was wrong rather than a
 * bare exit code.
 */
async function troubleshoot(run, step) {
  const svc = serviceOf(run, step);
  // Only this step's own output: an install's harmless ERESOLVE warning must
  // not be read as the reason the dev server died later.
  const src = sourceName(run, step);
  const tail = run.log.filter((e) => e.n > (step._fromLine || 0) && e.t !== 'sys' && e.s === src)
    .slice(-200).map((e) => e.l).join('\n');
  const d = diagnose(tail, { step: step.def, service: svc, spawnError: step._spawnError, installedThisRun: run._installed.has(step.service), cwd: step.cwd, root: run.projectPath });

  if (d && d.fix && !run._applied.has(d.key) && run.fixes.length < MAX_AUTO_FIXES) {
    run._applied.add(d.key);
    run._lastFailure = d.title;
    const action = await applyFix(run, step, svc, d.fix);
    if (action) {
      run.fixes.push({ title: d.title, action, at: toISO(Date.now()) });
      sys(run, sourceName(run, step), `⚙ Troubleshooting: ${d.title}. ${action}`);
      scheduleState(run);
      return 'retry';
    }
  }

  // The cure was already tried and the same failure came back: say that,
  // rather than recommending the thing that just did not work.
  const tried = Boolean(d && d.fix && run._applied.has(d.key));
  if (d && d.cure && !tried) d.detail = `${d.detail} ${d.cure}`;
  if (tried) {
    d.detail = d.ifStill ? d.detail : `${d.detail} Run already tried the usual fix once and it did not help.`;
    d.hint = d.ifStill || d.hint || null;
  }
  const base = d || {
    title: `${step.label} failed`,
    detail: step.exitCode != null ? `It exited with code ${step.exitCode}. The last lines of output are above.` : 'It stopped unexpectedly.',
  };
  // Who has to act now, said plainly: a click, the person (only for things
  // nobody else can know), or an agent that edits the project and re-runs it.
  const needs = (tried || (d && d.fix && !run.fixes.some((f) => f.title === d.title)) ? base.needsIfStill : null) || base.needs || 'agent';
  if (needs === 'you' && !base.why && base.whyIfStill) base.why = base.whyIfStill;
  run.diagnosis = { title: base.title, detail: base.detail, hint: base.hint || null, step: step.label,
    needs, why: base.why || null, install: base.install || null, key: base.key || null };
  // Anything else still running belongs to a run that is no longer going to
  // work. Marked as stopping first, so their exits are not diagnosed in turn.
  run._stopping = true;
  stopChildren(run);
  finish(run, 'failed', run.diagnosis);
  return 'stop';
}

async function applyFix(run, step, svc, fix) {
  if (fix.type === 'port') {
    const port = await freePort(Number(fix.port || step.def.portHint || 3000) + 1);
    run.urls = [];   // whatever the failed attempt printed is not where it is now
    run._watching = null;
    run.readyUrl = null;
    step.def = withPort(step.def, port);
    step.display = displayArgv(step.def.argv, step.cwd);
    return `Moving it to port ${port}, which is free.`;
  }
  if (fix.type === 'install-flag') {
    step.def = Object.assign({}, step.def, { argv: step.def.argv.concat([fix.flag]) });
    step.display = displayArgv(step.def.argv, step.cwd);
    step.state = 'pending';
    return `Retrying the install with ${fix.flag}.`;
  }
  if (fix.type === 'install' && svc && svc.installStep) {
    const existing = run.steps.find((s) => s.service === svc.id && s.kind === 'setup' && s.def.id === 'install');
    if (existing) { existing.state = 'pending'; if (existing._declined) existing._approved = false; }
    else insertBefore(run, step, stepRecord(run, svc, Object.assign({ why: 'added by troubleshooting' }, svc.installStep), 'setup'));
    return 'Installing the dependencies, then trying again.';
  }
  if (fix.type === 'pip' && svc && svc.python && exists(svc.python)) {
    insertBefore(run, step, stepRecord(run, svc, {
      id: 'pip:' + fix.pkg, label: `Install ${fix.pkg}`, argv: [svc.python, '-m', 'pip', 'install', fix.pkg], why: 'added by troubleshooting', consent: true,
    }, 'setup'));
    return `Installing ${fix.pkg} into the virtualenv, then trying again.`;
  }
  if (fix.type === 'loosen-pins') {
    const i = step.def.argv.indexOf('-r');
    const reqFile = path.join(step.cwd, step.def.argv[i + 1]);
    const text = readText(reqFile);
    if (!text) return null;
    // Same packages, no version pins, written beside nothing in the project:
    // requirements.txt itself is left exactly as it was.
    const loose = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim())
      .filter((l) => l && !l.startsWith('-'))
      .map((l) => l.split(';')[0].replace(/\s*(===|==|~=|<=|>=|<|>|!=).*$/, '').trim())
      .filter(Boolean);
    if (!loose.length) return null;
    const tmp = path.join(os.tmpdir(), `ground-control-requirements-${Date.now().toString(36)}.txt`);
    try { fs.writeFileSync(tmp, loose.join('\n') + '\n'); } catch { return null; }
    const argv = step.def.argv.slice();
    argv[i + 1] = tmp;
    step.def = Object.assign({}, step.def, { argv, loosened: true });
    step.display = displayArgv(argv, step.cwd);
    step.state = 'pending';
    step._approved = false;   // a different install from the one you said yes to
    return 'Installing the newest versions that work on this Python instead. requirements.txt is unchanged; update its pins once the project runs.';
  }
  if (fix.type === 'chmod') {
    try { fs.chmodSync(fix.file, fs.statSync(fix.file).mode | 0o111); } catch { return null; }
    return `Made ${path.relative(run.projectPath, fix.file) || fix.file} executable, then trying again.`;
  }
  if (fix.type === 'rebuild-venv' && svc && svc.venvName) {
    // Moved aside, not deleted: nothing in this codebase deletes your files.
    const dir = path.join(step.cwd, svc.venvName);
    const aside = `${dir}.broken-${Date.now().toString(36)}`;
    try { if (exists(dir)) fs.renameSync(dir, aside); } catch { return null; }
    insertBefore(run, step, stepRecord(run, svc, { id: 'venv', label: `Rebuild ${svc.venvName}/`, argv: ['python3', '-m', 'venv', svc.venvName], why: 'the old environment points at a Python that is gone', consent: true }, 'setup'));
    if (svc.installStep) insertBefore(run, step, stepRecord(run, svc, Object.assign({ why: 'added by troubleshooting' }, svc.installStep), 'setup'));
    return `Moved the broken environment to ${path.basename(aside)} and building a fresh one.`;
  }
  if (fix.type === 'start-docker') {
    sys(run, sourceName(run, step), '$ open -a Docker');
    const opened = await quiet(run, step, ['open', '-a', 'Docker'], 15000);
    if (opened.code !== 0) return null;
    const up = await waitFor(async () => (await quiet(run, step, ['docker', 'info'], 10000, true)).code === 0, 120000, 3000);
    if (!up) return null;
    return 'Started Docker Desktop and waited for it to come up.';
  }
  if (fix.type === 'start-service') return startService(run, step, fix);
  return null;
}

/** Run a short helper command, its output in the log; resolves `{ code }`. */
function quiet(run, step, argv, timeoutMs, silent = false) {
  return new Promise((resolve) => {
    const exe = which(argv[0]);
    if (!exe) return resolve({ code: -1, out: '' });
    let out = '';
    let child;
    try { child = spawn(exe, argv.slice(1), { cwd: step.cwd, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve({ code: -1, out: '' }); }
    const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    const take = (c) => { out += c; if (!silent) pushLog(run, sourceName(run, step), c, 'out'); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', () => { clearTimeout(t); resolve({ code: -1, out }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

async function waitFor(check, totalMs, everyMs) {
  const until = Date.now() + totalMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

/**
 * Start a database the app expects, using only what is already on this
 * machine: a service in the project's own compose file, else a Homebrew
 * formula that is already installed. Nothing new is installed.
 */
async function startService(run, step, fix) {
  const IMAGE = { PostgreSQL: /postgres/, MySQL: /mysql|mariadb/, MongoDB: /mongo/, Redis: /redis/, RabbitMQ: /rabbitmq/, Elasticsearch: /elasticsearch/ };
  const FORMULA = { PostgreSQL: /^postgresql(@\d+)?$/, MySQL: /^(mysql|mariadb)(@[\d.]+)?$/, MongoDB: /^mongodb-community(@[\d.]+)?$/, Redis: /^redis$/, RabbitMQ: /^rabbitmq$/, Elasticsearch: /^elasticsearch(-full)?$/ };
  const src = sourceName(run, step);
  const portUp = () => (fix.port ? waitFor(() => portInUse(fix.port), 45000, 1000) : Promise.resolve(true));

  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'].map((f) => path.join(run.projectPath, f)).find(exists);
  if (compose && IMAGE[fix.name]) {
    const text = readText(compose) || '';
    // service name is the key whose block holds a matching image line
    const svcMatch = [...text.matchAll(/^ {2}([\w.-]+):\s*\n((?: {4,}.*\n?)*)/gm)].find((m) => IMAGE[fix.name].test((/image:\s*(\S+)/.exec(m[2]) || [])[1] || ''));
    if (svcMatch && which('docker')) {
      sys(run, src, `$ docker compose up -d ${svcMatch[1]}`);
      const r = await quiet(run, step, ['docker', 'compose', '-f', compose, 'up', '-d', svcMatch[1]], 180000);
      if (r.code === 0 && await portUp()) return `Started ${fix.name} from the project's compose file (service "${svcMatch[1]}").`;
    }
  }
  if (process.platform === 'darwin' && which('brew') && FORMULA[fix.name]) {
    const list = await quiet(run, step, ['brew', 'list', '--formula', '-1'], 30000, true);
    const formula = list.out.split(/\s+/).find((f) => FORMULA[fix.name].test(f));
    if (formula) {
      sys(run, src, `$ brew services start ${formula}`);
      const r = await quiet(run, step, ['brew', 'services', 'start', formula], 60000);
      if (r.code === 0 && await portUp()) return `Started ${fix.name} (${formula}) with Homebrew.`;
    }
  }
  return null;
}

function insertBefore(run, step, rec) {
  const i = run.steps.indexOf(step);
  run.steps.splice(i === -1 ? run.steps.length : i, 0, rec);
}

function stopChildren(run) {
  // An app in the Simulator outlives the process that launched it: quit it there too.
  for (const st of run.steps) {
    if (st.def && st.def.onStop && st.state === 'running') {
      const exe = which(st.def.onStop[0]);
      if (exe) { try { spawn(exe, st.def.onStop.slice(1), { stdio: 'ignore', detached: true }).unref(); } catch { /* best effort */ } }
    }
  }
  for (const child of run._children.values()) killChild(child, 'SIGTERM');
  const kids = [...run._children.values()];
  if (kids.length) {
    const t = setTimeout(() => { for (const c of kids) killChild(c, 'SIGKILL'); }, SIGKILL_GRACE_MS);
    if (t.unref) t.unref();
  }
}

let failureHook = null;
/** server.js: called once when a run that opted into the agent fails in a way an agent can work on. */
function setFailureHook(fn) { failureHook = typeof fn === 'function' ? fn : null; }

const agentStates = new Map();   // projectId -> what the fixing agent is doing
function setAgent(projectId, info) {
  if (info) agentStates.set(projectId, info); else agentStates.delete(projectId);
  const run = runs.get(projectId);
  if (run) scheduleState(run);
}

function finish(run, state, diagnosis) {
  if (isTerminal(run.state)) return;
  run.state = state;
  run.endedAt = Date.now();
  if (diagnosis) run.diagnosis = Object.assign({ needs: 'agent' }, diagnosis);
  if (state === 'failed' && run.autoAgent && failureHook && run.diagnosis && run.diagnosis.needs === 'agent') {
    setImmediate(() => { try { failureHook(run); } catch { /* the hook reports its own problems */ } });
  }
  for (const s of run.steps) if (s.state === 'pending') s.state = 'skipped';
  run.ask = null;
  sys(run, '', state === 'done' ? 'Finished.' : state === 'stopped' ? 'Stopped.' : 'Run failed.');
  scheduleState(run);
}

function stop(projectId, reason = 'stopped') {
  const run = runs.get(projectId);
  if (!run || isTerminal(run.state)) return run || null;
  run._stopping = true;
  sys(run, '', `Stopping (${reason})…`);
  if (run._askResolve) run._askResolve('stop');
  stopChildren(run);
  if (!run._children.size) finish(run, 'stopped');
  return run;
}

function stopAndWait(run, reason) {
  return new Promise((resolve) => {
    stop(run.projectId, reason);
    if (isTerminal(run.state)) return resolve();
    const off = subscribe(run.projectId, (event, r) => { if (isTerminal(r.state)) { off(); resolve(); } });
    const t = setTimeout(() => { off(); finish(run, 'stopped'); resolve(); }, SIGKILL_GRACE_MS + 1500);
    if (t.unref) t.unref();
  });
}

/** Shutdown hook: synchronous, because it runs on `exit` too. */
function stopAll() {
  for (const run of runs.values()) {
    if (isTerminal(run.state)) continue;
    run._stopping = true;
    for (const child of run._children.values()) killChild(child, 'SIGTERM');
  }
}

/* ------------------------------------------------------------------ *
 * JSON shapes
 * ------------------------------------------------------------------ */

function stepJSON(st, cwd) {
  return { id: st.id, label: st.label, why: st.why || null, consent: Boolean(st.consent),
    command: st.builtin === 'copy' ? `cp ${st.from} ${st.to}` : displayArgv(st.argv, cwd) };
}

function planJSON(plan) {
  return {
    ok: plan.ok,
    checks: plan.checks,
    services: plan.services.map((s) => ({
      id: s.id, name: s.name, dir: s.dir, stack: s.stack,
      setup: s.setup.map((st) => stepJSON(st, path.join(plan.projectPath, s.dir))),
      starts: s.starts.map((st) => ({ id: st.id, label: st.label, why: st.why || null,
        command: st.builtin ? st.label : displayArgv(st.argv, path.join(plan.projectPath, s.dir)), port: st.portHint || null,
        mode: modeOf(st, s), modeLabel: MODES[modeOf(st, s)],
        pre: (st.pre || []).map((p) => stepJSON(p, path.join(plan.projectPath, s.dir))) })),
      startIndex: s.startIndex,
    })),
  };
}

function toJSON(run, { withLog = false } = {}) {
  if (!run) return null;
  const out = {
    id: run.id, projectId: run.projectId, state: run.state,
    startedAt: toISO(run.startedAt), endedAt: run.endedAt ? toISO(run.endedAt) : null,
    urls: run.urls.slice(),
    readyUrl: run.readyUrl, opened: run.opened, openOnReady: run.openOnReady, autoInstall: run.autoInstall,
    ask: run.ask,
    canType: !isTerminal(run.state) && run.steps.some((s) => s.kind === 'start' && s.state === 'running'),
    agent: agentStates.get(run.projectId) || null,
    fixes: run.fixes.slice(),
    diagnosis: run.diagnosis,
    multi: run.plan.services.length > 1,
    plan: planJSON(run.plan),
    steps: run.steps.map((s) => ({
      key: s.key, service: s.serviceName, kind: s.kind, label: s.label, command: s.display,
      why: s.why, state: s.state, exitCode: s.exitCode, consent: Boolean(s.def.consent),
      mode: s.kind === 'start' ? modeOf(s.def) : null, declined: Boolean(s._declined),
      durationMs: s.startedAt ? (s.endedAt || Date.now()) - s.startedAt : null,
    })),
  };
  if (withLog) out.log = run.log.slice();
  return out;
}

/** The last stretch of output, for handing to a chat agent. */
function logTail(run, lines = 80) {
  if (!run) return '';
  return run.log.slice(-lines).map((e) => (e.s ? `[${e.s}] ` : '') + (e.t === 'sys' ? '» ' : '') + e.l).join('\n');
}

function _internals() { return { searchDirs, which, nodeInstallReason, makeTargets, portFromScript, portInUse, freePort, livePids, runs, detectXcode, derivedDataFor, builtAppBinary, localUrl, installerFor, detectMacBundle, findBundles, describeInstall }; }

export {
  MAX_RUNS,
  detectPlan, detectService, preflight, diagnose, withPort, stripAnsi,
  start, stop, stopAll, get, subscribe, toJSON, planJSON, logTail,
  setStoreFile, storePathFor, reapOrphans, isTerminal,
  setOpener, setFailureHook, setAgent, installerFor, sendInput, answer, MODES,
  _internals,
};
