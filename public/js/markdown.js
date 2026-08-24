/*
 * ground-control/public/js/markdown.js
 *
 * A self-contained, zero-dependency markdown -> HTML renderer.
 *
 *   export function render(markdown, opts = {}) -> string
 *   export function headings(markdown) -> Array<{ level, text, id }>
 *   export function plainText(markdown, maxChars) -> string
 *
 * Security posture: every document handed to this module comes off the user's
 * disk and is treated as hostile. Raw HTML in the source is NEVER passed
 * through -- it is escaped to text. Every `href`/`src` goes through one
 * allowlist (`safeUrl`). No `style=`, no `on*=`, no `javascript:`/`data:`.
 * Text is escaped as it is emitted, never re-scanned afterwards, so no crafted
 * input can smuggle a tag through a later transform.
 */

/* ------------------------------------------------------------------ *
 * Escaping
 * ------------------------------------------------------------------ */

/** Full escape. Used for code, attribute values, and anything literal. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ENTITY_AT = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/;

/**
 * Escape prose. Identical to `esc` except that a well-formed HTML entity
 * reference (`&amp;`, `&copy;`, `&#8212;`) is preserved verbatim so documents
 * that use entities render as their authors intended. A bare `&` still becomes
 * `&amp;`, and `<` `>` `"` are always escaped -- an entity can never introduce
 * a tag.
 */
function escText(s) {
  const str = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '&') {
      const m = ENTITY_AT.exec(str.slice(i, i + 34));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
      out += '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else out += c;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * URL allowlist
 * ------------------------------------------------------------------ */

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp', 'ftps']);

function decodeNumericEntities(s) {
  return s.replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});?/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&colon;?/gi, ':')
    .replace(/&Tab;?|&NewLine;?/gi, ' ')
    .replace(/&amp;?/gi, '&');
}
function cp(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/**
 * The single gate every href/src passes through.
 * Returns a safe URL string, or '' when the URL must be dropped.
 */
function safeUrl(raw) {
  if (raw == null) return '';
  let url = String(raw).trim();
  if (!url) return '';
  // Control characters have no business in a URL and are the classic way to
  // break up a scheme (`java\tscript:`).
  url = url.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  if (!url) return '';

  // Probe copy: entity-decoded, whitespace stripped, lowercased. If *this*
  // looks like a dangerous scheme we reject, regardless of the original form.
  let probe = url;
  for (let i = 0; i < 3; i++) {
    const next = decodeNumericEntities(probe);
    if (next === probe) break;
    probe = next;
  }
  probe = probe.replace(/[\s\u0000-\u0020\u00a0\u2000-\u200f\ufeff]/g, '').toLowerCase();

  const m = /^([a-z][a-z0-9+.\-]*):/.exec(probe);
  if (m) {
    if (!ALLOWED_SCHEMES.has(m[1])) return '';
  } else if (probe.startsWith('//')) {
    // protocol-relative: fine, inherits http(s)
  } else if (/^[a-z][a-z0-9+.\-]*:/.test(probe) === false && probe.includes(':')) {
    // A colon that is not a scheme (e.g. `a b:c`) -- allow, it's relative.
  }
  return url;
}

/* ------------------------------------------------------------------ *
 * Path helpers for link/image rewriting
 * ------------------------------------------------------------------ */

function baseDirOf(basePath) {
  let b = String(basePath || '').replace(/^\/+/, '');
  if (!b) return '';
  if (b.endsWith('/')) return b.replace(/\/+$/, '');
  const i = b.lastIndexOf('/');
  return i < 0 ? '' : b.slice(0, i);
}

function resolveRel(baseDir, rel) {
  const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
  const parts = String(rel).split('/');
  if (String(rel).startsWith('/')) stack.length = 0;
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { stack.pop(); continue; }
    stack.push(seg);
  }
  return stack.join('/');
}

const ABSOLUTE_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.\-]*:|\/\/)/;
const MD_EXT_RE = /\.(?:md|markdown|mdown|mkd)$/i;

/**
 * Turn a source href into { href, attrs } ready for emission (already escaped).
 * Returns null when the URL was rejected by the allowlist.
 */
function linkAttrs(rawHref, ctx) {
  const clean = safeUrl(rawHref);
  if (clean === '') return null;

  // Pure fragment -> untouched.
  if (clean.startsWith('#')) return { href: esc(clean), extra: '' };

  if (ABSOLUTE_RE.test(clean)) {
    const isWeb = /^(?:https?:|\/\/)/i.test(clean);
    return { href: esc(clean), extra: isWeb ? ' target="_blank" rel="noreferrer noopener"' : '' };
  }

  // Relative. Split off query/fragment before resolving the path.
  const hashAt = clean.indexOf('#');
  const path = hashAt >= 0 ? clean.slice(0, hashAt) : clean;
  const frag = hashAt >= 0 ? clean.slice(hashAt) : '';
  if (!path) return { href: esc(clean), extra: '' };

  const resolved = resolveRel(ctx.baseDir, path);
  if (!resolved) return { href: esc(clean), extra: '' };

  if (MD_EXT_RE.test(resolved)) {
    if (!ctx.docBase) return { href: esc(clean), extra: ' data-doc="' + esc(resolved) + '"' };
    return {
      href: esc(ctx.docBase + encodeURIComponent(resolved) + frag),
      extra: ' data-doc="' + esc(resolved) + '"',
    };
  }
  if (!ctx.rawBase) return { href: esc(clean), extra: '' };
  return { href: esc(ctx.rawBase + encodeURIComponent(resolved) + frag), extra: '' };
}

function imageSrc(rawSrc, ctx) {
  const clean = safeUrl(rawSrc);
  if (clean === '') return null;
  if (clean.startsWith('#')) return null;
  if (ABSOLUTE_RE.test(clean)) return esc(clean);
  const hashAt = clean.indexOf('#');
  const path = hashAt >= 0 ? clean.slice(0, hashAt) : clean;
  const resolved = resolveRel(ctx.baseDir, path);
  if (!resolved) return null;
  if (!ctx.rawBase) return esc(clean);
  return esc(ctx.rawBase + encodeURIComponent(resolved));
}

/* ------------------------------------------------------------------ *
 * Slugs
 * ------------------------------------------------------------------ */

