/**
 * Ground Control Workbench: editor detection and launching (CONTRACT-WORKBENCH.md §2).
 *
 * Launching an editor executes a local application with a path the user chose
 * in a browser. That path is treated as hostile:
 *
 *   - `child_process.execFile` with an argv array, always. Never a shell string,
 *     never string interpolation into a command.
 *   - The caller (server.js) resolves the target through the same three gates as
 *     `/api/doc` (syntactic, post-`path.resolve`, post-`fs.realpath`) and this
 *     module re-checks containment against the caller's root before spawning, so
 *     a mistake upstream still cannot launch an editor outside the root.
 *   - Launch is fire-and-forget with a 5 s timeout: a wedged editor reports a
 *     readable error rather than hanging the request.
 *
 * Detection is a capability probe only (does this binary/app exist?) and is
 * cached for ~60 s so the UI stays fast.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DETECT_TTL_MS = 60_000;
const LAUNCH_TIMEOUT_MS = 5000;

const IS_DARWIN = process.platform === 'darwin';

/* ------------------------------------------------------------------ *
 * Probes
 * ------------------------------------------------------------------ */

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

/** First executable on PATH with this name, or null. No shell involved. */
function onPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

/**
 * `code` on PATH does not have to be VS Code: on this machine it is a symlink
 * into Cursor.app. A CLI shim is only accepted for an editor when it actually
 * resolves inside that editor's own bundle.
 */
function cliInsideBundle(name, bundleFragment) {
  const p = onPath(name);
  if (!p) return null;
  let real = p;
  try { real = fs.realpathSync(p); } catch { /* use the link itself */ }
  return real.includes(bundleFragment) ? p : null;
}

const VSCODE_APP = '/Applications/Visual Studio Code.app';
const VSCODE_BUNDLED_CLI = `${VSCODE_APP}/Contents/Resources/app/bin/code`;
const CURSOR_APP = '/Applications/Cursor.app';
const CURSOR_BUNDLED_CLI = `${CURSOR_APP}/Contents/Resources/app/bin/cursor`;
const XCODE_APP = '/Applications/Xcode.app';
const TERMINAL_APPS = [
  '/System/Applications/Utilities/Terminal.app',
  '/Applications/Utilities/Terminal.app',
];

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

let cache = null;   // { at, editors }

/**
 * Probe every supported editor.
 *
 * `Editor` = { id, name, kind: "cli"|"app", available, command, args }
 * plus two Ground Control extras the UI uses: `note` (why it is unavailable / how it
 * launches) and `needsTarget` (Xcode is only offered for a project that has an
 * Xcode target).
 */
function detectEditors(opts = {}) {
  if (!opts.fresh && cache && Date.now() - cache.at < DETECT_TTL_MS) return cache.editors;

  const editors = [];

  /* ---- VS Code -------------------------------------------------- */
  {
    const e = {
      id: 'vscode', name: 'VS Code', kind: 'cli', available: false,
      command: 'code', args: [], note: null, needsTarget: false, supportsGoto: true,
    };
    const bundled = isExecutable(VSCODE_BUNDLED_CLI) ? VSCODE_BUNDLED_CLI : null;
    const shim = cliInsideBundle('code', 'Visual Studio Code.app');
    const cli = bundled || shim;
    if (cli) {
      e.kind = 'cli'; e.command = cli; e.args = []; e.available = true;
      e.note = 'opens with the VS Code command line';
    } else if (IS_DARWIN && exists(VSCODE_APP)) {
      e.kind = 'app'; e.command = 'open'; e.args = ['-a', 'Visual Studio Code'];
      e.available = true; e.supportsGoto = false;
      e.note = 'opens the Visual Studio Code app';
    } else {
      e.note = 'Visual Studio Code was not found on this machine';
    }
    editors.push(e);
  }

  /* ---- Cursor --------------------------------------------------- */
  {
    const e = {
      id: 'cursor', name: 'Cursor', kind: 'app', available: false,
      command: 'open', args: ['-a', 'Cursor'], note: null, needsTarget: false, supportsGoto: false,
    };
    const cli = isExecutable(CURSOR_BUNDLED_CLI) ? CURSOR_BUNDLED_CLI : cliInsideBundle('cursor', 'Cursor.app');
    if (cli) {
      // The bundled CLI is preferred over `open -a` only because it supports
      // `-g <file>:<line>`, which the doc reader needs.
      e.kind = 'cli'; e.command = cli; e.args = []; e.available = true; e.supportsGoto = true;
      e.note = 'opens with the Cursor command line';
    } else if (IS_DARWIN && exists(CURSOR_APP)) {
      e.available = true;
      e.note = 'opens the Cursor app';
    } else {
      e.note = 'Cursor was not found on this machine';
    }
    editors.push(e);
  }

  /* ---- Xcode ---------------------------------------------------- */
  {
    const e = {
      id: 'xcode', name: 'Xcode', kind: 'app', available: false,
      command: 'open', args: ['-a', 'Xcode'], note: null, needsTarget: true, supportsGoto: false,
    };
    if (IS_DARWIN && exists(XCODE_APP)) {
      e.available = true;
      e.note = 'offered only for a project with an Xcode target';
    } else {
      e.note = 'Xcode was not found on this machine';
    }
    editors.push(e);
  }

  /* ---- Finder --------------------------------------------------- */
  editors.push({
    id: 'finder', name: 'Finder', kind: 'app', available: IS_DARWIN,
    command: 'open', args: [], needsTarget: false, supportsGoto: false,
    note: IS_DARWIN ? 'reveals the folder in Finder' : 'Finder is macOS only',
  });

  /* ---- Terminal ------------------------------------------------- */
  {
    const found = IS_DARWIN && TERMINAL_APPS.some(exists);
    editors.push({
      id: 'terminal', name: 'Terminal', kind: 'app', available: found,
      command: 'open', args: ['-a', 'Terminal'], needsTarget: false, supportsGoto: false,
      note: found ? 'opens a shell in the project directory' : 'Terminal was not found on this machine',
    });
  }

  cache = { at: Date.now(), editors };
  return editors;
}

