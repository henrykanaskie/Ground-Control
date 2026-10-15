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
};

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
const NODE_NOT_A_START = /^(pre|post)|^(test|lint|format|fmt|prettier|typecheck|check|clean|prepare|release|publish|deploy|build)(:|$)/;

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

function detectNode(dir) {
  const pkg = readJSON(path.join(dir, 'package.json'));
  if (!pkg) return null;
  const pm = nodePackageManager(dir, pkg);
  const setup = [];
  const why = nodeInstallReason(dir, pkg);
  if (why) setup.push({ id: 'install', label: 'Install dependencies', argv: nodeInstallArgv(pm), why });

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
    });
  }
  if (!starts.length) {
    const main = [pkg.main, 'server.js', 'index.js', 'app.js', 'main.js', 'src/index.js']
      .find((f) => f && exists(path.join(dir, f)));
    if (main) starts.push({ id: 'main', label: `node ${main}`, argv: ['node', main], why: 'the package entry file' });
  }
  return { stack: `Node (${pm})`, kind: 'node', pm, setup, starts, installStep: { id: 'install', label: 'Install dependencies', argv: nodeInstallArgv(pm) } };
}

/** Packages whose import name is not their install name. */
const PY_MODULE_TO_PACKAGE = {
  cv2: 'opencv-python', PIL: 'Pillow', yaml: 'PyYAML', sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4', dotenv: 'python-dotenv', jwt: 'PyJWT', dateutil: 'python-dateutil',
  serial: 'pyserial', usb: 'pyusb', Crypto: 'pycryptodome', magic: 'python-magic',
  docx: 'python-docx', pptx: 'python-pptx', telegram: 'python-telegram-bot', discord: 'discord.py',
  google: 'google-api-python-client', attr: 'attrs', OpenSSL: 'pyOpenSSL', gi: 'PyGObject',
};

