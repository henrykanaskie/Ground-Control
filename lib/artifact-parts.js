/**
 * Ground Control Forge: shared artifact parts.
 *
 * Pure functions only. No I/O, no Node built-ins, no state. Everything here
 * turns untrusted repository facts into safe HTML fragments in the Forge house
 * style, and is shared by `artifact-template.js` and anything else that needs
 * to draw the same furniture.
 *
 * ESCAPING RULE (non-negotiable): every value that came from a repository
 * (commit subjects, file names, doc titles, TODO text, branch names, remotes)
 * is untrusted. Every builder in this file escapes its own inputs. The only
 * functions that accept pre-built HTML take it in a parameter documented as
 * `…Html` and it is always produced by another builder here, never by a repo.
 *
 * Node stdlib only, ES modules, zero dependencies.
 */

/* ================================================================== *
 * 1. Escaping and coercion
 * ================================================================== */

/**
 * Escape text for HTML body content AND attribute values.
 * Quotes are escaped too, so this is safe in either position.
 */
export function esc(value) {
  return toText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Alias kept for call-site clarity when interpolating into an attribute. */
export const escAttr = esc;

/**
 * Coerce anything to a display string without ever producing "undefined",
 * "null", "NaN" or "[object Object]".
 */
export function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : '';
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    // Never leak "[object Object]". Prefer an obvious label field.
    for (const key of ['name', 'title', 'path', 'label', 'text', 'command']) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
    return '';
  }
  return String(value);
}

/** Collapse whitespace and hard-trim to `max` characters on a word boundary. */
export function clamp(value, max = 200) {
  const s = toText(value).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '') + '…';
}

/** Always an array; non-arrays become `[]` (or `[value]` when `wrap`). */
export function arr(value, wrap = false) {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined);
  if (value === null || value === undefined || value === '') return [];
  return wrap ? [value] : [];
}