function getEditor(id) {
  return detectEditors().find((e) => e.id === String(id)) || null;
}

/* ------------------------------------------------------------------ *
 * Xcode targets
 * ------------------------------------------------------------------ */

const XCODE_TARGET_RE = /\.(xcodeproj|xcworkspace)$/i;

/**
 * The file Xcode should actually open: a `.xcworkspace` if there is one, else a
 * `.xcodeproj`, else `Package.swift`. Root and one level down only. Returns an
 * absolute path or null.
 */
function xcodeTarget(projectPath) {
  const scan = (dir) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { ws: null, proj: null, pkg: null, dirs: [] }; }
    let ws = null, proj = null, pkg = null;
    const dirs = [];
    for (const d of list) {
      const nm = d.name;
      if (nm.startsWith('.')) continue;
      const abs = path.join(dir, nm);
      if (XCODE_TARGET_RE.test(nm)) {
        if (/\.xcworkspace$/i.test(nm)) { if (!ws) ws = abs; }
        else if (!proj) proj = abs;
      } else if (nm === 'Package.swift') {
        if (!pkg) pkg = abs;
      } else if (d.isDirectory() && nm !== 'node_modules' && nm !== 'Pods') {
        dirs.push(abs);
      }
    }
    return { ws, proj, pkg, dirs };
  };

  const top = scan(projectPath);
  if (top.ws) return top.ws;
  if (top.proj) return top.proj;
  for (const sub of top.dirs.slice(0, 60)) {
    const s = scan(sub);
    if (s.ws) return s.ws;
    if (s.proj) return s.proj;
  }
  if (top.pkg) return top.pkg;
  return null;
}

/* ------------------------------------------------------------------ *
 * Launching
 * ------------------------------------------------------------------ */

/** Absolute, no NUL, and inside `root` (compared post-realpath as well). */
function insideRoot(abs, root) {
  if (typeof abs !== 'string' || !abs || abs.indexOf('\0') !== -1) return false;
  if (!path.isAbsolute(abs)) return false;
  const resolved = path.resolve(abs);
  const rootResolved = path.resolve(root);
  const ok = (a, b) => a === b || a.startsWith(b + path.sep);
  if (!ok(resolved, rootResolved)) return false;
  let realRoot = rootResolved, realTarget = resolved;
  try { realRoot = fs.realpathSync(rootResolved); } catch { /* keep */ }
  try { realTarget = fs.realpathSync(resolved); } catch {
    try { realTarget = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch { /* keep */ }
  }
  return ok(realTarget, realRoot);
}

/** execFile with an argv array and a hard timeout. Never throws. */
function spawnOnce(command, args, timeout = LAUNCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = execFile(
        command, args,
        { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) return done({ ok: true });
          if (err.killed || err.signal === 'SIGTERM') {
            return done({ ok: false, error: 'the editor did not respond within 5 seconds' });
          }
          if (err.code === 'ENOENT') {
            return done({ ok: false, error: `“${command}” is not installed on this machine` });
          }
          const detail = String(stderr || err.message || '').trim().split('\n')[0].slice(0, 200);
          return done({ ok: false, error: detail || 'the editor could not be launched' });
        },
      );
    } catch (err) {
      return done({ ok: false, error: String((err && err.message) || err).slice(0, 200) });
    }
    child.on('error', (err) => done({ ok: false, error: String((err && err.message) || err).slice(0, 200) }));
  });
}

