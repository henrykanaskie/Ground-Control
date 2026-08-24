/**
 * Ground Control — document discovery, DocRef construction, featuredDoc selection
 * and blurb extraction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { collapseWhitespace, truncateWords, countWords } from './util.js';

/** Directories (below the project root) that doc discovery is allowed to look inside. */
const DOC_DIRS = new Set(['docs', 'doc', '.github']);

/** How much of a file we read to derive title / word count. */
const READ_LIMIT = 512 * 1024;

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/**
 * Map a relative POSIX path to a DocRef `kind`, or null if it is not a doc.
 * Filename matching is case-insensitive, per the contract.
 */
function classify(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  const ext = path.extname(lower);

  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
    if (/^(onboarding|onboard|getting[_-]?started)/.test(lower)) return 'onboarding';
    if (/^readme/.test(lower)) return 'readme';
    if (lower === 'claude.md' || lower === 'agents.md') return 'claude';
    if (/^(design|architecture|spec)/.test(lower) || /^adr-/.test(lower)) return 'design';
    return 'doc';
  }
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.ipynb') return 'notebook';
  return null;
}

function contentTypeFor(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'text';
}

/**
 * Is this relative path inside the doc search scope?
 * Project root (depth 1), plus any depth-2 file in a subdirectory that the
 * scanner did not already prune.
 *
 * Restricting depth 2 to `docs/`, `doc/`, `.github/` was too narrow for real
 * layouts: `plans/auxilium/` and `ideas/research/` hold the only writeups those
 * projects have, and both were invisible. The scanner's ignore list already
 * strips `node_modules`, virtualenvs, build output and dot-directories before
 * we get here, so accepting any surviving depth-2 directory adds real documents
 * rather than noise. Depth 3+ stays out — that is source, not documentation.
 */
function inDocScope(relPath) {
  const segs = relPath.split('/');
  if (segs.length === 1) return true;
  if (segs.length === 2) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** Read at most READ_LIMIT bytes of a file as utf-8. Returns '' on failure. */
function readHead(abs, limit = READ_LIMIT) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.allocUnsafe(limit);
    const n = fs.readSync(fd, buf, 0, limit, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ *
 * Titles
 * ------------------------------------------------------------------ */

/** First markdown H1 (ATX or setext), else null. */
function markdownTitle(text) {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length && i < 400; i++) {
    const line = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const atx = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) return cleanInline(atx[1]);
    // Setext: a text line immediately followed by ===
    if (line.trim() && /^\s{0,3}=+\s*$/.test(lines[i + 1] || '')) return cleanInline(line.trim());
  }
  return null;
}

function htmlTitle(text) {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (t && collapseWhitespace(stripTags(t[1]))) return collapseWhitespace(decodeEntities(stripTags(t[1])));
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
  if (h1 && collapseWhitespace(stripTags(h1[1]))) return collapseWhitespace(decodeEntities(stripTags(h1[1])));
  return null;
}

/** First markdown-cell heading of a notebook, else null. Parsing is best-effort. */
function notebookTitle(text) {
  try {
    const nb = JSON.parse(text);
    for (const cell of nb.cells || []) {
      if (cell.cell_type !== 'markdown') continue;
      const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
      const t = markdownTitle(src);
      if (t) return t;
    }
  } catch { /* truncated or not JSON — fall through */ }
  return null;
}

