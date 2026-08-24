/**
 * Ground Control — shared helpers.
 * Node stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Ignore list
 * ------------------------------------------------------------------ */

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'target',
  'Pods', '__pycache__', '.pytest_cache', '.venv', 'venv',
  '.DS_Store', 'coverage', '.cache', '.mypy_cache', '.ruff_cache',
  '.gradle', '.idea', '.tox', '.terraform', 'vendor', '.svelte-kit',
  'DerivedData', '.parcel-cache', '.turbo', 'bower_components',
]);

/** Dot-directories we DO want to look inside (doc discovery reads `.github/`). */
const DOT_DIR_ALLOW = new Set(['.github']);

/**
 * True for any directory we never descend into.
 * Beyond the explicit list this catches `*venv` (quant_venv, pot-venv) and
 * every other dot-directory (`.build`, `.swiftpm`, `.claude`, …), which are
 * tooling caches rather than project content.
 */
function isIgnoredDir(name) {
  if (IGNORE_DIRS.has(name)) return true;
  if (/venv$/i.test(name)) return true;      // quant_venv, pot-venv, env-venv, ...
  if (name === '__MACOSX') return true;
  if (name.startsWith('.') && !DOT_DIR_ALLOW.has(name)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Slugs
 * ------------------------------------------------------------------ */

/**
 * url-safe, stable slug. camelCase gets split on the hump so
 * `animAgent` -> `anim-agent`, `ML_quantitative_research` -> `ml-quantitative-research`.
 */
function slugify(name) {
  const s = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'project';
}

/** Make `base` unique against a Set of already-used slugs (mutates the set). */
function uniqueSlug(base, used) {
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

/**
 * "just now" | "3 hours ago" | "5 days ago" | "2 months ago" | "1 year ago"
 * Accepts ISO string, Date, or epoch ms. Returns null for falsy/invalid input.
 */
function relativeTime(when, now = Date.now()) {
  if (when == null) return null;
  const t = when instanceof Date ? when.getTime()
    : typeof when === 'number' ? when
      : Date.parse(when);
  if (!Number.isFinite(t)) return null;

  const diff = now - t;
  const future = diff < 0;
  const d = Math.abs(diff);
  const fmt = (n, unit) => {
    const s = `${n} ${unit}${n === 1 ? '' : 's'}`;
    return future ? `in ${s}` : `${s} ago`;
  };

  if (d < 45e3) return future ? 'just now' : 'just now';
  if (d < 90e3) return fmt(1, 'minute');
  if (d < 45 * MIN) return fmt(Math.round(d / MIN), 'minute');
  if (d < 90 * MIN) return fmt(1, 'hour');
  if (d < 22 * HOUR) return fmt(Math.round(d / HOUR), 'hour');
  if (d < 36 * HOUR) return fmt(1, 'day');
  if (d < 26 * DAY) return fmt(Math.round(d / DAY), 'day');
  if (d < 46 * DAY) return fmt(1, 'month');
  if (d < 320 * DAY) return fmt(Math.round(d / (DAY * 30.44)), 'month');
  if (d < 548 * DAY) return fmt(1, 'year');
  return fmt(Math.round(d / (DAY * 365.25)), 'year');
}

function toISO(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

/** YYYY-MM-DD in local time (matches `git log --date=short`). */
function localDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ *
 * Languages by extension
 * ------------------------------------------------------------------ */

const EXT_LANG = {
  '.py': 'Python', '.pyi': 'Python', '.pyx': 'Python',
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.swift': 'Swift',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.rb': 'Ruby', '.erb': 'Ruby',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'SCSS', '.sass': 'SCSS', '.less': 'CSS',
  '.md': 'Markdown', '.markdown': 'Markdown', '.mdx': 'Markdown',
  '.ipynb': 'Notebook',
  '.sql': 'SQL',
  '.c': 'C', '.h': 'C',
  '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.hh': 'C++', '.hxx': 'C++',
  '.m': 'Objective-C', '.mm': 'Objective-C++',
  '.json': 'JSON', '.jsonc': 'JSON',
  '.yml': 'YAML', '.yaml': 'YAML',
  '.toml': 'TOML',
  '.xml': 'XML', '.plist': 'XML', '.svg': 'SVG',
  '.php': 'PHP', '.pl': 'Perl', '.lua': 'Lua', '.r': 'R', '.jl': 'Julia',
  '.dart': 'Dart', '.scala': 'Scala', '.clj': 'Clojure', '.ex': 'Elixir', '.exs': 'Elixir',
  '.hs': 'Haskell', '.vue': 'Vue', '.svelte': 'Svelte',
  '.cs': 'C#', '.fs': 'F#', '.vb': 'Visual Basic',
  '.tf': 'Terraform', '.gradle': 'Gradle', '.pbxproj': 'Xcode',
  '.txt': 'Text', '.csv': 'CSV', '.tsv': 'CSV',
  '.zig': 'Zig', '.nim': 'Nim', '.proto': 'Protobuf', '.graphql': 'GraphQL', '.gql': 'GraphQL',
  '.rst': 'reStructuredText', '.tex': 'TeX', '.cfg': 'Config', '.ini': 'Config', '.env': 'Config',
};

/** Languages that should not win `primaryLanguage` if anything else exists. */
const NON_PRIMARY_LANGS = new Set([
  'Markdown', 'JSON', 'YAML', 'TOML', 'Text', 'CSV', 'XML', 'Config',
  'reStructuredText', 'SVG', 'Xcode',
]);

function langForExt(ext) {
  return EXT_LANG[ext.toLowerCase()] || null;
}

/* ------------------------------------------------------------------ *
 * Text vs binary
 * ------------------------------------------------------------------ */

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.heic',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.aiff', '.m4a', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.so', '.dylib', '.dll', '.exe', '.o', '.a', '.class', '.jar', '.wasm',
  '.pyc', '.pyo', '.pkl', '.npy', '.npz', '.h5', '.hdf5', '.parquet',
  '.db', '.sqlite', '.sqlite3', '.bin', '.dat', '.model', '.pt', '.pth',
  '.psd', '.ai', '.sketch', '.xcuserstate', '.dmg', '.pack', '.idx',
]);

function isBinaryExt(ext) {
  return BINARY_EXT.has(ext.toLowerCase());
}

/** Extensions worth grepping for TODO markers. */
function isScannableTextExt(ext) {
  const e = ext.toLowerCase();
  if (isBinaryExt(e)) return false;
  if (EXT_LANG[e]) return true;
  return ['.gitignore', '.dockerfile', '.conf', '.properties', '.gradle'].includes(e);
}

/* ------------------------------------------------------------------ *
 * MIME
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ipynb': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.swift': 'text/plain; charset=utf-8',
};

/** Extensions the static handler is allowed to serve out of public/. */
const STATIC_EXT = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.json', '.map', '.woff', '.woff2']);

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

/* ------------------------------------------------------------------ *
 * Path safety
 * ------------------------------------------------------------------ */

class PathError extends Error {
  constructor(msg) { super(msg); this.name = 'PathError'; this.status = 403; }
}

/**
 * Resolve `rel` inside `rootAbs` and prove it cannot escape.
 *
 * Three independent gates:
 *   1. syntactic — no absolute paths, no NUL, no `..` segment
 *   2. lexical   — path.resolve() result must be under the root
 *   3. physical  — fs.realpath() of the target (and of the root) must still be
 *                  under the real root, which defeats symlink escapes
 *
 * Throws PathError (status 403) on any violation. Returns the resolved
 * absolute path (not the realpath, so relative links keep working).
 */
function resolveInside(rootAbs, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new PathError('invalid path');
  if (rel.indexOf('\0') !== -1) throw new PathError('invalid path');

  // Normalise separators, then reject anything that walks upward.
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (path.isAbsolute(rel) || path.isAbsolute(cleaned)) throw new PathError('forbidden path');
  const segs = cleaned.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) throw new PathError('forbidden path');
  if (segs.length === 0) throw new PathError('invalid path');

  const rootResolved = path.resolve(rootAbs);
  const abs = path.resolve(rootResolved, segs.join('/'));
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new PathError('forbidden path');
  }

  // Physical check — realpath the deepest existing ancestor.
  let realRoot;
  try { realRoot = fs.realpathSync(rootResolved); } catch { realRoot = rootResolved; }
  let realTarget;
  try {
    realTarget = fs.realpathSync(abs);
  } catch {
    // Target may not exist; verify its existing parent instead.
    try { realTarget = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); }
    catch { realTarget = abs; }
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new PathError('forbidden path');
  }
  return abs;
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/** Truncate on a word boundary, appending an ellipsis. */
function truncateWords(s, max = 240) {
  const t = collapseWhitespace(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?-]+$/, '') + '…';
}

function countWords(s) {
  const m = String(s).trim();
  if (!m) return 0;
  return m.split(/\s+/).length;
}

export {
  IGNORE_DIRS, DOT_DIR_ALLOW, isIgnoredDir,
  slugify, uniqueSlug,
  relativeTime, toISO, localDateKey,
  EXT_LANG, NON_PRIMARY_LANGS, langForExt,
  isBinaryExt, isScannableTextExt,
  MIME, STATIC_EXT, mimeFor,
  PathError, resolveInside,
  collapseWhitespace, truncateWords, countWords,
};