function slugify(text, seen) {
  let base = String(text)
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'section';
  if (!seen) return base;
  const n = (seen.get(base) || 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : base + '-' + n;
}

/* ------------------------------------------------------------------ *
 * Inline: strip markdown to plain text (used for ids, alt text, TOC text)
 * ------------------------------------------------------------------ */

function stripInline(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  // Collapse first so constructs that wrap across lines still match below.
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/`+([^`]*)`+/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/<((?:https?|mailto|ftp|tel):[^>\s]+)>/g, '$1');
  t = t.replace(/<\/?[A-Za-z][^>]*>/g, '');
  // Emphasis markers. Underscores must not be stripped from inside words
  // (`DATA_CONTRACT.md`), so they need a non-word boundary on both sides.
  t = t.replace(/\*+([^*]+)\*+/g, '$1');
  t = t.replace(/(^|[^A-Za-z0-9_])_+([^_]+)_+(?![A-Za-z0-9_])/g, '$1$2');
  t = t.replace(/~+([^~]+)~+/g, '$1');
  t = t.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  return t.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * Inline parser
 * ------------------------------------------------------------------ */

const PUNCT_RE = /[!-/:-@[-`{-~\u00a1-\u00bf\u2010-\u2027\u2030-\u205e]/;
const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function isWs(ch) { return ch === undefined || /\s/.test(ch); }
function isPunct(ch) { return ch !== undefined && PUNCT_RE.test(ch); }

/** Normalise the text inside a code span per CommonMark. */
function codeSpanContent(s) {
  let t = s.replace(/\r?\n/g, ' ');
  if (t.length >= 2 && t[0] === ' ' && t[t.length - 1] === ' ' && /[^ ]/.test(t)) {
    t = t.slice(1, -1);
  }
  return t;
}

/** Find the `]` matching the `[` at `open`. Skips escapes, code spans, nesting. */
function findCloseBracket(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      let k = 0; while (src[i + k] === '`') k++;
      const close = src.indexOf('`'.repeat(k), i + k);
      if (close === -1) { i += k - 1; continue; }
      // must be an exact run
      let j = close; while (src[j] === '`') j++;
      if (j - close === k) { i = j - 1; continue; }
      i += k - 1; continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Parse `(dest "title")` starting at `i` (the `(`). Returns null on failure. */
function parseInlineDest(src, i) {
  if (src[i] !== '(') return null;
  let j = i + 1;
  while (j < src.length && /\s/.test(src[j])) j++;
  let dest = '';
  if (src[j] === '<') {
    const end = src.indexOf('>', j + 1);
    if (end === -1) return null;
    dest = src.slice(j + 1, end).replace(/\\(.)/g, '$1');
    j = end + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (/[\s]/.test(c)) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      j++;
    }
    dest = src.slice(start, j).replace(/\\(.)/g, '$1');
  }
  while (j < src.length && /\s/.test(src[j])) j++;
  let title = '';
  const tq = src[j];
  if (tq === '"' || tq === "'" || tq === '(') {
    const close = tq === '(' ? ')' : tq;
    let k = j + 1, buf = '';
    let ok = false;
    while (k < src.length) {
      if (src[k] === '\\') { buf += src[k + 1] || ''; k += 2; continue; }
      if (src[k] === close) { ok = true; break; }
      buf += src[k]; k++;
    }
    if (ok) { title = buf; j = k + 1; }
  }
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] !== ')') return null;
  return { dest, title, end: j + 1 };
}

function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