/** Strip inline markdown emphasis/links/code from a short string (heading, etc). */
function cleanInline(s) {
  return collapseWhitespace(
    String(s)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')      // images -> alt
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // links -> text
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')      // reference links -> text
      .replace(/`+/g, '')
      .replace(/\*\*\*|___/g, '')
      .replace(/\*\*|__/g, '')
      .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
      .replace(/~~/g, '')
      .replace(/<[^>]+>/g, '')
  );
}

/* ------------------------------------------------------------------ *
 * DocRef
 * ------------------------------------------------------------------ */

/**
 * Build a DocRef for `rel` inside `projectRoot`.
 * `stat` is optional; passed in from the walk to avoid a second stat().
 */
function buildDocRef(projectRoot, rel, stat) {
  const abs = path.join(projectRoot, rel);
  let st = stat;
  if (!st) {
    try { st = fs.statSync(abs); } catch { return null; }
  }
  const kind = classify(rel);
  if (!kind) return null;
  const contentType = contentTypeFor(rel);
  const base = rel.slice(rel.lastIndexOf('/') + 1);

  const text = readHead(abs);
  let title = null;
  if (contentType === 'markdown') title = markdownTitle(text);
  else if (contentType === 'html') title = htmlTitle(text);
  else if (kind === 'notebook') title = notebookTitle(text);
  if (!title) title = base;

  // Word count: exact for files we read whole, extrapolated for truncated reads.
  const sampleBytes = Buffer.byteLength(text, 'utf8');
  let wordCount;
  if (contentType === 'html') wordCount = countWords(stripTags(text));
  else if (kind === 'notebook') wordCount = countWords(text);
  else wordCount = countWords(text);
  if (sampleBytes > 0 && st.size > sampleBytes) {
    wordCount = Math.round(wordCount * (st.size / sampleBytes));
  }

  return {
    path: rel,
    title: truncateWords(title, 120),
    kind,
    contentType,
    sizeBytes: st.size,
    mtimeISO: new Date(st.mtimeMs).toISOString(),
    wordCount,
  };
}

/* ------------------------------------------------------------------ *
 * featuredDoc
 * ------------------------------------------------------------------ */

// onboarding > claude > readme > largest design > largest doc.
// html/notebook are intentionally NOT eligible (contract §2 precedence list).
// Markdown always wins; an HTML artifact is the last resort so that projects
// whose only explainer is a rendered page (e.g. growth/index.html) still
// surface something clickable instead of an empty card.
const FEATURED_ORDER = ['onboarding', 'claude', 'readme', 'design', 'doc', 'html'];

function pickFeatured(docs) {
  // Ranking runs in three passes, because neither "best kind" nor "shallowest
  // file" is right on its own:
  //
  //   1. An onboarding document wins at any depth — that is precisely the
  //      hand-written explainer this dashboard exists to surface, and it often
  //      lives in `docs/` (ML_quantitative_research/docs/ONBOARDING.md).
  //   2. Otherwise prefer a root-level document, by kind. Without this, a
  //      nested `ideas/team_dispatch/CLAUDE.md` outranks the project's own
  //      root README purely because `claude` sits higher in the kind order.
  //   3. Only if the root has nothing, fall back to nested documents, so
  //      `plans/` still surfaces `auxilium/SystemDesign.md` instead of nothing.
  const depth = (d) => d.path.split('/').length;
  const richest = (list) => list.slice().sort((a, b) =>
    (depth(a) - depth(b)) || (b.wordCount - a.wordCount) || (b.sizeBytes - a.sizeBytes))[0];

  const onboarding = docs.filter((d) => d.kind === 'onboarding');
  if (onboarding.length) return richest(onboarding);

  for (const scope of [(d) => depth(d) === 1, () => true]) {
    const pool = docs.filter(scope);
    for (const kind of FEATURED_ORDER) {
      const candidates = pool.filter((d) => d.kind === kind);
      if (candidates.length) return richest(candidates);
    }
  }
  return null;
}


/** Sort order for the `docs` array: by kind precedence, then richest first. */
const KIND_RANK = { onboarding: 0, claude: 1, readme: 2, design: 3, doc: 4, notebook: 5, html: 6 };

function sortDocs(docs) {
  return docs.slice().sort((a, b) => {
    const r = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
    if (r) return r;
    if (b.wordCount !== a.wordCount) return b.wordCount - a.wordCount;
    return a.path.localeCompare(b.path);
  });
}

/* ------------------------------------------------------------------ *
 * Blurb
 * ------------------------------------------------------------------ */

const BADGE_LINE = /^\s*(\[!\[|!\[|\[\s*!\[)/;          // badge rows: image (often linked)
const HTML_LINE = /^\s*<\/?[a-zA-Z!][^>]*>/;

/**
 * First real paragraph of a markdown document, stripped of markdown syntax,
 * whitespace-collapsed and truncated to 240 chars on a word boundary.
 */
function blurbFromMarkdown(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;

  // Skip YAML front matter.
  if (/^---\s*$/.test(lines[0] || '')) {
    i = 1;
    while (i < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[i])) i++;
    i++;
  }

  let inFence = false;
  let inComment = false;
  const para = [];

  for (; i < lines.length && i < 600; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (/^<!--/.test(line)) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    if (line === '') {
      if (para.length) break;          // paragraph ended
      continue;
    }
    // Lenient on purpose: `#Title` with no space is not a CommonMark heading,
    // but treating it as prose produced the blurb "#StockPortfolio". For a
    // one-line summary a malformed heading is still a heading, not a sentence.
    if (/^#{1,6}(\s|\S)/.test(line)) { if (para.length) break; continue; }   // heading
    if (/^>/.test(line)) { if (para.length) break; continue; }          // blockquote
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { if (para.length) break; continue; } // hr
    if (BADGE_LINE.test(line)) { if (para.length) break; continue; }    // badges
    if (HTML_LINE.test(line)) { if (para.length) break; continue; }     // raw html block
    if (/^\|/.test(line)) { if (para.length) break; continue; }         // table
    if (/^ {4,}\S/.test(raw) && !para.length) continue;                 // indented code

    para.push(line);
  }

  if (!para.length) return '';
  return truncateWords(stripMarkdown(para.join(' ')), 240);
}

/** Remove markdown syntax, leaving readable prose. */
function stripMarkdown(s) {
  return collapseWhitespace(
    String(s)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')          // images -> drop
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // links -> text
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')        // reference links -> text
      .replace(/<[^>]+>/g, ' ')                        // inline html
      .replace(/`([^`]*)`/g, '$1')                     // inline code
      .replace(/`+/g, '')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/___([^_]+)___/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1$2')
      .replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1$2')
      .replace(/~~([^~]*)~~/g, '$1')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')      // escaped chars
  );
}

