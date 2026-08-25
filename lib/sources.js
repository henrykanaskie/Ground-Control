/**
 * Ground Control: the source registry (CONTRACT-SOURCES.md).
 *
 * A "source" is a folder Ground Control watches. There are two kinds:
 *
 *   root     a folder whose immediate children are projects
 *            (the original `~/coding_projects` behaviour)
 *   project  a single folder that IS one project, wherever it happens to live
 *
 * The registry is a small JSON file (by default `~/.ground-control/sources.json`),
 * so a folder added today is still there after a restart. Everything here is
 * defensive: a missing, unreadable or malformed config never stops the server,
 * it just falls back to the default root.
 *
 * Node stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

import { isIgnoredDir, slugify, uniqueSlug } from './util.js';

const CONFIG_VERSION = 1;

const KINDS = new Set(['root', 'project']);

/* ------------------------------------------------------------------ *
 * Where the registry lives
 * ------------------------------------------------------------------ */

function defaultConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.ground-control', 'sources.json');
}

/** The folder Ground Control watches when it has never been told otherwise. */
function defaultRoot(homeDir = os.homedir()) {
  return path.join(homeDir, 'coding_projects');
}

/* ------------------------------------------------------------------ *
 * Path normalisation
 * ------------------------------------------------------------------ */

/**
 * Turn whatever the user handed us into an absolute path, or null.
 *
 * Accepts: an absolute path, `~/…`, a `file://` URL (what a Finder drag puts
 * on the clipboard), a path wrapped in quotes, and a path with a trailing
 * slash. Rejects relative paths outright: the server has no business guessing
 * what they are relative to.
 */
function normalizePath(input, homeDir = os.homedir()) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (s.indexOf('\0') !== -1) return null;

  // Strip one layer of surrounding quotes (drag-and-drop and shell copies).
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }

  // file:///Users/x/dev  →  /Users/x/dev
  if (/^file:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.hostname && u.hostname !== 'localhost') return null;   // file://server/share
      s = decodeURIComponent(u.pathname);
    } catch { return null; }
  }

  // Shell-style escapes survive a copy-paste from Terminal: `/Users/x/my\ dev`.
  if (s.includes('\\ ')) s = s.replace(/\\ /g, ' ');

  if (s === '~') s = homeDir;
  else if (s.startsWith('~/')) s = path.join(homeDir, s.slice(2));

  if (!path.isAbsolute(s)) return null;

  const abs = path.resolve(s);
  return abs;
}

/**
 * Every `file://` URL in a dropped `text/uri-list` payload, in order.
 * Returns [] for anything else, so a stray text drop is simply ignored.
 */
function pathsFromUriList(text, homeDir = os.homedir()) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const abs = normalizePath(line, homeDir);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Folders we refuse to watch
 * ------------------------------------------------------------------ */

/**
 * Scanning one of these as a folder-of-projects walks tens of thousands of
 * directories and produces a dashboard full of noise. The refusal explains
 * itself rather than silently doing something slow.
 */
const SYSTEM_DIRS = new Set([
  '/', '/System', '/Library', '/Applications', '/Users', '/private', '/var',
  '/tmp', '/etc', '/bin', '/sbin', '/usr', '/opt', '/dev', '/Volumes', '/cores',
  '/Network', '/System/Volumes', '/System/Volumes/Data', '/home', '/net',
]);