/** A finite number or `fallback`. Strings that look numeric are accepted. */
export function num(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Read the first defined, non-empty value at any of the given dotted paths.
 * Defensive plumbing: the brief comes from another agent's module and every
 * field may be absent, renamed or empty.
 */
export function pick(source, ...paths) {
  for (const p of paths) {
    let cur = source;
    for (const key of String(p).split('.')) {
      if (cur === null || cur === undefined) { cur = undefined; break; }
      cur = cur[key];
    }
    if (cur === null || cur === undefined) continue;
    if (typeof cur === 'string' && cur.trim() === '') continue;
    if (Array.isArray(cur) && cur.length === 0) continue;
    return cur;
  }
  return undefined;
}

/* ================================================================== *
 * 2. Formatting
 * ================================================================== */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 1234 -> "1,234". Non-numbers -> "". */
export function fmtInt(value) {
  const n = num(value, NaN);
  if (!Number.isFinite(n)) return '';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Bytes -> "8.1 MB". Non-numbers -> "". */
export function fmtBytes(value) {
  const n = num(value, NaN);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** ISO string -> "14 August 2026". Anything unparseable -> "". */
export function fmtDate(value) {
  const d = parseDate(value);
  if (!d) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** ISO string -> "2026-08-14". */
export function fmtDay(value) {
  const d = parseDate(value);
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}

/** Parse an ISO-ish date; returns a Date or null. Never throws. */
export function parseDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const s = toText(value).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** "5 days ago" from an ISO date, relative to `now`. */
export function relative(value, now = Date.now()) {
  const d = parseDate(value);
  if (!d) return '';
  const secs = Math.round((now - d.getTime()) / 1000);
  const future = secs < 0;
  const s = Math.abs(secs);
  const units = [
    [60, 'second'], [60, 'minute'], [24, 'hour'],
    [7, 'day'], [4.348, 'week'], [12, 'month'], [Infinity, 'year'],
  ];
  let v = s;
  let label = 'second';
  for (let i = 0; i < units.length; i += 1) {
    const [size, name] = units[i];
    if (v < size || size === Infinity) { label = name; break; }
    v /= size;
    label = units[i + 1] ? units[i + 1][1] : 'year';
  }
  const n = Math.max(1, Math.round(v));
  if (label === 'second' && s < 45) return future ? 'in a moment' : 'just now';
  const phrase = `${n} ${label}${n === 1 ? '' : 's'}`;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/* ================================================================== *
 * 2b. Brief normalisation
 * ================================================================== */

/**
 * Read a repo brief (CONTRACT-FORGE §3) defensively into one flat shape.
 *
 * Every lookup tries several plausible locations because this module is written
 * against a contract rather than an implementation: fields may be nested under
 * `identity`/`composition`/`history`/`signals`, hoisted to the top level, or
 * absent entirely. Nothing here throws on a malformed brief.
 */
export function normalizeBrief(briefIn) {
  const b = (briefIn && typeof briefIn === 'object' && !Array.isArray(briefIn)) ? briefIn : {};
  const id = (b.identity && typeof b.identity === 'object') ? b.identity : {};
  const proj = (b.project && typeof b.project === 'object') ? b.project : {};
  const comp = (b.composition && typeof b.composition === 'object') ? b.composition : {};
  const hist = (b.history && typeof b.history === 'object') ? b.history : {};
  const sig = (b.signals && typeof b.signals === 'object') ? b.signals : {};
  const prose = (b.prose && typeof b.prose === 'object') ? b.prose : {};
  const src = { b, id, proj, comp, hist, sig, prose };

  const git = pick(id, 'git') || pick(proj, 'git') || pick(b, 'git') || {};

  return {
    name: firstStr(src, ['id.name', 'proj.name', 'b.name']) || 'Untitled project',
    slug: firstStr(src, ['id.id', 'proj.id', 'b.id', 'b.projectId']),
    path: firstStr(src, ['id.path', 'proj.path', 'b.path']),
    status: firstStr(src, ['id.status', 'proj.status', 'b.status']),
    statusReason: firstStr(src, ['id.statusReason', 'proj.statusReason', 'b.statusReason']),
    blurb: firstStr(src, ['id.blurb', 'proj.blurb', 'b.blurb', 'b.description']),
    lastActivityISO: firstStr(src, ['id.lastActivityISO', 'proj.lastActivityISO', 'b.lastActivityISO']),
    lastActivityRelative: firstStr(src, ['id.lastActivityRelative', 'proj.lastActivityRelative', 'b.lastActivityRelative']),
    primaryLanguage: firstStr(src, ['comp.primaryLanguage', 'id.primaryLanguage', 'proj.primaryLanguage', 'b.primaryLanguage']),
    stack: firstList(src, ['id.stack', 'proj.stack', 'b.stack', 'comp.stack']),

    isGit: pick(id, 'isGit') ?? pick(proj, 'isGit') ?? pick(b, 'isGit') ?? (!!git && Object.keys(git).length > 0),
    branch: toText(pick(git, 'branch')),
    remote: toText(pick(git, 'remote')),
    ahead: num(pick(git, 'ahead'), 0),
    behind: num(pick(git, 'behind'), 0),
    dirty: !!pick(git, 'dirty'),
    dirtyCount: num(pick(git, 'dirtyCount'), NaN),

    langs: firstList(src, ['comp.langBreakdown', 'id.langBreakdown', 'proj.langBreakdown',
      'b.langBreakdown', 'comp.languages', 'b.languages']),
    fileCount: firstNum(src, ['comp.fileCount', 'id.fileCount', 'proj.fileCount', 'b.fileCount']),
    dirCount: firstNum(src, ['comp.dirCount', 'id.dirCount', 'proj.dirCount', 'b.dirCount']),
    sizeBytes: firstNum(src, ['comp.sizeBytes', 'id.sizeBytes', 'proj.sizeBytes', 'b.sizeBytes']),

    docs: firstList(src, ['b.docs', 'id.docs', 'proj.docs', 'prose.docs']),
    featuredDoc: pick(b, 'featuredDoc') || pick(id, 'featuredDoc') || pick(proj, 'featuredDoc')
      || pick(prose, 'featured.doc') || null,
    featuredProse: pick(prose, 'featured') || pick(prose, 'featuredDoc') || null,

    manifests: firstList(src, ['b.manifests', 'b.manifest', 'id.manifests']),
    run: firstList(src, ['b.run', 'b.runCommands', 'b.howToRun', 'b.commands', 'b.scripts']),
    entryPoints: firstList(src, ['b.entryPoints', 'b.entrypoints', 'b.entries']),
    // `structure` may be a bare array of rows, or an object with `dirs` and
    // `rootFiles`. Merge both so the map shows top-level files as well as dirs.
    structure: mergeStructure(
      firstList(src, ['b.structure.dirs', 'b.dirs', 'b.structure', 'b.tree', 'b.directories']),
      firstList(src, ['b.structure.rootFiles', 'b.rootFiles'])
    ),

    commitCount: firstNum(src, ['hist.commitCount', 'b.commitCount']) ?? num(pick(git, 'commitCount'), undefined),
    firstCommitISO: firstStr(src, ['hist.firstCommitISO', 'hist.firstCommit', 'b.firstCommitISO']),
    lastCommitISO: firstStr(src, ['hist.lastCommitISO', 'hist.lastCommit', 'b.lastCommitISO'])
      || toText(pick(git, 'lastCommitISO')),
    recentCommits: firstList(src, ['hist.recentCommits', 'hist.commits', 'hist.subjects',
      'b.recentCommits', 'b.commits']),
    activity: firstList(src, ['hist.activity', 'b.activity']),
    topFiles: firstList(src, ['hist.topFiles', 'hist.topChangedFiles', 'hist.mostChanged', 'b.topFiles']),

    todoCount: firstNum(src, ['sig.todoCount', 'b.todoCount', 'id.todoCount', 'proj.todoCount']),
    todos: firstList(src, ['sig.todos', 'sig.todoSamples', 'b.todos']),
    hasTests: pick(sig, 'hasTests') ?? pick(id, 'hasTests') ?? pick(proj, 'hasTests') ?? pick(b, 'hasTests'),
    testLayout: firstStr(src, ['sig.testLayout', 'sig.tests', 'b.testLayout']) || testLayoutFrom(sig),
    dirtyFiles: firstList(src, ['sig.dirtyFiles', 'b.dirtyFiles']),
    configFiles: firstList(src, ['sig.configFiles', 'sig.config', 'b.configFiles']),

    /** The brief's own honest record of what it could not establish. */
    unknowns: firstList(src, ['b.unknowns', 'b.gaps', 'b.notes']),
    generatedAtISO: firstStr(src, ['b.generatedAtISO', 'b.generatedISO', 'b.builtAtISO', 'b.atISO']),
  };
}

/** Describe the test layout from whatever the brief actually recorded. */
function testLayoutFrom(sig) {
  const dirs = arr(pick(sig, 'testDirs')).map(toText).filter(Boolean);
  const files = arr(pick(sig, 'testFiles')).map(toText).filter(Boolean);
  const count = num(pick(sig, 'testFileCount'), files.length);
  const frameworks = arr(pick(sig, 'frameworks')).map(toText).filter(Boolean);
  const bits = [];
  if (dirs.length) bits.push(`in ${dirs.slice(0, 4).join(', ')}`);
  if (count) bits.push(`${fmtInt(count)} test file${count === 1 ? '' : 's'}`);
  if (frameworks.length) bits.push(frameworks.slice(0, 3).join(', '));
  return bits.join(' · ');
}

function firstStr(src, paths) {
  for (const p of paths) {
    const dot = p.indexOf('.');
    const v = pick(src[p.slice(0, dot)], p.slice(dot + 1));
    const s = toText(v).trim();
    if (s) return s;
  }
  return '';
}

function firstNum(src, paths) {
  for (const p of paths) {
    const dot = p.indexOf('.');
    const v = pick(src[p.slice(0, dot)], p.slice(dot + 1));
    const n = num(v, NaN);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstList(src, paths) {
  for (const p of paths) {
    const dot = p.indexOf('.');
    const v = pick(src[p.slice(0, dot)], p.slice(dot + 1));
    if (Array.isArray(v) && v.length) return v;
    // A flat map of name -> string (e.g. package.json `scripts`) becomes rows.
    // Anything with nested objects is a record, not a list: skip it, or a
    // container like `structure: {dirs, rootFiles}` would be mangled into rows.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const flat = keys.length > 0
        && keys.every((k) => v[k] === null || ['string', 'number', 'boolean'].includes(typeof v[k]));
      if (flat) {
        return keys.map((k) => ({ name: k, command: toText(v[k]), source: p.split('.').pop() }));
      }
    }
  }
  return [];
}

/** Directories plus root-level files, in one path-sorted list. */
function mergeStructure(dirs, rootFiles) {
  const d = arr(dirs).filter((e) => e && typeof e === 'object');
  const f = arr(rootFiles)
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ ...e, type: 'file' }));
  if (!f.length) return d;
  return [...d, ...f].sort((a, b) => {
    const pa = toText(a.path);
    const pb = toText(b.path);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}

/* ================================================================== *
 * 3. Stylesheet: the Forge house style
 * ================================================================== */

/**
 * The complete stylesheet for a Forge artifact.
 *
 * Palette shape follows the user's own artifacts: the full light palette lives
 * on bare `:root`; the dark theme redefines ONLY the tokens that change, under
 * `prefers-color-scheme: dark` guarded against an explicit light override, and
 * again under `[data-theme="dark"]` so a forced toggle wins. No colour is ever
 * defined solely inside a media query.
 */
export function stylesheet() {
  return `
:root{
  --ground:#F6F7F9; --surface:#FFFFFF; --surface-2:#ECEFF3; --surface-3:#E2E7EE;
  --ink:#161B22; --ink-2:#4B5563; --ink-3:#8A94A3;
  --rule:#DCE1E8; --rule-2:#C2C9D4;
  --accent:#3B4F8C; --accent-soft:#E3E8F5; --accent-line:#B9C4E4;
  --good:#2C6A52; --good-soft:#E0EDE7;
  --warn:#9C5A22; --warn-soft:#F6EADB;
  --c1:#3B4F8C; --c2:#5C71AC; --c3:#8193C6; --c4:#A6B3D9; --c5:#C6CEE7; --c6:#DEE3F1;
  --h0:#E7EAEF; --h1:#C9D2E9; --h2:#9AAAD6; --h3:#6A80BA; --h4:#3B4F8C;
  --shadow:0 1px 2px rgba(22,27,34,.05),0 6px 16px -8px rgba(22,27,34,.12);
  --display:Georgia,'Iowan Old Style','Times New Roman',serif;
  --body:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
  --measure:72ch;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0F1319; --surface:#171C24; --surface-2:#1F262F; --surface-3:#28303A;
  --ink:#EAEEF4; --ink-2:#AAB4C2; --ink-3:#79838F;
  --rule:#28303A; --rule-2:#39424E;
  --accent:#9CB0E8; --accent-soft:#1C2436; --accent-line:#33405F;
  --good:#7FC4A6; --good-soft:#182A24;
  --warn:#D8975A; --warn-soft:#2E2418;
  --c1:#9CB0E8; --c2:#7C90C9; --c3:#6172A6; --c4:#4B5880; --c5:#3A445F; --c6:#2C3346;
  --h0:#1E252F; --h1:#2E3B55; --h2:#47598A; --h3:#6E85C4; --h4:#9CB0E8;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 16px -8px rgba(0,0,0,.5);
}}
:root[data-theme="dark"]{
  --ground:#0F1319; --surface:#171C24; --surface-2:#1F262F; --surface-3:#28303A;
  --ink:#EAEEF4; --ink-2:#AAB4C2; --ink-3:#79838F;
  --rule:#28303A; --rule-2:#39424E;
  --accent:#9CB0E8; --accent-soft:#1C2436; --accent-line:#33405F;
  --good:#7FC4A6; --good-soft:#182A24;
  --warn:#D8975A; --warn-soft:#2E2418;
  --c1:#9CB0E8; --c2:#7C90C9; --c3:#6172A6; --c4:#4B5880; --c5:#3A445F; --c6:#2C3346;
  --h0:#1E252F; --h1:#2E3B55; --h2:#47598A; --h3:#6E85C4; --h4:#9CB0E8;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 16px -8px rgba(0,0,0,.5);
}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--body);
  font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;
  overflow-x:hidden}
img{max-width:100%;height:auto}
a{color:var(--accent);text-underline-offset:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}

/* Only the horizontal padding lives here, so an element can be BOTH the
   centred column and carry its own vertical rhythm (main, .mast-in) without
   the shorthand wiping it out. */
.wrap{max-width:820px;margin:0 auto;padding-left:22px;padding-right:22px}

/* --- masthead ------------------------------------------------------ */
header.mast{background:var(--surface);border-bottom:1px solid var(--rule)}
.mast-in{padding-top:44px;padding-bottom:30px;display:flex;flex-direction:column;gap:18px}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--accent);margin:0}
h1{font-family:var(--display);font-weight:400;font-size:clamp(30px,5.4vw,46px);
  line-height:1.05;margin:0;letter-spacing:-.015em;text-wrap:balance;
  overflow-wrap:anywhere}
.standfirst{font-size:17px;color:var(--ink-2);margin:0;max-width:64ch;line-height:1.5}

/* --- stat band ----------------------------------------------------- */
.strip{display:flex;flex-wrap:wrap;border:1px solid var(--rule);border-radius:4px;
  overflow:hidden;margin:0}
.cell{flex:1 1 128px;padding:11px 14px;border-right:1px solid var(--rule);
  border-top:1px solid var(--rule);background:var(--surface);margin-top:-1px}
.cell:last-child{border-right:none}
.cell dt{font-family:var(--mono);font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink-3);margin:0 0 3px}
.cell dd{margin:0;font-size:14.5px;font-weight:600;font-variant-numeric:tabular-nums;
  overflow-wrap:anywhere}
.cell dd .unit{font-weight:400;color:var(--ink-3);font-size:12.5px}

/* --- callouts ------------------------------------------------------ */
.callout{background:var(--accent-soft);border-radius:4px;padding:15px 17px;
  display:flex;flex-direction:column;gap:8px}
.callout h2{font-family:var(--mono);font-size:10px;letter-spacing:.11em;
  text-transform:uppercase;color:var(--accent);margin:0;font-weight:600}
.callout p{margin:0;font-size:14.5px;line-height:1.55;color:var(--ink-2)}
.callout p strong{color:var(--ink);font-weight:600}
.callout.plain{background:var(--surface-2)}
.callout.plain h2{color:var(--ink-3)}
.callout.warnish{background:var(--warn-soft)}
.callout.warnish h2{color:var(--warn)}

/* --- sections ------------------------------------------------------ */
main{padding-top:34px;padding-bottom:56px}
section{margin-bottom:40px}
section:last-child{margin-bottom:0}
h2.sec{font-family:var(--display);font-weight:400;font-size:27px;margin:0 0 4px;
  line-height:1.2;letter-spacing:-.01em;text-wrap:balance}
p.seclabel{font-family:var(--mono);font-size:11px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink-3);margin:0 0 16px}
h3{font-family:var(--display);font-weight:400;font-size:20px;margin:28px 0 9px;
  line-height:1.25;letter-spacing:-.005em}
p.body{font-size:15.5px;color:var(--ink-2);max-width:var(--measure);margin:0 0 13px}
p.body:last-child{margin-bottom:0}
p.body strong{color:var(--ink);font-weight:600}
p.note{font-size:13.5px;color:var(--ink-3);max-width:var(--measure);margin:11px 0 0;
  line-height:1.5}
ul.body,ol.body{font-size:15.5px;color:var(--ink-2);max-width:var(--measure);
  margin:0 0 13px;padding-left:20px;display:flex;flex-direction:column;gap:7px}
ul.body strong,ol.body strong{color:var(--ink);font-weight:600}
.rule{border:0;border-top:1px solid var(--rule);margin:34px 0}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}

code,.path{font-family:var(--mono);font-size:.88em;background:var(--surface-2);
  padding:1px 5px;border-radius:2px;overflow-wrap:anywhere}
pre{font-family:var(--mono);font-size:13px;line-height:1.55;background:var(--surface-2);
  border:1px solid var(--rule);border-radius:4px;padding:12px 14px;margin:0 0 13px;
  overflow-x:auto}
pre code{background:none;padding:0;font-size:inherit}

/* --- code figures ---------------------------------------------------
   A bare stack of <pre> blocks reads as a text file. A snippet that matters
   gets a frame: where it came from above it, what to take from it below. */
figure.snip{margin:0 0 16px;border:1px solid var(--rule);border-radius:4px;
  background:var(--surface);overflow:hidden;break-inside:avoid}
figure.snip figcaption{display:flex;align-items:baseline;gap:10px;
  padding:7px 12px;background:var(--surface-2);
  border-bottom:1px solid var(--rule);
  font-family:var(--mono);font-size:11px;color:var(--ink-3)}
figure.snip figcaption .f{color:var(--accent);overflow-wrap:anywhere}
figure.snip figcaption .t{margin-left:auto;font-size:10px;letter-spacing:.09em;
  text-transform:uppercase;white-space:nowrap}
figure.snip pre{margin:0;border:0;border-radius:0;background:var(--surface)}
figure.snip .why{padding:10px 13px 12px;border-top:1px solid var(--rule);
  font-size:14.5px;line-height:1.55;color:var(--ink-2)}
figure.snip .why b{color:var(--ink);font-weight:600}
/* Point at the exact token under discussion, inside the code itself. */
pre mark,code mark{background:var(--accent-soft);color:var(--ink);
  border-radius:2px;padding:0 3px;box-shadow:inset 0 -1px 0 var(--accent-line)}

/* --- term grid -------------------------------------------------------
   For a glossary of constructs or an API surface: many short entries that
   would be a dozen thin sections if each got a heading of its own. */
ul.terms{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));
  gap:10px;margin:0 0 14px;padding:0;list-style:none}
ul.terms > li{border:1px solid var(--rule);border-radius:4px;
  padding:10px 12px;background:var(--surface);break-inside:avoid}
ul.terms .t{display:block;margin-bottom:5px;font-family:var(--mono);
  font-size:11.5px;letter-spacing:.02em;color:var(--accent);
  overflow-wrap:anywhere}
ul.terms .d{font-size:13.5px;line-height:1.5;color:var(--ink-2)}
ul.terms .w{display:block;margin-top:6px;font-family:var(--mono);font-size:11px;
  color:var(--ink-3);overflow-wrap:anywhere}

/* --- tables -------------------------------------------------------- */
.tw{overflow-x:auto;border:1px solid var(--rule);border-radius:4px;
  background:var(--surface);margin:0 0 6px;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px;margin:0}
th,td{text-align:left;padding:9px 13px;border-bottom:1px solid var(--rule);
  vertical-align:top}
th{font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-3);font-weight:600;background:var(--surface-2);white-space:nowrap}
tr:last-child td{border-bottom:none}
td b{color:var(--ink);font-weight:600}
td .path,td code{background:none;padding:0}
td.n{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ink-2)}
td.m{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
td.sub{color:var(--ink-3);font-size:13px}
td .sub{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);margin-top:2px;
  overflow-wrap:anywhere}

/* --- pills --------------------------------------------------------- */
.pills{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 4px;padding:0;list-style:none}
.pill{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;
  padding:3px 8px;border-radius:2px;background:var(--surface-2);color:var(--ink-2);
  white-space:nowrap}
.pill.ok{background:var(--good-soft);color:var(--good)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.accent{background:var(--accent-soft);color:var(--accent)}

/* --- composition bar ----------------------------------------------- */
.comp{display:flex;flex-direction:column;gap:11px}
.compbar{display:flex;width:100%;height:12px;border-radius:2px;overflow:hidden;
  background:var(--surface-2);border:1px solid var(--rule)}
.compbar span{display:block;height:100%;min-width:1px}
.compbar span+span{box-shadow:inset 1px 0 0 var(--surface)}
.complegend{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0;padding:0;list-style:none}
.complegend li{display:flex;align-items:baseline;gap:7px;font-size:13.5px;color:var(--ink-2)}
.sw{width:9px;height:9px;border-radius:2px;flex:none;transform:translateY(-1px)}
.complegend b{color:var(--ink);font-weight:600}
.complegend .n{font-family:var(--mono);font-size:12px;color:var(--ink-3);
  font-variant-numeric:tabular-nums}

/* --- heatmap ------------------------------------------------------- */
.heat{display:flex;flex-direction:column;gap:10px}
.heatscroll{overflow-x:auto;padding-bottom:2px;-webkit-overflow-scrolling:touch}
.heatscroll svg{display:block}
.heatfoot{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;
  font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-3)}
.scale{display:flex;align-items:center;gap:4px}
.scale i{width:10px;height:10px;border-radius:2px;display:block}

/* --- file tree ----------------------------------------------------- */
.treewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:4px;
  background:var(--surface);-webkit-overflow-scrolling:touch}
ul.tree{list-style:none;margin:0;padding:12px 14px;font-family:var(--mono);
  font-size:12.5px;line-height:1.9;min-width:max-content}
ul.tree li{display:flex;gap:14px;align-items:baseline;white-space:nowrap}
ul.tree .nm{color:var(--ink)}
ul.tree .nm.dir{color:var(--accent);font-weight:600}
ul.tree .meta{margin-left:auto;color:var(--ink-3);font-size:11px;padding-left:24px}

/* --- log / commit list --------------------------------------------- */
ul.log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
ul.log li{display:flex;gap:12px;align-items:baseline;padding:8px 0;
  border-bottom:1px solid var(--rule);font-size:14.5px}
ul.log li:last-child{border-bottom:none}
ul.log .sha{font-family:var(--mono);font-size:11.5px;color:var(--accent);flex:none;
  padding-top:1px}
ul.log .subj{flex:1 1 auto;color:var(--ink-2);overflow-wrap:anywhere;line-height:1.45}
ul.log .when{font-family:var(--mono);font-size:11px;color:var(--ink-3);flex:none;
  white-space:nowrap;padding-top:1px}

/* --- definition rows ----------------------------------------------- */
dl.facts{margin:0;display:grid;grid-template-columns:minmax(96px,auto) 1fr;
  gap:0;font-size:14.5px}
dl.facts dt{font-family:var(--mono);font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink-3);padding:8px 20px 8px 0;
  border-top:1px solid var(--rule);white-space:nowrap}
dl.facts dd{margin:0;padding:8px 0;border-top:1px solid var(--rule);color:var(--ink-2);
  overflow-wrap:anywhere;min-width:0}
dl.facts dt:first-of-type,dl.facts dd:first-of-type{border-top:none}
dl.facts dd b{color:var(--ink);font-weight:600}
dl.facts dd .path{background:none;padding:0;font-size:13px}

/* --- disclosure ---------------------------------------------------- */
details.fold{border:1px solid var(--rule);border-radius:4px;background:var(--surface);
  box-shadow:var(--shadow);overflow:hidden}
details.fold>summary{cursor:pointer;list-style:none;padding:11px 15px;
  font-family:var(--mono);font-size:11px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-3);display:flex;gap:10px;align-items:baseline}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary .foldn{margin-left:auto;color:var(--ink-3);opacity:.85;
  font-variant-numeric:tabular-nums}
details.fold>summary::after{content:"+";margin-left:12px;color:var(--accent);
  font-size:13px;line-height:1}
details.fold>summary:hover{color:var(--accent)}
details.fold[open]>summary::after{content:"–"}
details.fold[open]>summary{border-bottom:1px solid var(--rule)}
details.fold .foldbody{padding:13px 15px 16px}
details.fold .foldbody>.treewrap,details.fold .foldbody>.tw{border:none;border-radius:0}
details.fold .foldbody:has(>.treewrap),details.fold .foldbody:has(>.tw){padding:0}

/* --- empty state --------------------------------------------------- */
.hollow{border:1px dashed var(--rule-2);border-radius:4px;padding:26px 20px;
  text-align:center;color:var(--ink-3);font-size:14.5px;background:var(--surface)}
.hollow b{display:block;font-family:var(--display);font-size:19px;line-height:1.25;
  color:var(--ink-2);font-weight:400;margin-bottom:5px}

/* --- footer -------------------------------------------------------- */
footer{border-top:1px solid var(--rule);background:var(--surface);
  padding:30px 0 48px;font-size:14.5px;color:var(--ink-2)}
footer h2{font-family:var(--display);font-weight:400;font-size:21px;margin:0 0 10px;
  color:var(--ink)}
footer p{max-width:var(--measure);margin:0 0 11px;line-height:1.6}
footer ul{max-width:var(--measure);margin:0 0 11px;padding-left:20px;
  display:flex;flex-direction:column;gap:7px}
footer .colophon{font-family:var(--mono);font-size:11px;letter-spacing:.06em;
  color:var(--ink-3);margin:18px 0 0;line-height:1.7;overflow-wrap:anywhere}

/* --- narrow screens ------------------------------------------------ */
/* Keep the stat band on tidy rows rather than letting one trailing cell
   stretch across a whole row on its own. */
@media (max-width:800px){.cell{flex:1 1 33.333%}}

@media (max-width:560px){
  .wrap{padding-left:16px;padding-right:16px}
  .mast-in{padding-top:32px;padding-bottom:24px}
  .cell{flex:1 1 50%}
  dl.facts{grid-template-columns:1fr;gap:0}
  dl.facts dt{padding:8px 0 0;border-top:1px solid var(--rule)}
  dl.facts dd{padding:2px 0 8px;border-top:none}
  dl.facts dd:first-of-type{border-top:none}
  ul.log li{flex-wrap:wrap;gap:4px 12px}
  ul.log .subj{flex:1 1 100%;order:3}
}

@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

@media print{
  :root{--ground:#fff;--surface:#fff;--surface-2:#f4f4f4;--ink:#000;--ink-2:#333;
    --ink-3:#666;--rule:#ccc;--accent:#243a72;--accent-soft:#eef1f9}
  body{font-size:11pt}
  .wrap{max-width:none}
  header.mast,footer{background:none}
  details.fold{box-shadow:none}
  details.fold>summary::after{content:""}
  details.fold .foldbody{display:block!important}
  section{break-inside:avoid-page}
  .heatscroll,.treewrap,.tw{overflow:visible}
}
`.trim();
}

/* ================================================================== *
 * 4. Document shell
 * ================================================================== */

/**
 * Wrap body HTML in a complete, self-contained HTML document.
 * `title` and `description` are escaped here; `bodyHtml` must already be safe.
 */
export function page({ title, description = '', bodyHtml = '', extraCss = '' }) {
  const desc = clamp(description, 300);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${desc ? `<meta name="description" content="${esc(desc)}">\n` : ''}<title>${esc(clamp(title, 120) || 'Project brief')}</title>
<style>
${stylesheet()}${extraCss ? `\n${extraCss}` : ''}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

/* ================================================================== *
 * 5. Building blocks
 * ================================================================== */

/** A masthead. `standfirst` is plain text and is escaped. */
export function masthead({ eyebrow, title, standfirst, extraHtml = '' }) {
  const parts = [];
  if (eyebrow) parts.push(`<p class="eyebrow">${esc(clamp(eyebrow, 120))}</p>`);
  parts.push(`<h1>${esc(clamp(title, 140) || 'Untitled project')}</h1>`);
  if (standfirst) parts.push(`<p class="standfirst">${esc(clamp(standfirst, 380))}</p>`);
  if (extraHtml) parts.push(extraHtml);
  return `<header class="mast"><div class="wrap mast-in">\n${parts.join('\n')}\n</div></header>`;
}

/** A titled section. `bodyHtml` must already be safe HTML. */
export function section({ id, title, label, bodyHtml }) {
  if (!bodyHtml) return '';
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<section${idAttr}>
<h2 class="sec">${esc(clamp(title, 120))}</h2>
${label ? `<p class="seclabel">${esc(clamp(label, 140))}</p>` : ''}
${bodyHtml}
</section>`;
}

/**
 * The stat band. `items` is `[{ label, value, unit }]`; empty values are dropped.
 */
export function statBand(items) {
  const cells = arr(items)
    .map((it) => ({
      label: toText(it && it.label),
      value: toText(it && it.value),
      unit: toText(it && it.unit),
    }))
    .filter((it) => it.label && it.value);
  if (!cells.length) return '';
  const html = cells.map((it) => `<div class="cell"><dt>${esc(it.label)}</dt>` +
    `<dd>${esc(it.value)}${it.unit ? ` <span class="unit">${esc(it.unit)}</span>` : ''}</dd></div>`).join('');
  return `<dl class="strip">${html}</dl>`;
}

/** A callout box. `paragraphs` are plain strings; light `<strong>` is added by caller-free markup. */
export function callout({ heading, paragraphs, tone = '' }) {
  const ps = arr(paragraphs, true).map(toText).filter(Boolean);
  if (!ps.length && !heading) return '';
  const cls = tone === 'plain' ? ' plain' : tone === 'warn' ? ' warnish' : '';
  return `<div class="callout${cls}">` +
    (heading ? `<h2>${esc(clamp(heading, 90))}</h2>` : '') +
    ps.map((p) => `<p>${esc(p)}</p>`).join('') +
    '</div>';
}

/** A callout whose paragraphs are pre-built safe HTML (for inline <strong>/<code>). */
export function calloutHtml({ heading, paragraphsHtml, tone = '' }) {
  const ps = arr(paragraphsHtml, true).filter(Boolean);
  if (!ps.length && !heading) return '';
  const cls = tone === 'plain' ? ' plain' : tone === 'warn' ? ' warnish' : '';
  return `<div class="callout${cls}">` +
    (heading ? `<h2>${esc(clamp(heading, 90))}</h2>` : '') +
    ps.map((p) => `<p>${p}</p>`).join('') +
    '</div>';
}

/** An empty-state block. */
export function hollow(title, detail = '') {
  return `<div class="hollow"><b>${esc(clamp(title, 120))}</b>${detail ? esc(clamp(detail, 240)) : ''}</div>`;
}

/**
 * A table. `head` is an array of column labels; `rows` is an array of arrays of
 * cells. A cell is a string, or `{ text, cls, strong }`. Everything is escaped.
 */
export function table(head, rows, { caption = '' } = {}) {
  const cols = arr(head).map(toText);
  const body = arr(rows).filter((r) => Array.isArray(r) && r.length);
  if (!body.length) return '';
  const th = cols.length ? `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>` : '';
  const tr = body.map((row) => `<tr>${row.map((cell) => {
    const c = (cell && typeof cell === 'object' && !Array.isArray(cell)) ? cell : { text: cell };
    const cls = toText(c.cls);
    const inner = c.strong ? `<b>${esc(toText(c.text))}</b>` : esc(toText(c.text));
    const sub = c.sub ? `<div class="sub">${esc(clamp(c.sub, 200))}</div>` : '';
    return `<td${cls ? ` class="${esc(cls)}"` : ''}>${inner}${sub}</td>`;
  }).join('')}</tr>`).join('\n');
  return `<div class="tw"><table>${caption ? `<caption class="sr">${esc(caption)}</caption>` : ''}\n${th}\n${tr}\n</table></div>`;
}

/** A row of small pills. `items` is `[{ text, tone }]` or plain strings. */
export function pills(items) {
  const list = arr(items)
    .map((it) => (typeof it === 'object' && it ? { text: toText(it.text ?? it.label), tone: toText(it.tone) } : { text: toText(it), tone: '' }))
    .filter((it) => it.text);
  if (!list.length) return '';
  return `<ul class="pills">${list.map((it) => {
    const tone = ['ok', 'warn', 'accent'].includes(it.tone) ? ` ${it.tone}` : '';
    return `<li class="pill${tone}">${esc(clamp(it.text, 48))}</li>`;
  }).join('')}</ul>`;
}

/** A collapsible block. `bodyHtml` must already be safe. */
export function fold({ summary, bodyHtml, open = false, count = null, countLabel = 'entries' }) {
  if (!bodyHtml) return '';
  const c = num(count, NaN);
  const n = Number.isFinite(c)
    ? `<span class="foldn">${esc(fmtInt(c))} ${esc(c === 1 ? countLabel.replace(/s$/, '') : countLabel)}</span>`
    : '';
  return `<details class="fold"${open ? ' open' : ''}><summary>${esc(clamp(summary, 90))}${n}</summary>` +
    `<div class="foldbody">${bodyHtml}</div></details>`;
}

/** A definition list of facts. `rows` is `[{ label, value }]` or `[label, value]`. */
export function facts(rows) {
  const list = arr(rows)
    .map((r) => (Array.isArray(r) ? { label: r[0], value: r[1] } : r || {}))
    .map((r) => ({ label: toText(r.label), value: toText(r.value), mono: !!r.mono }))
    .filter((r) => r.label && r.value);
  if (!list.length) return '';
  return `<dl class="facts">${list.map((r) => `<dt>${esc(r.label)}</dt>` +
    `<dd>${r.mono ? `<span class="path">${esc(r.value)}</span>` : esc(r.value)}</dd>`).join('')}</dl>`;
}

/* ================================================================== *
 * 6. Composition bar
 * ================================================================== */

/**
 * A stacked language-composition bar plus legend.
 * `langs` is `[{ lang, bytes, pct }]`. Percentages are recomputed from bytes
 * when they are missing or do not add up, so the bar is never wrong.
 */
export function compositionBar(langs) {
  const raw = arr(langs)
    .map((l) => ({
      lang: toText(l && (l.lang ?? l.language ?? l.name)),
      bytes: num(l && l.bytes, 0),
      pct: num(l && l.pct, NaN),
    }))
    .filter((l) => l.lang);
  if (!raw.length) return '';

  const totalBytes = raw.reduce((s, l) => s + l.bytes, 0);
  const list = raw.map((l) => {
    let pct = Number.isFinite(l.pct) ? l.pct : (totalBytes > 0 ? (l.bytes / totalBytes) * 100 : 0);
    if (!Number.isFinite(pct) || pct < 0) pct = 0;
    return { ...l, pct };
  });
  const sum = list.reduce((s, l) => s + l.pct, 0);
  if (sum <= 0) return '';
  // Normalise so the bar always fills exactly, whatever the brief said.
  const scaled = list.map((l) => ({ ...l, w: (l.pct / sum) * 100 }));
  const remainder = Math.max(0, 100 - sum);

  const segs = scaled.map((l, i) => `<span style="width:${fixed(l.w)}%;background:var(--c${Math.min(i + 1, 6)})"` +
    ` title="${esc(`${l.lang}: ${fixed(l.pct)}%`)}"></span>`).join('');

  const legend = scaled.map((l, i) => `<li><span class="sw" style="background:var(--c${Math.min(i + 1, 6)})"></span>` +
    `<b>${esc(clamp(l.lang, 30))}</b> <span class="n">${esc(fixed(l.pct))}%` +
    `${l.bytes > 0 ? esc(` · ${fmtBytes(l.bytes)}`) : ''}</span></li>`).join('');

  const tail = remainder > 0.5
    ? `<p class="note">The remaining ${esc(fixed(remainder))}% is spread across file types too small to list individually.</p>`
    : '';

  return `<div class="comp"><div class="compbar" role="img" aria-label="${esc(
    `Language composition: ${scaled.map((l) => `${l.lang} ${fixed(l.pct)}%`).join(', ')}`
  )}">${segs}</div><ul class="complegend">${legend}</ul></div>${tail}`;
}

function fixed(n) {
  const v = num(n, 0);
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '');
}

/* ================================================================== *
 * 7. Commit heatmap
 * ================================================================== */

const DAY_MS = 86400000;

/**
 * A 90-day commit heatmap, hand-authored SVG, no script.
 * `activity` is `[{ date: "YYYY-MM-DD", count: n }]` ascending.
 */
export function heatmap(activity, { cell = 15, gap = 4, label = 'commits' } = {}) {
  const days = arr(activity)
    .map((d) => ({ date: toText(d && d.date).slice(0, 10), count: Math.max(0, num(d && d.count, 0)) }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  if (!days.length) return '';

  const byDate = new Map();
  for (const d of days) byDate.set(d.date, (byDate.get(d.date) || 0) + d.count);

  const stamps = [...byDate.keys()].map(dayStamp).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (!stamps.length) return '';
  const first = stamps[0];
  const last = stamps[stamps.length - 1];

  // Start on the Sunday on or before the first day, so weeks are columns.
  const firstDow = new Date(first).getUTCDay();
  const gridStart = first - firstDow * DAY_MS;
  const totalDays = Math.round((last - gridStart) / DAY_MS) + 1;
  const cols = Math.max(1, Math.ceil(totalDays / 7));

  const max = Math.max(...[...byDate.values()], 1);
  const step = cell + gap;
  const gutter = 26;
  const topLabel = 16;
  const width = gutter + cols * step;
  const height = topLabel + 7 * step;

  const rects = [];
  const monthMarks = [];
  let lastMonth = -1;

  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < 7; r += 1) {
      const stamp = gridStart + (c * 7 + r) * DAY_MS;
      if (stamp < first || stamp > last) continue;
      const d = new Date(stamp);
      const key = d.toISOString().slice(0, 10);
      const count = byDate.get(key) || 0;
      const lvl = count === 0 ? 0
        : count >= max * 0.75 ? 4
          : count >= max * 0.5 ? 3
            : count >= max * 0.25 ? 2 : 1;
      const x = gutter + c * step;
      const y = topLabel + r * step;
      const title = `${count} ${count === 1 ? label.replace(/s$/, '') : label} on ${key}`;
      rects.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5"` +
        ` fill="var(--h${lvl})"><title>${esc(title)}</title></rect>`);
      if (r === 0 || (c === 0 && monthMarks.length === 0)) {
        const m = d.getUTCMonth();
        if (m !== lastMonth) {
          lastMonth = m;
          monthMarks.push(`<text x="${gutter + c * step}" y="10" class="hm">${esc(MONTHS_SHORT[m])}</text>`);
        }
      }
    }
  }

  const dowLabels = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]
    .map(([r, t]) => `<text x="0" y="${topLabel + r * step + cell * 0.78}" class="hd">${esc(t)}</text>`)
    .join('');

  const total = [...byDate.values()].reduce((s, n) => s + n, 0);
  const activeDays = [...byDate.values()].filter((n) => n > 0).length;
  const span = Math.round((last - first) / DAY_MS) + 1;

  const scale = [0, 1, 2, 3, 4]
    .map((l) => `<i style="background:var(--h${l})"></i>`).join('');
  const one = label.replace(/s$/, '');
  const summary = `${fmtInt(total)} ${total === 1 ? one : label} in this window · `
    + `${fmtInt(activeDays)} active day${activeDays === 1 ? '' : 's'} of ${fmtInt(span)}`;

  return `<div class="heat">
<div class="heatscroll"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    `${summary}, ending ${[...byDate.keys()].sort().pop()}`
  )}">
<style>.hm{font:600 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;fill:var(--ink-3)}
.hd{font:600 8.5px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;fill:var(--ink-3)}</style>
${monthMarks.join('')}
${dowLabels}
${rects.join('\n')}
</svg></div>
<p class="heatfoot"><span>${esc(summary)}</span>
<span class="scale">none ${scale} ${esc(fmtInt(max))}</span></p>
</div>`;
}

function dayStamp(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/* ================================================================== *
 * 8. Directory map
 * ================================================================== */

/**
 * A directory / file map.
 *
 * Accepts either shape the brief might use:
 *   { path, type: "dir"|"file", depth, sizeBytes }        (flat tree)
 *   { path, fileCount, dominantExt, depth, sizeBytes }    (per-directory summary)
 */
export function directoryMap(entries, { limit = 140 } = {}) {
  const list = arr(entries).map((e) => {
    const p = toText(e && (e.path ?? e.dir ?? e.name)).replace(/^\.?\//, '').replace(/\/$/, '');
    const explicitType = toText(e && e.type).toLowerCase();
    const count = num(e && (e.fileCount ?? e.files), NaN);
    const isDir = explicitType === 'dir' || explicitType === 'directory'
      || (!explicitType && Number.isFinite(count));
    // Depth always comes from the path: briefs disagree about whether the top
    // level is 0 or 1, and mixing the two would break the indentation.
    const depth = Math.max(0, p.split('/').length - 1);
    const bits = [];
    if (isDir) {
      if (Number.isFinite(count)) bits.push(`${fmtInt(count)} file${count === 1 ? '' : 's'}`);
      const ext = toText(e.dominantExt);
      if (ext) bits.push(ext.startsWith('.') ? ext : `.${ext}`);
    } else {
      const sz = fmtBytes(e && (e.sizeBytes ?? e.size ?? e.bytes));
      if (sz) bits.push(sz);
    }
    return { path: p, isDir, depth, meta: bits.join(' · ') };
  }).filter((e) => e.path);

  if (!list.length) return '';

  const shown = list.slice(0, limit);
  const rows = shown.map((e) => {
    const name = e.path.split('/').pop() || e.path;
    const indent = '&nbsp;'.repeat(Math.min(e.depth, 6) * 2);
    return `<li>${indent}<span class="nm${e.isDir ? ' dir' : ''}">${esc(name)}${e.isDir ? '/' : ''}</span>` +
      (e.meta ? `<span class="meta">${esc(e.meta)}</span>` : '') + '</li>';
  }).join('\n');

  const extra = list.length - shown.length;
  const more = extra > 0
    ? `<p class="note">${esc(fmtInt(extra))} further entr${extra === 1 ? 'y' : 'ies'} not shown.</p>`
    : '';

  return `<div class="treewrap"><ul class="tree">\n${rows}\n</ul></div>${more}`;
}

/* ================================================================== *
 * 9. Commit log
 * ================================================================== */

/** A commit list. `commits` is `[{ sha, subject, dateISO, relative, author }]`. */
export function commitLog(commits, { limit = 20, now = Date.now() } = {}) {
  const list = arr(commits).map((c) => ({
    sha: toText(c && (c.sha ?? c.hash ?? c.id)).slice(0, 8),
    subject: toText(c && (c.subject ?? c.message ?? c.title)),
    when: toText(c && c.relative) || relative(c && (c.dateISO ?? c.date), now),
  })).filter((c) => c.subject || c.sha);
  if (!list.length) return '';
  const rows = list.slice(0, limit).map((c) => `<li>` +
    (c.sha ? `<span class="sha">${esc(c.sha)}</span>` : '') +
    `<span class="subj">${esc(clamp(c.subject, 180) || '(no subject)')}</span>` +
    (c.when ? `<span class="when">${esc(c.when)}</span>` : '') +
    `</li>`).join('\n');
  return `<ul class="log">\n${rows}\n</ul>`;
}

/* ================================================================== *
 * 10. Misc small builders
 * ================================================================== */

/** Inline `<code>`-wrapped, escaped snippet: safe to embed in prose HTML. */
export function code(value) {
  const s = toText(value);
  return s ? `<code>${esc(s)}</code>` : '';
}

/** A `<strong>`-wrapped, escaped run: safe to embed in prose HTML. */
export function strong(value) {
  const s = toText(value);
  return s ? `<strong>${esc(s)}</strong>` : '';
}

/** A plain paragraph of body prose (escaped). */
export function para(value, cls = 'body') {
  const s = toText(value);
  return s ? `<p class="${esc(cls)}">${esc(s)}</p>` : '';
}

/** A bullet list of plain strings (escaped). */
export function list(items, { ordered = false, cls = 'body' } = {}) {
  const rows = arr(items, false).map(toText).filter(Boolean);
  if (!rows.length) return '';
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag} class="${esc(cls)}">${rows.map((r) => `<li>${esc(r)}</li>`).join('')}</${tag}>`;
}

/** A bullet list whose items are pre-built safe HTML. */
export function listHtml(itemsHtml, { ordered = false, cls = 'body' } = {}) {
  const rows = arr(itemsHtml, false).filter(Boolean);
  if (!rows.length) return '';
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag} class="${esc(cls)}">${rows.map((r) => `<li>${r}</li>`).join('')}</${tag}>`;
}

/** A preformatted block (escaped). */
export function pre(value) {
  const s = toText(value);
  return s ? `<pre><code>${esc(s)}</code></pre>` : '';
}