/** Blurb for an HTML artifact: meta description, else <title>. */
function blurbFromHtml(text) {
  const meta = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(text)
    || /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i.exec(text);
  if (meta) return truncateWords(decodeEntities(meta[1]), 240);
  const t = htmlTitle(text);
  return t ? truncateWords(t, 240) : '';
}

/** Derive the project blurb from its featured doc (or an html artifact fallback). */
function blurbFor(projectRoot, doc) {
  if (!doc) return '';
  try {
    const text = readHead(path.join(projectRoot, doc.path), 256 * 1024);
    if (!text) return '';
    if (doc.contentType === 'markdown') return blurbFromMarkdown(text);
    if (doc.contentType === 'html') return blurbFromHtml(text);
    if (doc.kind === 'notebook') {
      try {
        const nb = JSON.parse(text);
        for (const cell of nb.cells || []) {
          if (cell.cell_type !== 'markdown') continue;
          const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
          const b = blurbFromMarkdown(src);
          if (b) return b;
        }
      } catch { /* ignore */ }
      return '';
    }
    return truncateWords(text, 240);
  } catch {
    return '';
  }
}

/** Count badge images in the top block of a README (the conventional badge row). */
function badgeCount(projectRoot, docs) {
  const readme = docs.find((d) => d.kind === 'readme');
  if (!readme) return 0;
  try {
    const text = readHead(path.join(projectRoot, readme.path), 16 * 1024);
    const head = text.split(/\r?\n/).slice(0, 25).join('\n');
    const m = head.match(/!\[[^\]]*\]\([^)]*\)/g);
    if (!m) return 0;
    // Only count images that look like badges (shields/badge services or an
    // svg), so a hero screenshot at the top of a README isn't miscounted.
    return m.filter((img) => /shields\.io|badge|badgen|travis-ci|circleci|codecov|coveralls|appveyor|\.svg/i.test(img)).length;
  } catch {
    return 0;
  }
}

export {
  DOC_DIRS, classify, contentTypeFor, inDocScope,
  buildDocRef, pickFeatured, sortDocs,
  blurbFor, blurbFromMarkdown, stripMarkdown, badgeCount,
  readHead, markdownTitle, htmlTitle,
};