/**
 * Open `absPath` (a project directory) in `editorId`.
 *
 * `opts`:
 *   root: REQUIRED. Every target must resolve inside this directory.
 *   file: absolute path of a file inside the project to open instead.
 *   line: 1-based line to jump to (VS Code / Cursor `-g <file>:<line>`).
 *
 * Resolves `{ ok, error?, opened?, editor?, status? }`. `status` is the HTTP
 * status the caller should use for a failure.
 */
async function openIn(editorId, absPath, opts = {}) {
  const editor = getEditor(editorId);
  if (!editor) return { ok: false, status: 404, error: 'unknown editor' };
  if (!editor.available) {
    return { ok: false, status: 409, error: `${editor.name} is not available on this machine` };
  }

  const root = opts.root;
  if (typeof root !== 'string' || !root) {
    return { ok: false, status: 500, error: 'no scan root was supplied' };
  }
  if (!insideRoot(absPath, root)) {
    return { ok: false, status: 403, error: 'forbidden path' };
  }

  // What actually gets handed to the editor.
  let target = absPath;
  let file = null;
  if (typeof opts.file === 'string' && opts.file) {
    if (!insideRoot(opts.file, root) || !insideRoot(opts.file, absPath)) {
      return { ok: false, status: 403, error: 'forbidden path' };
    }
    file = opts.file;
    target = opts.file;
  }

  if (editor.id === 'xcode') {
    const t = xcodeTarget(absPath);
    if (!t) {
      return {
        ok: false, status: 409,
        error: 'this project has no .xcodeproj, .xcworkspace or Package.swift for Xcode to open',
      };
    }
    if (!insideRoot(t, root)) return { ok: false, status: 403, error: 'forbidden path' };
    target = t;
    file = null;
  }

  const line = Number.isInteger(opts.line) && opts.line > 0 ? opts.line : null;

  /* ---- build the argv ------------------------------------------- */
  let command = editor.command;
  let args;

  if (editor.kind === 'cli') {
    args = editor.args.slice();
    if (file && line && editor.supportsGoto) args.push('-g', `${file}:${line}`);
    else args.push(target);
  } else if (editor.id === 'finder') {
    // `-R` reveals a file in its folder; a directory just opens.
    args = file ? ['-R', file] : [target];
  } else if (editor.id === 'terminal') {
    // A shell wants the directory, never the file.
    args = editor.args.concat([absPath]);
  } else {
    args = editor.args.concat([target]);
  }

  // Belt and braces: argv is a real array of strings, no shell anywhere.
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.indexOf('\0') !== -1)) {
    return { ok: false, status: 400, error: 'invalid launch arguments' };
  }

  const res = await spawnOnce(command, args);
  if (!res.ok) return { ok: false, status: 502, error: res.error };
  return { ok: true, opened: target, editor: editor.id };
}

/** Which editors make sense for one project (Xcode needs a target). */
function editorsForProject(projectPath) {
  const base = detectEditors();
  let hasXcode = false;
  try { hasXcode = Boolean(projectPath && xcodeTarget(projectPath)); } catch { hasXcode = false; }
  return base.map((e) => {
    if (e.id !== 'xcode') return Object.assign({}, e);
    return Object.assign({}, e, {
      available: e.available && hasXcode,
      note: !e.available ? e.note
        : hasXcode ? 'opens the Xcode project or workspace'
          : 'no .xcodeproj, .xcworkspace or Package.swift in this project',
    });
  });
}

export {
  detectEditors,
  editorsForProject,
  getEditor,
  openIn,
  xcodeTarget,
  insideRoot,
  DETECT_TTL_MS,
  LAUNCH_TIMEOUT_MS,
};