function refusalFor(abs, kind, homeDir = os.homedir()) {
  const home = path.resolve(homeDir);
  if (SYSTEM_DIRS.has(abs)) {
    return `${abs} is a system folder. Pick a folder that holds your own work.`;
  }
  if (abs === home) {
    return 'That is your home folder; scanning all of it would pull in Library, Downloads and everything else. '
      + 'Pick the folder your projects actually live in.';
  }
  if (kind === 'root' && (abs === path.join(home, 'Library') || abs.startsWith(path.join(home, 'Library') + path.sep))) {
    return 'That is inside your Library folder, which holds application data rather than projects.';
  }
  const base = path.basename(abs);
  if (base && isIgnoredDir(base) && base !== '.github') {
    return `“${base}” is a build or dependency folder, not a project.`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Is this folder a project, or a folder of projects?
 * ------------------------------------------------------------------ */

const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod',
  'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Package.swift',
  'requirements.txt', 'Makefile', 'CMakeLists.txt', 'Dockerfile', 'CLAUDE.md',
  'AGENTS.md', 'composer.json', 'mix.exs', 'pubspec.yaml', 'Podfile',
];

const PROJECT_MARKER_EXT = new Set(['.xcodeproj', '.xcworkspace']);

/**
 * Directory names that belong to a project's insides, not to a shelf of
 * projects. A folder containing `src/` is a project with a source directory;
 * a folder of projects almost never has a child literally called `src`.
 */
const INSIDE_DIR_NAMES = new Set([
  'src', 'source', 'sources', 'lib', 'libs', 'app', 'apps', 'bin', 'test',
  'tests', '__tests__', 'spec', 'docs', 'doc', 'include', 'assets', 'public',
  'static', 'scripts', 'config', 'templates', 'migrations', 'components',
]);

/** Top-level files that say "this folder holds code" all by themselves. */
const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.swift', '.go', '.rs',
  '.rb', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm',
  '.cs', '.php', '.sh', '.lua', '.r', '.jl', '.dart', '.scala', '.ex', '.hs',
  '.vue', '.svelte', '.ipynb', '.sql',
]);

/**
 * Paths we never open, even to look. `/home` and `/net` are autofs mounts on
 * macOS: a plain `readdir` on them blocks while the automounter goes looking
 * for a server that may not exist, which is a hang, not a slow answer.
 */
const NEVER_READ = new Set([
  '/home', '/net', '/Network', '/.vol', '/dev', '/Volumes', '/cores',
  '/System/Volumes',
]);

/**
 * One listing, both answers: does this folder carry project markers of its
 * own, and which of its children would become cards if it were read as a
 * folder-of-projects. Both are needed whichever way the user reads it, and one
 * `readdir` is cheaper than two.
 */
function surveyDir(abs) {
  const empty = { markers: false, insideDirs: false, codeFiles: false, hasFiles: false, childDirs: [] };
  if (NEVER_READ.has(abs)) return empty;
  let list;
  try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch { return empty; }

  const out = { markers: false, insideDirs: false, codeFiles: false, hasFiles: false, childDirs: [] };
  for (const d of list) {
    const lower = d.name.toLowerCase();
    const ext = path.extname(lower);
    if (!out.markers && (PROJECT_MARKERS.includes(d.name) || PROJECT_MARKER_EXT.has(ext))) {
      out.markers = true;
    }
    if (d.name.startsWith('.') || isIgnoredDir(d.name)) continue;

    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(abs, d.name)).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) {
      out.childDirs.push(d.name);
      if (INSIDE_DIR_NAMES.has(lower)) out.insideDirs = true;
    } else {
      out.hasFiles = true;
      if (CODE_EXT.has(ext)) out.codeFiles = true;
    }
  }
  out.childDirs.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Does this directory look like one project in its own right? */
function looksLikeProject(abs) {
  return surveyDir(abs).markers;
}

/** Immediate child directories that would become project cards. */
function childProjectDirs(abs) {
  return surveyDir(abs).childDirs;
}

/**
 * Decide, from the folder itself, whether to treat it as one project or as a
 * folder of projects. The user can always override the guess, so `childDirs`
 * is reported either way; overriding a repo to "folder of projects" still has
 * to be able to say how many cards that would make.
 */
function detectKind(abs) {
  const s = surveyDir(abs);

  /* Four things say "this is one project", in falling order of confidence.
   * Everything else is read as a shelf of projects, which is the safe guess:
   * being shown too many cards is obvious and one click to undo, where being
   * shown one card for a folder of twelve projects hides them.
   *
   *   1. a build or repo marker: package.json, .git, Cargo.toml, an xcodeproj
   *   2. a child directory that belongs to a project's insides (src/, tests/)
   *   3. loose source files sitting at the top level
   *   4. no subdirectories at all: there is nothing here to contain
   */
  const project = s.markers || s.insideDirs || s.codeFiles || s.childDirs.length === 0;
  return { kind: project ? 'project' : 'root', childDirs: s.childDirs };
}

