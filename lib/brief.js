/**
 * Ground Control Forge: the repo brief.
 *
 * Everything the authored artifact is allowed to say has to come from here, so
 * this module is deliberately thorough: parsed manifests, real runnable
 * commands, ranked entry points, a legible structure summary, the prose the
 * user already wrote, git history, and the signals that tell a newcomer what
 * state the project is actually in.
 *
 * No model is involved. Node stdlib only. See CONTRACT-FORGE.md §3.
 *
 * SECURITY: `isSensitive()` gates *every* file read in this module. Files that
 * match it are reported by name and never opened, see contract §3 "never read
 * `.env`, `creds*`, `*secret*`, `*key*`, `*.pem`".
 */

import fs from 'node:fs';
import path from 'node:path';

import * as util from './util.js';
import * as gitlib from './git.js';
import * as docslib from './docs.js';

const { isIgnoredDir, relativeTime, isScannableTextExt, isBinaryExt, langForExt } = util;

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

const WALK_MAX_ENTRIES = 40000;      // dirents visited per project
const WALK_MAX_DEPTH = 6;
const TREE_DEPTH = 3;                // depth reported in the structure summary
const TREE_MAX_DIRS = 120;

const TEXT_SCAN_MAX_FILES = 500;     // files opened for TODO / entry-point sniffing
const TEXT_SCAN_MAX_BYTES = 6 * 1024 * 1024;
const TEXT_SCAN_MAX_FILE = 512 * 1024;

const TODO_SAMPLES = 15;
const COMMIT_SUBJECTS = 40;
const PROSE_CAP = 24 * 1024;         // per document, per contract
const MANIFEST_RAW_HEAD = 3 * 1024;  // fallback when we can't parse a manifest

const MARKDOWN_BUDGET = 40 * 1024;
const DESIGN_MARKDOWN_BUDGET = 90 * 1024;   // the design docs are the payload
const CODE_MARKDOWN_BUDGET = 60 * 1024;     // an index of coordinates, not code

/* ------------------------------------------------------------------ *
 * Sensitive files: name only, never contents
 * ------------------------------------------------------------------ */

/**
 * True for any file whose *contents* must never be read or included.
 * Matched on the basename, case-insensitively, and deliberately broad: a false
 * positive costs us one TODO sample, a false negative leaks a credential.
 */
function isSensitive(relOrName) {
  const base = String(relOrName).split('/').pop().toLowerCase();
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return true;
  if (base.startsWith('creds')) return true;
  if (base.includes('secret')) return true;
  if (base.includes('credential')) return true;
  if (base.includes('key')) return true;           // *key* per contract (api_key.py, keys.json, …)
  if (base.endsWith('.pem') || base.endsWith('.p12') || base.endsWith('.pfx')) return true;
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519')) return true;
  if (base === '.netrc' || base === '.pgpass' || base === '.htpasswd') return true;
  if (base === '.npmrc' || base === '.pypirc') return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function humanBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Read a file as utf-8, honouring the sensitive-file gate. Returns '' on any failure. */
function readTextCapped(abs, rel, limit) {
  if (isSensitive(rel || abs)) return '';
  return docslib.readHead(abs, limit);
}

/** Read a whole file up to `cap`, reporting whether it was truncated. */
function readProse(abs, rel, cap = PROSE_CAP) {
  let size = 0;
  try { size = fs.statSync(abs).size; } catch { return null; }
  const text = readTextCapped(abs, rel, cap);
  if (!text) return null;
  return {
    text,
    originalBytes: size,
    truncated: size > Buffer.byteLength(text, 'utf8'),
  };
}

function uniq(arr) {
  return [...new Set(arr)];
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

/**
 * One traversal that feeds structure, entry points, manifests, config
 * discovery and the text scan. Never throws.
 */
function walk(root) {
  const files = [];            // { rel, name, ext, size, depth, mtimeMs }
  const dirs = new Map();      // rel -> { rel, depth, directFiles, subdirs }
  let truncated = false;
  let entries = 0;

  const visited = new Set();
  // Breadth-first on purpose. A depth-first walk of animAgent burns the entry
  // budget inside its 19k-file fixture tree and never reaches Sources/, which
  // silently loses the real entry points. Level order guarantees the shallow,
  // high-value directories are always visited before the cap can bite.
  const queue = [{ abs: root, rel: '', depth: 0 }];
  let head = 0;

  while (head < queue.length) {
    if (entries >= WALK_MAX_ENTRIES) { truncated = true; break; }
    const cur = queue[head++];

    let real;
    try { real = fs.realpathSync(cur.abs); } catch { continue; }
    if (visited.has(real)) continue;
    visited.add(real);

    let list;
    try { list = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }

    for (const d of list) {
      if (++entries > WALK_MAX_ENTRIES) { truncated = true; break; }
      const name = d.name;
      if (name === '.DS_Store') continue;
      const rel = cur.rel ? `${cur.rel}/${name}` : name;
      const abs = path.join(cur.abs, name);

      let isDir = d.isDirectory();
      let isFile = d.isFile();
      let st = null;
      if (d.isSymbolicLink()) {
        try { st = fs.statSync(abs); isDir = st.isDirectory(); isFile = st.isFile(); }
        catch { continue; }
      }

      if (isDir) {
        // `Foo.xcodeproj` is a directory but reads as a manifest: keep it as
        // an entry without descending into its bundle contents.
        const ext = path.extname(name).toLowerCase();
        if (ext === '.xcodeproj' || ext === '.xcworkspace') {
          files.push({ rel, name, ext, size: 0, depth: cur.depth + 1, mtimeMs: 0, isBundle: true });
          continue;
        }
        if (isIgnoredDir(name)) continue;
        dirs.set(rel, { rel, depth: cur.depth + 1, directFiles: 0, subdirs: 0 });
        const parent = dirs.get(cur.rel);
        if (parent) parent.subdirs++;
        if (cur.depth + 1 <= WALK_MAX_DEPTH) queue.push({ abs, rel, depth: cur.depth + 1 });
        continue;
      }

      if (!isFile) continue;
      if (!st) { try { st = fs.statSync(abs); } catch { continue; } }

      files.push({
        rel, name,
        ext: path.extname(name).toLowerCase(),
        size: st.size,
        depth: cur.depth + 1,
        mtimeMs: st.mtimeMs,
      });
      const parent = dirs.get(cur.rel);
      if (parent) parent.directFiles++;
    }
  }

  return { files, dirs, truncated };
}

/* ------------------------------------------------------------------ *
 * Structure summary
 * ------------------------------------------------------------------ */

/**
 * Directory tree to `maxDepth`, each row carrying a *recursive* file count,
 * total bytes and dominant extension. That is what makes a 19,681-file
 * fixture tree legible in six lines instead of six thousand.
 */
function buildStructure(walked, maxDepth = TREE_DEPTH) {
  const agg = new Map();   // dirRel -> { files, bytes, ext: Map }

  const bump = (dirRel, f) => {
    let a = agg.get(dirRel);
    if (!a) { a = { files: 0, bytes: 0, ext: new Map() }; agg.set(dirRel, a); }
    a.files++;
    a.bytes += f.size;
    if (f.ext) a.ext.set(f.ext, (a.ext.get(f.ext) || 0) + 1);
  };

  for (const f of walked.files) {
    const segs = f.rel.split('/');
    segs.pop();
    // Attribute the file to its own directory and to every ancestor.
    bump('', f);
    for (let i = 1; i <= segs.length; i++) bump(segs.slice(0, i).join('/'), f);
  }

  const rows = [];
  for (const [rel, info] of dirsAtDepth(walked.dirs, maxDepth)) {
    const a = agg.get(rel) || { files: 0, bytes: 0, ext: new Map() };
    let dominant = null, best = 0;
    for (const [ext, n] of a.ext) if (n > best) { best = n; dominant = ext; }
    rows.push({
      path: rel,
      depth: info.depth,
      files: a.files,
      bytes: a.bytes,
      dominantExt: dominant,
      dominantCount: best,
    });
  }
  rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  const rootFiles = walked.files
    .filter((f) => f.depth === 1)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({ path: f.rel, bytes: f.size }));

  const rootAgg = agg.get('') || { files: 0, bytes: 0 };

  return {
    maxDepth,
    rootFiles,
    dirs: rows.slice(0, TREE_MAX_DIRS),
    dirsOmitted: Math.max(0, rows.length - TREE_MAX_DIRS),
    totalFiles: rootAgg.files,
    totalBytes: rootAgg.bytes,
    truncated: walked.truncated,
  };
}

function dirsAtDepth(dirs, maxDepth) {
  const out = [];
  for (const [rel, info] of dirs) if (info.depth <= maxDepth) out.push([rel, info]);
  return out;
}

/* ------------------------------------------------------------------ *
 * Manifests
 * ------------------------------------------------------------------ */

/** Extremely small TOML reader: sections, `key = value`, inline arrays. */
function parseToml(text) {
  const out = {};
  let section = out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const sec = /^\[+([^\]]+)\]+$/.exec(line);
    if (sec) {
      section = out;
      for (const part of sec[1].split('.')) {
        const k = part.replace(/^["']|["']$/g, '').trim();
        if (typeof section[k] !== 'object' || section[k] === null) section[k] = {};
        section = section[k];
      }
      continue;
    }

    const kv = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/^["']|["']$/g, '');
    let raw = kv[2];

    // Multi-line array: join until the bracket balances (bounded).
    if (raw.startsWith('[') && !raw.includes(']')) {
      let j = i + 1;
      while (j < lines.length && j < i + 200 && !raw.includes(']')) raw += ' ' + lines[j++].trim();
      i = j - 1;
    }
    section[key] = tomlValue(raw);
  }
  return out;
}

function tomlValue(raw) {
  const s = raw.replace(/\s+#.*$/, '').trim();
  if (s.startsWith('[')) {
    return s.replace(/^\[|\]$/g, '')
      .split(',')
      .map((x) => x.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (s.startsWith('{')) return s;
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  if (s !== '' && Number.isFinite(n) && /^-?[\d.]+$/.test(s)) return n;
  return s.replace(/^["']|["']$/g, '');
}

/** Makefile targets, ignoring pattern rules and special targets. */
function parseMakefile(text) {
  const targets = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line)) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9_.\/-]*)\s*:(?!=)/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith('.')) continue;
    if (name.includes('%')) continue;
    if (!targets.includes(name)) targets.push(name);
    if (targets.length >= 40) break;
  }
  return targets;
}

function parseDockerfile(text) {
  const out = { from: [], expose: [], cmd: null, entrypoint: null, workdir: null };
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(FROM|EXPOSE|CMD|ENTRYPOINT|WORKDIR)\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const k = m[1].toUpperCase();
    if (k === 'FROM') out.from.push(m[2]);
    else if (k === 'EXPOSE') out.expose.push(m[2]);
    else if (k === 'CMD') out.cmd = m[2];
    else if (k === 'ENTRYPOINT') out.entrypoint = m[2];
    else if (k === 'WORKDIR') out.workdir = m[2];
  }
  return out;
}

const MANIFEST_MATCHERS = [
  { re: /^package\.json$/i, kind: 'npm' },
  { re: /^pyproject\.toml$/i, kind: 'pyproject' },
  { re: /^requirements[\w.-]*\.txt$/i, kind: 'requirements' },
  { re: /^setup\.py$/i, kind: 'setup.py' },
  { re: /^environment\.ya?ml$/i, kind: 'conda' },
  { re: /^Pipfile$/i, kind: 'pipfile' },
  { re: /^Package\.swift$/i, kind: 'swiftpm' },
  { re: /^Cargo\.toml$/i, kind: 'cargo' },
  { re: /^go\.mod$/i, kind: 'gomod' },
  { re: /^Gemfile$/i, kind: 'gemfile' },
  { re: /^Makefile$|^makefile$|^GNUmakefile$/, kind: 'makefile' },
  { re: /^Dockerfile$/i, kind: 'dockerfile' },
  { re: /^docker-compose\.ya?ml$|^compose\.ya?ml$/i, kind: 'compose' },
  { re: /\.xcodeproj$|\.xcworkspace$/i, kind: 'xcode' },
  { re: /^build\.gradle(\.kts)?$/i, kind: 'gradle' },
  { re: /^pom\.xml$/i, kind: 'maven' },
];

