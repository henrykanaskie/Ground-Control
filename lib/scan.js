/**
 * Ground Control — project scanning.
 *
 * One directory walk per project collects everything the summary needs:
 * counts, size, language bytes, doc candidates, TODO markers, test signals,
 * stack markers and the newest mtime. Git work runs concurrently.
 */

import fs from 'node:fs';
import path from 'node:path';

import * as util from './util.js';
import * as gitlib from './git.js';
import * as docslib from './docs.js';

const {
  isIgnoredDir, slugify, uniqueSlug, relativeTime, toISO,
  langForExt, NON_PRIMARY_LANGS, isScannableTextExt, truncateWords,
} = util;

/* ------------------------------------------------------------------ *
 * Walk limits
 * ------------------------------------------------------------------ */

const MAX_DEPTH = 6;             // directory levels below the project root
const MAX_ENTRIES = 20000;       // total dirents visited per project
const TODO_MAX_FILES = 600;      // files opened for TODO markers per project
const TODO_MAX_BYTES = 8 * 1024 * 1024;
const TODO_MAX_FILE_SIZE = 512 * 1024;
const MAX_DOC_CANDIDATES = 80;

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/g;

const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testing']);
const TEST_FILE_RE = /(^test_.*\.|.*_test\.|.*\.test\.|.*\.spec\.)/i;

/* ------------------------------------------------------------------ *
 * Stack markers
 * ------------------------------------------------------------------ */

// Display order = confidence. Frameworks/platforms first, language-ish last.
const STACK_ORDER = [
  'Next.js', 'iOS', 'Swift', 'Node', 'Python', 'Rust', 'Go', 'Ruby',
  'Java', 'Jupyter', 'Docker', 'Claude Code',
];