const BARE_URL_RE = /^(?:https?:\/\/|www\.)[^\s<>[\]`"']+/i;

/**
 * Parse an inline run into HTML.
 * @param {string} src   raw markdown (never pre-escaped)
 * @param {object} ctx
 * @param {number} depth recursion guard
 * @param {boolean} inLink suppress nested links/autolinks
 */
function inline(src, ctx, depth, inLink) {
  depth = depth || 0;
  if (depth > 12) return escText(src);
  const nodes = [];
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'text', v: buf }); buf = ''; } };
  const html = (v) => { flush(); nodes.push({ t: 'html', v }); };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];

    /* backslash escapes and hard breaks */
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { flush(); nodes.push({ t: 'html', v: '<br>\n' }); i += 2; continue; }
      if (nx !== undefined && ESCAPABLE.indexOf(nx) !== -1) { buf += nx; i += 2; continue; }
      buf += '\\'; i++; continue;
    }

    /* code spans -- may themselves contain backticks */
    if (c === '`') {
      let k = 0; while (src[i + k] === '`') k++;
      let j = i + k, found = -1;
      while (j < n) {
        const at = src.indexOf('`'.repeat(k), j);
        if (at === -1) break;
        let e = at; while (src[e] === '`') e++;
        if (e - at === k) { found = at; break; }
        j = e;
      }
      if (found === -1) { buf += '`'.repeat(k); i += k; continue; }
      html('<code>' + esc(codeSpanContent(src.slice(i + k, found))) + '</code>');
      i = found + k;
      continue;
    }

    /* `<...>`: comments stripped, autolinks honoured, everything else escaped */
    if (c === '<') {
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4);
        if (end !== -1) { i = end + 3; continue; }
        buf += '<'; i++; continue;
      }
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^<>\u0000-\u0020]*)>/.exec(src.slice(i));
      if (auto && !inLink) {
        const u = linkAttrs(auto[1], ctx);
        if (u) { html('<a href="' + u.href + '"' + u.extra + '>' + escText(auto[1]) + '</a>'); i += auto[0].length; continue; }
        buf += auto[1]; i += auto[0].length; continue;
      }
      const mail = /^<([^\s<>@]+@[^\s<>@]+\.[A-Za-z]{2,})>/.exec(src.slice(i));
      if (mail && !inLink) {
        html('<a href="' + esc('mailto:' + mail[1]) + '">' + escText(mail[1]) + '</a>');
        i += mail[0].length; continue;
      }
      // Raw HTML tag from the source: escaped to text, never emitted.
      buf += '<'; i++; continue;
    }

    /* images */
    if (c === '!' && src[i + 1] === '[') {
      const close = findCloseBracket(src, i + 1);
      if (close !== -1) {
        const label = src.slice(i + 2, close);
        const res = resolveLinkTarget(src, close + 1, label, ctx);
        if (res) {
          const s = imageSrc(res.dest, ctx);
          const alt = esc(stripInline(label));
          if (s) {
            html('<img src="' + s + '" alt="' + alt + '"' +
              (res.title ? ' title="' + esc(res.title) + '"' : '') + ' loading="lazy">');
          } else {
            html('<span class="md-img-blocked">' + alt + '</span>');
          }
          i = res.end; continue;
        }
      }
      buf += '!'; i++; continue;
    }

    /* links (including reference links) */
    if (c === '[' && !inLink) {
      const close = findCloseBracket(src, i);
      if (close !== -1) {
        const label = src.slice(i + 1, close);
        const res = resolveLinkTarget(src, close + 1, label, ctx);
        if (res) {
          const a = linkAttrs(res.dest, ctx);
          const inner = inline(label, ctx, depth + 1, true);
          if (a) {
            html('<a href="' + a.href + '"' + a.extra +
              (res.title ? ' title="' + esc(res.title) + '"' : '') + '>' + inner + '</a>');
          } else {
            html(inner);
          }
          i = res.end; continue;
        }
      }
      buf += '['; i++; continue;
    }

    /* emphasis / strong / strikethrough delimiter runs */
    if (c === '*' || c === '_' || c === '~') {
      let k = 0; while (src[i + k] === c) k++;
      if (c === '~' && k > 2) { buf += c.repeat(k); i += k; continue; }
      const prev = i === 0 ? undefined : src[i - 1];
      const next = src[i + k];
      const nextWs = isWs(next), prevWs = isWs(prev);
      const nextPunct = isPunct(next), prevPunct = isPunct(prev);
      const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || prevPunct);
        canClose = rightFlank && (!leftFlank || nextPunct);
      } else {
        canOpen = leftFlank; canClose = rightFlank;
      }
      flush();
      nodes.push({ t: 'delim', ch: c, len: k, origLen: k, canOpen, canClose });
      i += k; continue;
    }

    /* bare URL autolink */
    if ((c === 'h' || c === 'H' || c === 'w' || c === 'W') && !inLink &&
      (i === 0 || !/[A-Za-z0-9/@._~:-]/.test(src[i - 1]))) {
      const m = BARE_URL_RE.exec(src.slice(i));
      if (m) {
        let u = m[0];
        // trailing punctuation rarely belongs to the URL
        let trimmed = u.replace(/[.,;:!?)\]}'"]+$/, '');
        // keep a balanced closing paren
        const opens = (trimmed.match(/\(/g) || []).length;
        const closes = (trimmed.match(/\)/g) || []).length;
        if (opens > closes && u[trimmed.length] === ')') trimmed += ')';
        if (trimmed.length > 6 && /[a-z]/i.test(trimmed.replace(/^https?:\/\//i, ''))) {
          const target = /^www\./i.test(trimmed) ? 'https://' + trimmed : trimmed;
          const a = linkAttrs(target, ctx);
          if (a) {
            html('<a href="' + a.href + '"' + a.extra + '>' + escText(trimmed) + '</a>');
            i += trimmed.length; continue;
          }
        }
      }
    }

    /* line breaks */
    if (c === '\n') {
      const hard = /  +$/.test(buf);
      buf = buf.replace(/[ \t]+$/, '');
      flush();
      nodes.push({ t: 'html', v: hard ? '<br>\n' : '\n' });
      i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  processEmphasis(nodes);
  return serialize(nodes);
}

/**
 * After a link/image label, work out the destination:
 * inline `(...)`, full reference `[label]`, collapsed `[]`, or shortcut.
 */
function resolveLinkTarget(src, after, label, ctx) {
  if (src[after] === '(') {
    const d = parseInlineDest(src, after);
    if (d) return { dest: d.dest, title: d.title, end: d.end };
  }
  if (src[after] === '[') {
    const close = src.indexOf(']', after + 1);
    if (close !== -1) {
      const ref = src.slice(after + 1, close);
      const key = normalizeLabel(ref || label);
      const def = ctx.refs.get(key);
      if (def) return { dest: def.dest, title: def.title, end: close + 1 };
      return null;
    }
  }
  const def = ctx.refs.get(normalizeLabel(label));
  if (def) return { dest: def.dest, title: def.title, end: after };
  return null;
}

function delimToText(nd) {
  if (nd.t === 'delim') { nd.t = 'text'; nd.v = nd.ch.repeat(nd.len); }
}

function processEmphasis(nodes) {
  let closerIdx = 0;
  let guard = 0;
  while (closerIdx < nodes.length) {
    if (++guard > 20000) break;
    const closer = nodes[closerIdx];
    if (!closer || closer.t !== 'delim' || !closer.canClose) { closerIdx++; continue; }

    let openerIdx = -1;
    for (let j = closerIdx - 1; j >= 0; j--) {
      const o = nodes[j];
      if (!o || o.t !== 'delim' || o.ch !== closer.ch || !o.canOpen) continue;
      // CommonMark "rule of three"
      if ((closer.canOpen || o.canClose) &&
        (o.origLen + closer.origLen) % 3 === 0 &&
        !(o.origLen % 3 === 0 && closer.origLen % 3 === 0)) continue;
      openerIdx = j; break;
    }

    if (openerIdx === -1) {
      if (!closer.canOpen) delimToText(closer);
      closerIdx++;
      continue;
    }

    const opener = nodes[openerIdx];
    let use, tag;
    if (closer.ch === '~') {
      use = Math.min(opener.len, closer.len, 2);
      tag = 'del';
    } else {
      use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      tag = use === 2 ? 'strong' : 'em';
    }

    const children = nodes.slice(openerIdx + 1, closerIdx);
    for (const ch of children) delimToText(ch);

    opener.len -= use;
    closer.len -= use;

    const wrap = { t: 'wrap', tag, children };
    nodes.splice(openerIdx + 1, closerIdx - openerIdx - 1, wrap);
    let ci = openerIdx + 2;
    if (closer.len === 0) nodes.splice(ci, 1);
    if (opener.len === 0) { nodes.splice(openerIdx, 1); ci--; }
    closerIdx = Math.max(0, ci);
  }
  for (const nd of nodes) delimToText(nd);
}

function serialize(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (!nd) continue;
    if (nd.t === 'text') out += escText(nd.v);
    else if (nd.t === 'html') out += nd.v;
    else if (nd.t === 'wrap') out += '<' + nd.tag + '>' + serialize(nd.children) + '</' + nd.tag + '>';
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Syntax highlighting
 * ------------------------------------------------------------------ */

function words(list) { return new RegExp('(?:' + list.join('|') + ')\\b', 'y'); }

const PY_KW = ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield', 'match', 'case', 'self', 'cls'];
const PY_BUILTIN = ['abs', 'all', 'any', 'bool', 'bytes', 'dict', 'dir', 'enumerate', 'filter',
  'float', 'format', 'frozenset', 'getattr', 'hasattr', 'hash', 'id', 'int', 'isinstance', 'iter',
  'len', 'list', 'map', 'max', 'min', 'next', 'object', 'open', 'ord', 'pow', 'print', 'range',
  'repr', 'reversed', 'round', 'set', 'setattr', 'sorted', 'str', 'sum', 'super', 'tuple', 'type',
  'zip', 'Exception', 'ValueError', 'TypeError', 'KeyError', 'RuntimeError'];

const JS_KW = ['abstract', 'any', 'as', 'asserts', 'async', 'await', 'boolean', 'break', 'case',
  'catch', 'class', 'const', 'constructor', 'continue', 'debugger', 'declare', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get',
  'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace',
  'new', 'number', 'of', 'override', 'private', 'protected', 'public', 'readonly', 'return',
  'satisfies', 'set', 'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'try',
  'type', 'typeof', 'unknown', 'var', 'void', 'while', 'with', 'yield'];
const JS_BUILTIN = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'console', 'document',
  'window', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map',
  'Set', 'Date', 'RegExp', 'Error', 'globalThis', 'process', 'require', 'module', 'exports'];

const SWIFT_KW = ['actor', 'any', 'as', 'associatedtype', 'async', 'await', 'break', 'case', 'catch',
  'class', 'continue', 'convenience', 'default', 'defer', 'deinit', 'didSet', 'do', 'dynamic',
  'else', 'enum', 'extension', 'fallthrough', 'fileprivate', 'final', 'for', 'func', 'get', 'guard',
  'if', 'import', 'in', 'indirect', 'infix', 'init', 'inout', 'internal', 'is', 'lazy', 'let',
  'mutating', 'nil', 'none', 'nonmutating', 'open', 'operator', 'optional', 'override', 'postfix',
  'precedencegroup', 'prefix', 'private', 'protocol', 'public', 'repeat', 'required', 'rethrows',
  'return', 'self', 'set', 'some', 'static', 'struct', 'subscript', 'super', 'switch', 'throw',
  'throws', 'try', 'typealias', 'unowned', 'var', 'weak', 'where', 'while', 'willSet', 'true',
  'false'];

const SH_KW = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case',
  'esac', 'in', 'function', 'select', 'time', 'return', 'break', 'continue', 'local', 'export',
  'readonly', 'declare', 'source', 'alias', 'unset', 'shift', 'trap', 'set', 'exit'];