function manifestKind(name) {
  for (const m of MANIFEST_MATCHERS) if (m.re.test(name)) return m.kind;
  return null;
}

/**
 * Parse every manifest at depth <= 2. Parse what's cheap; fall back to a raw
 * head otherwise, so the author always has *something* concrete to work from.
 */
function collectManifests(root, walked) {
  const out = [];
  const candidates = walked.files
    .filter((f) => f.depth <= 2 && manifestKind(f.name))
    .sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel))
    .slice(0, 24);

  for (const f of candidates) {
    const kind = manifestKind(f.name);
    const abs = path.join(root, f.rel);
    const entry = { path: f.rel, kind, sizeBytes: f.size, parsed: null, raw: null };

    try {
      if (kind === 'xcode') {
        entry.parsed = { project: f.name };
        out.push(entry);
        continue;
      }

      const text = readTextCapped(abs, f.rel, 256 * 1024);
      if (!text) { out.push(entry); continue; }

      if (kind === 'npm') {
        const j = JSON.parse(text);
        entry.parsed = {
          name: j.name || null,
          version: j.version || null,
          description: j.description || null,
          type: j.type || null,
          main: j.main || null,
          module: j.module || null,
          bin: j.bin || null,
          engines: j.engines || null,
          scripts: j.scripts || null,
          dependencies: Object.keys(j.dependencies || {}),
          devDependencies: Object.keys(j.devDependencies || {}),
          workspaces: j.workspaces || null,
        };
      } else if (kind === 'pyproject') {
        const t = parseToml(text);
        const proj = t.project || {};
        const poetry = (t.tool && t.tool.poetry) || {};
        entry.parsed = {
          name: proj.name || poetry.name || null,
          version: proj.version || poetry.version || null,
          description: proj.description || poetry.description || null,
          requiresPython: proj['requires-python'] || null,
          dependencies: [].concat(proj.dependencies || [], Object.keys(poetry.dependencies || {})),
          scripts: proj.scripts || poetry.scripts || null,
          buildBackend: (t['build-system'] && t['build-system']['build-backend']) || null,
          tools: Object.keys(t.tool || {}),
        };
      } else if (kind === 'requirements') {
        const deps = text.split(/\r?\n/)
          .map((l) => l.replace(/#.*$/, '').trim())
          .filter((l) => l && !l.startsWith('-'));
        entry.parsed = { dependencies: deps.slice(0, 80), count: deps.length };
      } else if (kind === 'cargo') {
        const t = parseToml(text);
        entry.parsed = {
          name: (t.package && t.package.name) || null,
          version: (t.package && t.package.version) || null,
          edition: (t.package && t.package.edition) || null,
          description: (t.package && t.package.description) || null,
          dependencies: Object.keys(t.dependencies || {}),
          bins: Object.keys(t.bin || {}),
        };
      } else if (kind === 'gomod') {
        const mod = /^module\s+(\S+)/m.exec(text);
        const go = /^go\s+(\S+)/m.exec(text);
        const reqs = [...text.matchAll(/^\s*([\w./-]+)\s+v[\w.+-]+/gm)].map((m) => m[1]);
        entry.parsed = { module: mod ? mod[1] : null, go: go ? go[1] : null, requires: uniq(reqs).slice(0, 40) };
      } else if (kind === 'swiftpm') {
        const name = /name:\s*"([^"]+)"/.exec(text);
        const tools = /swift-tools-version:\s*([\d.]+)/.exec(text);
        const products = uniq([...text.matchAll(/\.(?:executable|library)\(\s*name:\s*"([^"]+)"/g)].map((m) => m[1]));
        const targets = uniq([...text.matchAll(/\.(?:target|executableTarget|testTarget)\(\s*\n?\s*name:\s*"([^"]+)"/g)].map((m) => m[1]));
        const deps = uniq([...text.matchAll(/\.package\(\s*url:\s*"([^"]+)"/g)].map((m) => m[1]));
        entry.parsed = {
          name: name ? name[1] : null,
          toolsVersion: tools ? tools[1] : null,
          products, targets, dependencies: deps,
        };
      } else if (kind === 'gemfile') {
        const gems = uniq([...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]));
        entry.parsed = { gems: gems.slice(0, 40) };
      } else if (kind === 'makefile') {
        entry.parsed = { targets: parseMakefile(text) };
      } else if (kind === 'dockerfile') {
        entry.parsed = parseDockerfile(text);
      } else if (kind === 'setup.py') {
        const name = /name\s*=\s*["']([^"']+)["']/.exec(text);
        const entryPts = /console_scripts["']?\s*:\s*\[([^\]]*)\]/s.exec(text);
        entry.parsed = {
          name: name ? name[1] : null,
          consoleScripts: entryPts ? entryPts[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [],
        };
      } else {
        entry.raw = text.slice(0, MANIFEST_RAW_HEAD);
      }
    } catch {
      // Unparseable manifest still earns its raw head: better than nothing.
      try { entry.raw = readTextCapped(abs, f.rel, MANIFEST_RAW_HEAD); } catch { /* ignore */ }
    }
    out.push(entry);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Text scan: TODO samples, __main__ guards, framework hints
 * ------------------------------------------------------------------ */

const TODO_LINE_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/;

/**
 * Extensions that are text but are *data*, not code. Scanning them burns the
 * byte budget on CSV rows and lockfiles and finds nothing: ML_quantitative_research
 * exhausted the whole 6 MB allowance on 38 sector CSVs before reaching src/.
 */
const NON_CODE_TEXT_EXT = new Set([
  '.csv', '.tsv', '.ipynb', '.svg', '.lock', '.log', '.map', '.min.js',
  '.plist', '.pbxproj', '.xcuserstate', '.rst', '.tex',
]);

function isCodeish(f) {
  if (NON_CODE_TEXT_EXT.has(f.ext)) return false;
  if (/\.min\.(js|css)$/i.test(f.name)) return false;
  if (f.ext === '.json' && f.size > 64 * 1024) return false;   // fixtures, manifests
  if (f.ext === '.txt' && f.size > 64 * 1024) return false;
  return isScannableTextExt(f.ext);
}

/* ------------------------------------------------------------------ *
 * Design evidence: the "why", not the "what"
 * ------------------------------------------------------------------ */

/**
 * A rationale document explains *what* a repository contains. This section
 * gathers the evidence for *why* it contains it, which lives in four places
 * and nowhere else:
 *
 *   1. Comment blocks sitting above a declaration, explaining the choice.
 *   2. Named constants: the tuning knobs. A documented one carries its
 *      reasoning; an undocumented one is a load-bearing magic number, and
 *      saying so is itself useful.
 *   3. Commit message *bodies*. Subjects say what changed; bodies say why.
 *   4. Design documents: ADRs, RFCs, CONTRACT/ARCHITECTURE/DESIGN files.
 *      `collectProse` deliberately only reads the featured doc, README and
 *      CLAUDE.md, so these would otherwise never reach the model.
 *
 * None of it is inferred. Every item carries the path and line it came from so
 * the author can cite it, and so a reader can check the citation.
 */

const WHY_RE = new RegExp([
  '\\b(?:because|since|so that|so it|rather than|instead of|otherwise|as opposed to)\\b',
  '\\b(?:deliberate|deliberately|intentional|intentionally|on purpose|by design)\\b',
  '\\b(?:the reason|reason is|rationale|trade[- ]?off|tradeoff|we chose|chose to|opted|decided)\\b',
  '\\b(?:must not|must sit|must stay|must remain|must be|has to be|never |do not |don\'t )\\b',
  '\\b(?:avoids?|avoiding|prevents?|guards? against|protects? against|works? around|workaround)\\b',
  '\\b(?:historically|originally|used to|turns out|it turned out|in practice|measured)\\b',
  '\\b(?:beware|careful|gotcha|caveat|footgun|subtle|non-obvious|counter-?intuitive)\\b',
  '\\b(?:invariant|guarantees?|assumes?|assumption|precondition|contract)\\b',
  '\\b(?:cheaper|faster|slower|expensive|hot path|budget|cap|throttl)\\b',
].join('|'), 'i');

/** Line-comment token per language. Block comments are handled separately. */
function commentSyntax(ext) {
  switch (ext) {
    case '.js': case '.mjs': case '.cjs': case '.ts': case '.tsx': case '.jsx':
    case '.swift': case '.go': case '.rs': case '.java': case '.kt': case '.scala':
    case '.c': case '.h': case '.cpp': case '.hpp': case '.cc': case '.cs':
    case '.m': case '.mm': case '.php': case '.dart':
      return { line: '//', block: true };
    case '.py': case '.rb': case '.sh': case '.bash': case '.zsh': case '.pl':
    case '.yml': case '.yaml': case '.toml': case '.r': case '.jl':
      return { line: '#', block: false };
    case '.sql': case '.lua': case '.hs': case '.elm':
      return { line: '--', block: false };
    case '.css': case '.scss':
      return { line: null, block: true };
    default:
      return null;
  }
}

/**
 * Comment shapes that are never rationale, however many keywords they contain:
 * decorative section banners, licence headers, and tooling directives.
 */
const BANNER_RE = /^[\s\-=*_~#/]*$/;
const NON_RATIONALE_RE = /^(?:copyright\b|licen[sc]ed?\b|spdx-|all rights reserved|eslint-|@ts-|prettier-|jshint|globals?\s|istanbul\s)/i;
/** A comment above an import block is a file header, not a decision about it. */
const IMPORT_SUBJECT_RE = /^(?:import\s|from\s|require\b|const\s+\{?[\w\s,}]*\}?\s*=\s*require\(|#include\b|using\s|use\s|package\s|@import\b|module\s)/;

const RATIONALE_MAX = 90;         // across the whole repository
const CONSTANTS_MAX = 140;
const RATIONALE_PER_FILE = 6;
const RATIONALE_TEXT_MAX = 420;
const SUBJECT_MAX = 150;
const CONST_PER_FILE = 12;
const CONST_VALUE_MAX = 90;

/**
 * Only literal values count as tuning knobs: numbers (including arithmetic
 * like `2 * 1024 * 1024`), strings, and booleans. `const PUBLIC_DIR =
 * path.join(...)` is a derived path, not a decision someone tuned, and listing
 * it dilutes the table that matters.
 */
const CONST_VALUE_LITERAL_RE = new RegExp(
  '^(?:'
  + '-?\\d[\\d_]*(?:\\.\\d+)?(?:\\s*[*+/-]\\s*-?\\d[\\d_]*(?:\\.\\d+)?)*'   // 5000, 2 * 1024 * 1024
  + "|true|false|null"
  + "|'[^']*'|\"[^\"]*\"|`[^`$]*`"                                                  // plain string literals
  + ')$',
);

/**
 * Named constants: `const FOO_MS = 5000`, `FOO = 5000`, `#define FOO 5000`.
 * Deliberately restricted to SCREAMING_SNAKE names: those are the ones the
 * author elevated to a named knob, which is exactly the population a rationale
 * document needs to account for.
 */
const CONST_RE = /^\s*(?:export\s+|public\s+|private\s+|internal\s+|protected\s+|static\s+|final\s+|const\s+|let\s+|var\s+|val\s+|pub\s+|#define\s+)*([A-Z][A-Z0-9_]{2,})\s*(?::\s*[^=]+?)?\s*(?:=|\s)\s*([^;]+?)\s*;?\s*$/;

/**
 * Harvest rationale comments and named constants from one already-read file.
 *
 * Runs inside the existing `textScan` pass rather than opening files again:
 * the lines are already split and the credential skip has already been
 * applied, so the marginal cost of this is a regex sweep, not any new I/O.
 */
function harvestFile(rel, ext, lines) {
  const syn = commentSyntax(ext);
  if (!syn) return { rationale: [], constants: [] };

  const rationale = [];
  const constants = [];
  const documented = new Set();     // line numbers preceded by a comment run

  let i = 0;
  while (i < lines.length) {
    const collected = [];
    const startLine = i + 1;
    let inBlock = false;

    // Gather a contiguous comment run.
    while (i < lines.length) {
      const raw = lines[i];
      const t = raw.trim();
      if (inBlock) {
        collected.push(t.replace(/^\*+\s?/, '').replace(/\*\/\s*$/, ''));
        if (t.includes('*/')) inBlock = false;
        i++;
        continue;
      }
      if (syn.block && /^\/\*/.test(t)) {
        collected.push(t.replace(/^\/\*+\s?/, '').replace(/\*\/\s*$/, ''));
        if (!t.includes('*/')) inBlock = true;
        i++;
        continue;
      }
      if (syn.line && t.startsWith(syn.line)) {
        collected.push(t.slice(syn.line.length).trim());
        i++;
        continue;
      }
      break;
    }

    if (!collected.length) { i++; continue; }

    // The declaration the comment sits above, skipping blank lines.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const subject = j < lines.length ? lines[j].trim() : '';
    if (subject) documented.add(j + 1);

    // Strip decorative rules (`/* ---- Section ---- */`) so a banner cannot
    // masquerade as an explanation, and so the text that survives is prose.
    const text = collected
      .filter((l) => !BANNER_RE.test(l))
      .join(' ')
      .replace(/[-=*_~]{4,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // A multi-line block is a deliberate explanation; a one-liner has to earn
    // its place by actually containing reasoning.
    const usable = text.length >= 25
      && !NON_RATIONALE_RE.test(text)
      && subject
      && !IMPORT_SUBJECT_RE.test(subject);
    const worthy = usable && (collected.length >= 2 ? WHY_RE.test(text) || text.length > 90 : WHY_RE.test(text));
    if (worthy && rationale.length < RATIONALE_PER_FILE) {
      rationale.push({
        path: rel,
        line: startLine,
        text: util.truncateWords(text, RATIONALE_TEXT_MAX),
        subject: util.truncateWords(subject, SUBJECT_MAX),
      });
    }
  }

  for (let k = 0; k < lines.length && constants.length < CONST_PER_FILE; k++) {
    const t = lines[k].trim();
    if (!t || t.length > 200) continue;
    if (syn.line && t.startsWith(syn.line)) continue;
    const m = CONST_RE.exec(t);
    if (!m) continue;
    const value = m[2].trim();
    // Skip type-only declarations and anything that is obviously a whole
    // expression body rather than a tuning value.
    if (!value || value.length > CONST_VALUE_MAX) continue;
    if (!CONST_VALUE_LITERAL_RE.test(value)) continue;
    constants.push({
      path: rel,
      line: k + 1,
      name: m[1],
      value: util.truncateWords(value, CONST_VALUE_MAX),
      documented: documented.has(k + 1),
    });
  }

  return { rationale, constants };
}

/* ------------------------------------------------------------------ *
 * Code surface: what the project actually imports, calls and uses
 * ------------------------------------------------------------------ */

/**
 * Evidence for the code-breakdown document: which libraries are genuinely in
 * use (not merely declared in a manifest), which language constructs appear
 * and where, which external services and environment variables are touched.
 *
 * This is an INDEX, not a copy of the code. The authoring model has Read,
 * Glob and Grep, so the useful thing to hand it is precise coordinates:
 * "asyncIterator appears at lib/foo.js:88", and let it open the file and
 * quote the real lines. Shipping excerpts instead would burn the budget and
 * still leave the model unable to see the surrounding context.
 *
 * Nothing here records a VALUE. Environment variables are recorded by name
 * only, and URLs are reduced to their host, so a token embedded in a query
 * string cannot ride along into the brief.
 */

const IMPORT_PATTERNS = [
  // JS/TS: import x from 'y' / import 'y' / export … from 'y'
  { ext: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'], re: /(?:^|\s)(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g },
  { ext: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'], re: /(?:^|\s)import\s*['"]([^'"]+)['"]/g },
  { ext: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'], re: /require\(\s*['"]([^'"]+)['"]\s*\)/g },
  // Python
  { ext: ['.py'], re: /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s/gm },
  { ext: ['.py'], re: /^\s*import\s+([A-Za-z_][\w.]*)/gm },
  // Swift / Go / Rust / Java / Kotlin
  { ext: ['.swift'], re: /^\s*import\s+([A-Za-z_][\w.]*)/gm },
  { ext: ['.go'], re: /^\s*(?:import\s+)?"([a-z0-9][\w./-]+)"/gm },
  { ext: ['.rs'], re: /^\s*use\s+([a-z_][\w:]*)/gm },
  { ext: ['.java', '.kt'], re: /^\s*import\s+([a-z][\w.]*)/gm },
  { ext: ['.rb'], re: /^\s*require\s+['"]([^'"]+)['"]/gm },
];

/**
 * A module path that points back into the project rather than out to a
 * dependency.
 *
 * Relative paths are obvious. The subtle case is Python (and Go), where a
 * first-party package is imported by its plain name: `from src.contract
 * import ...` is indistinguishable from a PyPI package until you notice that
 * `src/` is a directory in this repository. `localRoots` carries the project's
 * own top-level directory and module names so those stop being reported as
 * third-party libraries.
 */
function isLocalModule(name, localRoots) {
  if (/^[./]/.test(name) || name.startsWith('~/') || name.startsWith('@/')) return true;
  if (localRoots && localRoots.size) {
    const head = name.split(/[./]/)[0];
    if (head && localRoots.has(head)) return true;
  }
  return false;
}

/**
 * Language constructs worth explaining to someone learning the codebase.
 * Chosen for teachability: each one is a thing a reader might not know, that
 * changes how the surrounding code must be read.
 */
const CONSTRUCT_PATTERNS = {
  js: [
    ['async/await', /\basync\s+(?:function|\(|[A-Za-z_$])|\bawait\s/],
    ['generator function', /\bfunction\s*\*|\byield\s/],
    ['async iterator (for await)', /\bfor\s+await\s*\(/],
    ['destructuring', /(?:const|let|var)\s*[{[][^=;]{2,}[}\]]\s*=/],
    ['spread / rest', /\.\.\.[A-Za-z_$]/],
    ['optional chaining', /\?\./],
    ['nullish coalescing', /\?\?/],
    ['template literal', /`[^`]*\$\{/],
    ['class', /\bclass\s+[A-Za-z_$][\w$]*/],
    ['Promise combinator', /\bPromise\.(?:all|race|allSettled|any)\b/],
    ['EventEmitter', /\bEventEmitter\b|\.emit\(|\.on\(['"]/],
    ['Proxy / Reflect', /\bnew\s+Proxy\b|\bReflect\./],
    ['Symbol', /\bSymbol\s*\(/],
    ['getter/setter', /^\s*(?:get|set)\s+[A-Za-z_$][\w$]*\s*\(/m],
    ['regular expression', /=\s*\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/],
    ['tagged union / switch', /\bswitch\s*\(/],
    ['AbortController', /\bAbortController\b|\bsignal\s*:/],
    ['WeakMap / WeakSet', /\bWeak(?:Map|Set)\b/],
    ['labelled template / SVG namespace', /createElementNS/],
  ],
  py: [
    ['decorator', /^\s*@[A-Za-z_][\w.]*/m],
    ['async/await', /\basync\s+def\b|\bawait\s/],
    ['comprehension', /\[[^\]\n]*\bfor\b[^\]\n]*\]|\{[^}\n]*\bfor\b[^}\n]*\}/],
    ['generator / yield', /\byield\b/],
    ['context manager (with)', /^\s*(?:async\s+)?with\s+/m],
    ['dataclass', /@dataclass\b|\bfrom\s+dataclasses\b/],
    ['type hints', /def\s+\w+\s*\([^)]*:\s*[A-Za-z_]|->\s*[A-Za-z_\[]/],
    ['f-string', /\bf["'][^"']*\{/],
    ['class', /^\s*class\s+\w+/m],
    ['walrus operator', /:=/],
  ],
  swift: [
    ['optional / unwrapping', /\bif\s+let\b|\bguard\s+let\b|\?\?/],
    ['closure', /\{\s*\(?[\w\s,:]*\)?\s*(?:->\s*\w+\s*)?in\b/],
    ['protocol', /\bprotocol\s+\w+/],
    ['extension', /\bextension\s+\w+/],
    ['async/await', /\basync\b|\bawait\b/],
    ['property wrapper', /@(?:State|Binding|Published|ObservedObject|StateObject|Environment)\b/],
    ['result builder / SwiftUI body', /\bvar\s+body\s*:\s*some\s+View/],
  ],
};

function constructSetFor(ext) {
  switch (ext) {
    case '.js': case '.mjs': case '.cjs': case '.ts': case '.tsx': case '.jsx': return CONSTRUCT_PATTERNS.js;
    case '.py': return CONSTRUCT_PATTERNS.py;
    case '.swift': return CONSTRUCT_PATTERNS.swift;
    default: return null;
  }
}

const ENV_PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([^'"]+)['"]\s*\]/g,
  /os\.environ(?:\.get)?\[?\(?\s*['"]([^'"]+)['"]/g,
  /getenv\(\s*['"]([^'"]+)['"]/g,
  /ProcessInfo\.processInfo\.environment\[\s*['"]([^'"]+)['"]/g,
];

/** Host only: never the path or query, which is where tokens hide. */
const URL_RE = /\bhttps?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?/g;

const IMPORT_SITES_MAX = 4;
const CONSTRUCT_SITES_MAX = 3;

/**
 * Harvest the code surface of one already-read file. Runs inside `textScan`
 * alongside the rationale harvest, so it costs a regex sweep and no new I/O.
 */
function harvestCode(rel, ext, text, lines, acc, localRoots) {
  /* imports */
  for (const spec of IMPORT_PATTERNS) {
    if (!spec.ext.includes(ext)) continue;
    spec.re.lastIndex = 0;
    let m;
    while ((m = spec.re.exec(text)) !== null) {
      const name = (m[1] || '').trim();
      if (!name || name.length > 120) continue;
      const local = isLocalModule(name, localRoots);
      // Bare package root: `lodash/fp` and `node:fs/promises` both collapse to
      // the thing a reader would actually look up.
      let key = name;
      if (!local) {
        if (name.startsWith('@')) key = name.split('/').slice(0, 2).join('/');
        else if (name.startsWith('node:')) key = name;
        else key = name.split('/')[0];
      }
      const bucket = local ? acc.localImports : acc.imports;
      let rec = bucket.get(key);
      if (!rec) { rec = { name: key, count: 0, sites: [] }; bucket.set(key, rec); }
      rec.count++;
      if (rec.sites.length < IMPORT_SITES_MAX && !rec.sites.includes(rel)) rec.sites.push(rel);
    }
  }

  /* constructs */
  const set = constructSetFor(ext);
  if (set) {
    for (const [label, re] of set) {
      let line = 0;
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) { line = i + 1; break; }
      }
      if (!line) continue;
      let rec = acc.constructs.get(label);
      if (!rec) { rec = { label, count: 0, sites: [] }; acc.constructs.set(label, rec); }
      rec.count++;
      if (rec.sites.length < CONSTRUCT_SITES_MAX) rec.sites.push(`${rel}:${line}`);
    }
  }

  /* environment variables: names only, never values */
  for (const re of ENV_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = (m[1] || '').trim();
      if (name && name.length <= 80 && acc.envVars.size < 60) acc.envVars.add(name);
    }
  }

  /* outbound hosts: host only, never path or query */
  URL_RE.lastIndex = 0;
  let u;
  while ((u = URL_RE.exec(text)) !== null) {
    const host = u[1];
    if (!host || acc.hosts.size >= 40) break;
    // Documentation and fixture hosts are not services this project talks to.
    if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(host)) continue;
    if (/(?:^|\.)(?:example|invalid|test|local|localdomain)$/i.test(host)) continue;
    if (/^example\.(?:com|org|net)$/i.test(host)) continue;
    // Schema and docs URLs say nothing about what the code talks to.
    if (/(?:w3\.org|schema\.org|json-schema\.org|creativecommons\.org)$/i.test(host)) continue;
    acc.hosts.add(host);
  }
}

function textScan(root, walked) {
  const todos = [];
  let todoCount = 0;
  const pythonMains = new Set();
  const frameworks = new Set();
  const rationale = [];
  const constants = [];
  const code = {
    imports: new Map(),
    localImports: new Map(),
    constructs: new Map(),
    envVars: new Set(),
    hosts: new Set(),
  };
  let filesRead = 0;
  let bytesRead = 0;
  let skippedSensitive = 0;

  // Shallowest first: root-level source is far more interesting than fixtures.
  const candidates = walked.files
    .filter((f) => f.size > 0 && f.size <= TEXT_SCAN_MAX_FILE && isCodeish(f))
    .sort((a, b) => a.depth - b.depth || b.size - a.size);

  // Top-level directory names and root module basenames: the project's own
  // namespace, used to tell a first-party import from a dependency.
  const localRoots = new Set();
  for (const rel of walked.dirs.keys()) {
    if (rel && !rel.includes('/')) localRoots.add(rel);
  }
  for (const f of walked.files) {
    if (f.depth === 1) localRoots.add(f.name.replace(/\.[^.]+$/, ''));
  }

  let hitCap = false;
  for (const f of candidates) {
    if (filesRead >= TEXT_SCAN_MAX_FILES || bytesRead >= TEXT_SCAN_MAX_BYTES) { hitCap = true; break; }
    if (isSensitive(f.rel)) { skippedSensitive++; continue; }

    let text;
    try { text = fs.readFileSync(path.join(root, f.rel), 'utf8'); }
    catch { continue; }
    filesRead++;
    bytesRead += f.size;

    if (/if\s+__name__\s*==\s*["']__main__["']/.test(text)) pythonMains.add(f.rel);

    if (/\bimport\s+pytest\b|\bfrom\s+pytest\b/.test(text)) frameworks.add('pytest');
    if (/\bimport\s+unittest\b/.test(text)) frameworks.add('unittest');
    if (/\bimport\s+XCTest\b/.test(text)) frameworks.add('XCTest');
    if (/\bfrom\s+fastapi\b|\bimport\s+fastapi\b/.test(text)) frameworks.add('FastAPI');
    if (/\bfrom\s+flask\b|\bimport\s+flask\b/i.test(text)) frameworks.add('Flask');
    if (/\bimport\s+streamlit\b/.test(text)) frameworks.add('Streamlit');
    if (/\bimport\s+SwiftUI\b/.test(text)) frameworks.add('SwiftUI');
    if (/require\(['"]express['"]\)|from\s+['"]express['"]/.test(text)) frameworks.add('Express');
    if (/\bimport\s+torch\b/.test(text)) frameworks.add('PyTorch');
    if (/\bimport\s+pandas\b/.test(text)) frameworks.add('pandas');

    const lines = text.split(/\r?\n/);

    // Code surface, harvested from the same read (see harvestCode).
    try { harvestCode(f.rel, f.ext, text, lines, code, localRoots); } catch { /* never fail a scan over this */ }

    // Design evidence, harvested from the same read (see harvestFile).
    if (rationale.length < RATIONALE_MAX || constants.length < CONSTANTS_MAX) {
      let got;
      try { got = harvestFile(f.rel, f.ext, lines); } catch { got = null; }
      if (got) {
        for (const r of got.rationale) if (rationale.length < RATIONALE_MAX) rationale.push(r);
        for (const c of got.constants) if (constants.length < CONSTANTS_MAX) constants.push(c);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const m = TODO_LINE_RE.exec(lines[i]);
      if (!m) continue;
      todoCount++;
      if (todos.length < 60) {
        todos.push({
          path: f.rel,
          line: i + 1,
          marker: m[1],
          text: util.truncateWords(m[2] || lines[i], 140),
        });
      }
    }
  }

  return {
    todos, todoCount, pythonMains, frameworks: [...frameworks],
    rationale, constants, code,
    filesRead, skippedSensitive,
    candidates: candidates.length,
    // Only "partial" when we actually stopped early: skipping a credential
    // file is deliberate, not a shortfall.
    partial: hitCap,
  };
}

/* ------------------------------------------------------------------ *
 * Run commands
 * ------------------------------------------------------------------ */

function collectRunCommands(project, manifests, walked, scanned) {
  const cmds = [];
  const push = (command, source, note) => {
    if (!command) return;
    if (cmds.some((c) => c.command === command)) return;
    cmds.push({ command, source, note: note || null });
  };

  for (const m of manifests) {
    const p = m.parsed;
    if (!p) continue;
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '';
    const prefix = dir ? `(in ${dir}/) ` : '';

    if (m.kind === 'npm') {
      for (const [name, body] of Object.entries(p.scripts || {})) {
        push(`${prefix}npm run ${name}`, m.path, String(body).slice(0, 160));
      }
      if (p.bin) {
        const bins = typeof p.bin === 'string' ? { [p.name || 'bin']: p.bin } : p.bin;
        for (const [name, target] of Object.entries(bins)) push(`${prefix}node ${target}`, `${m.path} bin.${name}`);
      }
      if (!p.scripts && p.main) push(`${prefix}node ${p.main}`, `${m.path} main`);
    } else if (m.kind === 'makefile') {
      for (const t of p.targets || []) push(`${prefix}make ${t}`, m.path);
    } else if (m.kind === 'pyproject') {
      for (const [name, target] of Object.entries(p.scripts || {})) push(`${prefix}${name}`, `${m.path} scripts`, String(target));
    } else if (m.kind === 'setup.py') {
      for (const s of p.consoleScripts || []) push(`${prefix}${String(s).split('=')[0].trim()}`, `${m.path} console_scripts`);
    } else if (m.kind === 'requirements') {
      push(`${prefix}pip install -r ${m.path}`, m.path, 'dependency install, inferred from the file existing');
    } else if (m.kind === 'swiftpm') {
      push('swift build', m.path);
      for (const prod of p.products || []) push(`swift run ${prod}`, `${m.path} products`);
      if (!(p.products || []).length) push('swift run', m.path);
      push('swift test', m.path);
    } else if (m.kind === 'cargo') {
      push('cargo build', m.path);
      push('cargo run', m.path);
      push('cargo test', m.path);
    } else if (m.kind === 'gomod') {
      push('go build ./...', m.path);
      push('go test ./...', m.path);
    } else if (m.kind === 'gemfile') {
      push('bundle install', m.path);
    } else if (m.kind === 'dockerfile') {
      push(`docker build -t ${project.id} -f ${m.path} .`, m.path);
      if (p.cmd) push('docker run <image>', `${m.path} CMD`, p.cmd);
    } else if (m.kind === 'compose') {
      push(`docker compose -f ${m.path} up`, m.path);
    } else if (m.kind === 'xcode') {
      push(`open ${m.path}`, m.path, 'Xcode project, build from the IDE');
    }
  }

  // Python entry files, ranked shallowest-first.
  const mains = [...scanned.pythonMains].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const rel of mains.slice(0, 8)) push(`python ${rel}`, `${rel}: has an \`if __name__ == "__main__"\` guard`);

  // main.swift
  for (const f of walked.files) {
    if (f.name.toLowerCase() === 'main.swift') push('swift run', `${f.rel} exists`);
  }

  // bin/* executables
  for (const f of walked.files) {
    if (!/^bin\//.test(f.rel) || f.depth > 2) continue;
    let exec = false;
    try { fs.accessSync(path.join(project.path, f.rel), fs.constants.X_OK); exec = true; } catch { /* not executable */ }
    if (exec) push(`./${f.rel}`, `${f.rel} is executable`);
  }

  // A bare HTML project is "opened", not "run".
  if (!cmds.length) {
    const html = walked.files.find((f) => f.depth <= 2 && (f.name === 'index.html' || f.ext === '.html'));
    if (html) push(`open ${html.rel}`, `${html.rel}: static page, no build step found`);
  }

  return cmds.slice(0, 40);
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

const ENTRY_BASENAMES = new Map([
  ['main', 55], ['index', 50], ['app', 48], ['__main__', 55], ['cli', 45],
  ['server', 45], ['run', 40], ['start', 38], ['bot', 34],
]);

const SOURCE_LANGS = new Set([
  'Python', 'JavaScript', 'TypeScript', 'Swift', 'Go', 'Rust', 'Ruby', 'Java',
  'Kotlin', 'C', 'C++', 'C#', 'Objective-C', 'Objective-C++', 'Shell', 'PHP',
  'Lua', 'R', 'Julia', 'Dart', 'Scala', 'Elixir', 'Haskell', 'Vue', 'Svelte',
  'HTML', 'SQL', 'Notebook',
]);

function collectEntryPoints(manifests, walked, scanned) {
  const declared = new Set();
  const targetDirs = [];        // SwiftPM/Cargo target roots, e.g. Sources/SpriteRoomApp
  for (const m of manifests) {
    const p = m.parsed;
    if (!p) continue;
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) + '/' : '';
    if (p.main) declared.add(dir + String(p.main).replace(/^\.\//, ''));
    if (p.module) declared.add(dir + String(p.module).replace(/^\.\//, ''));
    if (p.bin) {
      const bins = typeof p.bin === 'string' ? [p.bin] : Object.values(p.bin);
      for (const b of bins) declared.add(dir + String(b).replace(/^\.\//, ''));
    }
    if (m.kind === 'swiftpm') {
      // A SwiftPM product is a directory of Swift files, not one file: treat
      // `Sources/<product>/` as declared so its contents outrank helper scripts.
      for (const t of [].concat(p.products || [], p.targets || [])) {
        targetDirs.push(`${dir}Sources/${t}/`);
      }
    }
  }

  // Shallowest directory that actually holds source, for the "largest source
  // file in the shallowest source dir" rule.
  const sourceFiles = walked.files.filter((f) => !f.isBundle && SOURCE_LANGS.has(langForExt(f.ext) || ''));
  let shallowest = Infinity;
  for (const f of sourceFiles) if (f.depth < shallowest) shallowest = f.depth;
  let biggestShallow = null;
  for (const f of sourceFiles) {
    if (f.depth !== shallowest) continue;
    if (!biggestShallow || f.size > biggestShallow.size) biggestShallow = f;
  }

  const scored = [];
  for (const f of sourceFiles) {
    if (/(^|\/)(test|tests|__tests__|spec|specs|fixtures?|examples?|vendor|migrations)(\/|$)/i.test(f.rel)) continue;
    if (/^test_|_test\.|\.test\.|\.spec\./i.test(f.name)) continue;

    const base = f.name.replace(/\.[^.]+$/, '').toLowerCase();
    const why = [];
    let score = 0;

    if (declared.has(f.rel)) { score += 70; why.push('declared in a manifest'); }
    const inTarget = targetDirs.find((d) => f.rel.startsWith(d));
    if (inTarget) { score += 30; why.push(`inside the declared target \`${inTarget.replace(/\/$/, '')}\``); }
    const bn = ENTRY_BASENAMES.get(base);
    if (bn) { score += bn; why.push(`named \`${f.name}\``); }
    if (/App\.swift$|AppDelegate\.swift$|ContentView\.swift$/.test(f.name)) { score += 35; why.push('SwiftUI/AppKit application entry'); }
    if (scanned.pythonMains.has(f.rel)) { score += 45; why.push('has an `if __name__ == "__main__"` guard'); }
    if (biggestShallow && f.rel === biggestShallow.rel) { score += 25; why.push('largest source file at the shallowest level'); }
    if (f.name.toLowerCase() === 'main.swift') { score += 25; why.push('SwiftPM executable entry'); }
    // Helper scripts are real, but they are not where you start reading.
    if (/^(scripts?|tools?|bin)\//.test(f.rel)) { score -= 18; }

    if (!score) continue;
    score -= (f.depth - 1) * 6;                             // shallower reads first
    score += Math.min(14, Math.round(Math.log2(f.size + 2))); // bigger file = more substance

    scored.push({ path: f.rel, sizeBytes: f.size, score, why });
  }

  if (!scored.length && biggestShallow) {
    scored.push({
      path: biggestShallow.rel,
      sizeBytes: biggestShallow.size,
      score: 1,
      why: ['largest source file at the shallowest level (nothing else stood out)'],
    });
  }

  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 10);
}

/**
 * The source files worth naming. The structure table says "rlog/: 16 files,
 * mostly .py"; this says *which* 16. For a project with no documentation at
 * all it is the only inventory the author gets.
 */
function collectSourceFiles(walked, limit = 45) {
  return walked.files
    .filter((f) => !f.isBundle && SOURCE_LANGS.has(langForExt(f.ext) || '') && f.size > 0)
    .sort((a, b) => a.depth - b.depth || b.size - a.size)
    .slice(0, limit)
    .map((f) => ({ path: f.rel, sizeBytes: f.size, lang: langForExt(f.ext) }));
}

/* ------------------------------------------------------------------ *
 * Signals: tests, config, sensitive files
 * ------------------------------------------------------------------ */

const CONFIG_NAMES = [
  /^\.env/i, /^creds?/i, /secrets?/i, /^config\./i, /^settings\./i,
  /^tsconfig(\.\w+)?\.json$/i, /^jsconfig\.json$/i, /^\.eslintrc/i, /^\.prettierrc/i,
  /^setup\.cfg$/i, /^tox\.ini$/i, /^pytest\.ini$/i, /^mypy\.ini$/i, /^ruff\.toml$/i,
  /^\.python-version$/i, /^\.nvmrc$/i, /^\.tool-versions$/i, /^Procfile$/i,
  /^netlify\.toml$/i, /^vercel\.json$/i, /^railway\.json$/i, /^fly\.toml$/i,
  /^\.gitignore$/i, /^\.dockerignore$/i, /^\.editorconfig$/i,
  /\.ya?ml$/i, /\.toml$/i, /\.ini$/i, /\.cfg$/i, /\.plist$/i,
];

function isConfigish(name) {
  return CONFIG_NAMES.some((re) => re.test(name));
}

function collectSignals(project, walked, scanned, dirtyFiles) {
  const testDirs = [];
  for (const [rel, info] of walked.dirs) {
    if (info.depth > 3) continue;
    const base = rel.split('/').pop().toLowerCase();
    if (['test', 'tests', '__tests__', 'spec', 'specs', 'testing'].includes(base)) testDirs.push(rel);
  }
  const testFiles = walked.files
    .filter((f) => /^test_|_test\.|\.test\.|\.spec\.|Tests?\.swift$/i.test(f.name))
    .map((f) => f.rel);

  const configFiles = [];
  const sensitiveFiles = [];
  for (const f of walked.files) {
    if (f.depth > 3) continue;
    if (isSensitive(f.rel)) {
      // Name only. Never opened, never sampled, never quoted.
      sensitiveFiles.push({ path: f.rel, sizeBytes: f.size, note: 'not read: potential credentials' });
      continue;
    }
    if (f.depth <= 2 && isConfigish(f.name)) configFiles.push({ path: f.rel, sizeBytes: f.size });
  }

  const workflows = walked.files
    .filter((f) => /^\.github\/workflows\//.test(f.rel))
    .map((f) => f.rel);

  return {
    todoCount: scanned.todoCount || project.todoCount || 0,
    todoCountFromScan: scanned.todoCount,
    todoSamples: scanned.todos.slice(0, TODO_SAMPLES),
    todoSamplesTotal: scanned.todos.length,
    hasTests: Boolean(testDirs.length || testFiles.length || project.hasTests),
    testDirs: testDirs.slice(0, 12),
    testFiles: testFiles.slice(0, 20),
    testFileCount: testFiles.length,
    frameworks: scanned.frameworks,
    dirtyFiles: (dirtyFiles || []).slice(0, 40),
    configFiles: configFiles.slice(0, 40),
    sensitiveFiles: sensitiveFiles.slice(0, 30),
    workflows: workflows.slice(0, 10),
    scanPartial: scanned.partial,
    filesTextScanned: scanned.filesRead,
  };
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

async function collectHistory(project) {
  const empty = {
    isGit: false, commitCount: 0, firstCommitISO: null, lastCommitISO: null,
    subjects: [], activity: [], topChangedFiles: [], authors: [],
  };
  if (!project.isGit) return empty;

  const dir = project.path;
  const [subjectsRaw, rootRaw, nameOnlyRaw, authorsRaw, activity] = await Promise.all([
    gitlib.git(dir, ['log', `-${COMMIT_SUBJECTS}`, '--format=%h\x1f%aI\x1f%s\x1f%an']),
    gitlib.git(dir, ['log', '--max-parents=0', '--format=%aI']),
    gitlib.git(dir, ['log', '-400', '--name-only', '--format=']),
    gitlib.git(dir, ['shortlog', '-sn', '--all', '--no-merges']),
    gitlib.activity(dir, 90).catch(() => []),
  ]);

  const subjects = (subjectsRaw || '').split('\n').filter(Boolean).map((line) => {
    const [sha, iso, subject, author] = line.split('\x1f');
    return { sha: sha || '', dateISO: iso || null, relative: relativeTime(iso), subject: subject || '', author: author || '' };
  });

  let firstCommitISO = null;
  if (rootRaw) {
    const dates = rootRaw.split('\n').map((s) => Date.parse(s.trim())).filter(Number.isFinite);
    if (dates.length) firstCommitISO = new Date(Math.min(...dates)).toISOString();
  }

  const counts = new Map();
  for (const line of (nameOnlyRaw || '').split('\n')) {
    const p = line.trim();
    if (!p) continue;
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  const topChangedFiles = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([p, changes]) => ({ path: p, changes }));

  const authors = (authorsRaw || '').split('\n').filter(Boolean).slice(0, 6).map((l) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    return m ? { name: m[2], commits: Number(m[1]) || 0 } : null;
  }).filter(Boolean);

  const g = project.git || {};
  return {
    isGit: true,
    branch: g.branch || null,
    remote: g.remote || null,
    ahead: g.ahead || 0,
    behind: g.behind || 0,
    commitCount: g.commitCount || subjects.length,
    commitsLast30d: g.commitsLast30d || 0,
    firstCommitISO,
    lastCommitISO: g.lastCommitISO || (subjects[0] ? subjects[0].dateISO : null),
    subjects,
    // Aliases so downstream consumers find these under the names they expect.
    recentCommits: subjects,
    activity,
    topChangedFiles,
    topFiles: topChangedFiles,
    authors,
    windowNote: counts.size ? 'most-changed files computed over the last 400 commits' : null,
  };
}

/* ------------------------------------------------------------------ *
 * Prose
 * ------------------------------------------------------------------ */

/**
 * The featured doc plus README and CLAUDE.md, in full (capped). This is the
 * single most valuable input in the brief; the author is told to build on it
 * rather than restate it.
 */
function collectProse(project) {
  const wanted = [];
  const seen = new Set();

  const add = (doc, role) => {
    if (!doc || seen.has(doc.path)) return;
    seen.add(doc.path);
    wanted.push({ doc, role });
  };

  add(project.featuredDoc, 'featured');
  for (const d of project.docs || []) {
    if (d.kind === 'readme' && d.path.split('/').length === 1) add(d, 'readme');
  }
  for (const d of project.docs || []) {
    if (d.kind === 'claude') add(d, 'claude');
  }
  // If none of the above existed, take the richest remaining markdown doc.
  if (!wanted.length) {
    const md = (project.docs || []).filter((d) => d.contentType === 'markdown')
      .sort((a, b) => b.wordCount - a.wordCount)[0];
    if (md) add(md, 'fallback');
  }

  const out = [];
  for (const { doc, role } of wanted.slice(0, 4)) {
    if (isSensitive(doc.path)) continue;
    const got = readProse(path.join(project.path, doc.path), doc.path);
    if (!got || !got.text.trim()) continue;
    out.push({
      path: doc.path,
      role,
      kind: doc.kind,
      title: doc.title,
      contentType: doc.contentType,
      wordCount: doc.wordCount,
      originalBytes: got.originalBytes,
      truncated: got.truncated,
      text: got.text,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Design documents and commit rationale
 * ------------------------------------------------------------------ */

const DESIGN_DOC_BASENAME_RE = /^(?:adr|rfc|design|architecture|contract|decisions?|rationale|spec|proposal)\b/i;
const DESIGN_DOC_DIR_RE = /(?:^|\/)(?:adr|adrs|rfc|rfcs|decisions|design|architecture|specs?|proposals?)(?:\/|$)/i;
const DESIGN_DOC_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);

const DESIGN_DOC_MAX = 8;
const DESIGN_DOC_CAP = 20 * 1024;         // per document
const DESIGN_DOC_TOTAL = 110 * 1024;      // across all of them

/**
 * ADRs, RFCs, CONTRACT/DESIGN/ARCHITECTURE files: the documents where an
 * author states intent directly.
 *
 * `collectProse` only reaches the featured doc, README and CLAUDE.md, so on a
 * repository that keeps its reasoning in a separate design document none of it
 * would otherwise reach the model. `skip` carries the paths prose already read
 * so the same bytes are never sent twice.
 */
function collectDesignDocs(project, walked, skip) {
  const seen = new Set(skip || []);
  const candidates = [];

  for (const f of walked.files) {
    if (seen.has(f.rel)) continue;
    if (!DESIGN_DOC_EXT.has(f.ext)) continue;
    if (isSensitive(f.rel)) continue;
    const base = f.name.replace(/\.[^.]+$/, '');
    const inDesignDir = DESIGN_DOC_DIR_RE.test(f.rel.slice(0, f.rel.lastIndexOf('/') + 1));
    if (!DESIGN_DOC_BASENAME_RE.test(base) && !inDesignDir) continue;
    if (f.size <= 0) continue;
    candidates.push(f);
  }

  // Shallowest first, then largest: a root CONTRACT.md outranks a deep note.
  candidates.sort((a, b) => a.depth - b.depth || b.size - a.size);

  const out = [];
  let total = 0;
  for (const f of candidates) {
    if (out.length >= DESIGN_DOC_MAX || total >= DESIGN_DOC_TOTAL) break;
    const room = Math.min(DESIGN_DOC_CAP, DESIGN_DOC_TOTAL - total);
    const got = readProse(path.join(project.path, f.rel), f.rel, room);
    if (!got || !got.text.trim()) continue;
    total += Buffer.byteLength(got.text, 'utf8');
    out.push({
      path: f.rel,
      bytes: f.size,
      originalBytes: got.originalBytes,
      truncated: got.truncated,
      text: got.text,
    });
  }
  return { docs: out, candidates: candidates.length, omitted: Math.max(0, candidates.length - out.length) };
}

const COMMIT_BODIES = 80;
const COMMIT_BODY_MAX = 900;

/**
 * Commit message *bodies*. A subject says what changed; a body is the only
 * place in a repository where an author routinely writes down why they made a
 * choice at the moment they made it. Commits without a body are skipped:
 * they carry no rationale by definition.
 */
async function collectCommitRationale(project) {
  if (!project.isGit) return [];
  // \x1e terminates each record so multi-line bodies survive the split.
  const raw = await gitlib.git(project.path, [
    'log', `-${COMMIT_BODIES}`, '--no-merges', '--format=%h%x1f%aI%x1f%s%x1f%b%x1e',
  ]);
  if (!raw) return [];

  const out = [];
  for (const rec of raw.split('\x1e')) {
    const line = rec.replace(/^\s+/, '');
    if (!line) continue;
    const [sha, iso, subject, body] = line.split('\x1f');
    const text = (body || '').trim();
    if (!text) continue;
    out.push({
      sha: sha || '',
      dateISO: iso || null,
      relative: relativeTime(iso),
      subject: subject || '',
      body: util.truncateWords(text.replace(/\s*\n\s*\n\s*/g, ' ¶ ').replace(/\s*\n\s*/g, ' '), COMMIT_BODY_MAX),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * buildBrief
 * ------------------------------------------------------------------ */

/**
 * Gather everything, deterministically. `project` is a ProjectSummary from
 * lib/scan.js (it must carry `path`). Never throws: each section degrades to
 * an empty/partial value and records a caveat in `brief.unknowns`.
 */
async function buildBrief(project, opts = {}) {
  const started = Date.now();
  const unknowns = [];
  const note = (msg) => { if (!unknowns.includes(msg)) unknowns.push(msg); };

  const root = project.path;

  let walked;
  try { walked = walk(root); }
  catch { walked = { files: [], dirs: new Map(), truncated: true }; note('the directory walk failed; structure and entry points are unavailable'); }
  if (walked.truncated) note(`the directory walk hit its ${WALK_MAX_ENTRIES}-entry cap, so counts below depth 3 may be partial`);

  let manifests = [];
  try { manifests = collectManifests(root, walked); } catch { note('manifest parsing failed'); }

  let scanned;
  try { scanned = textScan(root, walked); }
  catch { scanned = { todos: [], todoCount: 0, pythonMains: new Set(), frameworks: [], filesRead: 0, skippedSensitive: 0, partial: true }; note('the text scan failed; TODO samples are unavailable'); }
  if (scanned.partial) note(`only ${scanned.filesRead} files were opened for TODO/entry-point sniffing, so the TODO count is a floor, not a total`);
  if (scanned.skippedSensitive) note(`${scanned.skippedSensitive} file(s) matching credential patterns were skipped without being read`);

  let structure;
  try { structure = buildStructure(walked, TREE_DEPTH); }
  catch { structure = { maxDepth: TREE_DEPTH, rootFiles: [], dirs: [], dirsOmitted: 0, totalFiles: 0, totalBytes: 0, truncated: true }; }

  let entryPoints = [];
  try { entryPoints = collectEntryPoints(manifests, walked, scanned); } catch { note('entry-point ranking failed'); }

  let runCommands = [];
  try { runCommands = collectRunCommands(project, manifests, walked, scanned); } catch { note('run-command discovery failed'); }
  if (!runCommands.length) note('no runnable command could be evidenced anywhere in the repository: do not invent one');

  let prose = [];
  try { prose = collectProse(project); } catch { note('reading the existing documentation failed'); }
  if (!prose.length) note('this project has no README, CLAUDE.md or other prose documentation');

  let dirty = [];
  try { dirty = project.isGit ? await gitlib.dirtyFiles(root, 40) : []; } catch { dirty = []; }

  let history;
  try { history = await collectHistory(project); }
  catch { history = { isGit: Boolean(project.isGit), commitCount: 0, firstCommitISO: null, lastCommitISO: null, subjects: [], activity: [], topChangedFiles: [], authors: [] }; note('git history could not be read'); }
  if (!project.isGit) note('this directory is not a git repository, so there is no commit history');

  let signals;
  try { signals = collectSignals(project, walked, scanned, dirty); }
  catch { signals = { todoCount: 0, todoSamples: [], hasTests: false, testDirs: [], testFiles: [], frameworks: [], dirtyFiles: [], configFiles: [], sensitiveFiles: [], workflows: [] }; }

  if (!signals.hasTests) note('no test directory or test-named file was found');

  /* Code surface ----------------------------------------------------
   * Cheap: the harvest already happened inside textScan. Only assembled for
   * the code-breakdown document, which is its only consumer. */
  let codeSurface = null;
  if (opts.kind === 'code') {
    const c = (scanned.code) || { imports: new Map(), localImports: new Map(), constructs: new Map(), envVars: new Set(), hosts: new Set() };
    const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);

    // A dependency declared in a manifest but never imported is a different
    // fact from one the code actually uses, and the difference is worth
    // reporting rather than smoothing over.
    const declared = new Set();
    for (const man of manifests) {
      for (const key of ['dependencies', 'devDependencies', 'deps', 'requires']) {
        const v = man && man[key];
        if (Array.isArray(v)) for (const d of v) declared.add(String(d && d.name ? d.name : d).split('@')[0]);
        else if (v && typeof v === 'object') for (const d of Object.keys(v)) declared.add(d);
      }
    }

    const imports = [...c.imports.values()].sort(byCount);
    const used = new Set(imports.map((i) => i.name));

    codeSurface = {
      imports,
      localImports: [...c.localImports.values()].sort(byCount).slice(0, 40),
      constructs: [...c.constructs.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      envVars: [...c.envVars].sort(),
      hosts: [...c.hosts].sort(),
      declaredNotImported: [...declared].filter((d) => !used.has(d)).sort().slice(0, 40),
      importedNotDeclared: imports
        .filter((i) => !declared.has(i.name) && !i.name.startsWith('node:'))
        .map((i) => i.name).slice(0, 40),
      coverage: {
        filesRead: scanned.filesRead || 0,
        filesAvailable: scanned.candidates || 0,
        partial: Boolean(scanned.partial),
      },
    };

    if (!imports.length) {
      note('no import or require statement was found in any scanned file: this project may not use external libraries, or its sources were not reached by the scan');
    }
    if (codeSurface.envVars.length) {
      note(`${codeSurface.envVars.length} environment variable name(s) are read by this code; only the NAMES were collected, never any value`);
    }
  }

  /* Design evidence -------------------------------------------------
   * Only gathered for the rationale document. The comment/constant harvest
   * already happened inside textScan for free; what costs extra is reading
   * the design documents and asking git for commit bodies, so onboarding
   * generations skip both. */
  let design = null;
  if (opts.kind === 'design') {
    let designDocs = { docs: [], candidates: 0, omitted: 0 };
    try { designDocs = collectDesignDocs(project, walked, prose.map((d) => d.path)); }
    catch { note('the design-document sweep failed'); }

    let commitRationale = [];
    try { commitRationale = await collectCommitRationale(project); }
    catch { note('commit message bodies could not be read'); }

    const rationale = scanned.rationale || [];
    const constants = scanned.constants || [];
    const undocumented = constants.filter((c) => !c.documented).length;

    if (!rationale.length) {
      note('no explanatory comments were found anywhere in the code: this repository does not write down why it does things, and the rationale document must say so rather than inventing reasons');
    }
    if (!designDocs.docs.length) {
      note('there is no ADR, RFC, CONTRACT, DESIGN or ARCHITECTURE document in this repository');
    }
    if (project.isGit && !commitRationale.length) {
      note('no commit message in the last 80 commits has a body: the git history records what changed but never why');
    }
    if (undocumented) {
      note(`${undocumented} named constant(s) carry no explanatory comment; their values are load-bearing but undocumented`);
    }

    design = {
      rationale,
      constants,
      undocumentedConstants: undocumented,
      designDocs: designDocs.docs,
      designDocsOmitted: designDocs.omitted,
      commitRationale,
      // What the harvest could and could not see, so the author can calibrate
      // how much silence means "no reasoning" versus "not scanned".
      coverage: {
        filesRead: scanned.filesRead || 0,
        filesAvailable: scanned.candidates || 0,
        partial: Boolean(scanned.partial),
      },
    };
  }

  const brief = {
    schema: 1,
    generatedISO: new Date().toISOString(),
    buildMs: 0,
    audience: typeof opts.audience === 'string' ? opts.audience.slice(0, 200) : null,

    identity: {
      id: project.id,
      name: project.name,
      path: project.path,
      status: project.status,
      statusReason: project.statusReason,
      lastActivityISO: project.lastActivityISO,
      lastActivityRelative: project.lastActivityRelative,
      isGit: Boolean(project.isGit),
      branch: project.git ? project.git.branch : null,
      remote: project.git ? project.git.remote : null,
      dirty: project.git ? project.git.dirty : false,
      dirtyCount: project.git ? project.git.dirtyCount : 0,
      ahead: project.git ? project.git.ahead : 0,
      behind: project.git ? project.git.behind : 0,
      blurb: project.blurb || '',
      // The raw ProjectSummary.git block, kept whole so consumers that expect
      // it (lib/artifact-parts.js normalizeBrief) find it where they look.
      git: project.git || null,
    },

    composition: {
      fileCount: project.fileCount,
      dirCount: project.dirCount,
      sizeBytes: project.sizeBytes,
      sizeHuman: humanBytes(project.sizeBytes),
      primaryLanguage: project.primaryLanguage,
      stack: project.stack || [],
      langBreakdown: project.langBreakdown || [],
      hasTests: Boolean(project.hasTests),
    },

    manifests,
    runCommands,
    entryPoints,
    sourceFiles: (() => { try { return collectSourceFiles(walked); } catch { return []; } })(),
    structure,
    dirs: structure.dirs,      // flat alias of structure.dirs, for list consumers
    docs: project.docs || [],
    featuredDoc: project.featuredDoc || null,
    prose,
    history,
    signals,
    design,
    code: codeSurface,
    unknowns,
  };

  brief.buildMs = Date.now() - started;
  return brief;
}

/* ------------------------------------------------------------------ *
 * briefToMarkdown
 * ------------------------------------------------------------------ */

/**
 * Fence `text` without mangling it: pick a fence longer than the longest run of
 * backticks the content already contains (CommonMark's own rule), so embedded
 * markdown code blocks survive verbatim.
 */
function fence(text, lang = '') {
  const body = String(text).replace(/\n+$/, '');
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const bar = '`'.repeat(Math.max(3, longest + 1));
  return `${bar}${lang}\n${body}\n${bar}`;
}

function bulletList(items) {
  return items.map((s) => `- ${s}`).join('\n');
}

/**
 * Render the brief as compact markdown for the authoring prompt.
 *
 * Budget: ~40KB. When over, sections are shed in ascending order of value:
 * commit subjects, then TODO samples, then tree depth, then prose caps, and
 * every drop is announced in the output so the author knows the brief is
 * partial rather than the repository being empty.
 */
function briefToMarkdown(brief, opts = {}) {
  // A rationale brief carries the design evidence, which IS the payload for
  // that document, so it gets a larger envelope and sheds in a different
  // order: the onboarding-shaped sections (tree, file inventory, TODO samples)
  // go first, and the author's own reasoning goes last.
  const isDesign = Boolean(brief && brief.design);
  const isCode = Boolean(brief && brief.code);
  const budget = Number(opts.budget)
    || (isDesign ? DESIGN_MARKDOWN_BUDGET : isCode ? CODE_MARKDOWN_BUDGET : MARKDOWN_BUDGET);

  // The code surface is an index of coordinates, so it is compact; what it
  // must not lose is the import and construct tables, which are the document's
  // entire subject. Prose and tree depth go first instead.
  const codePlans = [
    { subjects: 10, todos: 8, treeDepth: 3, proseCap: PROSE_CAP, dropped: [] },
    { subjects: 0, todos: 5, treeDepth: 2, sourceFiles: 30, proseCap: 16 * 1024,
      dropped: ['commit subjects omitted', 'directory tree cut to depth 2', 'existing prose truncated to 16KB per file'] },
    { subjects: 0, todos: 0, treeDepth: 2, sourceFiles: 20, proseCap: 10 * 1024,
      dropped: ['commit subjects and TODO samples omitted', 'existing prose truncated to 10KB per file'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 12, proseCap: 8 * 1024, imports: 60, constructs: 40,
      dropped: ['structural sections reduced', 'library list trimmed to 60, constructs to 40'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 8, proseCap: 6 * 1024, imports: 40, constructs: 25,
      dropped: ['structural sections reduced', 'library list trimmed to 40, constructs to 25'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 6, proseCap: 4 * 1024, imports: 25, constructs: 15,
      dropped: ['structural sections reduced to a minimum', 'library list trimmed to 25, constructs to 15'] },
  ];

  const designPlans = [
    { subjects: 10, todos: 8, treeDepth: 3, proseCap: PROSE_CAP, dropped: [] },
    { subjects: 0, todos: 5, treeDepth: 2, sourceFiles: 25, proseCap: PROSE_CAP,
      dropped: ['commit subject list omitted (the bodies below carry the reasoning)', 'directory tree cut to depth 2'] },
    { subjects: 0, todos: 0, treeDepth: 2, sourceFiles: 15, proseCap: 16 * 1024,
      dropped: ['commit subjects and TODO samples omitted', 'source inventory trimmed', 'existing prose truncated to 16KB per file'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 10, proseCap: 12 * 1024, commitBodies: 45,
      dropped: ['commit subjects, TODO samples and the directory tree reduced', 'commit bodies trimmed to 45'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 10, proseCap: 10 * 1024,
      designDocs: 6, rationale: 60, constants: 90, commitBodies: 25,
      dropped: ['structural sections reduced', 'design evidence trimmed: 6 documents, 60 comments, 25 commit bodies'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 8, proseCap: 8 * 1024,
      designDocs: 4, rationale: 40, constants: 60, commitBodies: 15,
      dropped: ['structural sections reduced', 'design evidence trimmed: 4 documents, 40 comments, 15 commit bodies'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 6, proseCap: 6 * 1024,
      designDocs: 3, rationale: 25, constants: 40, commitBodies: 8,
      dropped: ['structural sections reduced', 'design evidence trimmed: 3 documents, 25 comments, 8 commit bodies'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 6, proseCap: 4 * 1024,
      designDocs: 2, rationale: 15, constants: 25, commitBodies: 4,
      dropped: ['structural sections reduced to a minimum', 'design evidence heavily trimmed: 2 documents, 15 comments, 4 commit bodies'] },
  ];

  // Progressive shedding plan. Each level is strictly poorer than the last.
  const plans = isDesign ? designPlans : isCode ? codePlans : [
    { subjects: 40, todos: 15, treeDepth: 3, proseCap: PROSE_CAP, dropped: [] },
    { subjects: 15, todos: 15, treeDepth: 3, proseCap: PROSE_CAP, dropped: ['recent commit subjects trimmed to 15'] },
    { subjects: 0, todos: 15, treeDepth: 3, proseCap: PROSE_CAP, dropped: ['recent commit subjects omitted'] },
    { subjects: 0, todos: 5, treeDepth: 3, proseCap: PROSE_CAP, dropped: ['recent commit subjects omitted', 'TODO samples trimmed to 5'] },
    { subjects: 0, todos: 0, treeDepth: 3, proseCap: PROSE_CAP, dropped: ['recent commit subjects omitted', 'TODO samples omitted'] },
    { subjects: 0, todos: 0, treeDepth: 2, proseCap: PROSE_CAP, dropped: ['recent commit subjects omitted', 'TODO samples omitted', 'directory tree cut to depth 2'] },
    { subjects: 0, todos: 0, treeDepth: 1, proseCap: PROSE_CAP, dropped: ['recent commit subjects omitted', 'TODO samples omitted', 'directory tree cut to depth 1'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 20, proseCap: PROSE_CAP, dropped: ['commits, TODO samples and the directory tree omitted', 'source file inventory trimmed to 20'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 10, proseCap: 16 * 1024, dropped: ['commits, TODO samples and the directory tree omitted', 'source file inventory trimmed to 10', 'existing documentation truncated to 16KB per file'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 10, proseCap: 8 * 1024, dropped: ['commits, TODO samples and the directory tree omitted', 'source file inventory trimmed to 10', 'existing documentation truncated to 8KB per file'] },
    { subjects: 0, todos: 0, treeDepth: 1, sourceFiles: 10, proseCap: 4 * 1024, dropped: ['commits, TODO samples and the directory tree omitted', 'source file inventory trimmed to 10', 'existing documentation truncated to 4KB per file'] },
  ];

  let out = '';
  for (let i = 0; i < plans.length; i++) {
    out = renderBrief(brief, plans[i]);
    if (Buffer.byteLength(out, 'utf8') <= budget) return out;
  }
  // Still over: hard-truncate as the last resort, and say so.
  const cut = Buffer.from(out, 'utf8').slice(0, budget - 220).toString('utf8');
  return cut + '\n\n> **BRIEF TRUNCATED**: the repository brief exceeded its size budget and was cut here. Anything below this point is missing, not absent from the repository.\n';
}

function renderBrief(brief, plan) {
  const L = [];
  const id = brief.identity;
  const comp = brief.composition;

  L.push(`# Repository brief: ${id.name}`);
  L.push('');
  L.push('*Gathered deterministically from the filesystem and git. Every fact below was read from the repository; nothing here is inferred by a model.*');
  L.push('');

  /* Identity ------------------------------------------------------- */
  L.push('## Identity');
  L.push('');
  const idRows = [
    `**Name**: ${id.name}`,
    `**Path**: \`${id.path}\``,
    `**Status**: ${id.status}, ${id.statusReason}`,
    `**Last activity**: ${id.lastActivityISO || 'unknown'}${id.lastActivityRelative ? ` (${id.lastActivityRelative})` : ''}`,
  ];
  if (id.isGit) {
    idRows.push(`**Git**: branch \`${id.branch || '?'}\`${id.remote ? `, remote \`${id.remote}\`` : ', no remote configured'}`);
    idRows.push(`**Working tree**: ${id.dirty ? `dirty: ${id.dirtyCount} changed file(s)` : 'clean'}${id.ahead || id.behind ? `, ${id.ahead} ahead / ${id.behind} behind upstream` : ''}`);
  } else {
    idRows.push('**Git**: not a git repository');
  }
  if (id.blurb) idRows.push(`**Existing one-line description** (extracted from its own docs): ${id.blurb}`);
  L.push(bulletList(idRows));
  L.push('');

  /* Composition ---------------------------------------------------- */
  L.push('## Composition');
  L.push('');
  L.push(bulletList([
    `${comp.fileCount} files, ${comp.dirCount} directories, ${comp.sizeHuman} on disk`,
    `Primary language: ${comp.primaryLanguage || 'none detected'}`,
    `Detected stack: ${(comp.stack || []).join(', ') || 'none detected'}`,
    `Tests present: ${comp.hasTests ? 'yes' : 'no'}`,
  ]));
  if ((comp.langBreakdown || []).length) {
    L.push('');
    L.push('| Language | Bytes | % |');
    L.push('|---|---:|---:|');
    for (const r of comp.langBreakdown) L.push(`| ${r.lang} | ${r.bytes} | ${r.pct}% |`);
  }
  L.push('');

  /* Manifests ------------------------------------------------------ */
  L.push('## Manifests');
  L.push('');
  if (!brief.manifests.length) {
    L.push('_No package manifest of any kind was found (no package.json, pyproject.toml, requirements.txt, Package.swift, Cargo.toml, go.mod, Gemfile, Makefile or Dockerfile)._');
  } else {
    for (const m of brief.manifests) {
      L.push(`### \`${m.path}\` (${m.kind})`);
      if (m.parsed) {
        const p = m.parsed;
        const rows = [];
        for (const [k, v] of Object.entries(p)) {
          if (v == null) continue;
          if (Array.isArray(v)) {
            if (!v.length) continue;
            rows.push(`**${k}**: ${v.slice(0, 40).map((x) => `\`${x}\``).join(', ')}${v.length > 40 ? ` … (+${v.length - 40})` : ''}`);
          } else if (typeof v === 'object') {
            const ent = Object.entries(v).slice(0, 30);
            if (!ent.length) continue;
            rows.push(`**${k}**:`);
            for (const [kk, vv] of ent) rows.push(`  - \`${kk}\` → \`${String(vv).slice(0, 200)}\``);
          } else {
            rows.push(`**${k}**: ${typeof v === 'string' ? v.slice(0, 300) : v}`);
          }
        }
        L.push(rows.length ? bulletList(rows) : '_(parsed, but empty)_');
      } else if (m.raw) {
        L.push('Could not parse; raw head:');
        L.push(fence(m.raw.slice(0, 1500)));
      } else {
        L.push('_(present but unreadable)_');
      }
      L.push('');
    }
  }
  L.push('');

  /* Run commands --------------------------------------------------- */
  L.push('## How to run it: commands evidenced in the repository');
  L.push('');
  L.push('*These are the ONLY commands with evidence behind them. Do not invent others.*');
  L.push('');
  if (!brief.runCommands.length) {
    L.push('_No runnable command could be evidenced. Say so plainly in the artifact rather than guessing._');
  } else {
    L.push('| Command | Evidence | Detail |');
    L.push('|---|---|---|');
    for (const c of brief.runCommands) {
      L.push(`| \`${c.command}\` | ${mdCell(c.source)} | ${mdCell(c.note || '')} |`);
    }
  }
  L.push('');

  /* Entry points --------------------------------------------------- */
  L.push('## Entry points: likely "start reading here" files, ranked');
  L.push('');
  if (!brief.entryPoints.length) {
    L.push('_No source file stood out as an entry point._');
  } else {
    for (const e of brief.entryPoints) {
      L.push(`- \`${e.path}\` (${humanBytes(e.sizeBytes)}): ${e.why.join('; ')}`);
    }
  }
  L.push('');

  /* Source inventory ----------------------------------------------- */
  const src = (brief.sourceFiles || []).slice(0, plan.sourceFiles == null ? 45 : plan.sourceFiles);
  if (src.length) {
    L.push('## Source files (largest first, shallowest first)');
    L.push('');
    for (const f of src) L.push(`- \`${f.path}\`: ${f.lang}, ${humanBytes(f.sizeBytes)}`);
    if ((brief.sourceFiles || []).length > src.length) {
      L.push(`- _(+${brief.sourceFiles.length - src.length} more source files not listed)_`);
    }
    L.push('');
  }

  /* Structure ------------------------------------------------------ */
  const st = brief.structure;
  L.push(`## Structure (depth ${Math.min(plan.treeDepth, st.maxDepth)})`);
  L.push('');
  L.push(`Totals under the project root: ${st.totalFiles} files, ${humanBytes(st.totalBytes)}.`);
  L.push('');
  if (st.rootFiles.length) {
    L.push('**Root files**: ' + st.rootFiles.slice(0, 60).map((f) => `\`${f.path}\``).join(', ')
      + (st.rootFiles.length > 60 ? ` … (+${st.rootFiles.length - 60})` : ''));
    L.push('');
  }
  const rows = st.dirs.filter((d) => d.depth <= plan.treeDepth);
  if (rows.length) {
    L.push('| Directory | Files (recursive) | Size | Dominant type |');
    L.push('|---|---:|---:|---|');
    for (const d of rows) {
      const dom = d.dominantExt ? `\`${d.dominantExt}\` (${d.dominantCount})` : '-';
      L.push(`| \`${d.path}/\` | ${d.files} | ${humanBytes(d.bytes)} | ${dom} |`);
    }
    if (st.dirsOmitted) L.push('');
    if (st.dirsOmitted) L.push(`_(+${st.dirsOmitted} more directories omitted)_`);
  } else {
    L.push('_No subdirectories._');
  }
  if (st.truncated) L.push('\n_Note: the walk hit its entry cap; deep counts may be partial._');
  L.push('');

  /* Documents ------------------------------------------------------ */
  L.push('## Documents already in the repository');
  L.push('');
  if (!brief.docs.length) {
    L.push('_None._');
  } else {
    L.push('| Path | Kind | Words | Size | Modified |');
    L.push('|---|---|---:|---:|---|');
    for (const d of brief.docs.slice(0, 40)) {
      L.push(`| \`${d.path}\` | ${d.kind}${brief.featuredDoc && brief.featuredDoc.path === d.path ? ' *(featured)*' : ''} | ${d.wordCount} | ${humanBytes(d.sizeBytes)} | ${(d.mtimeISO || '').slice(0, 10)} |`);
    }
  }
  L.push('');

  /* Prose ---------------------------------------------------------- */
  L.push('## Existing prose: what the author already wrote');
  L.push('');
  if (!brief.prose.length) {
    L.push('_This project has no README, CLAUDE.md or other prose documentation. Everything in the artifact must come from code and structure, and the artifact should say that no written documentation exists._');
  } else {
    L.push('*Build on this. Do not restate it; extend, organise and fill its gaps.*');
    L.push('');
    for (const p of brief.prose) {
      let text = p.text;
      let cut = p.truncated;
      if (Buffer.byteLength(text, 'utf8') > plan.proseCap) {
        text = Buffer.from(text, 'utf8').slice(0, plan.proseCap).toString('utf8');
        cut = true;
      }
      L.push(`### \`${p.path}\`: ${p.kind}${p.role === 'featured' ? ' (featured document)' : ''}`);
      L.push('');
      L.push(`Title: ${p.title} · ${p.wordCount} words · ${humanBytes(p.originalBytes)}${cut ? ' · **TRUNCATED for this brief: the real file is longer**' : ''}`);
      L.push('');
      L.push(fence(text, p.contentType === 'markdown' ? 'markdown' : p.contentType === 'html' ? 'html' : ''));
      L.push('');
    }
  }
  L.push('');

  /* History -------------------------------------------------------- */
  const h = brief.history;
  L.push('## History');
  L.push('');
  if (!h.isGit) {
    L.push('_Not a git repository: there is no commit history, no authorship record and no way to tell how this project evolved._');
  } else {
    L.push(bulletList([
      `${h.commitCount} commits total, ${h.commitsLast30d || 0} in the last 30 days`,
      `First commit: ${h.firstCommitISO || 'unknown'}`,
      `Latest commit: ${h.lastCommitISO || 'unknown'}`,
      `Authors: ${(h.authors || []).map((a) => `${a.name} (${a.commits})`).join(', ') || 'unknown'}`,
    ]));
    L.push('');
    if ((h.activity || []).length) {
      L.push(`**90-day activity** (date:count): ${h.activity.map((a) => `${a.date}:${a.count}`).join(' ')}`);
      L.push('');
    }
    if ((h.topChangedFiles || []).length) {
      L.push('**Most-changed files** ' + (h.windowNote ? `(${h.windowNote})` : '') + ':');
      L.push(bulletList(h.topChangedFiles.map((f) => `\`${f.path}\`: touched in ${f.changes} commits`)));
      L.push('');
    }
    if (plan.subjects > 0 && (h.subjects || []).length) {
      L.push(`**Recent commits** (${Math.min(plan.subjects, h.subjects.length)}):`);
      L.push(bulletList(h.subjects.slice(0, plan.subjects).map((c) => `\`${c.sha}\` ${(c.dateISO || '').slice(0, 10)}: ${c.subject}`)));
      L.push('');
    }
  }

  /* Signals -------------------------------------------------------- */
  const s = brief.signals;
  L.push('## Signals');
  L.push('');
  L.push(bulletList([
    `TODO/FIXME/HACK/XXX markers found: ${s.todoCount}${s.scanPartial ? ' (floor: the scan is capped, the real number may be higher)' : ''}`,
    `Tests: ${s.hasTests ? `yes, ${s.testFileCount || 0} test-named file(s)${s.testDirs.length ? `, directories: ${s.testDirs.map((d) => `\`${d}\``).join(', ')}` : ''}` : 'none found'}`,
    `Libraries/frameworks seen in source: ${(s.frameworks || []).join(', ') || 'none detected'}`,
    `CI workflows: ${(s.workflows || []).length ? s.workflows.map((w) => `\`${w}\``).join(', ') : 'none'}`,
  ]));
  L.push('');
  if (plan.todos > 0 && (s.todoSamples || []).length) {
    L.push(`**TODO samples** (${Math.min(plan.todos, s.todoSamples.length)} of ${s.todoCount}):`);
    L.push(bulletList(s.todoSamples.slice(0, plan.todos).map((t) => `\`${t.path}:${t.line}\`, ${t.marker}: ${t.text}`)));
    L.push('');
  }
  if ((s.dirtyFiles || []).length) {
    L.push(`**Uncommitted changes** (${s.dirtyFiles.length} shown):`);
    L.push(bulletList(s.dirtyFiles.map((d) => `\`${d.path}\` (${d.state})`)));
    L.push('');
  }
  if ((s.configFiles || []).length) {
    L.push('**Config files present**: ' + s.configFiles.map((c) => `\`${c.path}\``).join(', '));
    L.push('');
  }
  if ((s.sensitiveFiles || []).length) {
    L.push('**Credential-shaped files: NAMES ONLY, never opened by this tool:**');
    L.push(bulletList(s.sensitiveFiles.map((f) => `\`${f.path}\` (${humanBytes(f.sizeBytes)}), not read`)));
    L.push('');
    L.push('_Do not read these files, do not quote them, and do not describe their contents. Mentioning that the project expects credentials in them is fine._');
    L.push('');
  }

  /* Design evidence ------------------------------------------------ */
  const dsn = brief.design;
  if (dsn) {
    L.push('## Design evidence: where this repository states its own reasoning');
    L.push('');
    L.push('*Everything in this section was written by the project\'s author, not inferred. It is the raw material for explaining **why** the code is the way it is. Where a section below is empty, the reasoning genuinely is not written down anywhere: say that plainly rather than supplying a plausible-sounding motive.*');
    L.push('');

    const docLimit = plan.designDocs != null ? plan.designDocs : dsn.designDocs.length;
    const shownDocs = dsn.designDocs.slice(0, docLimit);
    if (shownDocs.length) {
      L.push(`### Design documents (${shownDocs.length}${dsn.designDocsOmitted ? `, ${dsn.designDocsOmitted} more not read` : ''})`);
      L.push('');
      L.push('These are ADR/RFC/CONTRACT/DESIGN-style files: the places an author states intent directly. They are the highest-value input in this brief.');
      L.push('');
      for (const d of shownDocs) {
        L.push(`#### \`${d.path}\`${d.truncated ? `: truncated, ${humanBytes(d.originalBytes)} in full` : ''}`);
        L.push('');
        L.push(fence(d.text, 'markdown'));
        L.push('');
      }
    } else {
      L.push('### Design documents');
      L.push('');
      L.push('_None. This repository has no ADR, RFC, CONTRACT, DESIGN or ARCHITECTURE document._');
      L.push('');
    }

    const ratLimit = plan.rationale != null ? plan.rationale : dsn.rationale.length;
    const rats = dsn.rationale.slice(0, ratLimit);
    L.push(`### Explanatory comments, each paired with the declaration it sits above (${rats.length}${dsn.rationale.length > rats.length ? ` of ${dsn.rationale.length}` : ''})`);
    L.push('');
    if (rats.length) {
      L.push('Read these as the author explaining a choice at the moment they made it. The `documents:` line is the code the comment is attached to.');
      L.push('');
      for (const r of rats) {
        L.push(`- \`${r.path}:${r.line}\``);
        L.push(`  - comment: ${r.text}`);
        L.push(`  - documents: \`${r.subject}\``);
      }
      L.push('');
    } else {
      L.push('_No explanatory comments were found. The code does not say why it does what it does._');
      L.push('');
    }

    const constLimit = plan.constants != null ? plan.constants : dsn.constants.length;
    const consts = dsn.constants.slice(0, constLimit);
    if (consts.length) {
      L.push(`### Named constants: the tuning knobs (${consts.length}${dsn.constants.length > consts.length ? ` of ${dsn.constants.length}` : ''}, ${dsn.undocumentedConstants} undocumented)`);
      L.push('');
      L.push('A constant with `documented: no` is a value someone chose for a reason that was never written down. Those are worth flagging to the reader as risk, not guessing at.');
      L.push('');
      L.push('| Constant | Value | Where | Documented |');
      L.push('|---|---|---|---|');
      for (const c of consts) {
        L.push(`| \`${mdCell(c.name)}\` | \`${mdCell(c.value)}\` | \`${mdCell(c.path)}:${c.line}\` | ${c.documented ? 'yes' : 'no'} |`);
      }
      L.push('');
    }

    const bodyLimit = plan.commitBodies != null ? plan.commitBodies : dsn.commitRationale.length;
    const bodies = dsn.commitRationale.slice(0, bodyLimit);
    L.push(`### Commit messages that explain a decision (${bodies.length}${dsn.commitRationale.length > bodies.length ? ` of ${dsn.commitRationale.length}` : ''})`);
    L.push('');
    if (bodies.length) {
      L.push('Only commits whose message has a body are listed: a body is where an author writes down why. `¶` marks a paragraph break in the original message.');
      L.push('');
      for (const c of bodies) {
        L.push(`- **${mdCell(c.subject)}** (\`${c.sha}\`, ${c.relative})`);
        L.push(`  - ${c.body}`);
      }
      L.push('');
    } else {
      L.push('_No commit in the scanned history has a message body._');
      L.push('');
    }

    L.push(`_Harvest coverage: ${dsn.coverage.filesRead} of ${dsn.coverage.filesAvailable} candidate source files were opened${dsn.coverage.partial ? ' before the scan budget ran out' : ''}. A comment in a file that was not opened is not represented here._`);
    L.push('');
  }

  /* Code surface --------------------------------------------------- */
  const cs = brief.code;
  if (cs) {
    L.push('## Code surface: what this project actually imports, uses and talks to');
    L.push('');
    L.push('*An index, not the code. Every entry carries a path (and where useful a line) so you can open the real thing and quote it. Do not describe a construct you have not read: the coordinates are here so you can go and look.*');
    L.push('');

    const impLimit = plan.imports != null ? plan.imports : cs.imports.length;
    const imps = cs.imports.slice(0, impLimit);
    L.push(`### External libraries actually imported (${imps.length}${cs.imports.length > imps.length ? ` of ${cs.imports.length}` : ''})`);
    L.push('');
    if (imps.length) {
      L.push('Sorted by how often they are imported. `Imports` counts import statements, not calls.');
      L.push('');
      L.push('| Library | Imports | Seen in |');
      L.push('|---|---|---|');
      for (const i of imps) {
        L.push(`| \`${mdCell(i.name)}\` | ${i.count} | ${i.sites.map((x) => `\`${mdCell(x)}\``).join(', ')} |`);
      }
      L.push('');
    } else {
      L.push('_No external imports were found in the scanned files._');
      L.push('');
    }

    if (cs.declaredNotImported.length) {
      L.push('**Declared in a manifest but never imported anywhere scanned:** '
        + cs.declaredNotImported.map((d) => `\`${mdCell(d)}\``).join(', '));
      L.push('');
      L.push('_That is a real finding: either dead dependencies, or used somewhere the scan did not reach. Check before asserting either._');
      L.push('');
    }
    if (cs.importedNotDeclared.length) {
      L.push('**Imported but not declared in any manifest:** '
        + cs.importedNotDeclared.map((d) => `\`${mdCell(d)}\``).join(', '));
      L.push('');
      L.push('_Usually a runtime built-in or a transitive dependency being relied on directly. Worth explaining which._');
      L.push('');
    }

    const conLimit = plan.constructs != null ? plan.constructs : cs.constructs.length;
    const cons = cs.constructs.slice(0, conLimit);
    if (cons.length) {
      L.push(`### Language constructs in use (${cons.length}${cs.constructs.length > cons.length ? ` of ${cs.constructs.length}` : ''})`);
      L.push('');
      L.push('Each was detected in the file listed. `Files` is how many scanned files contain it: a construct used once is a curiosity, one used everywhere is part of the house style, and the two deserve different treatment.');
      L.push('');
      L.push('| Construct | Files | Example sites |');
      L.push('|---|---|---|');
      for (const c of cons) {
        L.push(`| ${mdCell(c.label)} | ${c.count} | ${c.sites.map((x) => `\`${mdCell(x)}\``).join(', ')} |`);
      }
      L.push('');
    }

    if (cs.localImports.length) {
      L.push('### Internal modules, by how often they are imported');
      L.push('');
      L.push('The most-imported internal module is usually the one a reader should understand first.');
      L.push('');
      L.push(bulletList(cs.localImports.slice(0, 20).map((i) => `\`${i.name}\`: imported ${i.count}×`)));
      L.push('');
    }

    if (cs.hosts.length) {
      L.push('### External services contacted');
      L.push('');
      L.push('Hostnames only: paths and query strings were deliberately not collected, because that is where credentials hide.');
      L.push('');
      L.push(bulletList(cs.hosts.map((x) => `\`${x}\``)));
      L.push('');
    }

    if (cs.envVars.length) {
      L.push('### Environment variables this code reads');
      L.push('');
      L.push('**Names only. No value was read, and none must be guessed at or invented.**');
      L.push('');
      L.push(bulletList(cs.envVars.map((x) => `\`${x}\``)));
      L.push('');
    }

    L.push(`_Scan coverage: ${cs.coverage.filesRead} of ${cs.coverage.filesAvailable} candidate source files were opened${cs.coverage.partial ? ' before the budget ran out' : ''}. A library imported only in a file that was not opened does not appear above._`);
    L.push('');
  }

  /* Unknowns ------------------------------------------------------- */
  L.push('## What this brief could NOT determine');
  L.push('');
  const shed = plan.dropped || [];
  const allUnknowns = (brief.unknowns || []).concat(shed.map((d) => `to fit the size budget, ${d}`));
  L.push(allUnknowns.length ? bulletList(allUnknowns) : '_Nothing notable: the gather completed in full._');
  L.push('');

  return L.join('\n');
}

/** Escape a value for a markdown table cell. */
function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 200);
}

export {
  buildBrief, briefToMarkdown,
  isSensitive, humanBytes,
  parseToml, parseMakefile, parseDockerfile,
};