/** Marker filename (lowercased basename) -> stack label. */
function markerFor(baseLower, ext) {
  if (baseLower === 'package.json') return 'Node';
  if (baseLower === 'pyproject.toml' || baseLower === 'setup.py' || baseLower === 'pipfile'
    || /^requirements[\w.-]*\.txt$/.test(baseLower) || baseLower === 'environment.yml') return 'Python';
  if (baseLower === 'package.swift') return 'Swift';
  if (ext === '.xcodeproj' || ext === '.xcworkspace') return 'iOS';
  if (baseLower === 'cargo.toml') return 'Rust';
  if (baseLower === 'go.mod') return 'Go';
  if (baseLower === 'gemfile') return 'Ruby';
  if (baseLower === 'dockerfile' || baseLower === 'docker-compose.yml'
    || baseLower === 'compose.yaml' || baseLower === 'docker-compose.yaml') return 'Docker';
  if (/^next\.config\./.test(baseLower)) return 'Next.js';
  if (baseLower === 'pom.xml' || baseLower === 'build.gradle' || baseLower === 'build.gradle.kts') return 'Java';
  if (ext === '.ipynb') return 'Jupyter';
  if (baseLower === 'claude.md') return 'Claude Code';
  return null;
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

/**
 * Single-pass traversal of a project directory.
 * Never throws: unreadable entries are skipped.
 */
function walkProject(root) {
  const acc = {
    fileCount: 0,
    dirCount: 0,
    sizeBytes: 0,
    langBytes: new Map(),
    newestMtimeMs: 0,
    hasRealFile: false,        // a non-dotfile outside any dot-directory
    docs: [],                  // { rel, size, mtimeMs }
    todoCount: 0,
    hasTests: false,
    markers: new Set(),
    truncated: false,
  };

  let entries = 0;
  let todoFiles = 0;
  let todoBytes = 0;

  const visited = new Set();
  // Stack of directories still to read: { abs, rel, depth }
  const stack = [{ abs: root, rel: '', depth: 0 }];

  while (stack.length) {
    if (entries >= MAX_ENTRIES) { acc.truncated = true; break; }
    const cur = stack.pop();

    // Symlink-loop guard: a real path is only ever descended into once.
    let real;
    try { real = fs.realpathSync(cur.abs); } catch { continue; }
    if (visited.has(real)) continue;
    visited.add(real);

    let list;
    try { list = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }

    for (const d of list) {
      if (++entries > MAX_ENTRIES) { acc.truncated = true; break; }

      const name = d.name;
      if (name === '.DS_Store') continue;
      const rel = cur.rel ? `${cur.rel}/${name}` : name;
      const abs = path.join(cur.abs, name);

      // Resolve type; symlinks are followed only far enough to classify.
      let isDir = d.isDirectory();
      let isFile = d.isFile();
      let st = null;
      if (d.isSymbolicLink()) {
        try {
          st = fs.statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }

      if (isDir) {
        if (isIgnoredDir(name)) continue;
        acc.dirCount++;
        if (TEST_DIR_NAMES.has(name.toLowerCase())) acc.hasTests = true;
        const ext = path.extname(name).toLowerCase();
        const m = markerFor(name.toLowerCase(), ext);   // e.g. Foo.xcodeproj is a directory
        if (m && cur.depth <= 2) acc.markers.add(m);
        if (cur.depth + 1 <= MAX_DEPTH) {
          stack.push({ abs, rel, depth: cur.depth + 1 });
        }
        continue;
      }

      if (!isFile) continue;

      if (!st) {
        try { st = fs.statSync(abs); } catch { continue; }
      }

      acc.fileCount++;
      acc.sizeBytes += st.size;
      if (st.mtimeMs > acc.newestMtimeMs) acc.newestMtimeMs = st.mtimeMs;

      const baseLower = name.toLowerCase();
      const ext = path.extname(baseLower);

      // "only dotfiles" emptiness test: ignore dot-files and anything under a dot-dir.
      if (!acc.hasRealFile && !rel.split('/').some((s) => s.startsWith('.'))) {
        acc.hasRealFile = true;
      }

      // Language bytes.
      const lang = langForExt(ext);
      if (lang) acc.langBytes.set(lang, (acc.langBytes.get(lang) || 0) + st.size);

      // Stack markers (root + two levels down).
      if (cur.depth <= 2) {
        const m = markerFor(baseLower, ext);
        if (m) acc.markers.add(m);
      }

      // Tests.
      if (!acc.hasTests && TEST_FILE_RE.test(name)) acc.hasTests = true;

      // Doc candidates (root, docs/, doc/, .github/ — depth <= 2).
      if (acc.docs.length < MAX_DOC_CANDIDATES
        && docslib.inDocScope(rel) && docslib.classify(rel)) {
        acc.docs.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      }

      // TODO markers — capped so a big repo doesn't stall the scan.
      if (todoFiles < TODO_MAX_FILES && todoBytes < TODO_MAX_BYTES
        && st.size > 0 && st.size <= TODO_MAX_FILE_SIZE && isScannableTextExt(ext)) {
        todoFiles++;
        todoBytes += st.size;
        try {
          const text = fs.readFileSync(abs, 'utf8');
          TODO_RE.lastIndex = 0;
          while (TODO_RE.exec(text) !== null) acc.todoCount++;
        } catch { /* unreadable / not utf-8 — skip */ }
      }
    }
  }

  return acc;
}

/* ------------------------------------------------------------------ *
 * Derived fields
 * ------------------------------------------------------------------ */

function buildLangBreakdown(langBytes) {
  const total = [...langBytes.values()].reduce((a, b) => a + b, 0);
  if (!total) return { breakdown: [], primaryLanguage: null, ranked: [] };

  const ranked = [...langBytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, bytes]) => ({ lang, bytes, pct: Math.round((bytes / total) * 1000) / 10 }));

  // Prefer a real programming language for `primaryLanguage`; fall back to the
  // top entry if the project is nothing but markdown/data.
  const primary = ranked.find((r) => !NON_PRIMARY_LANGS.has(r.lang)) || ranked[0];

  return { breakdown: ranked.slice(0, 6), primaryLanguage: primary ? primary.lang : null, ranked };
}

function buildStack(markers, primaryLanguage, ranked) {
  const stack = [];
  const push = (v) => { if (v && !stack.includes(v)) stack.push(v); };

  for (const s of STACK_ORDER) if (markers.has(s)) push(s);
  for (const s of markers) push(s);                     // anything not in STACK_ORDER
  push(primaryLanguage);
  for (const r of ranked.slice(0, 3)) push(r.lang);     // fold in the loudest languages
  return stack.slice(0, 6);
}

function classifyStatus(lastActivityMs, isEmpty, now) {
  if (isEmpty) return 'empty';
  if (!lastActivityMs) return 'empty';
  const days = (now - lastActivityMs) / 86400000;
  if (days < 7) return 'active';
  if (days < 30) return 'recent';
  if (days < 120) return 'idle';
  return 'dormant';
}

function buildStatusReason(status, git, commitsLast7d, lastActivityISO) {
  if (status === 'empty') return 'no files';
  if (git) {
    if (commitsLast7d > 0) return `${commitsLast7d} commit${commitsLast7d === 1 ? '' : 's'} this week`;
    if (git.commitsLast30d > 0) {
      const n = git.commitsLast30d;
      return `${n} commit${n === 1 ? '' : 's'} in 30 days`;
    }
    if (git.lastCommitISO) return truncateWords(`last commit ${relativeTime(git.lastCommitISO)}`, 40);
    return 'repo with no commits';
  }
  const rel = relativeTime(lastActivityISO);
  return rel ? truncateWords(`edited ${rel}`, 40) : 'no git history';
}