function detectPython(dir) {
  const has = (f) => exists(path.join(dir, f));
  const markers = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'manage.py',
    'main.py', 'app.py', 'run.py', 'server.py', 'bot.py', 'streamlit_app.py'];
  if (!markers.some(has)) return null;

  const venvName = ['.venv', 'venv', 'env'].find((v) => exists(venvPython(dir, v))) || '.venv';
  const py = venvPython(dir, venvName);
  const venvExists = exists(py);
  const stamp = path.join(dir, venvName, '.ground-control-installed');
  const setup = [];

  if (!venvExists) {
    setup.push({
      id: 'venv', label: `Create a virtual environment in ${venvName}/`,
      argv: ['python3', '-m', 'venv', venvName],
      why: 'so packages install for this project only, never into your system Python',
    });
  }

  let installStep = null;
  let installWhy = null;
  const reqFile = ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt'].find(has);
  const pyproject = readText(path.join(dir, 'pyproject.toml')) || '';
  if (reqFile) {
    installStep = { id: 'install', label: 'Install requirements', argv: [py, '-m', 'pip', 'install', '-r', reqFile], touch: stamp };
    if (!venvExists || !exists(stamp)) installWhy = 'the requirements have not been installed into the environment yet';
    else if (mtime(path.join(dir, reqFile)) > mtime(stamp)) installWhy = `${reqFile} changed since the last install`;
  } else if (has('setup.py') || (/^\s*\[build-system\]/m.test(pyproject) && /^\s*\[(?:project|tool\.poetry)\]/m.test(pyproject))) {
    installStep = { id: 'install', label: 'Install the project and its dependencies', argv: [py, '-m', 'pip', 'install', '-e', '.'], touch: stamp };
    if (!venvExists || !exists(stamp)) installWhy = 'the project has not been installed into the environment yet';
    else if (mtime(path.join(dir, 'pyproject.toml')) > mtime(stamp)) installWhy = 'pyproject.toml changed since the last install';
  }
  if (installStep && installWhy) setup.push(Object.assign({}, installStep, { why: installWhy }));

  const starts = [];
  if (has('manage.py')) {
    starts.push({ id: 'django', label: 'python manage.py runserver', argv: [py, 'manage.py', 'runserver'], why: 'a Django project', portHint: 8000, portFlag: 'django' });
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
      starts.push({ id: 'streamlit:' + f, label: `streamlit run ${f}`, argv: [py, '-m', 'streamlit', 'run', f], why: 'a Streamlit app', portHint: 8501, portFlag: 'streamlit' });
      continue;
    }
    const fastapi = /^(\w+)\s*=\s*FastAPI\(/m.exec(src);
    if (fastapi && !/uvicorn\.run\(/.test(src)) {
      starts.push({ id: 'uvicorn:' + f, label: `uvicorn ${mod}:${fastapi[1]} --reload`, argv: [py, '-m', 'uvicorn', `${mod}:${fastapi[1]}`, '--reload'], why: 'a FastAPI app', portHint: 8000, portFlag: 'uvicorn' });
      continue;
    }
    const flask = /^(\w+)\s*=\s*Flask\(/m.exec(src);
    if (flask && !/\.run\(/.test(src)) {
      starts.push({ id: 'flask:' + f, label: `flask --app ${mod} run`, argv: [py, '-m', 'flask', '--app', mod, 'run'], why: 'a Flask app', portHint: 5000, portFlag: 'flask' });
      continue;
    }
    starts.push({ id: 'py:' + f, label: `python ${f}`, argv: [py, f], why: f === 'main.py' || f === 'app.py' ? 'the entry file' : 'a runnable file at the root', portHint: /\.run\(/.test(src) && /Flask\(/.test(src) ? 5000 : null });
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
  return { stack: 'Python', kind: 'python', python: py, venvName, setup, starts, installStep };
}

function detectSimple(dir) {
  const has = (f) => exists(path.join(dir, f));
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
    if (!starts.length) starts.push({ id: 'gobuild', label: 'go build ./...', argv: ['go', 'build', './...'], why: 'no main package found, so this only builds' });
    return { stack: 'Go', kind: 'go', setup: [], starts };
  }
  if (has('Package.swift')) {
    return { stack: 'Swift', kind: 'swift', setup: [], starts: [{ id: 'swift', label: 'swift run', argv: ['swift', 'run'], why: 'Swift Package Manager' }] };
  }
  if (has('deno.json') || has('deno.jsonc')) {
    const conf = readJSON(path.join(dir, 'deno.json')) || {};
    const tasks = Object.keys(conf.tasks || {});
    tasks.sort((a, b) => (NODE_START_PRIORITY.indexOf(a) + 100) % 100 - (NODE_START_PRIORITY.indexOf(b) + 100) % 100);
    const starts = tasks.map((t) => ({ id: 'deno:' + t, label: `deno task ${t}`, argv: ['deno', 'task', t], why: String(conf.tasks[t]).slice(0, 200) }));
    if (starts.length) return { stack: 'Deno', kind: 'deno', setup: [], starts };
  }
  if (has('Gemfile')) {
    const setup = [{ id: 'install', label: 'Install gems', argv: ['bundle', 'install'], why: 'Bundler checks the Gemfile and installs anything missing' }];
    const starts = [];
    if (has('bin/rails')) starts.push({ id: 'rails', label: 'bin/rails server', argv: ['bin/rails', 'server'], why: 'a Rails app', portHint: 3000, portFlag: 'rails' });
    else if (has('config.ru')) starts.push({ id: 'rackup', label: 'bundle exec rackup', argv: ['bundle', 'exec', 'rackup'], why: 'a Rack app' });
    for (const f of ['main.rb', 'app.rb']) if (has(f)) starts.push({ id: 'rb:' + f, label: `ruby ${f}`, argv: ['bundle', 'exec', 'ruby', f], why: 'the entry file' });
    if (starts.length) return { stack: 'Ruby', kind: 'ruby', setup, starts, installStep: setup[0] };
  }
  return null;
}

function makeTargets(dir) {
  const text = readText(path.join(dir, 'Makefile')) || readText(path.join(dir, 'makefile'));
  if (!text) return [];
  const found = new Set();
  for (const m of text.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)) found.add(m[1]);
  return ['run', 'dev', 'start', 'serve', 'up'].filter((t) => found.has(t));
}

/** One folder → one runnable service, or null. */
function detectService(dir) {
  // A package.json that only holds prettier must not hide the main.py beside
  // it, so the first detector that found a way to START the folder wins.
  const found = [detectNode, detectPython, detectSimple].map((f) => f(dir)).filter(Boolean);
  let svc = found.find((c) => c.starts.length) || found[0] || null;

  // A Makefile `run`/`dev` target is the author telling you how they run it.
  const targets = makeTargets(dir);
  if (targets.length) {
    const mk = targets.map((t) => ({ id: 'make:' + t, label: `make ${t}`, argv: ['make', t], why: 'a target in the Makefile' }));
    if (!svc) svc = { stack: 'Make', kind: 'make', setup: [], starts: mk };
    else if (svc.kind !== 'node') svc.starts = mk.concat(svc.starts);
    else svc.starts = svc.starts.concat(mk);
  }

  if (!svc || !svc.starts.length) {
    const xcode = (() => { try { return fs.readdirSync(dir).find((f) => /\.(xcworkspace|xcodeproj)$/.test(f)); } catch { return null; } })();
    if (xcode) {
      svc = { stack: 'Xcode', kind: 'xcode', setup: [], starts: [{ id: 'xcode', label: `open ${xcode}`, argv: ['open', xcode], why: 'an Xcode project builds and runs from Xcode itself', opensApp: true }] };
    }
  }

  if (!svc || !svc.starts.length) {
    if (exists(path.join(dir, 'docker-compose.yml')) || exists(path.join(dir, 'compose.yaml')) || exists(path.join(dir, 'docker-compose.yaml'))) {
      svc = { stack: 'Docker Compose', kind: 'docker', setup: [], starts: [{ id: 'compose', label: 'docker compose up', argv: ['docker', 'compose', 'up'], why: 'a Compose file' }] };
    }
  }

  if (!svc || !svc.starts.length) {
    if (exists(path.join(dir, 'index.html'))) {
      svc = { stack: 'Static site', kind: 'static', setup: [], starts: [{ id: 'static', label: 'python3 -m http.server 8000', argv: ['python3', '-m', 'http.server', '8000'], why: 'a plain index.html, served locally', portHint: 8000, portFlag: 'positional' }] };
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
      const svc = detectService(path.join(projectPath, s));
      // A static index.html in a docs/ folder is not the app.
      if (svc && svc.kind !== 'static' && svc.kind !== 'xcode') services.push(Object.assign({ name: s, dir: s }, svc));
      if (services.length >= 3) break;
    }
  }
  for (const s of services) { s.startIndex = 0; s.id = s.dir || '.'; }
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

/** Is something listening on this port on loopback? */
function portInUse(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
  });
}

function freePort(start = 3001) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(start + 1)));
    s.listen(start, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
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
    const steps = svc.setup.concat(svc.starts.length ? [svc.starts[svc.startIndex] || svc.starts[0]] : []);
    for (const step of steps) {
      if (!step.argv) continue;
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
      plan.checks.push({ level: 'error', text: `${prefix}\`${tool}\` is not installed (or not on any PATH Ground Control can see).`, hint: INSTALL_HINTS[tool] || null });
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
    return { key: 'missing:' + tool, title: `\`${tool}\` is not installed`, detail: `The step needs \`${tool}\` and it is not on any PATH Ground Control can see.`, hint: INSTALL_HINTS[tool] || null };
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

  if (/externally-managed-environment/.test(t)) {
    return { key: 'pep668', title: 'This Python refuses system-wide installs', detail: 'Packages have to go into a virtualenv. Delete the broken environment folder and press Run again so a fresh one is made.' };
  }
  if (/bad interpreter|No such file or directory.*\/(?:\.venv|venv)\/bin\/python/.test(t)) {
    return { key: 'venv-broken', title: 'The virtualenv points at a Python that no longer exists', detail: 'Usually Python was upgraded or moved after the environment was made.', hint: `Delete the ${svc.venvName || '.venv'} folder and press Run again: it is rebuilt from the requirements.` };
  }
  m = /The engine "node" is incompatible|requires (?:a )?Node(?:\.js)? (?:version )?([>=^~\d. ]+)|Unsupported engine/i.exec(t);
  if (m) {
    return { key: 'node-version', title: 'This project wants a different Node version', detail: m[0], hint: 'Install the version it asks for (nodejs.org, or `nvm install` in the project folder), then Run again.' };
  }
  if (/linker [`']cc[`'] not found|xcrun: error: invalid active developer path/.test(t)) {
    return { key: 'xcode-clt', title: 'The C toolchain is missing', detail: 'Compiling needs the Xcode Command Line Tools.', hint: 'Run `xcode-select --install`, then Run again.' };
  }
  if (/Cannot connect to the Docker daemon|docker daemon is not running|error during connect/i.test(t)) {
    return { key: 'docker-down', title: 'Docker is not running', detail: 'The Docker command is installed but its daemon is not up.', hint: 'Start Docker Desktop, wait for it to say it is running, then Run again.' };
  }
  m = /ECONNREFUSED[^\n]*?:(5432|3306|27017|6379|5672|9200)\b|connection to server .* port (5432)|Can't connect to MySQL server|Error: Redis connection to/i.exec(t);
  if (m) {
    const port = m[1] || m[2];
    const name = { 5432: 'PostgreSQL', 3306: 'MySQL', 27017: 'MongoDB', 6379: 'Redis', 5672: 'RabbitMQ', 9200: 'Elasticsearch' }[port] || 'a database';
    return { key: 'db-down', title: `The app can't reach ${name}`, detail: `It expects ${name} to be running${port ? ` on port ${port}` : ''} and nothing answered.`, hint: `Start ${name} (for example \`brew services start ${name.toLowerCase()}\`, or the project's docker compose file), then Run again.` };
  }
  m = /KeyError: '([A-Z][A-Z0-9_]+)'|Missing (?:required )?environment variable:? [`'"]?([A-Z][A-Z0-9_]+)|([A-Z][A-Z0-9_]+) (?:is not set|environment variable is (?:not set|required|missing))/.exec(t);
  if (m) {
    const v = m[1] || m[2] || m[3];
    return { key: 'env:' + v, title: `\`${v}\` is not set`, detail: `The app reads the environment variable \`${v}\` and it has no value.`, hint: `Add \`${v}=…\` to the project's .env file (or your shell profile), then Run again.` };
  }
  m = /(?:EACCES|Permission denied)[^\n]*?((?:\.\/|\/)[\w./-]+)/.exec(t);
  if (m) {
    return { key: 'perm', title: 'A file is not executable', detail: m[0], hint: `Run \`chmod +x ${m[1]}\` in the project folder, then Run again.` };
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
  // A prompt or a progress line without a newline still deserves to be seen.
  const rest = run._carry.get(carryKey);
  if (rest && rest.length > 400) { addLine(run, source, rest, stream); run._carry.set(carryKey, ''); }
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
      if (!run.urls.includes(u) && run.urls.length < 4) { run.urls.push(u); scheduleState(run); }
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

function scheduleState(run) { emit(run, 'state', toJSON(run)); }

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
async function start(project, { choices = {} } = {}) {
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
  await preflight(plan);

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

  for (const svc of plan.services) {
    for (const s of svc.setup) run.steps.push(stepRecord(run, svc, s, 'setup'));
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
    if (step.kind !== 'setup' || step.state === 'done') continue;
    if (run._stopping) return;
    const ok = await runSetupStep(run, step);
    if (run._stopping) return;
    if (!ok) {
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
  sys(run, src, `$ ${step.display}`);
  scheduleState(run);
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
        const ok = await runSetupStep(run, s);
        if (run._stopping) break;
        if (!ok && await troubleshoot(run, s) !== 'retry') return;
      }
      if (run._stopping) return finish(run, 'stopped');
      launchStart(run, step);
    }
  });
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
  const d = diagnose(tail, { step: step.def, service: svc, spawnError: step._spawnError, installedThisRun: run._installed.has(step.service) });

  if (d && d.fix && !run._applied.has(d.key) && run.fixes.length < MAX_AUTO_FIXES) {
    run._applied.add(d.key);
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
    hint: 'No known cause matched. "Ask an agent to fix it" hands this log to a chat agent in the project.',
  };
  run.diagnosis = { title: base.title, detail: base.detail, hint: base.hint || null, step: step.label };
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
    if (existing) existing.state = 'pending';
    else insertBefore(run, step, stepRecord(run, svc, Object.assign({ why: 'added by troubleshooting' }, svc.installStep), 'setup'));
    return 'Installing the dependencies, then trying again.';
  }
  if (fix.type === 'pip' && svc && svc.python && exists(svc.python)) {
    insertBefore(run, step, stepRecord(run, svc, {
      id: 'pip:' + fix.pkg, label: `Install ${fix.pkg}`, argv: [svc.python, '-m', 'pip', 'install', fix.pkg], why: 'added by troubleshooting',
    }, 'setup'));
    return `Installing ${fix.pkg} into the virtualenv, then trying again.`;
  }
  return null;
}