/**
 * Everything the UI needs to describe a folder before it is added:
 * whether it is there, what it looks like, and why it might be refused.
 */
function inspect(input, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const abs = normalizePath(input, homeDir);
  if (!abs) {
    return { ok: false, path: null, error: 'That does not look like a folder path. Use an absolute path such as /Users/you/dev.' };
  }

  let st;
  try { st = fs.statSync(abs); } catch {
    return { ok: false, path: abs, exists: false, error: 'There is nothing at that path.' };
  }
  if (!st.isDirectory()) {
    return { ok: false, path: abs, exists: true, isDir: false, error: 'That is a file, not a folder.' };
  }
  try { fs.accessSync(abs, fs.constants.R_OK | fs.constants.X_OK); } catch {
    return { ok: false, path: abs, exists: true, isDir: true, error: 'That folder cannot be read.' };
  }

  /* Refuse first, look second. Deciding what `/` looks like means reading
   * every directory under it, and some of those are network mounts. */
  const early = refusalFor(abs, KINDS.has(opts.kind) ? opts.kind : 'root', homeDir);
  if (early) {
    return {
      ok: false, error: early, path: abs, exists: true, isDir: true,
      name: path.basename(abs) || abs,
      kind: KINDS.has(opts.kind) ? opts.kind : 'root',
      detectedKind: null, projectCount: null, sample: [], isRepo: false,
    };
  }

  const det = detectKind(abs);
  const kind = KINDS.has(opts.kind) ? opts.kind : det.kind;
  const refusal = refusalFor(abs, kind, homeDir);

  return {
    ok: !refusal,
    error: refusal || null,
    path: abs,
    exists: true,
    isDir: true,
    name: path.basename(abs) || abs,
    kind,
    detectedKind: det.kind,
    projectCount: kind === 'project' ? 1 : det.childDirs.length,
    sample: det.childDirs.slice(0, 6),
    isRepo: fs.existsSync(path.join(abs, '.git')),
  };
}

/* ------------------------------------------------------------------ *
 * Finding a folder by name (the drag-and-drop fallback)
 * ------------------------------------------------------------------ */

/**
 * A browser drop hands us a folder NAME but never its path. Rather than give
 * up, look for it: the existing sources first, then a bounded walk of the home
 * directory. Returns up to `limit` absolute paths, best guess first.
 *
 * Bounded on purpose: depth, dirent count and wall-clock all cap out, so a
 * drop on a machine with a huge home directory still answers promptly.
 */