/* ------------------------------------------------------------------ *
 * Per-project scan
 * ------------------------------------------------------------------ */

/**
 * Build a full ProjectSummary. Wrapped in try/catch by the caller, but also
 * defends internally so a partial failure still yields a complete shape.
 */
async function scanProject(rootDir, name, id, now = Date.now()) {
  const projPath = path.join(rootDir, name);

  const base = {
    id,
    name,
    path: projPath,
    status: 'empty',
    statusReason: 'no files',
    isGit: false,
    git: null,
    lastActivityISO: null,
    lastActivityRelative: null,
    stack: [],
    primaryLanguage: null,
    langBreakdown: [],
    fileCount: 0,
    dirCount: 0,
    sizeBytes: 0,
    docs: [],
    featuredDoc: null,
    blurb: '',
    todoCount: 0,
    hasTests: false,
    readmeBadgeCount: 0,
  };

  // Git first (async, so it overlaps other projects' walks).
  const isGit = gitlib.isGitRepo(projPath);
  const gitP = isGit ? gitlib.summary(projPath).catch(() => null) : Promise.resolve(null);
  const c7P = isGit ? gitlib.commitsSince(projPath, 7).catch(() => 0) : Promise.resolve(0);

  let acc;
  try {
    acc = walkProject(projPath);
  } catch {
    acc = null;
  }

  const git = await gitP;
  const commitsLast7d = await c7P;

  base.isGit = Boolean(git);
  base.git = git;

  if (!acc) {
    // The walk blew up entirely; still return git-derived facts.
    if (git && git.lastCommitISO) {
      base.lastActivityISO = git.lastCommitISO;
      base.lastActivityRelative = relativeTime(git.lastCommitISO);
      base.status = classifyStatus(Date.parse(git.lastCommitISO), false, now);
      base.statusReason = buildStatusReason(base.status, git, commitsLast7d, base.lastActivityISO);
    }
    return base;
  }

  base.fileCount = acc.fileCount;
  base.dirCount = acc.dirCount;
  base.sizeBytes = acc.sizeBytes;
  base.todoCount = acc.todoCount;
  base.hasTests = acc.hasTests;

  /* --- last activity ------------------------------------------------
   * For a clean git repo the commit date is the truth: a fresh clone has
   * today's mtimes but is not "active" work. When the tree is dirty the file
   * mtimes are real edits, so we take the later of the two.
   * Non-git projects fall back to the newest file mtime.
   */
  const commitMs = git && git.lastCommitISO ? Date.parse(git.lastCommitISO) : 0;
  const mtimeMs = acc.newestMtimeMs || 0;
  let lastMs;
  if (git) lastMs = git.dirty ? Math.max(commitMs, mtimeMs) : (commitMs || mtimeMs);
  else lastMs = mtimeMs;

  // "no files at all, or only dotfiles" -> empty.
  const isEmpty = !acc.hasRealFile;

  base.lastActivityISO = isEmpty ? null : toISO(lastMs);
  base.lastActivityRelative = base.lastActivityISO ? relativeTime(base.lastActivityISO, now) : null;
  base.status = classifyStatus(isEmpty ? 0 : lastMs, isEmpty, now);
  base.statusReason = buildStatusReason(base.status, git, commitsLast7d, base.lastActivityISO);

  /* --- languages & stack --- */
  const { breakdown, primaryLanguage, ranked } = buildLangBreakdown(acc.langBytes);
  base.langBreakdown = breakdown;
  base.primaryLanguage = primaryLanguage;
  base.stack = buildStack(acc.markers, primaryLanguage, ranked);

  /* --- docs --- */
  const docRefs = [];
  for (const c of acc.docs) {
    try {
      const ref = docslib.buildDocRef(projPath, c.rel, { size: c.size, mtimeMs: c.mtimeMs });
      if (ref) docRefs.push(ref);
    } catch { /* one bad doc must not sink the project */ }
  }
  base.docs = docslib.sortDocs(docRefs);
  base.featuredDoc = docslib.pickFeatured(base.docs);

  // Blurb comes from the featured doc; if a project is nothing but an HTML
  // artifact, fall back to that page's description/title so the card isn't blank.
  const blurbSource = base.featuredDoc || base.docs.find((d) => d.kind === 'html') || null;
  base.blurb = docslib.blurbFor(projPath, blurbSource);
  base.readmeBadgeCount = docslib.badgeCount(projPath, base.docs);

  return base;
}

/* ------------------------------------------------------------------ *
 * Root scan
 * ------------------------------------------------------------------ */