const SH_CMD = ['echo', 'printf', 'cd', 'ls', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'cat',
  'head', 'tail', 'grep', 'egrep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'tr', 'find',
  'xargs', 'chmod', 'chown', 'curl', 'wget', 'tar', 'zip', 'unzip', 'git', 'npm', 'npx', 'node',
  'python', 'python3', 'pip', 'pip3', 'pytest', 'make', 'docker', 'kubectl', 'brew', 'swift',
  'xcodebuild', 'open', 'pwd', 'which', 'env', 'test', 'sudo', 'ssh', 'scp', 'jq', 'touch', 'diff'];

const SQL_KW = ['ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CHECK',
  'COLUMN', 'CONSTRAINT', 'CREATE', 'CROSS', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP',
  'ELSE', 'END', 'EXISTS', 'FOREIGN', 'FROM', 'FULL', 'GROUP', 'HAVING', 'IN', 'INDEX', 'INNER',
  'INSERT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL', 'OFFSET', 'ON',
  'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRIMARY', 'REFERENCES', 'RIGHT', 'SELECT', 'SET',
  'TABLE', 'THEN', 'UNION', 'UNIQUE', 'UPDATE', 'USING', 'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WITH'];
const SQL_FN = ['ABS', 'AVG', 'COALESCE', 'CONCAT', 'COUNT', 'DATE', 'DENSE_RANK', 'EXTRACT',
  'GREATEST', 'LAG', 'LEAD', 'LEAST', 'LOWER', 'MAX', 'MIN', 'NOW', 'NULLIF', 'RANK', 'ROUND',
  'ROW_NUMBER', 'SUBSTR', 'SUM', 'TRIM', 'UPPER'];

const GENERIC_KW = ['abstract', 'and', 'as', 'assert', 'async', 'await', 'bool', 'break', 'case',
  'catch', 'char', 'class', 'const', 'continue', 'def', 'default', 'defer', 'do', 'double', 'elif',
  'else', 'end', 'enum', 'extends', 'false', 'final', 'finally', 'float', 'fn', 'for', 'func',
  'function', 'go', 'if', 'impl', 'import', 'in', 'int', 'interface', 'let', 'match', 'mod', 'move',
  'mut', 'new', 'nil', 'not', 'null', 'or', 'package', 'private', 'pub', 'public', 'return',
  'self', 'static', 'struct', 'switch', 'then', 'this', 'throw', 'trait', 'true', 'try', 'type',
  'typedef', 'union', 'unsafe', 'use', 'var', 'void', 'where', 'while', 'yield'];