function locateByName(name, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const limit = opts.limit || 12;
  const budgetMs = opts.budgetMs || 1500;
  const maxDepth = opts.maxDepth || 4;
  const maxEntries = opts.maxEntries || 40000;

  const target = String(name || '').trim();
  if (!target || target.includes('/') || target.includes('\0') || target === '.' || target === '..') return [];

  const deadline = Date.now() + budgetMs;
  const found = [];
  const seen = new Set();

  const consider = (abs) => {
    if (found.length >= limit) return;
    const real = (() => { try { return fs.realpathSync(abs); } catch { return abs; } })();
    if (seen.has(real)) return;
    seen.add(real);
    try { if (!fs.statSync(abs).isDirectory()) return; } catch { return; }
    found.push(abs);
  };

  // 1. Directly under a folder we already watch, overwhelmingly the common case.
  for (const dir of (opts.searchFirst || [])) {
    const cand = path.join(dir, target);
    if (fs.existsSync(cand)) consider(cand);
  }

  // 2. A bounded breadth-first sweep of the home directory.
  let entries = 0;
  let queue = [{ abs: homeDir, depth: 0 }];
  while (queue.length && found.length < limit) {
    if (Date.now() > deadline || entries > maxEntries) break;
    const next = [];
    for (const cur of queue) {
      if (Date.now() > deadline || entries > maxEntries || found.length >= limit) break;
      let list;
      try { list = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }
      for (const d of list) {
        if (++entries > maxEntries) break;
        if (!d.isDirectory()) continue;
        if (d.name.startsWith('.') || isIgnoredDir(d.name)) continue;
        if (cur.depth === 0 && (d.name === 'Library' || d.name === 'Applications')) continue;
        const abs = path.join(cur.abs, d.name);
        if (d.name === target) consider(abs);
        if (cur.depth + 1 < maxDepth) next.push({ abs, depth: cur.depth + 1 });
      }
    }
    queue = next;
  }

  // Shallower paths first: `~/dev/thing` beats `~/dev/old/backup/thing`.
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  return found.slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Browsing (the in-app folder picker)
 * ------------------------------------------------------------------ */

const BROWSE_LIMIT = 400;

/**
 * One directory listing for the picker: subdirectories only, each tagged with
 * whether it looks like a project. Never escapes into unreadable territory:
 * an unreadable folder returns an error rather than throwing.
 */
function browse(input, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const abs = normalizePath(input || homeDir, homeDir);
  if (!abs) return { ok: false, error: 'That does not look like a folder path.' };

  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, path: abs, error: 'There is nothing at that path.' }; }
  if (!st.isDirectory()) {
    // Browsing a file lands you in its folder, friendlier than an error.
    return browse(path.dirname(abs), opts);
  }

  let list;
  try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch {
    return { ok: false, path: abs, error: 'That folder cannot be read.' };
  }

  const entries = [];
  let hidden = 0;
  for (const d of list) {
    if (entries.length >= BROWSE_LIMIT) break;
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(abs, d.name)).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;
    if (d.name.startsWith('.') || isIgnoredDir(d.name)) { hidden++; continue; }
    const child = path.join(abs, d.name);
    entries.push({
      name: d.name,
      path: child,
      isProject: looksLikeProject(child),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = path.dirname(abs);
  return {
    ok: true,
    path: abs,
    name: path.basename(abs) || abs,
    parent: parent === abs ? null : parent,
    home: path.resolve(homeDir),
    entries,
    hiddenCount: hidden,
    truncated: entries.length >= BROWSE_LIMIT,
    self: inspect(abs, { homeDir }),
  };
}

/* ------------------------------------------------------------------ *
 * The native macOS folder chooser
 * ------------------------------------------------------------------ */

/**
 * `choose folder` through osascript. Ground Control is a local app, so the real
 * system picker is available and is by far the least annoying way to add a
 * folder. Resolves `{ ok:false, cancelled:true }` when the user cancels.
 */
function pickFolder(opts = {}) {
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: false, unsupported: true, error: 'The system folder picker is only available on macOS.' });
  }
  const prompt = 'Choose a folder for Ground Control';
  const script = [
    'activate',
    `set chosen to choose folder with prompt "${prompt}"`,
    'POSIX path of chosen',
  ];
  const args = [];
  for (const line of script) args.push('-e', line);

  return new Promise((resolve) => {
    execFile('osascript', args, { timeout: opts.timeoutMs || 120000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '');
        // -128 is the documented "user cancelled" code.
        if (/-128/.test(msg) || /User canceled/i.test(msg)) {
          return resolve({ ok: false, cancelled: true });
        }
        return resolve({ ok: false, error: 'The folder picker could not be opened.' });
      }
      const picked = String(stdout || '').trim();
      if (!picked) return resolve({ ok: false, cancelled: true });
      // `POSIX path of` returns a trailing slash for folders.
      const abs = path.resolve(picked.replace(/\/+$/, '')) || '/';
      resolve({ ok: true, path: abs });
    });
  });
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

function makeSourceId(abs, kind, used) {
  const base = slugify(path.basename(abs) || (kind === 'root' ? 'root' : 'project')) || 'folder';
  return uniqueSlug(base, used);
}

/** Coerce one persisted entry into a valid source, or null. */
function reviveSource(raw, used, homeDir) {
  if (!raw || typeof raw !== 'object') return null;
  const abs = normalizePath(raw.path, homeDir);
  if (!abs) return null;
  const kind = KINDS.has(raw.kind) ? raw.kind : 'root';
  let id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || used.has(id) || /[/\\\0]/.test(id)) id = makeSourceId(abs, kind, used);
  else used.add(id);
  return {
    id,
    kind,
    path: abs,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : null,
    addedISO: typeof raw.addedISO === 'string' ? raw.addedISO : new Date().toISOString(),
  };
}