/** List candidate project directories directly under `root`. */
function listProjectDirs(root) {
  let list;
  try { list = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const names = [];
  for (const d of list) {
    const name = d.name;
    if (name.startsWith('.')) continue;             // .git, .claude, .DS_Store
    if (isIgnoredDir(name)) continue;
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(root, name)).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Scan every project under `root`.
 * Resolves to the `GET /api/projects` payload. Never rejects.
 */
async function scanRoot(root) {
  const started = Date.now();
  const rootAbs = path.resolve(root);
  const names = listProjectDirs(rootAbs);

  // Ids are assigned over the alphabetical name list, so they stay stable no
  // matter how the projects end up sorted for display.
  const used = new Set();
  const ids = new Map();
  for (const n of names) ids.set(n, uniqueSlug(slugify(n), used));

  const results = await Promise.all(names.map(async (name) => {
    try {
      return await scanProject(rootAbs, name, ids.get(name), started);
    } catch (err) {
      // A project that fails outright still appears, marked and inert.
      return {
        id: ids.get(name),
        name,
        path: path.join(rootAbs, name),
        status: 'empty',
        statusReason: 'scan failed',
        isGit: false,
        git: null,
        lastActivityISO: null,
        lastActivityRelative: null,
        stack: [],
        primaryLanguage: null,
        langBreakdown: [],
        fileCount: 0,
        dirCount: 0,
        sizeBytes: 0,
        docs: [],
        featuredDoc: null,
        blurb: '',
        todoCount: 0,
        hasTests: false,
        readmeBadgeCount: 0,
        error: String((err && err.message) || err),
      };
    }
  }));

  // lastActivityISO desc, nulls last, name as the tiebreak.
  results.sort((a, b) => {
    const av = a.lastActivityISO ? Date.parse(a.lastActivityISO) : null;
    const bv = b.lastActivityISO ? Date.parse(b.lastActivityISO) : null;
    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;
    return a.name.localeCompare(b.name);
  });

  return {
    root: rootAbs,
    scannedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    projects: results,
  };
}

/* ------------------------------------------------------------------ *
 * File tree (detail view)
 * ------------------------------------------------------------------ */

/**
 * Up to `limit` entries, depth <= `maxDepth`, same ignore list.
 * Directories before files, alphabetical, depth-first so the listing reads
 * like a tree.
 */
function buildTree(root, maxDepth = 3, limit = 300) {
  const out = [];

  const visit = (absDir, relDir, depth) => {
    if (out.length >= limit || depth > maxDepth) return;
    let list;
    try { list = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }

    const dirs = [];
    const files = [];
    for (const d of list) {
      const name = d.name;
      if (name === '.DS_Store') continue;
      let isDir = d.isDirectory();
      let st = null;
      if (d.isSymbolicLink()) {
        try { st = fs.statSync(path.join(absDir, name)); isDir = st.isDirectory(); } catch { continue; }
      }
      if (isDir) {
        if (isIgnoredDir(name)) continue;
        dirs.push(name);
      } else {
        files.push(name);
      }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));

    for (const name of dirs) {
      if (out.length >= limit) return;
      const rel = relDir ? `${relDir}/${name}` : name;
      out.push({ path: rel, type: 'dir', sizeBytes: 0, depth });
      visit(path.join(absDir, name), rel, depth + 1);
    }
    for (const name of files) {
      if (out.length >= limit) return;
      const rel = relDir ? `${relDir}/${name}` : name;
      let size = 0;
      try { size = fs.statSync(path.join(absDir, name)).size; } catch { /* ignore */ }
      out.push({ path: rel, type: 'file', sizeBytes: size, depth });
    }
  };

  visit(root, '', 0);
  return out.slice(0, limit);
}

/** ProjectSummary + recentCommits / tree / dirtyFiles / activity. */
async function projectDetail(summary) {
  const detail = Object.assign({}, summary, {
    recentCommits: [],
    tree: [],
    dirtyFiles: [],
    activity: [],
  });

  try {
    detail.tree = buildTree(summary.path, 3, 300);
  } catch { detail.tree = []; }

  if (summary.isGit) {
    const [commits, dirty, act] = await Promise.all([
      gitlib.recentCommits(summary.path, 15).catch(() => []),
      gitlib.dirtyFiles(summary.path, 40).catch(() => []),
      gitlib.activity(summary.path, 90).catch(() => []),
    ]);
    detail.recentCommits = commits;
    detail.dirtyFiles = dirty;
    detail.activity = act;
  }

  return detail;
}

export {
  scanRoot, scanProject, projectDetail, buildTree, listProjectDirs, walkProject,
  MAX_DEPTH, MAX_ENTRIES,
};