const R_WS = { re: /\s+/y };
const R_NUM = { re: /(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z_]*/y, cls: 'tok-num' };
const R_IDENT = { re: /[A-Za-z_$][A-Za-z0-9_$]*/y };
const R_FN = { re: /[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/y, cls: 'tok-fn' };
const R_PUNC = { re: /[{}()[\].,;:?!+\-*/%=<>&|^~@#$\\]+/y, cls: 'tok-punc' };

const LANGS = {
  python: [
    R_WS,
    { re: /#[^\n]*/y, cls: 'tok-com' },
    { re: /[rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?''')/y, cls: 'tok-str' },
    { re: /[rRbBuUfF]{0,2}(?:"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*')/y, cls: 'tok-str' },
    { re: /@[A-Za-z_][A-Za-z0-9_.]*/y, cls: 'tok-meta' },
    R_NUM,
    { re: words(PY_KW), cls: 'tok-kw' },
    { re: words(PY_BUILTIN), cls: 'tok-builtin' },
    { re: /[A-Z][A-Za-z0-9_]*(?=\s*[.(])/y, cls: 'tok-type' },
    R_FN, R_IDENT, R_PUNC,
  ],
  javascript: [
    R_WS,
    { re: /\/\/[^\n]*/y, cls: 'tok-com' },
    { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'tok-com' },
    { re: /`(?:\\[\s\S]|[^`\\])*`/y, cls: 'tok-str' },
    { re: /"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'/y, cls: 'tok-str' },
    R_NUM,
    { re: words(JS_KW), cls: 'tok-kw' },
    { re: words(JS_BUILTIN), cls: 'tok-builtin' },
    R_FN, R_IDENT, R_PUNC,
  ],
  swift: [
    R_WS,
    { re: /\/\/[^\n]*/y, cls: 'tok-com' },
    { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'tok-com' },
    { re: /"""[\s\S]*?"""/y, cls: 'tok-str' },
    { re: /"(?:\\[\s\S]|[^"\\\n])*"/y, cls: 'tok-str' },
    { re: /@[A-Za-z_][A-Za-z0-9_]*/y, cls: 'tok-meta' },
    { re: /#[A-Za-z_][A-Za-z0-9_]*/y, cls: 'tok-meta' },
    R_NUM,
    { re: words(SWIFT_KW), cls: 'tok-kw' },
    { re: /[A-Z][A-Za-z0-9_]*/y, cls: 'tok-type' },
    R_FN, R_IDENT, R_PUNC,
  ],
  bash: [
    R_WS,
    { re: /#[^\n]*/y, cls: 'tok-com' },
    { re: /<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?[\s\S]*?\n\1/y, cls: 'tok-str' },
    { re: /"(?:\\[\s\S]|[^"\\])*"/y, cls: 'tok-str' },
    { re: /'[^']*'/y, cls: 'tok-str' },
    { re: /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]/y, cls: 'tok-var' },
    { re: words(SH_KW), cls: 'tok-kw' },
    { re: words(SH_CMD), cls: 'tok-builtin' },
    R_NUM,
    R_IDENT,
    { re: /--?[A-Za-z][A-Za-z0-9_-]*/y, cls: 'tok-meta' },
    R_PUNC,
  ],
  json: [
    R_WS,
    { re: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/y, cls: 'tok-prop' },
    { re: /"(?:\\[\s\S]|[^"\\])*"/y, cls: 'tok-str' },
    { re: /\b(?:true|false|null)\b/y, cls: 'tok-kw' },
    { re: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y, cls: 'tok-num' },
    R_PUNC,
  ],
  jsonc: [
    R_WS,
    { re: /\/\/[^\n]*/y, cls: 'tok-com' },
    { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'tok-com' },
    { re: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/y, cls: 'tok-prop' },
    { re: /"(?:\\[\s\S]|[^"\\])*"/y, cls: 'tok-str' },
    { re: /\b(?:true|false|null)\b/y, cls: 'tok-kw' },
    { re: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y, cls: 'tok-num' },
    R_IDENT, R_PUNC,
  ],
  yaml: [
    { re: /[ \t]*(?:-[ \t]+)*[A-Za-z_][A-Za-z0-9_.\-/ ]*(?=[ \t]*:(?:\s|$))/y, cls: 'tok-prop', bol: true },
    { re: /[ \t]*(?:---|\.\.\.)[ \t]*$/my, cls: 'tok-meta', bol: true },
    R_WS,
    { re: /#[^\n]*/y, cls: 'tok-com' },
    { re: /"(?:\\[\s\S]|[^"\\\n])*"|'(?:''|[^'\n])*'/y, cls: 'tok-str' },
    { re: /&[A-Za-z0-9_-]+|\*[A-Za-z0-9_-]+/y, cls: 'tok-meta' },
    { re: /\b(?:true|false|null|yes|no|on|off|~)\b/iy, cls: 'tok-kw' },
    R_NUM,
    { re: /[A-Za-z_][A-Za-z0-9_.\-/]*/y },
    R_PUNC,
  ],
  sql: [
    R_WS,
    { re: /--[^\n]*/y, cls: 'tok-com' },
    { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'tok-com' },
    { re: /'(?:''|[^'])*'/y, cls: 'tok-str' },
    { re: /"(?:""|[^"])*"|`[^`]*`/y, cls: 'tok-prop' },
    { re: new RegExp('(?:' + SQL_KW.join('|') + ')\\b', 'iy'), cls: 'tok-kw' },
    { re: new RegExp('(?:' + SQL_FN.join('|') + ')\\b', 'iy'), cls: 'tok-fn' },
    R_NUM, R_IDENT, R_PUNC,
  ],
  css: [
    R_WS,
    { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'tok-com' },
    { re: /@[A-Za-z-]+/y, cls: 'tok-kw' },
    { re: /"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'/y, cls: 'tok-str' },
    { re: /--[A-Za-z0-9_-]+/y, cls: 'tok-var' },
    { re: /[A-Za-z-]+(?=\s*:)/y, cls: 'tok-prop' },
    { re: /#[0-9a-fA-F]{3,8}\b/y, cls: 'tok-num' },
    { re: /[.#][A-Za-z_][A-Za-z0-9_-]*|::?[a-z-]+/y, cls: 'tok-type' },
    { re: /-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|ch|fr|deg|pt)?/y, cls: 'tok-num' },
    R_FN,
    { re: /[A-Za-z_][A-Za-z0-9_-]*/y },
    R_PUNC,
  ],
  generic: [
    R_WS,
    { re: /(?:#|\/\/|--)[^\n]*/y, cls: 'tok-com' },
    { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'tok-com' },
    { re: /"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/y, cls: 'tok-str' },
    R_NUM,
    { re: words(GENERIC_KW), cls: 'tok-kw' },
    R_FN, R_IDENT, R_PUNC,
  ],
};

/* HTML gets a small dedicated tokenizer so attributes are handled properly. */
function highlightHtml(code) {
  let out = '', i = 0;
  const n = code.length;
  const TAG = /^<\/?[A-Za-z][A-Za-z0-9:-]*(?:"[^"]*"|'[^']*'|[^<>])*>/;
  while (i < n) {
    const c = code[i];
    if (c === '<') {
      if (code.startsWith('<!--', i)) {
        const e = code.indexOf('-->', i + 4);
        const end = e === -1 ? n : e + 3;
        out += '<span class="tok-com">' + esc(code.slice(i, end)) + '</span>';
        i = end; continue;
      }
      if (code[i + 1] === '!') {
        const e = code.indexOf('>', i);
        const end = e === -1 ? n : e + 1;
        out += '<span class="tok-meta">' + esc(code.slice(i, end)) + '</span>';
        i = end; continue;
      }
      const m = TAG.exec(code.slice(i));
      if (m) { out += htmlTag(m[0]); i += m[0].length; continue; }
      out += esc('<'); i++; continue;
    }
    const next = code.indexOf('<', i);
    const end = next === -1 ? n : next;
    out += esc(code.slice(i, end));
    i = end;
  }
  return out;
}

function htmlTag(tag) {
  const m = /^<\/?[A-Za-z][A-Za-z0-9:-]*/.exec(tag);
  if (!m) return esc(tag);
  let out = '<span class="tok-tag">' + esc(m[0]) + '</span>';
  const body = tag.slice(m[0].length);
  const re = /([A-Za-z_:][A-Za-z0-9_:.\-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?|(\s+)|([/>])|([\s\S])/g;
  let mm;
  while ((mm = re.exec(body))) {
    if (mm[1] !== undefined) {
      out += '<span class="tok-attr">' + esc(mm[1]) + '</span>' +
        '<span class="tok-punc">' + esc(mm[2]) + '</span>' +
        (mm[3] ? '<span class="tok-str">' + esc(mm[3]) + '</span>' : '');
    } else if (mm[4] !== undefined) out += esc(mm[4]);
    else if (mm[5] !== undefined) out += '<span class="tok-punc">' + esc(mm[5]) + '</span>';
    else out += esc(mm[6]);
  }
  return out;
}

const LANG_ALIASES = {
  py: 'python', python3: 'python', py3: 'python', ipython: 'python',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'javascript', tsx: 'javascript', typescript: 'javascript',
  swift: 'swift', swiftui: 'swift',
  sh: 'bash', shell: 'bash', bash: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
  shellsession: 'bash', 'shell-session': 'bash', fish: 'bash',
  json: 'json', json5: 'jsonc', jsonc: 'jsonc',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql', postgres: 'sql', postgresql: 'sql', psql: 'sql', mysql: 'sql', sqlite: 'sql',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  c: 'generic', h: 'generic', cpp: 'generic', 'c++': 'generic', cc: 'generic', hpp: 'generic',
  cs: 'generic', csharp: 'generic', java: 'generic', kotlin: 'generic', kt: 'generic',
  go: 'generic', golang: 'generic', rust: 'generic', rs: 'generic', ruby: 'generic', rb: 'generic',
  php: 'generic', scala: 'generic', dart: 'generic', r: 'generic', lua: 'generic',
  toml: 'generic', ini: 'generic', cfg: 'generic', conf: 'generic', dockerfile: 'generic',
  docker: 'generic', make: 'generic', makefile: 'generic', cmake: 'generic', groovy: 'generic',
  objc: 'generic', 'objective-c': 'generic', m: 'generic', perl: 'generic', proto: 'generic',
};

export function normalizeLang(info) {
  if (!info) return '';
  const first = String(info).trim().split(/[\s,{]/)[0].toLowerCase().replace(/^\./, '');
  return first;
}

function highlight(code, lang) {
  const key = LANG_ALIASES[lang] || (LANGS[lang] ? lang : null);
  if (!key) return esc(code);
  if (key === 'html') {
    try { return highlightHtml(code); } catch { return esc(code); }
  }
  const rules = LANGS[key];
  if (!rules) return esc(code);
  try {
    let out = '', i = 0, lineStart = 0;
    const n = code.length;
    let guard = 0;
    while (i < n) {
      if (++guard > n * 3 + 5000) return esc(code);
      let hit = null;
      for (const r of rules) {
        if (r.bol && !/^[ \t]*(?:-[ \t]+)*$/.test(code.slice(lineStart, i))) continue;
        r.re.lastIndex = i;
        const m = r.re.exec(code);
        if (m && m[0].length > 0) { hit = { m: m[0], cls: r.cls }; break; }
      }
      const text = hit ? hit.m : code[i];
      out += hit && hit.cls
        ? '<span class="' + hit.cls + '">' + esc(text) + '</span>'
        : esc(text);
      const nl = text.lastIndexOf('\n');
      if (nl >= 0) lineStart = i + nl + 1;
      i += text.length;
    }
    return out;
  } catch {
    return esc(code);
  }
}

/* ------------------------------------------------------------------ *
 * Block-level parsing
 * ------------------------------------------------------------------ */

const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*?))?[ \t]*$/;
const RE_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*)$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_BQ = /^ {0,3}>/;
const RE_BULLET = /^( {0,3})([-+*])(?:([ \t]+)|$)/;
const RE_ORDERED = /^( {0,3})(\d{1,9})([.)])(?:([ \t]+)|$)/;
const RE_SETEXT1 = /^ {0,3}=+[ \t]*$/;
const RE_SETEXT2 = /^ {0,3}-+[ \t]*$/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
const RE_DEF = /^ {0,3}\[([^\]^][^\]]*|)\]:[ \t]*(?:<([^<>\n]*)>|(\S+))[ \t]*(?:(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))[ \t]*)?$/;

function expandTabs(line) {
  if (line.indexOf('\t') === -1) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(4 - (out.length % 4));
    else out += ch;
  }
  return out;
}

function indentOf(line) {
  let i = 0;
  while (line[i] === ' ') i++;
  return i;
}

function isFenceLine(l) {
  const m = RE_FENCE.exec(l);
  if (!m) return false;
  if (m[2][0] === '`' && m[3].indexOf('`') !== -1) return false;
  return true;
}

function isListStart(l) { return RE_BULLET.test(l) || RE_ORDERED.test(l); }

function isBlockStartAny(l) {
  return RE_ATX.test(l) || isFenceLine(l) || RE_HR.test(l) || RE_BQ.test(l) ||
    isListStart(l) || /^ {0,3}<!--/.test(l);
}

/** Can this line interrupt an open paragraph? */
function canInterruptPara(l, lines, idx) {
  if (RE_ATX.test(l)) return true;
  if (isFenceLine(l)) return true;
  if (RE_HR.test(l)) return true;
  if (RE_BQ.test(l)) return true;
  if (/^ {0,3}<!--/.test(l)) return true;
  const b = RE_BULLET.exec(l);
  if (b && l.slice(b[0].length).trim()) return true;
  const o = RE_ORDERED.exec(l);
  if (o && o[2] === '1' && l.slice(o[0].length).trim()) return true;
  if (isTableStart(lines, idx)) return true;
  return false;
}

function isTableStart(lines, i) {
  const head = lines[i], delim = lines[i + 1];
  if (!head || !delim) return false;
  if (head.indexOf('|') === -1) return false;
  if (!RE_TABLE_DELIM.test(delim) || delim.indexOf('-') === -1) return false;
  if (RE_HR.test(delim) && delim.indexOf('|') === -1) return false;
  return splitRow(head).length === splitRow(delim).length && splitRow(delim).length > 0;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (/[^\\]\|$/.test(s) || s === '|') s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** Strip YAML front matter and collect reference definitions. */
function preprocess(src, ctx) {
  let text = String(src == null ? '' : src).replace(/\r\n?/g, '\n').replace(/\u0000/g, '\ufffd');
  let lines = text.split('\n').map(expandTabs);

  // front matter
  if (lines[0] !== undefined && /^---[ \t]*$/.test(lines[0])) {
    for (let i = 1; i < lines.length && i < 200; i++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i])) { lines = lines.slice(i + 1); break; }
    }
  }

  // reference definitions (outside fenced code)
  const kept = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      kept.push(l);
      if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$').test(l)) fence = null;
      continue;
    }
    const fm = RE_FENCE.exec(l);
    if (fm && !(fm[2][0] === '`' && fm[3].indexOf('`') !== -1)) { fence = fm[2]; kept.push(l); continue; }
    const d = RE_DEF.exec(l);
    if (d && d[1].trim()) {
      const key = normalizeLabel(d[1]);
      if (!ctx.refs.has(key)) {
        ctx.refs.set(key, {
          dest: (d[2] !== undefined ? d[2] : d[3]).replace(/\\(.)/g, '$1'),
          title: d[4] || d[5] || d[6] || '',
        });
      }
      continue;
    }
    kept.push(l);
  }
  return kept;
}

function hasInteriorBlank(lines) {
  let fence = null;
  let seenContent = false, blankAfterContent = false;
  for (const l of lines) {
    if (fence) {
      if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$').test(l)) fence = null;
      seenContent = true;
      continue;
    }
    const fm = RE_FENCE.exec(l);
    if (fm && !(fm[2][0] === '`' && fm[3].indexOf('`') !== -1)) { fence = fm[2]; seenContent = true; continue; }
    if (!l.trim()) { if (seenContent) blankAfterContent = true; continue; }
    if (blankAfterContent) return true;
    seenContent = true;
  }
  return false;
}

function headingBlock(level, rawText, ctx) {
  const plain = stripInline(rawText);
  const id = slugify(plain, ctx.slugs);
  ctx.headings.push({ level, text: plain, id });
  const inner = inline(rawText, ctx, 0, false);
  return '<h' + level + ' id="' + esc(id) + '">' + inner +
    '<a class="heading-anchor" href="#' + esc(id) + '" aria-label="Permalink to this section">#</a></h' + level + '>\n';
}

function codeBlock(code, lang) {
  const cls = lang ? ' class="language-' + esc(lang) + '"' : '';
  const attr = lang ? ' data-lang="' + esc(lang) + '"' : '';
  return '<pre class="md-pre"' + attr + '><code' + cls + '>' +
    highlight(code, lang) + '</code></pre>\n';
}

function tableBlock(lines, i, ctx) {
  const header = splitRow(lines[i]);
  const delim = splitRow(lines[i + 1]);
  const align = delim.map((d) => {
    const left = d.startsWith(':'), right = d.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
  const cols = header.length;
  let j = i + 2;
  const rows = [];
  while (j < lines.length) {
    const l = lines[j];
    if (!l.trim()) break;
    if (l.indexOf('|') === -1 && !RE_TABLE_DELIM.test(l)) break;
    if (isBlockStartAny(l) && l.indexOf('|') === -1) break;
    rows.push(splitRow(l));
    j++;
  }
  const cls = (k) => (align[k] ? ' class="md-' + align[k] + '"' : '');
  let out = '<div class="md-table-wrap"><table class="md-table">\n<thead>\n<tr>';
  for (let k = 0; k < cols; k++) out += '<th' + cls(k) + '>' + inline(header[k] || '', ctx, 0, false) + '</th>';
  out += '</tr>\n</thead>\n';
  if (rows.length) {
    out += '<tbody>\n';
    for (const r of rows) {
      out += '<tr>';
      for (let k = 0; k < cols; k++) out += '<td' + cls(k) + '>' + inline(r[k] || '', ctx, 0, false) + '</td>';
      out += '</tr>\n';
    }
    out += '</tbody>\n';
  }
  out += '</table></div>\n';
  return { html: out, next: j };
}

function parseList(lines, start, ctx) {
  const first = lines[start];
  let ordered = false, marker, startNum = 1;
  let m = RE_BULLET.exec(first);
  if (m) marker = m[2];
  else {
    m = RE_ORDERED.exec(first);
    if (!m) return null;
    ordered = true; marker = m[3]; startNum = parseInt(m[2], 10);
    if (!Number.isFinite(startNum)) startNum = 1;
  }

  const items = [];
  let i = start;
  let loose = false;

  while (i < lines.length) {
    const line = lines[i];
    const mm = ordered ? RE_ORDERED.exec(line) : RE_BULLET.exec(line);
    if (!mm) break;
    if ((ordered ? mm[3] : mm[2]) !== marker) break;
    if (RE_HR.test(line)) break;

    const indent = mm[1].length;
    const markerStr = ordered ? mm[2] + mm[3] : mm[2];
    const afterMarker = indent + markerStr.length;
    const rest = line.slice(afterMarker);
    const spaces = /^[ ]*/.exec(rest)[0].length;
    let contentIndent;
    if (!rest.trim()) contentIndent = afterMarker + 1;
    else if (spaces === 0 || spaces >= 5) contentIndent = afterMarker + 1;
    else contentIndent = afterMarker + spaces;

    const itemLines = [line.slice(Math.min(contentIndent, line.length))];
    i++;
    let blanks = 0;
    while (i < lines.length) {
      const l2 = lines[i];
      if (!l2.trim()) { itemLines.push(''); i++; blanks++; continue; }
      const ind = indentOf(l2);
      if (ind >= contentIndent) { itemLines.push(l2.slice(contentIndent)); i++; blanks = 0; continue; }
      if (blanks === 0 && !isBlockStartAny(l2) && !isTableStart(lines, i)) {
        itemLines.push(l2.replace(/^ +/, '')); i++; continue;
      }
      break;
    }
    let trailingBlank = false;
    while (itemLines.length && !itemLines[itemLines.length - 1].trim()) { itemLines.pop(); trailingBlank = true; }
    if (hasInteriorBlank(itemLines)) loose = true;
    items.push({ lines: itemLines, trailingBlank });
    if (i >= lines.length) break;
  }

  if (!items.length) return null;
  for (let k = 0; k < items.length - 1; k++) if (items[k].trailingBlank) loose = true;

  let out = ordered
    ? '<ol' + (startNum !== 1 ? ' start="' + startNum + '"' : '') + '>\n'
    : '<ul>\n';
  let anyTask = false;
  for (const it of items) {
    let lns = it.lines.slice();
    let task = null;
    const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(lns[0] || '');
    if (tm) {
      task = tm[1].toLowerCase() === 'x';
      lns[0] = lns[0].slice(tm[0].length);
      anyTask = true;
    }
    const body = renderBlocks(lns, ctx, !loose);
    const liCls = task === null ? '' : ' class="task-list-item"';
    const box = task === null ? '' :
      '<input class="task-checkbox" type="checkbox" disabled' + (task ? ' checked' : '') + '> ';
    out += '<li' + liCls + '>' + box + body.replace(/\n$/, '') + '</li>\n';
  }
  out += ordered ? '</ol>\n' : '</ul>\n';
  if (anyTask) out = out.replace(ordered ? '<ol' : '<ul', (ordered ? '<ol' : '<ul') + ' class="contains-task-list"');
  return { html: out, next: i, loose };
}

/**
 * Render an array of lines into HTML.
 * @param {boolean} tight when true, top-level paragraphs in this run are
 *                        emitted without <p> wrappers (tight list items).
 */
function renderBlocks(lines, ctx, tight) {
  let out = '';
  let i = 0;
  const n = lines.length;
  let guard = 0;

  while (i < n) {
    if (++guard > n * 8 + 10000) break;
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    /* HTML comment block */
    if (/^ {0,3}<!--/.test(line)) {
      let j = i;
      let found = false;
      while (j < n) { if (lines[j].indexOf('-->') !== -1) { found = true; break; } j++; }
      if (found) { i = j + 1; continue; }
    }

    /* fenced code */
    const fm = RE_FENCE.exec(line);
    if (fm && !(fm[2][0] === '`' && fm[3].indexOf('`') !== -1)) {
      const fenceChar = fm[2][0], fenceLen = fm[2].length, baseIndent = fm[1].length;
      const info = fm[3].trim();
      const closeRe = new RegExp('^ {0,3}' + (fenceChar === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$');
      const body = [];
      let j = i + 1;
      while (j < n && !closeRe.test(lines[j])) {
        let l = lines[j];
        let strip = 0;
        while (strip < baseIndent && l[strip] === ' ') strip++;
        body.push(l.slice(strip));
        j++;
      }
      out += codeBlock(body.join('\n'), normalizeLang(info));
      i = j < n ? j + 1 : n;
      continue;
    }

    /* ATX heading */
    const hm = RE_ATX.exec(line);
    if (hm) {
      let text = (hm[2] || '').replace(/(?:^|[ \t])#+[ \t]*$/, '').trim();
      out += headingBlock(hm[1].length, text, ctx);
      i++; continue;
    }

    /* thematic break */
    if (RE_HR.test(line)) { out += '<hr>\n'; i++; continue; }

    /* blockquote */
    if (RE_BQ.test(line)) {
      const inner = [];
      while (i < n) {
        const l = lines[i];
        if (RE_BQ.test(l)) { inner.push(l.replace(/^ {0,3}> ?/, '')); i++; continue; }
        const last = inner[inner.length - 1];
        if (l.trim() && last && last.trim() && !isBlockStartAny(l)) { inner.push(l); i++; continue; }
        break;
      }
      out += '<blockquote>\n' + renderBlocks(inner, ctx, false) + '</blockquote>\n';
      continue;
    }

    /* table */
    if (isTableStart(lines, i)) {
      const t = tableBlock(lines, i, ctx);
      out += t.html; i = t.next; continue;
    }

    /* lists */
    if (isListStart(line) && !RE_HR.test(line)) {
      const lst = parseList(lines, i, ctx);
      if (lst && lst.next > i) { out += lst.html; i = lst.next; continue; }
    }

    /* indented code */
    if (indentOf(line) >= 4) {
      const body = [];
      let j = i;
      while (j < n) {
        const l = lines[j];
        if (!l.trim()) { body.push(''); j++; continue; }
        if (indentOf(l) < 4) break;
        body.push(l.slice(4)); j++;
      }
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out += codeBlock(body.join('\n'), '');
      i = j; continue;
    }

    /* paragraph (with lazy continuation and setext headings) */
    const para = [];
    let setext = 0;
    while (i < n) {
      const l = lines[i];
      if (!l.trim()) break;
      if (para.length && RE_SETEXT1.test(l)) { setext = 1; i++; break; }
      if (para.length && RE_SETEXT2.test(l) && l.trim().length >= 1 && !isListStart(l)) { setext = 2; i++; break; }
      if (para.length && canInterruptPara(l, lines, i)) break;
      para.push(l.replace(/^ {0,3}/, ''));
      i++;
    }
    if (!para.length) { i++; continue; }
    const raw = para.join('\n').replace(/\s+$/, '');
    if (setext) {
      const text = raw.replace(/\n/g, ' ').trim();
      out += headingBlock(setext, text, ctx);
      continue;
    }
    const rendered = inline(raw, ctx, 0, false);
    out += tight ? rendered + '\n' : '<p>' + rendered + '</p>\n';
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function makeCtx(opts) {
  const o = opts || {};
  return {
    rawBase: typeof o.rawBase === 'string' ? o.rawBase : '',
    docBase: typeof o.docBase === 'string' ? o.docBase : '',
    baseDir: baseDirOf(o.basePath),
    refs: new Map(),
    slugs: new Map(),
    headings: [],
  };
}

/**
 * Render markdown to trusted-safe HTML.
 * @param {string} markdown
 * @param {{rawBase?:string, docBase?:string, basePath?:string}} [opts]
 * @returns {string}
 */
export function render(markdown, opts = {}) {
  try {
    const ctx = makeCtx(opts);
    const lines = preprocess(markdown, ctx);
    const body = renderBlocks(lines, ctx, false);
    return '<div class="ground-control-doc">\n' + body + '</div>';
  } catch (err) {
    return '<div class="ground-control-doc"><p class="md-error">Could not render this document (' +
      esc(err && err.message ? err.message : 'unknown error') + ').</p></div>';
  }
}

/**
 * The headings in a document, with ids identical to those `render()` emits.
 * Implemented by running the renderer so the two can never drift apart.
 * @returns {Array<{level:number, text:string, id:string}>}
 */
export function headings(markdown) {
  try {
    const ctx = makeCtx({});
    const lines = preprocess(markdown, ctx);
    renderBlocks(lines, ctx, false);
    return ctx.headings.map((h) => ({ level: h.level, text: h.text, id: h.id }));
  } catch {
    return [];
  }
}

/**
 * Flatten markdown to readable plain text.
 * @param {string} markdown
 * @param {number} [maxChars] truncate on a word boundary, appending an ellipsis
 * @returns {string}
 */
export function plainText(markdown, maxChars) {
  let t;
  try {
    t = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
    // front matter
    if (/^---[ \t]*\n/.test(t)) t = t.replace(/^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*\n/, '');
    t = t.replace(/<!--[\s\S]*?-->/g, ' ');
    t = t.replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*(?=\n|$)|$)/gm, ' ');
    t = t.replace(/^ {0,3}\[[^\]]+\]:[^\n]*$/gm, ' ');
    t = t.replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ');
    t = t.replace(/^ {0,3}#{1,6}[ \t]+/gm, '');
    t = t.replace(/^ {0,3}>[ \t]?/gm, '');
    t = t.replace(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '');
    t = t.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ' ');
    t = t.replace(/\|/g, ' ');
    t = stripInline(t);
  } catch {
    t = '';
  }
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0 || t.length <= limit) return t;
  let cut = t.slice(0, limit);
  const sp = cut.lastIndexOf(' ');
  if (sp > limit * 0.5) cut = cut.slice(0, sp);
  return cut.replace(/[\s.,;:!?-]+$/, '') + '\u2026';
}

export default { render, headings, plainText };