class SourceError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

/**
 * The live set of watched folders, backed by a JSON file.
 *
 * Reads are cheap and synchronous; writes are atomic (temp file + rename) so a
 * crash mid-save cannot leave a truncated config behind.
 */
class Registry {
  /**
   * `opts.file`      where to persist (default ~/.ground-control/sources.json)
   * `opts.homeDir`   for `~` expansion and the default root
   * `opts.seedRoot`  the folder to start with when there is no config yet
   * `opts.ensure`    a folder that must be present this run (from --root),
   *                  added at the front and NOT persisted if the config
   *                  already exists: a CLI flag is for one run, not forever.
   */
  constructor(opts = {}) {
    this.homeDir = opts.homeDir || os.homedir();
    this.file = opts.file || defaultConfigPath(this.homeDir);
    this.sources = [];
    this.loadError = null;
    this.ephemeral = new Set();
    this.load(opts);
  }

  load(opts = {}) {
    const used = new Set();
    let parsed = null;
    let existed = false;

    try {
      const text = fs.readFileSync(this.file, 'utf8');
      existed = true;
      parsed = JSON.parse(text);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this.loadError = `The source list at ${this.file} could not be read (${err.message}). Starting from the default folder.`;
      }
    }

    const revived = [];
    if (parsed && Array.isArray(parsed.sources)) {
      for (const raw of parsed.sources) {
        const s = reviveSource(raw, used, this.homeDir);
        if (s && !revived.some((x) => x.path === s.path)) revived.push(s);
      }
    } else if (existed) {
      this.loadError = `The source list at ${this.file} is not in a shape Ground Control understands. Starting from the default folder.`;
    }

    this.sources = revived;

    // First run: seed with the folder we were pointed at.
    if (!existed) {
      const seed = normalizePath(opts.seedRoot || opts.ensure || defaultRoot(this.homeDir), this.homeDir);
      if (seed && !this.sources.some((s) => s.path === seed)) {
        this.sources.push({
          id: makeSourceId(seed, 'root', used),
          kind: 'root',
          path: seed,
          label: null,
          addedISO: new Date().toISOString(),
        });
      }
      this.persist();
      return;
    }