function insertBefore(run, step, rec) {
  const i = run.steps.indexOf(step);
  run.steps.splice(i === -1 ? run.steps.length : i, 0, rec);
}

function stopChildren(run) {
  for (const child of run._children.values()) killChild(child, 'SIGTERM');
  const kids = [...run._children.values()];
  if (kids.length) {
    const t = setTimeout(() => { for (const c of kids) killChild(c, 'SIGKILL'); }, SIGKILL_GRACE_MS);
    if (t.unref) t.unref();
  }
}

function finish(run, state, diagnosis) {
  if (isTerminal(run.state)) return;
  run.state = state;
  run.endedAt = Date.now();
  if (diagnosis) run.diagnosis = diagnosis;
  for (const s of run.steps) if (s.state === 'pending') s.state = 'skipped';
  sys(run, '', state === 'done' ? 'Finished.' : state === 'stopped' ? 'Stopped.' : 'Run failed.');
  scheduleState(run);
}

function stop(projectId, reason = 'stopped') {
  const run = runs.get(projectId);
  if (!run || isTerminal(run.state)) return run || null;
  run._stopping = true;
  sys(run, '', `Stopping (${reason})…`);
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

function planJSON(plan) {
  return {
    ok: plan.ok,
    checks: plan.checks,
    services: plan.services.map((s) => ({
      id: s.id, name: s.name, dir: s.dir, stack: s.stack,
      setup: s.setup.map((st) => ({ id: st.id, label: st.label, why: st.why || null,
        command: st.builtin === 'copy' ? `cp ${st.from} ${st.to}` : displayArgv(st.argv, path.join(plan.projectPath, s.dir)) })),
      starts: s.starts.map((st) => ({ id: st.id, label: st.label, why: st.why || null,
        command: displayArgv(st.argv, path.join(plan.projectPath, s.dir)), port: st.portHint || null })),
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
    fixes: run.fixes.slice(),
    diagnosis: run.diagnosis,
    multi: run.plan.services.length > 1,
    plan: planJSON(run.plan),
    steps: run.steps.map((s) => ({
      key: s.key, service: s.serviceName, kind: s.kind, label: s.label, command: s.display,
      why: s.why, state: s.state, exitCode: s.exitCode,
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

function _internals() { return { searchDirs, which, nodeInstallReason, makeTargets, portFromScript, livePids, runs }; }

export {
  MAX_RUNS,
  detectPlan, detectService, preflight, diagnose, withPort, stripAnsi,
  start, stop, stopAll, get, subscribe, toJSON, planJSON, logTail,
  setStoreFile, storePathFor, reapOrphans, isTerminal,
  _internals,
};