    // `--root` on an existing config: present for this run, not written down.
    const ensure = opts.ensure ? normalizePath(opts.ensure, this.homeDir) : null;
    if (ensure && !this.sources.some((s) => s.path === ensure)) {
      const s = {
        id: makeSourceId(ensure, 'root', used),
        kind: 'root',
        path: ensure,
        label: null,
        addedISO: new Date().toISOString(),
      };
      this.sources.unshift(s);
      this.ephemeral.add(s.id);
    }
  }

  /** Atomic write. Failure is reported, never thrown at a request. */
  persist() {
    const keep = this.sources.filter((s) => !this.ephemeral.has(s.id));
    const body = JSON.stringify({
      version: CONFIG_VERSION,
      updatedISO: new Date().toISOString(),
      sources: keep.map((s) => ({
        id: s.id, kind: s.kind, path: s.path, label: s.label, addedISO: s.addedISO,
      })),
    }, null, 2) + '\n';

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.saveError = null;
      return true;
    } catch (err) {
      this.saveError = `The source list could not be saved to ${this.file} (${(err && err.message) || err}).`;
      console.error('[sources] save failed:', this.saveError);
      return false;
    }
  }

  all() { return this.sources.slice(); }

  byId(id) { return this.sources.find((s) => s.id === id) || null; }

  /** The folder the header calls "the root": the first root-kind source. */
  primary() {
    return this.sources.find((s) => s.kind === 'root') || this.sources[0] || null;
  }

  /** The source a project path belongs to; used as its path-safety anchor. */
  ownerOf(projectPath) {
    const abs = path.resolve(String(projectPath || ''));
    if (!abs) return null;
    let best = null;
    for (const s of this.sources) {
      if (s.kind === 'project') {
        if (abs === s.path) return s;
        continue;
      }
      if (abs === s.path || abs.startsWith(s.path + path.sep)) {
        if (!best || s.path.length > best.path.length) best = s;
      }
    }
    return best;
  }

  /**
   * Add a folder. Throws SourceError with a status and a sentence the UI can
   * show verbatim.
   */
  add(input, opts = {}) {
    const info = inspect(input, { homeDir: this.homeDir, kind: opts.kind });
    if (!info.path) throw new SourceError(400, info.error || 'That does not look like a folder path.');
    if (info.exists === false) throw new SourceError(404, info.error || 'There is nothing at that path.');
    if (!info.ok) throw new SourceError(400, info.error || 'That folder cannot be added.');

    const existing = this.sources.find((s) => s.path === info.path);
    if (existing) {
      throw new SourceError(409, `Ground Control is already watching ${info.path}.`, { source: this.describe(existing) });
    }

    const used = new Set(this.sources.map((s) => s.id));
    const source = {
      id: makeSourceId(info.path, info.kind, used),
      kind: info.kind,
      path: info.path,
      label: typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim().slice(0, 80) : null,
      addedISO: new Date().toISOString(),
    };
    this.sources.push(source);
    this.persist();
    return { source: this.describe(source), info };
  }

  remove(id) {
    const i = this.sources.findIndex((s) => s.id === id);
    if (i === -1) throw new SourceError(404, 'unknown folder');
    const [gone] = this.sources.splice(i, 1);
    this.ephemeral.delete(gone.id);
    this.persist();
    return this.describe(gone);
  }

  update(id, patch = {}) {
    const s = this.byId(id);
    if (!s) throw new SourceError(404, 'unknown folder');
    if (patch.label !== undefined) {
      s.label = typeof patch.label === 'string' && patch.label.trim()
        ? patch.label.trim().slice(0, 80) : null;
    }
    if (patch.kind !== undefined) {
      if (!KINDS.has(patch.kind)) throw new SourceError(400, 'kind must be "root" or "project"');
      const refusal = refusalFor(s.path, patch.kind, this.homeDir);
      if (refusal) throw new SourceError(400, refusal);
      s.kind = patch.kind;
    }
    this.ephemeral.delete(s.id);      // an edited source is one the user meant
    this.persist();
    return this.describe(s);
  }

  /** Move a source to a new position, so the dashboard order is the user's. */
  reorder(ids) {
    if (!Array.isArray(ids)) throw new SourceError(400, 'ids must be an array');
    const byId = new Map(this.sources.map((s) => [s.id, s]));
    const next = [];
    for (const id of ids) {
      const s = byId.get(id);
      if (s && !next.includes(s)) next.push(s);
    }
    for (const s of this.sources) if (!next.includes(s)) next.push(s);
    this.sources = next;
    this.persist();
    return this.all().map((s) => this.describe(s));
  }

  /** The wire shape: what the source is, plus whether it is actually there. */
  describe(source) {
    const s = source;
    let exists = false;
    let readable = false;
    let projectCount = null;
    try {
      exists = fs.statSync(s.path).isDirectory();
    } catch { exists = false; }
    if (exists) {
      try { fs.accessSync(s.path, fs.constants.R_OK | fs.constants.X_OK); readable = true; } catch { readable = false; }
      if (readable) {
        projectCount = s.kind === 'project' ? 1 : childProjectDirs(s.path).length;
      }
    }
    return {
      id: s.id,
      kind: s.kind,
      path: s.path,
      name: path.basename(s.path) || s.path,
      label: s.label,
      display: s.label || path.basename(s.path) || s.path,
      addedISO: s.addedISO,
      primary: this.primary() ? this.primary().id === s.id : false,
      ephemeral: this.ephemeral.has(s.id),
      exists,
      readable,
      projectCount,
    };
  }

  describeAll() { return this.sources.map((s) => this.describe(s)); }
}

export {
  Registry, SourceError,
  CONFIG_VERSION, KINDS, SYSTEM_DIRS,
  defaultConfigPath, defaultRoot,
  normalizePath, pathsFromUriList, refusalFor,
  surveyDir, looksLikeProject, childProjectDirs, detectKind, inspect, NEVER_READ,
  locateByName, browse, pickFolder,
};
