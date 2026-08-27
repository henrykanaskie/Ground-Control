/* ============================================================================
 * Ground Control: frontend
 *
 * Vanilla ES module. No framework, no build step, no network beyond this origin.
 *
 * Security note: every value that comes from the API is written with
 * `textContent` / `setAttribute`, never `innerHTML`. The single exception is the
 * markdown reader, which assigns the output of markdown.js `render()`: the
 * contract guarantees that string is escape-safe.
 * ========================================================================= */

/* ── small DOM helpers ────────────────────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? 'icon ' + cls : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#' + name);
  svg.appendChild(use);
  return svg;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

const $ = (sel) => document.querySelector(sel);

/* ── formatting ───────────────────────────────────────────────────────── */

const nf = new Intl.NumberFormat('en-US');

function fmtNum(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '-';
  return nf.format(n);
}

function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '-';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(1)) + ' ' + units[i];
}

const DIVS = [
  [31536000, 'year'], [2592000, 'month'], [604800, 'week'],
  [86400, 'day'], [3600, 'hour'], [60, 'minute'],
];

/**
 * Word counts used to render as `1522w`, which reads as "1522 weeks": the
 * unit has to be unambiguous even at 10.5px. Large counts are abbreviated so
 * the label still fits the card's meta row.
 */
function fmtWords(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return Math.round(v / 1000) + 'k words';
  return fmtNum(v) + (v === 1 ? ' word' : ' words');
}

function relTime(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!isFinite(t)) return 'never';
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 45) return 'just now';
  for (const [size, unit] of DIVS) {
    if (secs >= size) {
      const v = Math.floor(secs / size);
      return v + ' ' + unit + (v === 1 ? '' : 's') + ' ago';
    }
  }
  return 'just now';
}

function fmtDate(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function dirnameOf(p) {
  const i = String(p || '').lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

/* ── vocabulary ───────────────────────────────────────────────────────── */

const STATUSES = ['active', 'recent', 'idle', 'dormant', 'empty'];
const STATUS_LABEL = {
  active: 'Active', recent: 'Recent', idle: 'Idle', dormant: 'Dormant', empty: 'Empty',
};

const KIND = {
  onboarding: { label: 'Onboarding', icon: 'i-doc', order: 0 },
  claude:     { label: 'Agent guide', icon: 'i-code', order: 1 },
  readme:     { label: 'Readme', icon: 'i-doc', order: 2 },
  design:     { label: 'Design', icon: 'i-doc', order: 3 },
  doc:        { label: 'Docs', icon: 'i-doc', order: 4 },
  html:       { label: 'Artifact', icon: 'i-window', order: 5 },
  notebook:   { label: 'Notebook', icon: 'i-notebook', order: 6 },
};
const kindOf = (k) => KIND[k] || { label: k || 'File', icon: 'i-file', order: 9 };

const LANG_COLOR = {
  javascript: '#d6b64a', typescript: '#4a86c8', python: '#4b8bbe', swift: '#e0693f',
  ruby: '#c0504d', go: '#4aa5c8', rust: '#b08060', java: '#b07a4a', c: '#7a869a',
  'c++': '#8a6fa8', 'c#': '#5a9a5a', html: '#d1734a', css: '#5a7fc0', scss: '#c06a94',
  shell: '#6fa86f', bash: '#6fa86f', markdown: '#78828f', json: '#8a8f99', yaml: '#8a8f99',
  sql: '#b0864a', r: '#4a7fc0', 'jupyter notebook': '#d1734a', notebook: '#d1734a',
  vue: '#4aa580', kotlin: '#a07ac0', php: '#6f7fb0', 'objective-c': '#5a8fc0',
  dart: '#4aa5b0', lua: '#4a5fb0', toml: '#9a8f80', text: '#6b7280',
};

function langColor(name) {
  const k = String(name || '').toLowerCase();
  if (LANG_COLOR[k]) return LANG_COLOR[k];
  let hash = 0;
  for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) >>> 0;
  return 'hsl(' + (hash % 360) + ' 32% 52%)';
}

/* ── application state ────────────────────────────────────────────────── */

const state = {
  payload: null,               // last /api/projects response
  byId: new Map(),             // id -> ProjectSummary
  order: [],                   // ids in server order
  cards: new Map(),            // id -> <article.card>
  filters: { q: '', status: new Set(), stack: '', sort: 'activity', agent: false, source: '' },  // Workbench §5, Sources §5
  route: { view: 'grid', id: null, path: null },
  routeKey: '',
  loaded: false,
  detailCache: new Map(),
  docCache: new Map(),
  scroll: new Map(),
  readerCleanup: null,
  detailToken: 0,
  readerToken: 0,
};

const el = {};

/* ── URL: filters live in ?query, the view lives in #hash ─────────────── */

function readFilters() {
  const p = new URLSearchParams(location.search);
  const status = new Set(
    (p.get('status') || '').split(',').map((s) => s.trim()).filter((s) => STATUSES.includes(s))
  );
  const sort = p.get('sort');
  state.filters = {
    q: p.get('q') || '',
    status,
    stack: p.get('stack') || '',
    sort: ['activity', 'name', 'size', 'commits', 'agent'].includes(sort) ? sort : 'activity',
    agent: p.get('agent') === '1',                      // Workbench §5
    source: p.get('source') || '',                      // Sources §5
  };
}

function filterQueryString() {
  const p = new URLSearchParams();
  const f = state.filters;
  if (f.q) p.set('q', f.q);
  if (f.status.size) p.set('status', STATUSES.filter((s) => f.status.has(s)).join(','));
  if (f.stack) p.set('stack', f.stack);
  if (f.sort !== 'activity') p.set('sort', f.sort);
  if (f.agent) p.set('agent', '1');                     // Workbench §5
  if (f.source) p.set('source', f.source);              // Sources §5
  const s = p.toString();
  return s ? '?' + s : '';
}

function syncFilterUrl() {
  const url = location.pathname + filterQueryString() + location.hash;
  history.replaceState(history.state, '', url);
}

function readRoute() {
  let raw = location.hash.replace(/^#/, '');
  if (!raw || raw === '/') return { view: 'grid', id: null, path: null };
  const qi = raw.indexOf('?');
  if (qi >= 0) raw = raw.slice(0, qi);
  const segs = raw.split('/').filter(Boolean);
  if (segs[0] !== 'p' || !segs[1]) return { view: 'grid', id: null, path: null };
  const id = safeDecode(segs[1]);
  if (segs[2] === 'doc' && segs.length > 3) {
    return { view: 'reader', id, path: safeDecode(segs.slice(3).join('/')) };
  }
  return { view: 'detail', id, path: null };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const hrefProject = (id) => '#/p/' + encodeURIComponent(id);
const hrefDoc = (id, path) => '#/p/' + encodeURIComponent(id) + '/doc/' + encodeURIComponent(path);
const rawUrl = (id, path) => '/api/raw?id=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(path);

/* ── announcements + banner ───────────────────────────────────────────── */

let announceTimer = 0;
function announce(msg) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.announcer.textContent = msg; }, 60);
}

let bannerReason = null;
function showBanner(text, reason) {
  bannerReason = reason;
  el.bannerText.textContent = text;
  el.banner.hidden = false;
}
function hideBanner(reason) {
  if (reason && bannerReason !== reason) return;
  bannerReason = null;
  el.banner.hidden = true;
}

/* ── fetch helper ─────────────────────────────────────────────────────── */

async function getJSON(url, opts) {
  const res = await fetch(url, Object.assign({ headers: { accept: 'application/json' } }, opts));
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  if (!body) throw new Error('malformed response');
  return body;
}

/* ============================================================================
 * Loading /api/projects (with retry that never blanks the page)
 * ========================================================================= */

const BACKOFF = [1000, 2000, 5000, 15000];
let pollAttempt = 0;
let pollTimer = 0;

async function loadProjects(fresh) {
  if (fresh) { setRescanBusy(true); state.detailCache.clear(); state.docCache.clear(); }
  try {
    const data = await getJSON('/api/projects' + (fresh ? '?fresh=1' : ''));
    pollAttempt = 0;
    clearTimeout(pollTimer);
    hideBanner('api');
    applyData(data, { live: false });
  } catch (err) {
    if (!state.loaded) {
      // First load failed: replace skeletons with a non-fatal waiting state.
      el.skeletons.hidden = true;
      clear(el.skeletons);
      el.grid.hidden = true;
      el.gridEmpty.hidden = false;
      el.gridEmptyClear.hidden = true;
      el.gridEmptyText.textContent =
        'Ground Control could not reach its server. The page will fill in automatically once the connection comes back.';
    }
    showBanner('Can’t reach the Ground Control server (' + err.message + '). Retrying…', 'api');
    schedulePoll();
  } finally {
    if (fresh) setRescanBusy(false);
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const wait = BACKOFF[Math.min(pollAttempt, BACKOFF.length - 1)];
  pollAttempt++;
  pollTimer = setTimeout(() => loadProjects(false), wait);
}

function setRescanBusy(on) {
  el.rescan.classList.toggle('is-busy', !!on);
  el.rescan.disabled = !!on;
}

/* ── ingest a payload, diff into the grid ─────────────────────────────── */

function applyData(payload, { live }) {
  if (!payload || !Array.isArray(payload.projects)) return;

  const prevById = state.byId;
  const next = new Map();
  const order = [];
  for (const p of payload.projects) {
    if (!p || !p.id) continue;
    next.set(p.id, p);
    order.push(p.id);
  }

  const changed = [];
  const added = [];
  for (const [id, p] of next) {
    const prev = prevById.get(id);
    if (!prev) { if (state.loaded) added.push(id); continue; }
    if (prev.status !== p.status || prev.lastActivityISO !== p.lastActivityISO) changed.push(id);
  }
  const removed = [];
  for (const id of prevById.keys()) if (!next.has(id)) removed.push(id);

  state.payload = payload;
  state.byId = next;
  state.order = order;
  state.loaded = true;

  el.skeletons.hidden = true;
  clear(el.skeletons);

  srcApplyPayload(payload);                             // Sources §5
  renderHeader();
  renderStackOptions();
  srcRenderOptions();                                   // Sources §5
  syncCards({ pulse: live ? new Set(changed) : new Set(), enter: new Set(added), removed });
  renderGrid();

  if (live) {
    pulseLiveDot();
    const bits = [];
    if (added.length) bits.push(added.length + ' added');
    if (removed.length) bits.push(removed.length + ' removed');
    if (changed.length) bits.push(changed.length + ' updated');
    if (bits.length) announce('Projects ' + bits.join(', ') + '.');
    // Keep an open detail view honest.
    if (state.route.view === 'detail' && (changed.includes(state.route.id) || added.includes(state.route.id))) {
      state.detailCache.delete(state.route.id);
      renderDetail(state.route.id, { silent: true });
    }
  }
}

/* ============================================================================
 * Header
 * ========================================================================= */

function renderHeader() {
  const pay = state.payload;
  if (!pay) return;
  srcRenderHeader();                                    // Sources §5

  const counts = countByStatus();
  clear(el.counts);
  const total = h('span', null);
  total.append(h('b', null, fmtNum(state.order.length)), document.createTextNode(' projects'));
  el.counts.append(total);
  // The separator only earns its place when a status chip follows it.
  if (STATUSES.some((s) => counts[s])) el.counts.append(h('span', 'count-sep'));
  for (const s of STATUSES) {
    if (!counts[s]) continue;
    const chip = h('span', 'count-chip');
    const d = h('span', 'dot');
    d.dataset.status = s;
    chip.append(d, h('b', null, fmtNum(counts[s])), document.createTextNode(' ' + s));
    chip.title = counts[s] + ' ' + s;
    el.counts.append(chip);
  }

  if (pay.scannedAt) {
    const dur = typeof pay.durationMs === 'number' ? ' in ' + fmtNum(Math.round(pay.durationMs)) + ' ms' : '';
    el.footScan.textContent = 'scanned ' + relTime(pay.scannedAt) + dur + ' · ' + srcFootLabel();
  }
}

function countByStatus() {
  const c = {};
  for (const id of state.order) {
    const p = state.byId.get(id);
    const s = p && p.status;
    if (s) c[s] = (c[s] || 0) + 1;
  }
  return c;
}

let beatTimer = 0;
function pulseLiveDot() {
  el.live.classList.add('beat');
  clearTimeout(beatTimer);
  beatTimer = setTimeout(() => el.live.classList.remove('beat'), 700);
}

function setLive(stateName) {
  el.live.dataset.state = stateName;
  el.liveLabel.textContent =
    stateName === 'open' ? 'live' : stateName === 'connecting' ? 'connecting' : 'offline';
  el.live.title =
    stateName === 'open' ? 'Live updates connected'
      : stateName === 'connecting' ? 'Reconnecting to the update stream'
        : 'Update stream disconnected';
}

/* ============================================================================
 * Controls
 * ========================================================================= */

function buildStatusChips() {
  clear(el.fStatus);
  for (const s of STATUSES) {
    const b = h('button', 'chip');
    b.type = 'button';
    b.dataset.status = s;
    b.setAttribute('aria-pressed', String(state.filters.status.has(s)));
    const d = h('span', 'dot');
    d.dataset.status = s;
    b.append(d, h('span', null, STATUS_LABEL[s]), h('span', 'chip-n', ''));
    b.addEventListener('click', () => {
      const f = state.filters.status;
      if (f.has(s)) f.delete(s); else f.add(s);
      b.setAttribute('aria-pressed', String(f.has(s)));
      syncFilterUrl();
      renderGrid();
    });
    el.fStatus.append(b);
  }
}

function renderStackOptions() {
  const seen = new Map();
  for (const id of state.order) {
    const p = state.byId.get(id);
    if (!p || !Array.isArray(p.stack)) continue;
    for (const s of p.stack) if (s) seen.set(s, (seen.get(s) || 0) + 1);
  }
  const names = [...seen.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const current = state.filters.stack;
  const sig = names.join('\u0000');
  if (el.fStack.dataset.sig === sig) { el.fStack.value = current || ''; return; }
  el.fStack.dataset.sig = sig;
  clear(el.fStack);
  el.fStack.append(new Option('All stacks', ''));
  for (const n of names) el.fStack.append(new Option(n + ' (' + seen.get(n) + ')', n));
  el.fStack.value = names.includes(current) ? current : '';
  if (el.fStack.value !== current) { state.filters.stack = el.fStack.value; syncFilterUrl(); }
}

function syncControlsFromState() {
  el.fQ.value = state.filters.q;
  el.fStack.value = state.filters.stack;
  if (el.fSource) el.fSource.value = state.filters.source;      // Sources §5
  el.fSort.value = state.filters.sort;
  for (const b of el.fStatus.children) {
    b.setAttribute('aria-pressed', String(state.filters.status.has(b.dataset.status)));
  }
}

function filtersActive() {
  const f = state.filters;
  return !!(f.q || f.status.size || f.stack || f.sort !== 'activity' || f.agent || f.source);  // Workbench §5, Sources §5
}

/* ── filtering + sorting ──────────────────────────────────────────────── */

function matches(p, needle) {
  if (!needle) return true;
  const hay = [
    p.name, p.id, p.primaryLanguage, p.blurb,
    Array.isArray(p.stack) ? p.stack.join(' ') : '',
    p.statusReason,
    p.sourceLabel || '',                                // Sources §5
  ].join(' ').toLowerCase();
  return needle.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

const SORTERS = {
  activity: (a, b) => {
    const ta = a.lastActivityISO ? Date.parse(a.lastActivityISO) : -Infinity;
    const tb = b.lastActivityISO ? Date.parse(b.lastActivityISO) : -Infinity;
    if (ta !== tb) return tb - ta;
    return byName(a, b);
  },
  name: byName,
  size: (a, b) => ((b.sizeBytes || 0) - (a.sizeBytes || 0)) || byName(a, b),
  commits: (a, b) => {
    const ca = a.git ? (a.git.commitCount || 0) : -1;
    const cb = b.git ? (b.git.commitCount || 0) : -1;
    return (cb - ca) || byName(a, b);
  },
};

function byName(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
}

function visibleProjects() {
  const f = state.filters;
  const needle = f.q.trim().toLowerCase();
  const list = [];
  for (const id of state.order) {
    const p = state.byId.get(id);
    if (!p) continue;
    if (f.status.size && !f.status.has(p.status)) continue;
    if (f.stack && !(Array.isArray(p.stack) && p.stack.includes(f.stack))) continue;
    if (f.agent && !(p.agent && p.agent.live > 0)) continue;    // Workbench §5
    if (f.source && p.sourceId !== f.source) continue;          // Sources §5
    if (!matches(p, needle)) continue;
    list.push(p);
  }
  list.sort(SORTERS[f.sort] || SORTERS.activity);
  return list;
}

/* ============================================================================
 * Cards: created once per project, patched in place forever after
 * ========================================================================= */

function syncCards({ pulse, enter, removed }) {
  for (const id of removed) {
    const card = state.cards.get(id);
    state.cards.delete(id);
    if (!card) continue;
    card.classList.add('exit');
    setTimeout(() => card.remove(), 220);
  }
  for (const id of state.order) {
    const p = state.byId.get(id);
    let card = state.cards.get(id);
    if (!card) {
      card = h('article', 'card');
      card.dataset.id = id;
      state.cards.set(id, card);
      fillCard(card, p);
      if (enter.has(id)) {
        card.classList.add('enter');
        setTimeout(() => card.classList.remove('enter'), 260);
      }
    } else if (card._sig !== signature(p)) {
      fillCard(card, p);
    } else if (p.agent && p.agent.state === 'working') {
      // Only the agent's currentAction can have moved: patch the text rather
      // than rebuilding the card and restarting the orbit cluster's animations.
      const what = card.querySelector('.wb-what');
      if (what) {
        const label = wbLiveLabel(p.agent);
        if (what.textContent !== label) { what.textContent = label; what.title = label; }
        const row = what.closest('.wb-live');
        if (row) row.setAttribute('aria-label', wbLiveAria(p.agent));
      }
    }
    if (pulse.has(id)) {
      card.classList.remove('pulse');
      void card.offsetWidth;
      card.classList.add('pulse');
      setTimeout(() => card.classList.remove('pulse'), 1200);
    }
  }
}

/**
 * "Forge is building a document for this project right now." A hammer that
 * actually swings: the motion is the signal, and it stops the moment the job
 * reaches a terminal state (the grid re-emits on Forge lifecycle events).
 */
const FORGE_BADGE = {
  onboarding: { icon: 'i-hammer',  verb: 'forging',  label: 'building the onboarding document' },
  design:     { icon: 'i-compass', verb: 'drafting', label: 'building the design rationale' },
  code:       { icon: 'i-code',    verb: 'reading',  label: 'building the code breakdown' },
};

function forgeBadge(f) {
  const kind = FORGE_BADGE[f.kind] ? f.kind : 'onboarding';
  const spec = FORGE_BADGE[kind];
  const b = h('span', 'forge-badge is-' + kind);
  b.append(icon(spec.icon));
  b.append(h('span', 'forge-badge-t', spec.verb));
  b.title = f.phase ? spec.label + ' - ' + f.phase : spec.label;
  b.setAttribute('aria-label', spec.label);
  return b;
}

function signature(p) {
  const g = p.git || {};
  return [
    p.name, p.status, p.statusReason, p.lastActivityISO, p.lastActivityRelative,
    p.blurb, p.fileCount, p.sizeBytes, p.todoCount, p.hasTests,
    (p.stack || []).join(','), (p.docs || []).length,
    p.featuredDoc ? p.featuredDoc.path : '',
    g.commitCount, g.dirty, g.dirtyCount, g.branch,
    // Workbench §5: an agent starting or stopping must repaint the card.
    // currentAction is deliberately absent: it changes on every transcript write
    // and is patched in place by syncCards, not worth a full rebuild.
    p.agent ? p.agent.state + ':' + p.agent.live + ':' + p.agent.active : '',
    // A Forge build starting or finishing must repaint the card.
    p.forge && p.forge.running ? 'forge:' + p.forge.jobId + ':' + p.forge.kind : '',
    // Sources §5: the provenance chip appears, disappears and renames.
    (p.sourceId || '') + ':' + (srcMulti() ? (p.sourceLabel || '') : ''),
  ].join('\u0001');
}

function fillCard(card, p) {
  const active = document.activeElement;
  const restore = card.contains(active) && active.dataset ? active.dataset.part : null;

  card._sig = signature(p);
  card.classList.toggle('is-empty', p.status === 'empty');
  clear(card);

  srcCardChip(card, p);                                 // Sources §5

  /* head: name + relative activity */
  const head = h('div', 'card-head');
  const title = h('a', 'card-title', p.name || p.id);
  title.href = hrefProject(p.id);
  title.dataset.part = 'title';
  head.append(title);
  if (p.forge && p.forge.running) head.append(forgeBadge(p.forge));
  const when = h('span', 'card-when', p.lastActivityRelative || relTime(p.lastActivityISO));
  if (p.lastActivityISO) when.title = fmtDate(p.lastActivityISO);
  head.append(when);
  card.append(head);

  /* status */
  const st = h('div', 'card-status');
  const dot = h('span', 'dot');
  dot.dataset.status = p.status || 'dormant';
  const reason = h('span', 'reason', p.statusReason || STATUS_LABEL[p.status] || '');
  reason.title = reason.textContent;
  st.append(dot, reason);
  card.append(st);

  /* blurb */
  const blurbText = (p.blurb || '').trim();
  const blurb = h('p', 'card-blurb');
  if (blurbText) {
    blurb.textContent = blurbText;
  } else {
    blurb.classList.add('is-quiet');
    blurb.textContent = p.status === 'empty'
      ? 'Nothing here yet: an empty placeholder directory.'
      : (p.docs && p.docs.length)
        ? 'No description found in this project’s documents.'
        : 'No documents found: files only.';
  }
  card.append(blurb);

  card.append(h('div', 'card-spacer'));

  /* stack chips */
  const stack = Array.isArray(p.stack) ? p.stack : [];
  const row = h('div', 'card-stack');
  if (stack.length) {
    for (const s of stack.slice(0, 4)) row.append(h('span', 'tag', s));
    if (stack.length > 4) row.append(h('span', 'tag tag-more', '+' + (stack.length - 4)));
  } else {
    row.append(h('span', 'tag tag-more', p.status === 'empty' ? 'empty' : 'no stack detected'));
  }
  card.append(row);

  /* metric row */
  const meta = h('div', 'card-meta');
  meta.append(metric('i-file', fmtNum(p.fileCount || 0), (p.fileCount || 0) + ' files'));
  meta.append(metric('i-disk', fmtBytes(p.sizeBytes || 0), 'on disk'));
  if (p.git) {
    meta.append(metric('i-commit', fmtNum(p.git.commitCount || 0), 'commits on ' + (p.git.branch || 'HEAD')));
  } else if (p.status !== 'empty') {
    meta.append(metric('i-branch', 'no git', 'not a git repository'));
  }
  if (p.todoCount > 0) meta.append(metric('i-flag', p.todoCount + ' TODO', p.todoCount + ' TODO markers', 'is-todo'));
  if (p.git && p.git.dirty) {
    meta.append(metric('i-diff', (p.git.dirtyCount || 0) + ' dirty', 'uncommitted changes', 'is-dirty'));
  }
  card.append(meta);

  /* featured document affordance (falls back to the first doc of any kind) */
  const feat = p.featuredDoc || (Array.isArray(p.docs) && p.docs.length ? p.docs[0] : null);
  if (feat && feat.path) {
    const k = kindOf(feat.kind);
    const a = h('a', 'card-doc');
    a.href = hrefDoc(p.id, feat.path);
    a.dataset.part = 'doc';
    a.append(icon(k.icon));
    a.append(h('span', 'd-kind', k.label));
    const t = h('span', 'd-title', feat.title || feat.path);
    t.title = feat.path;
    a.append(t);
    if (feat.wordCount) {
      const w = h('span', 'd-words', fmtWords(feat.wordCount));
      w.title = fmtNum(feat.wordCount) + ' words';
      a.append(w);
    }
    a.setAttribute('aria-label', 'Open ' + k.label + ': ' + (feat.title || feat.path) + ' - ' + (p.name || p.id));
    card.append(a);
  } else {
    card.append(h('div', 'card-nodoc', p.status === 'empty' ? 'empty directory' : 'no documents'));
  }

  wbDecorateCard(card, p);                              // Workbench §5

  if (restore) {
    const back = card.querySelector('[data-part="' + restore + '"]');
    if (back) back.focus({ preventScroll: true });
  }
}

function metric(ic, text, title, cls) {
  const s = h('span', cls ? 'm ' + cls : 'm');
  s.append(icon(ic), h('span', null, text));
  if (title) s.title = title;
  return s;
}

/* ── grid layout / filtering pass ─────────────────────────────────────── */

function renderGrid() {
  if (!state.loaded) return;
  const list = visibleProjects();
  const shown = new Set(list.map((p) => p.id));

  for (const [id, card] of state.cards) {
    card.hidden = !shown.has(id);
  }

  // Order the DOM to match the sort, moving only what must move.
  let cursor = null;
  for (const p of list) {
    const card = state.cards.get(p.id);
    if (!card) continue;
    const expected = cursor ? cursor.nextElementSibling : el.grid.firstElementChild;
    if (expected !== card) el.grid.insertBefore(card, expected);
    cursor = card;
  }
  // Filtered-out (hidden) cards live after the visible run.
  for (const [id, card] of state.cards) {
    if (!shown.has(id) && card.parentNode !== el.grid) el.grid.append(card);
  }

  const total = state.order.length;
  clear(el.resultLine);
  if (total) {
    const b = h('b', null, fmtNum(list.length));
    el.resultLine.append(
      b,
      document.createTextNode(list.length === 1 ? ' project' : ' projects'),
      document.createTextNode(list.length === total ? '' : ' of ' + fmtNum(total)),
      document.createTextNode(' · sorted by ' + sortLabel(state.filters.sort))
    );
  }

  const empty = total > 0 && list.length === 0;
  el.gridEmpty.hidden = !empty;
  el.grid.hidden = empty;
  if (empty) {
    el.gridEmptyClear.hidden = !filtersActive();
    el.gridEmptyText.textContent = filtersActive()
      ? 'No project matches the current filters. Try widening the search.'
      : srcCount() > 1
        ? 'No projects were found in any of the watched folders.'
        : 'No projects were found in the watched folder.';
  }

  if (total === 0 && state.payload) {
    el.gridEmpty.hidden = false;
    el.grid.hidden = true;
    el.gridEmptyClear.hidden = true;
    el.gridEmptyText.textContent = srcCount() === 0
      ? 'Ground Control is not watching any folder yet.'
      : srcCount() === 1
        ? 'The folder Ground Control is watching has no project directories in it.'
        : 'None of the watched folders has a project directory in it.';
  }

  /* Sources §5: with nothing watched at all, the fix is to add a folder, not
   * to widen a filter. That panel replaces both the grid and its empty state. */
  const nothingWatched = Boolean(state.payload) && srcCount() === 0;
  el.srcBlank.hidden = !nothingWatched;
  if (nothingWatched) { el.gridEmpty.hidden = true; el.grid.hidden = true; }

  el.fClear.hidden = !filtersActive();

  // Per-status counts on the chips.
  const counts = countByStatus();
  for (const b of el.fStatus.children) {
    const s = b.dataset.status;
    const n = counts[s] || 0;
    b.querySelector('.chip-n').textContent = n ? String(n) : '';
    b.disabled = n === 0 && !state.filters.status.has(s);
  }
  wbSyncChip();                                         // Workbench §5
}

function sortLabel(s) {
  return { activity: 'last activity', name: 'name', size: 'size', commits: 'commits',
    agent: 'agent activity' }[s] || s;                  // Workbench §5
}

function renderSkeletons(n) {
  clear(el.skeletons);
  el.skeletons.hidden = false;
  for (let i = 0; i < n; i++) {
    const s = h('div', 'sk');
    s.append(h('i', 't'), h('i', 's'), h('i', 'a'), h('i', 'b'), h('i', 'c'));
    const f = h('div', 'sk-foot');
    f.append(h('i', null), h('i', null));
    s.append(f);
    el.skeletons.append(s);
  }
}

/* ============================================================================
 * Detail view
 * ========================================================================= */

async function renderDetail(id, opts = {}) {
  const token = ++state.detailToken;
  const box = el.viewDetail;

  const cached = state.detailCache.get(id);
  if (cached) {
    paintDetail(box, cached);
  } else if (!opts.silent) {
    clear(box);
    box.append(crumbs(null, null));
    const load = h('div', 'doc-loading');
    for (let i = 0; i < 6; i++) load.append(h('i', null));
    box.append(load);
  }

  if (cached && opts.silent !== true) return;

  let data;
  try {
    data = await getJSON('/api/project/' + encodeURIComponent(id));
  } catch (err) {
    if (token !== state.detailToken) return;
    if (err.status === 404) return paintNotFound(box, id);
    if (!cached) paintError(box, 'Could not load this project', err.message, () => renderDetail(id));
    return;
  }
  if (token !== state.detailToken) return;
  state.detailCache.set(id, data);
  paintDetail(box, data);
}

function paintNotFound(box, id) {
  clear(box);
  box.append(crumbs(null, null));
  const b = h('div', 'blank');
  b.append(icon('i-alert', 'blank-icon'));
  b.append(h('h2', null, 'Unknown project'));
  b.append(h('p', null, 'No project with the id “' + id + '” exists in the current scan. It may have been renamed or removed.'));
  const back = h('a', 'btn', 'Back to all projects');
  back.href = '#/';
  b.append(back);
  box.append(b);
}

function paintError(box, title, detail, retry) {
  clear(box);
  box.append(crumbs(null, null));
  const b = h('div', 'blank');
  b.append(icon('i-alert', 'blank-icon'));
  b.append(h('h2', null, title));
  b.append(h('p', null, detail || ''));
  if (retry) {
    const btn = h('button', 'btn', 'Try again');
    btn.type = 'button';
    btn.addEventListener('click', retry);
    b.append(btn);
  }
  box.append(b);
}

function crumbs(project, docTitle) {
  const nav = h('nav', 'crumbs');
  nav.setAttribute('aria-label', 'Breadcrumb');
  const all = h('a', null);
  all.href = '#/';
  all.append(icon('i-back'), h('span', null, 'All projects'));
  nav.append(all);
  if (project) {
    nav.append(h('span', 'sep', '/'));
    if (docTitle) {
      const pl = h('a', null, project.name || project.id);
      pl.href = hrefProject(project.id);
      nav.append(pl, h('span', 'sep', '/'), h('span', 'here', docTitle));
    } else {
      nav.append(h('span', 'here', project.name || project.id));
    }
  }
  return nav;
}

/**
 * "Move to Trash" for ANY project, not only ones the Reclaim sweep flagged.
 *
 * It goes through the same endpoint, the same typed-name confirmation and the
 * same guards as the Reclaim flow: the only difference is the way in. A
 * folder Ground Control judged worth keeping now refuses once, explains why, and lets
 * the owner override; a folder that is structurally protected (Ground Control itself,
 * a path outside every watched folder) still cannot be removed at all.
 */
function trashAction(d) {
  const wrap = document.createDocumentFragment();
  const b = h('button', 'btn dtrash-b', null);
  b.type = 'button';
  b.append(icon('i-trash'), h('span', null, 'Move to Trash…'));
  b.title = 'Move ' + (d.name || d.id) + ' to the macOS Trash';
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.classList.add('is-busy');
    try {
      // The dialog is driven by an assessment, so fetch the real one rather
      // than synthesising a half-populated stand-in.
      const a = await getJSON('/api/reclaim/' + encodeURIComponent(d.id));
      rcOpenDialog(a);
    } catch (err) {
      announce('Could not check this folder before removal: ' + ((err && err.message) || err));
    } finally {
      b.disabled = false;
      b.classList.remove('is-busy');
    }
  });
  wrap.append(b);
  return wrap;
}

function paintDetail(box, d) {
  clear(box);
  box.append(crumbs(d, null));

  /* ── header ── */
  const head = h('header', 'dhead');
  head.append(h('h1', null, d.name || d.id));

  const row = h('div', 'dhead-row');
  const stPill = h('span', 'pill');
  const dot = h('span', 'dot');
  dot.dataset.status = d.status || 'dormant';
  stPill.append(dot, h('span', null, d.statusReason || STATUS_LABEL[d.status] || ''));
  row.append(stPill);

  const act = h('span', 'pill');
  act.append(h('span', null, d.lastActivityRelative || relTime(d.lastActivityISO)));
  if (d.lastActivityISO) act.title = fmtDate(d.lastActivityISO);
  row.append(act);

  if (d.git) {
    const g = h('span', 'pill is-git');
    g.append(icon('i-branch'), h('span', null, d.git.branch || 'HEAD'));
    if (d.git.ahead) g.append(h('span', null, '↑' + d.git.ahead));
    if (d.git.behind) g.append(h('span', null, '↓' + d.git.behind));
    row.append(g);
    if (d.git.dirty) {
      const dp = h('span', 'pill is-git is-dirty');
      dp.append(icon('i-diff'), h('span', null, (d.git.dirtyCount || 0) + ' uncommitted'));
      row.append(dp);
    }
    if (d.git.remote) {
      const rp = h('span', 'pill is-git');
      rp.append(h('span', null, shortRemote(d.git.remote)));
      rp.title = d.git.remote;
      row.append(rp);
    }
  } else {
    const g = h('span', 'pill');
    g.append(icon('i-branch'), h('span', null, 'not a git repository'));
    row.append(g);
  }
  if (d.hasTests) {
    const t = h('span', 'pill');
    t.append(icon('i-flask'), h('span', null, 'tests'));
    row.append(t);
  }
  head.append(row);
  head.append(wbOpenRow(d));                            // Workbench §5
  head.append(h('div', 'dpath mono', d.path || ''));
  const actions = h('div', 'dtrash');
  actions.append(trashAction(d));
  srcDetachAction(actions, d);                          // Sources §5
  head.append(actions);

  if (d.blurb) head.append(h('p', 'dblurb', d.blurb));

  const stats = h('dl', 'stats');
  stats.append(stat('Files', fmtNum(d.fileCount || 0)));
  stats.append(stat('Folders', fmtNum(d.dirCount || 0)));
  stats.append(stat('Size', fmtBytes(d.sizeBytes || 0)));
  stats.append(stat('Commits', d.git ? fmtNum(d.git.commitCount || 0) : '-'));
  stats.append(stat('Last 30d', d.git ? fmtNum(d.git.commitsLast30d || 0) : '-'));
  stats.append(stat('Documents', fmtNum((d.docs || []).length)));
  stats.append(stat('TODOs', fmtNum(d.todoCount || 0)));
  head.append(stats);
  box.append(head);

  /* ── Forge (CONTRACT-FORGE.md §9) ── */
  box.append(forgePanel(d));

  /* ── two columns ── */
  const grid = h('div', 'dgrid');
  const left = h('div', null);
  const right = h('div', null);

  left.append(heatmapPanel(d));
  left.append(wbAgentsPanel(d));                        // Workbench §5
  left.append(docsPanel(d));
  if (d.git) left.append(commitsPanel(d));

  right.append(langPanel(d));
  if (d.git && Array.isArray(d.dirtyFiles) && d.dirtyFiles.length) right.append(dirtyPanel(d));
  right.append(treePanel(d));

  grid.append(left, right);
  box.append(grid);
}

function shortRemote(r) {
  const m = String(r).match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : String(r);
}

function stat(label, value) {
  const wrap = h('div', 'stat');
  wrap.append(h('dt', null, label), h('dd', null, value));
  return wrap;
}

function panel(title, iconName, count) {
  const p = h('section', 'panel');
  const head = h('div', 'panel-h');
  head.append(icon(iconName));
  head.append(h('h2', null, title));
  if (count != null) head.append(h('span', 'n', count));
  p.append(head);
  const body = h('div', 'panel-b');
  p.append(body);
  p._body = body;
  return p;
}

/* ── 90-day commit heatmap ────────────────────────────────────────────── */

function heatLevel(n) {
  if (!n) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  if (n <= 9) return 3;
  return 4;
}

function heatmapPanel(d) {
  const p = panel('Commit activity', 'i-commit', d.git ? '90 days' : null);
  const body = p._body;
  const acts = Array.isArray(d.activity) ? d.activity : [];

  if (!d.git) {
    body.remove();
    p.append(h('div', 'panel-note', 'No git history: this project is not a repository.'));
    return p;
  }
  if (!acts.length) {
    body.remove();
    p.append(h('div', 'panel-note', 'No commits in the last 90 days.'));
    return p;
  }

  const counts = new Map();
  for (const a of acts) if (a && a.date) counts.set(a.date, (counts.get(a.date) || 0) + (a.count || 0));

  const wrap = h('div', 'heat');
  const gridEl = h('div', 'heat-grid');
  gridEl.setAttribute('role', 'img');

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 89);

  // Pad so the first column starts on Sunday.
  for (let i = 0; i < start.getDay(); i++) {
    const c = h('div', 'heat-cell');
    c.dataset.l = '0';
    c.dataset.future = '1';
    gridEl.append(c);
  }

  let total = 0, days = 0;
  for (let i = 0; i < 90; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') +
      '-' + String(day.getDate()).padStart(2, '0');
    const n = counts.get(key) || 0;
    total += n;
    if (n) days++;
    const c = h('div', 'heat-cell');
    c.dataset.l = String(heatLevel(n));
    c.title = (n === 0 ? 'No commits' : n + (n === 1 ? ' commit' : ' commits')) + ' · ' +
      day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    gridEl.append(c);
  }
  gridEl.setAttribute('aria-label', total + ' commits across the last 90 days');
  wrap.append(gridEl);

  const sum = h('div', 'heat-sum');
  sum.append(h('b', null, fmtNum(total)));
  sum.append(document.createTextNode(total === 1 ? ' commit over the last 90 days on ' : ' commits over the last 90 days on '));
  sum.append(h('b', null, fmtNum(days)));
  sum.append(document.createTextNode(days === 1 ? ' day' : ' days'));

  const legend = h('div', 'heat-legend');
  legend.append(h('span', null, 'less'));
  for (let l = 0; l <= 4; l++) {
    const c = h('div', 'heat-cell');
    c.dataset.l = String(l);
    legend.append(c);
  }
  legend.append(h('span', null, 'more'), h('span', 'spacer'));

  const side = h('div', 'heat-side');
  side.append(sum, legend);
  wrap.append(side);

  body.append(wrap);
  return p;
}

/* ── documents ────────────────────────────────────────────────────────── */

function docsPanel(d) {
  const docs = Array.isArray(d.docs) ? d.docs.slice() : [];
  const p = panel('Documents', 'i-doc', docs.length ? String(docs.length) : null);
  p._body.remove();

  if (!docs.length) {
    p.append(h('div', 'panel-note', 'No documents were found in this project.'));
    return p;
  }

  const featPath = d.featuredDoc && d.featuredDoc.path;
  const groups = new Map();
  for (const doc of docs) {
    const k = doc.kind || 'doc';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(doc);
  }
  const keys = [...groups.keys()].sort((a, b) => kindOf(a).order - kindOf(b).order);

  for (const k of keys) {
    const g = h('div', 'doc-group');
    g.append(h('div', 'doc-group-h', kindOf(k).label));
    const items = groups.get(k).sort((a, b) => (b.wordCount || 0) - (a.wordCount || 0));
    for (const doc of items) {
      const a = h('a', 'doc-item' + (doc.path === featPath ? ' is-featured' : ''));
      a.href = hrefDoc(d.id, doc.path);
      a.append(icon(kindOf(k).icon));
      const main = h('div', 'd-main');
      main.append(h('div', 'd-t', doc.title || doc.path));
      main.append(h('div', 'd-p', doc.path));
      a.append(main);
      const meta = doc.wordCount ? fmtWords(doc.wordCount) : fmtBytes(doc.sizeBytes || 0);
      a.append(h('span', 'd-w', meta));
      a.title = doc.path + (doc.mtimeISO ? ' · updated ' + relTime(doc.mtimeISO) : '');
      g.append(a);
    }
    p.append(g);
  }
  return p;
}

/* ── commits ──────────────────────────────────────────────────────────── */

function commitsPanel(d) {
  const list = Array.isArray(d.recentCommits) ? d.recentCommits : [];
  const p = panel('Recent commits', 'i-commit', list.length ? String(list.length) : null);
  p._body.remove();
  if (!list.length) {
    p.append(h('div', 'panel-note', 'No commits yet.'));
    return p;
  }
  const ul = h('ul', null);
  for (const c of list) {
    const li = h('li', 'commit');
    li.append(h('span', 'sha', String(c.sha || '').slice(0, 7)));
    const subj = h('span', 'subj', c.subject || '');
    li.append(subj);
    const when = h('span', 'when', c.relative || relTime(c.dateISO));
    when.title = (c.author ? c.author + ' · ' : '') + fmtDate(c.dateISO);
    li.append(when);
    ul.append(li);
  }
  p.append(ul);
  return p;
}

/* ── dirty files ──────────────────────────────────────────────────────── */

function dirtyPanel(d) {
  const list = d.dirtyFiles || [];
  const p = panel('Uncommitted', 'i-diff', String(list.length));
  p._body.classList.add('flush');
  const ul = h('ul', null);
  ul.style.padding = '8px 0';
  for (const f of list) {
    const li = h('li', 'dirty');
    const s = h('span', 'st', f.state || '?');
    s.dataset.s = (f.state || '?').trim().charAt(0) || '?';
    li.append(s, h('span', 'fp', f.path || ''));
    li.title = f.path || '';
    ul.append(li);
  }
  p._body.append(ul);
  return p;
}

/* ── languages ────────────────────────────────────────────────────────── */

function langPanel(d) {
  const langs = Array.isArray(d.langBreakdown) ? d.langBreakdown.filter((l) => l && l.lang) : [];
  const p = panel('Composition', 'i-code', d.primaryLanguage || null);
  if (!langs.length) {
    p._body.remove();
    p.append(h('div', 'panel-note', 'No source languages detected.'));
    return p;
  }
  const bar = h('div', 'langbar');
  for (const l of langs) {
    const i = h('i', null);
    i.style.width = Math.max(0, Math.min(100, l.pct || 0)) + '%';
    i.style.background = langColor(l.lang);
    i.title = l.lang + ' · ' + (l.pct || 0).toFixed(1) + '%';
    bar.append(i);
  }
  p._body.append(bar);
  const ul = h('ul', 'langlist');
  for (const l of langs) {
    const li = h('li', null);
    const sw = h('span', 'sw');
    sw.style.background = langColor(l.lang);
    li.append(sw, h('span', null, l.lang), h('span', 'pc', (l.pct || 0).toFixed(1) + '%'));
    ul.append(li);
  }
  p._body.append(ul);
  return p;
}

/* ── file tree ────────────────────────────────────────────────────────── */

function treePanel(d) {
  const tree = Array.isArray(d.tree) ? d.tree : [];
  const p = panel('Files', 'i-folder', tree.length ? String(tree.length) : null);
  p._body.remove();
  if (!tree.length) {
    p.append(h('div', 'panel-note', 'This directory is empty.'));
    return p;
  }
  const box = h('div', 'tree');
  for (const node of tree) {
    const isDir = node.type === 'dir' || node.type === 'directory';
    const rowEl = h('div', 'tree-row' + (isDir ? ' is-dir' : ''));
    rowEl.style.paddingLeft = (16 + (node.depth || 0) * 14) + 'px';
    rowEl.append(icon(isDir ? 'i-folder' : 'i-file'));
    const base = String(node.path || '').split('/').pop();
    const nameEl = h('span', 'tn', base + (isDir ? '/' : ''));
    rowEl.append(nameEl);
    if (!isDir && typeof node.sizeBytes === 'number') rowEl.append(h('span', 'tz', fmtBytes(node.sizeBytes)));
    rowEl.title = node.path || '';
    box.append(rowEl);
  }
  p.append(box);
  return p;
}

/* ============================================================================
 * Reader
 * ========================================================================= */

let mdModule = null;
let mdPromise = null;

function loadMarkdown() {
  if (mdModule) return Promise.resolve(mdModule);
  if (!mdPromise) {
    mdPromise = import('./markdown.js')
      .then((m) => { mdModule = m; return m; })
      .catch((err) => { mdPromise = null; throw err; });
  }
  return mdPromise;
}

async function renderReader(id, path) {
  const token = ++state.readerToken;
  const box = el.viewReader;
  teardownReader();

  const key = id + '\u0000' + path;
  const cached = state.docCache.get(key);

  if (!cached) {
    clear(box);
    box.append(crumbs({ id, name: id }, path.split('/').pop()));
    const load = h('div', 'doc-loading');
    for (let i = 0; i < 7; i++) load.append(h('i', null));
    box.append(load);
  }

  let doc = cached;
  if (!doc) {
    try {
      doc = await getJSON('/api/doc?id=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(path));
    } catch (err) {
      if (token !== state.readerToken) return;
      clear(box);
      box.append(crumbs({ id, name: id }, path.split('/').pop()));
      const b = h('div', 'blank');
      b.append(icon('i-alert', 'blank-icon'));
      b.append(h('h2', null, err.status === 404 ? 'Document not found' : 'Could not open this document'));
      b.append(h('p', null, path + ' - ' + err.message));
      const back = h('a', 'btn', 'Back to project');
      back.href = hrefProject(id);
      b.append(back);
      box.append(b);
      return;
    }
    if (token !== state.readerToken) return;
    state.docCache.set(key, doc);
  }

  await paintReader(box, id, path, doc, token);
}

async function paintReader(box, id, path, doc, token) {
  clear(box);
  const projName = doc.project || id;
  box.append(crumbs({ id, name: projName }, doc.title || path.split('/').pop()));

  const layout = h('div', 'reader');
  const col = h('div', null);
  const aside = h('aside', 'reader-toc');
  aside.setAttribute('aria-label', 'Table of contents');

  /* header */
  const head = h('header', 'rhead');
  head.append(h('h1', null, doc.title || path.split('/').pop()));
  const meta = h('div', 'rhead-meta');
  meta.append(h('span', 'kind', kindOf(doc.kind).label));
  meta.append(h('span', null, path));
  if (doc.sizeBytes) meta.append(h('span', null, fmtBytes(doc.sizeBytes)));
  if (doc.mtimeISO) {
    const m = h('span', null, 'updated ' + relTime(doc.mtimeISO));
    m.title = fmtDate(doc.mtimeISO);
    meta.append(m);
  }
  const raw = h('a', null);
  raw.href = rawUrl(id, path);
  raw.target = '_blank';
  raw.rel = 'noreferrer';
  raw.append(h('span', null, 'raw file'), icon('i-external'));
  meta.append(raw);
  meta.append(wbReaderOpen(id, path));                  // Workbench §5
  head.append(meta);
  col.append(head);

  const content = typeof doc.content === 'string' ? doc.content : '';
  const kind = doc.kind;
  const ctype = doc.contentType;

  if (kind === 'html' || ctype === 'html') {
    const note = h('div', 'artifact-note');
    note.append(icon('i-window'));
    const noteText = h('span', null, 'This is a project artifact, rendered in a sandboxed frame exactly as it sits on disk. Scripts are blocked here: ');
    const open = h('a', null, 'open it in a new tab');
    open.href = rawUrl(id, path);
    open.target = '_blank';
    open.rel = 'noreferrer';
    noteText.append(open, document.createTextNode(' to run it.'));
    note.append(noteText);
    col.append(note);
    const frame = h('iframe', 'raw-frame');
    // allow-scripts is deliberately absent (CONTRACT-FORGE.md §9): this frame
    // renders arbitrary HTML out of the user's own repositories, and pairing
    // allow-scripts with allow-same-origin would let that page reach this
    // origin. A page that needs JS therefore renders empty here: detected
    // below, rather than left as a blank box.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('title', (doc.title || path) + ' (project artifact)');
    frame.setAttribute('loading', 'lazy');
    frame.src = rawUrl(id, path);
    col.append(frame);

    frame.addEventListener('load', () => {
      let empty = false;
      try {
        const inner = frame.contentDocument;
        empty = !inner || !inner.body || !inner.body.textContent.trim();
      } catch {
        empty = false;      // unreadable for some reason: don't guess it's broken
      }
      if (!empty) return;

      frame.hidden = true;
      note.hidden = true;
      const b = h('div', 'blank');
      b.append(icon('i-window', 'blank-icon'));
      b.append(h('h2', null, 'This page needs JavaScript to render'));
      b.append(h('p', null,
        'It came out blank because Ground Control renders project HTML with scripts blocked: '
        + 'this frame shows files straight out of your repository, so running their code here '
        + 'would not be safe. Open it in a new tab to view it properly.'));
      const open2 = h('a', 'btn', 'Open in a new tab');
      open2.href = rawUrl(id, path);
      open2.target = '_blank';
      open2.rel = 'noreferrer';
      b.append(open2);
      col.append(b);
    });
    aside.remove();
    layout.style.gridTemplateColumns = 'minmax(0,1fr)';
  } else if (kind === 'notebook' || /\.ipynb$/i.test(path)) {
    col.append(notebookView(content));
    aside.remove();
    layout.style.gridTemplateColumns = 'minmax(0,1fr)';
  } else if (ctype === 'markdown' || /\.(md|markdown|mdx)$/i.test(path)) {
    const docEl = h('article', 'ground-control-doc');
    col.append(docEl);
    let md = null;
    try {
      md = await loadMarkdown();
    } catch {
      md = null;
    }
    if (token !== state.readerToken) return;
    if (md && typeof md.render === 'function') {
      const base = { rawBase: '/api/raw?id=' + encodeURIComponent(id) + '&path=', docBase: '/api/doc?id=' + encodeURIComponent(id) + '&path=', basePath: dirnameOf(path) };
      try {
        // The ONE place innerHTML is used: markdown.js guarantees escaped-safe HTML.
        docEl.innerHTML = md.render(content, base);
      } catch (err) {
        docEl.append(plainFallback(content, 'The markdown renderer failed (' + err.message + '): showing the raw file.'));
      }
      docEl.addEventListener('click', onDocClick);
      try {
        const hs = (typeof md.headings === 'function' ? md.headings(content) : []) || [];
        buildToc(aside, hs, docEl);
      } catch { aside.remove(); }
    } else {
      docEl.append(plainFallback(content, 'The markdown renderer is unavailable: showing the raw file.'));
      aside.remove();
      layout.style.gridTemplateColumns = 'minmax(0,1fr)';
    }
  } else {
    col.append(h('pre', 'rawtext', content));
    aside.remove();
    layout.style.gridTemplateColumns = 'minmax(0,1fr)';
  }

  layout.append(col);
  if (aside.childNodes.length) layout.append(aside);
  else layout.style.gridTemplateColumns = 'minmax(0,1fr)';
  box.append(layout);
}

function plainFallback(content, note) {
  const frag = document.createDocumentFragment();
  const n = h('div', 'artifact-note');
  n.append(icon('i-alert'));
  n.append(h('span', null, note));
  frag.append(n);
  frag.append(h('pre', 'rawtext', content));
  return frag;
}

function notebookView(content) {
  const frag = document.createDocumentFragment();
  const n = h('div', 'artifact-note');
  n.append(icon('i-notebook'));
  n.append(h('span', null, 'Jupyter notebook: showing the raw document source.'));
  frag.append(n);
  let text = content;
  try { text = JSON.stringify(JSON.parse(content), null, 2); } catch { /* leave raw */ }
  frag.append(h('pre', 'rawtext', text));
  return frag;
}

/* in-app navigation for markdown links to other .md files */
function onDocClick(ev) {
  const a = ev.target.closest && ev.target.closest('a[data-doc]');
  if (!a) return;
  const rel = a.getAttribute('data-doc');
  if (!rel) return;
  ev.preventDefault();
  location.hash = hrefDoc(state.route.id, rel).slice(1);
}

function buildToc(aside, headingList, docEl) {
  const items = headingList.filter((x) => x && x.level >= 2 && x.level <= 4 && x.text);
  if (items.length < 2) { aside.remove(); return; }

  aside.append(h('div', 'toc-h', 'On this page'));
  const ul = h('ul', 'ground-control-doc-toc');
  const links = [];
  for (const it of items) {
    const li = h('li', null);
    li.dataset.level = String(it.level);
    const a = h('a', null, it.text);
    a.href = '#' + it.id;
    a.addEventListener('click', (ev) => {
      const target = docEl.querySelector('#' + cssEscape(it.id));
      if (!target) return;
      ev.preventDefault();
      const top = window.scrollY + target.getBoundingClientRect().top - 82;
      window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      history.replaceState(history.state, '', location.pathname + location.search + location.hash);
    });
    li.append(a);
    ul.append(li);
    links.push({ id: it.id, a });
  }
  aside.append(ul);

  // Time-throttled rather than rAF-gated: a frame that never arrives (a
  // backgrounded tab, heavy throttling) must not jam the spy permanently.
  let lastRun = 0;
  let trailing = 0;
  const run = () => {
    lastRun = performance.now();
    let current = links[0];
    for (const l of links) {
      const t = docEl.querySelector('#' + cssEscape(l.id));
      if (!t) continue;
      if (t.getBoundingClientRect().top <= 130) current = l; else break;
    }
    for (const l of links) l.a.classList.toggle('is-current', l === current);
  };
  const onScroll = () => {
    clearTimeout(trailing);
    if (performance.now() - lastRun >= 90) run();
    else trailing = setTimeout(run, 90);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  // The doc is not in the document yet when this runs; settle once it is.
  setTimeout(run, 0);
  state.readerCleanup = () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    clearTimeout(trailing);
  };
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function teardownReader() {
  if (state.readerCleanup) { state.readerCleanup(); state.readerCleanup = null; }
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ============================================================================
 * Forge: generate an onboarding artifact for a project
 *
 * See CONTRACT-FORGE.md §6 (API) and §9 (this UI).
 *
 * Two rules shape everything below:
 *   §0b: generation runs on the user's Claude *subscription* via the
 *         authenticated CLI. `costUsd` is a list-price equivalent, never money
 *         charged. It is only ever worded as usage.
 *   §2: saving writes into the user's real project. It is a separate,
 *         explicit, confirmed action, and a 409 needs a second confirmation.
 *
 * Job state lives in `forge.byProject`, outside the DOM, so navigating away
 * from a running job and back re-attaches instead of orphaning it.
 * ========================================================================= */

/* Fallback only: /api/forge/status may ship its own `models` list, which wins. */
const FORGE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

const MODEL_NOTE = {
  'claude-opus-5': 'most thorough',
  'claude-opus-4-8': 'most thorough',
  'claude-sonnet-5': 'faster',
  'claude-sonnet-4-5': 'faster',
  'claude-haiku-4-5': 'quickest',
};

function forgeModels() {
  const fromServer = forge.status && Array.isArray(forge.status.models) ? forge.status.models : null;
  const list = (fromServer && fromServer.length ? fromServer : FORGE_MODELS).filter((m) => typeof m === 'string' && m);
  return list.map((id) => ({ value: id, label: MODEL_NOTE[id] ? id + ' - ' + MODEL_NOTE[id] : id }));
}

const FORGE_BACKOFF = [1000, 2000, 5000, 15000];
const FORGE_POLL_MS = 8000;
// Fallbacks only: a job carries its own suggestedFilename.
const DEFAULT_ARTIFACT_NAME = 'ONBOARDING.html';
const DESIGN_ARTIFACT_NAME = 'DESIGN.html';

const forge = {
  status: null,        // /api/forge/status, or { unavailable: reason }
  statusAt: 0,
  statusPromise: null,
  byProject: new Map(),
};

function forgeState(id) {
  let st = forge.byProject.get(id);
  if (!st) {
    st = {
      id,
      project: null,
      phase: 'idle',        // idle | starting | queued | running | done | failed | cancelled
      jobId: null,
      job: null,
      progress: [],
      error: null,
      notice: null,
      saved: null,
      controls: { kind: 'onboarding', tier: 'authored', model: '', localModel: '', audience: '' },
      es: null, esAttempt: 0, esTimer: 0, streamDown: false,
      pollTimer: 0, tickTimer: 0,
      startedMs: 0,
      body: null,
      els: null,
    };
    forge.byProject.set(id, st);
  }
  return st;
}

const forgeLive = (st) => st.phase === 'starting' || st.phase === 'queued' || st.phase === 'running';

/* ── transport ────────────────────────────────────────────────────────── */

async function forgeFetch(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON */ }
  return { ok: res.ok, status: res.status, body: body || {} };
}

function forgePost(url, payload) {
  return forgeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

function loadForgeStatus(force) {
  if (!force && forge.status && Date.now() - forge.statusAt < 30000) {
    return Promise.resolve(forge.status);
  }
  if (forge.statusPromise) return forge.statusPromise;
  forge.statusPromise = getJSON('/api/forge/status')
    .then((s) => {
      forge.status = s && typeof s === 'object' ? s : { unavailable: 'malformed response' };
      forge.statusAt = Date.now();
      forge.statusPromise = null;
      return forge.status;
    })
    .catch((err) => {
      forge.status = { unavailable: err.message || 'unreachable' };
      forge.statusAt = Date.now();
      forge.statusPromise = null;
      return forge.status;
    });
  return forge.statusPromise;
}

const claudeReady = () => !!(forge.status && !forge.status.unavailable && forge.status.claude && forge.status.claude.available);

/* ── the local-model tier (CONTRACT-LOCAL.md §5) ──────────────────────── *
 * Runs a model on this machine through ollama. It works offline, never
 * touches the Claude subscription, and must never be shown with a money
 * figure, because there isn't one.
 * --------------------------------------------------------------------- */

const ollamaInfo = () => (forge.status && !forge.status.unavailable && forge.status.ollama) || null;
const ollamaReady = () => {
  const o = ollamaInfo();
  return !!(o && o.available && Array.isArray(o.models) && o.models.length);
};

/** `[{value,label}]` for the ollama model picker, defaults first. */
function localModels() {
  const o = ollamaInfo();
  const list = (o && Array.isArray(o.models) ? o.models : []).filter((m) => m && m.name);
  return list.map((m) => {
    const bits = [];
    if (m.parameterSize) bits.push(m.parameterSize);
    if (typeof m.sizeBytes === 'number' && m.sizeBytes > 0) bits.push(fmtBytes(m.sizeBytes));
    return { value: m.name, label: bits.length ? m.name + ' - ' + bits.join(', ') : m.name };
  });
}

/** Why the local tier is off, worded for a person. */
function ollamaOffReason() {
  const o = ollamaInfo();
  if (o && o.error) return o.error;
  if (o && o.available) return 'ollama is running but has no models installed.';
  return 'ollama isn’t running on this machine.';
}

/** The verification summary the local tier attaches to a finished job. */
function verificationSentence(job) {
  const v = job && job.verification;
  if (!v || typeof v !== 'object') return null;
  const dropped = Number(v.dropped) || 0;
  const checked = Number(v.mentioned) || 0;
  if (dropped > 0) {
    return dropped + ' sentence' + (dropped === 1 ? '' : 's') + ' were dropped before rendering: they named a file path ' +
      'or command that couldn’t be traced to this repository. The page says so too.';
  }
  if (checked > 0) {
    return 'All ' + checked + ' path and command mentions in the prose trace back to this repository.';
  }
  return 'The prose names no paths or commands, so there was nothing to disprove.';
}

/* ── formatting ───────────────────────────────────────────────────────── */

function fmtElapsed(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? h + ':' + two(m) + ':' + two(sec) : m + ':' + two(sec);
}

function fmtClock(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * §0b: the CLI reports a list-price equivalent. On a Max subscription nothing
 * is billed per run, so this is worded as usage and never as a charge.
 */
function usageSentence(job) {
  const c = job && job.costUsd;
  if (typeof c !== 'number' || !isFinite(c) || c <= 0) return null;
  const amount = c < 0.01 ? '<$0.01' : '~$' + c.toFixed(2);
  return amount + ' of list-price usage: counts toward your Claude subscription, not billed separately.';
}

const previewUrl = (jobId) => '/api/forge/job/' + encodeURIComponent(jobId) + '/preview';

/* ── job lifecycle ────────────────────────────────────────────────────── */

function applyJob(st, job, opts = {}) {
  if (!job || typeof job !== 'object' || !job.id) return;
  if (st.jobId && job.id !== st.jobId) return;   // a stale frame from a previous run
  st.jobId = job.id;
  st.job = job;

  if (Array.isArray(job.progress) && (opts.replaceProgress || job.progress.length > st.progress.length)) {
    st.progress = job.progress.slice();
  }
  const state = typeof job.state === 'string' ? job.state : 'running';
  st.phase = ['queued', 'running', 'done', 'failed', 'cancelled'].includes(state) ? state : 'running';
  if (job.startedISO) {
    const t = Date.parse(job.startedISO);
    if (isFinite(t)) st.startedMs = t;
  }
  if (st.phase === 'failed') st.error = job.error || st.error || 'Generation failed without a reason.';
  if (!forgeLive(st)) { stopForgeTimers(st); st.notice = null; }
}

function stopForgeTimers(st) {
  closeForgeStream(st);
  st.streamDown = false;   // a finished job has nothing left to reconnect to
  clearTimeout(st.pollTimer); st.pollTimer = 0;
  clearInterval(st.tickTimer); st.tickTimer = 0;
  clearTimeout(st.esTimer); st.esTimer = 0;
}

function closeForgeStream(st) {
  if (st.es) { try { st.es.close(); } catch { /* noop */ } st.es = null; }
  clearTimeout(st.esTimer); st.esTimer = 0;
}

function openForgeStream(st) {
  closeForgeStream(st);
  if (!st.jobId || !forgeLive(st)) return;

  let src;
  try {
    src = new EventSource('/api/forge/job/' + encodeURIComponent(st.jobId) + '/stream');
  } catch {
    scheduleForgeStream(st);
    return;
  }
  st.es = src;

  const alive = () => {
    if (st.es !== src) return;
    st.esAttempt = 0;
    if (st.streamDown) { st.streamDown = false; paintForgeMeta(st); }
  };

  src.addEventListener('open', alive);
  src.addEventListener('hello', alive);
  src.addEventListener('ping', alive);

  src.addEventListener('progress', (ev) => {
    if (st.es !== src) return;
    alive();
    onForgeProgress(st, ev.data);
  });
  for (const kind of ['done', 'failed', 'cancelled']) {
    src.addEventListener(kind, (ev) => {
      if (st.es !== src) return;
      onForgeTerminal(st, ev.data, kind);
    });
  }
  src.addEventListener('error', () => {
    if (st.es !== src) return;
    closeForgeStream(st);
    if (!forgeLive(st)) return;
    // The poll below still guarantees a terminal state even if this never comes back.
    st.streamDown = true;
    paintForgeMeta(st);
    scheduleForgeStream(st);
  });
}

function scheduleForgeStream(st) {
  clearTimeout(st.esTimer);
  const wait = FORGE_BACKOFF[Math.min(st.esAttempt, FORGE_BACKOFF.length - 1)];
  st.esAttempt++;
  st.esTimer = setTimeout(() => { if (forgeLive(st)) openForgeStream(st); }, wait);
}

/** SSE payload shapes are loosely specified: accept anything reasonable. */
function onForgeProgress(st, raw) {
  let data = null;
  try { data = JSON.parse(raw); } catch { data = { text: String(raw == null ? '' : raw) }; }
  if (data == null) return;
  if (typeof data === 'string') data = { text: data };

  if (Array.isArray(data.progress)) {
    st.progress = data.progress.slice();
    paintForgeLog(st, { full: true });
  } else if (typeof data.text === 'string' && data.text) {
    pushForgeProgress(st, { atISO: data.atISO || new Date().toISOString(), text: data.text });
  } else if (typeof data.message === 'string' && data.message) {
    pushForgeProgress(st, { atISO: data.atISO || new Date().toISOString(), text: data.message });
  }
  if (data.state || data.id) applyJob(st, Object.assign({ id: st.jobId }, data), {});
}

function pushForgeProgress(st, item) {
  st.progress.push(item);
  if (st.progress.length > 200) st.progress.splice(0, st.progress.length - 200);
  // Work is visibly happening: don't keep claiming the job is queued until the
  // next poll catches up.
  if (st.phase === 'starting' || st.phase === 'queued') {
    st.phase = 'running';
    if (st.job) st.job.state = 'running';
    if (st.els && st.els.state) st.els.state.textContent = 'Working…';
  }
  paintForgeLog(st, { one: item });
}

async function onForgeTerminal(st, raw, kind) {
  closeForgeStream(st);
  let data = null;
  try { data = JSON.parse(raw); } catch { /* ignore */ }
  const job = data && typeof data === 'object' ? (data.job && data.job.id ? data.job : data) : null;
  if (job && job.id) applyJob(st, job, {});
  else { st.phase = kind; if (kind === 'failed' && !st.error) st.error = 'Generation failed.'; }
  // The stream frame may be thin; the job route is authoritative for bytes/cost/error.
  await refreshForgeJob(st);
}

async function refreshForgeJob(st) {
  if (!st.jobId) return;
  const before = st.phase;
  try {
    const job = await getJSON('/api/forge/job/' + encodeURIComponent(st.jobId));
    applyJob(st, job, { replaceProgress: true });
  } catch (err) {
    if (err.status === 404) {
      // Never leave a spinner with no terminal state.
      stopForgeTimers(st);
      st.phase = 'failed';
      st.error = 'Ground Control no longer has a record of this job: the server may have restarted.';
    } else if (!forgeLive(st)) {
      st.error = st.error || err.message;
    }
  }
  // Patch in place while the phase is unchanged, so the safety poll never
  // yanks the progress log out from under someone reading it.
  if (st.phase !== before || !forgeLive(st)) renderForge(st);
  else { paintForgeLog(st, { full: true }); paintForgeMeta(st); paintForgeElapsed(st); }
  if (!forgeLive(st)) announceForgeEnd(st);
}

let forgeAnnounced = new Set();
function announceForgeEnd(st) {
  const key = st.jobId + ':' + st.phase;
  if (!st.jobId || forgeAnnounced.has(key)) return;
  forgeAnnounced.add(key);
  const name = (st.project && st.project.name) || st.id;
  if (st.phase === 'done') announce('The ' + kindLabel(st.job && st.job.kind) + ' artifact is ready for ' + name + '.');
  else if (st.phase === 'failed') announce('Artifact generation failed for ' + name + '.');
  else if (st.phase === 'cancelled') announce('Artifact generation cancelled for ' + name + '.');
}

function startForgeTick(st) {
  clearInterval(st.tickTimer);
  st.tickTimer = setInterval(() => {
    if (!forgeLive(st)) { clearInterval(st.tickTimer); st.tickTimer = 0; return; }
    paintForgeElapsed(st);
  }, 1000);
}

function startForgePoll(st) {
  clearTimeout(st.pollTimer);
  const tick = async () => {
    if (!forgeLive(st)) return;
    await refreshForgeJob(st);
    if (forgeLive(st)) st.pollTimer = setTimeout(tick, FORGE_POLL_MS);
  };
  st.pollTimer = setTimeout(tick, FORGE_POLL_MS);
}

function beginForgeWatch(st) {
  openForgeStream(st);
  startForgeTick(st);
  startForgePoll(st);
}

/* ── re-attach to a job that is already running ───────────────────────── */

async function reattachForge(st) {
  if (st.jobId || st.phase !== 'idle') return;
  const s = forge.status;
  if (!s || s.unavailable || !Array.isArray(s.runningJobs) || !s.runningJobs.length) return;

  let jobId = null;
  for (const entry of s.runningJobs) {
    if (entry && typeof entry === 'object') {
      if (entry.projectId === st.id && entry.id) { jobId = entry.id; break; }
      continue;
    }
    if (typeof entry === 'string' && entry) {
      try {
        const job = await getJSON('/api/forge/job/' + encodeURIComponent(entry));
        if (job && job.projectId === st.id) { jobId = job.id || entry; break; }
      } catch { /* skip */ }
    }
  }
  if (!jobId) return;
  if (st.jobId || st.phase !== 'idle') return;
  adoptForgeJob(st, jobId, 'Re-attached to a generation that was already running.');
}

async function adoptForgeJob(st, jobId, notice) {
  st.jobId = jobId;
  st.phase = 'running';
  st.error = null;
  st.saved = null;
  st.notice = notice || null;
  st.startedMs = st.startedMs || Date.now();
  renderForge(st);
  await refreshForgeJob(st);
  if (forgeLive(st)) beginForgeWatch(st);
  renderForge(st);
}

/* ── launching ────────────────────────────────────────────────────────── */

async function startForge(st, override) {
  if (forgeLive(st)) return;
  Object.assign(st.controls, override || {});
  const c = st.controls;

  st.phase = 'starting';
  st.jobId = null;
  st.job = null;
  st.progress = [];
  st.error = null;
  st.saved = null;
  st.notice = null;
  st.streamDown = false;
  st.esAttempt = 0;
  st.startedMs = Date.now();
  renderForge(st);

  const payload = { id: st.id, kind: c.kind, tier: c.tier };
  if (c.tier === 'authored' || c.tier === 'local') {
    const m = c.tier === 'local' ? c.localModel : c.model;
    if (m) payload.model = m;
    const aud = String(c.audience || '').trim();
    if (aud) payload.audience = aud.slice(0, 200);
  }

  let res;
  try {
    res = await forgePost('/api/forge/generate', payload);
  } catch (err) {
    st.phase = 'failed';
    st.error = 'Could not reach the Ground Control server (' + err.message + ').';
    renderForge(st);
    return;
  }

  const body = res.body || {};
  const job = body.id ? body : (body.job && body.job.id ? body.job : null);

  if ((res.ok || res.status === 202) && job) {
    applyJob(st, job, { replaceProgress: true });
    if (forgeLive(st)) beginForgeWatch(st); else await refreshForgeJob(st);
    renderForge(st);
    announce('Generating the ' + kindLabel(c.kind) + ' artifact for ' + ((st.project && st.project.name) || st.id) + '.');
    return;
  }

  if (res.status === 409) {
    const running = body.jobId || body.id || (body.job && body.job.id) || null;
    if (running) {
      adoptForgeJob(st, running, 'A generation was already running for this project: re-attached to it.');
      return;
    }
  }

  st.phase = 'failed';
  st.error = body.error || ('The server rejected the request (HTTP ' + res.status + ').');
  renderForge(st);
}

async function cancelForge(st) {
  if (!st.jobId || !forgeLive(st)) return;
  st.notice = 'Cancelling…';
  paintForgeMeta(st);
  try {
    await forgePost('/api/forge/job/' + encodeURIComponent(st.jobId) + '/cancel', {});
  } catch (err) {
    st.notice = 'Could not send the cancel request (' + err.message + ').';
    paintForgeMeta(st);
    return;
  }
  st.notice = null;
  await refreshForgeJob(st);
}

function discardForge(st) {
  stopForgeTimers(st);
  st.phase = 'idle';
  st.jobId = null;
  st.job = null;
  st.progress = [];
  st.error = null;
  st.saved = null;
  st.notice = null;
  renderForge(st);
  announce('Preview discarded.');
}

/* ============================================================================
 * Forge: rendering
 * ========================================================================= */

function forgePanel(d) {
  const st = forgeState(d.id);
  st.project = d;

  const p = panel('Forge', 'i-spark', null);
  p.classList.add('forge');
  p._body.classList.add('forge-b');
  st.body = p._body;
  st.els = null;
  renderForge(st);

  loadForgeStatus(false).then(() => {
    if (st.body !== p._body) return;
    renderForge(st);
    reattachForge(st);
  });

  return p;
}

function renderForge(st) {
  const box = st.body;
  if (!box) return;
  clear(box);
  st.els = {};

  // One home for transient notices and stream warnings, in every phase.
  const meta = h('div', 'forge-meta');
  st.els.meta = meta;
  box.append(meta);
  paintForgeMeta(st);

  if (forge.status && forge.status.unavailable) return void box.append(forgeUnavailable(st));

  switch (st.phase) {
    case 'starting':
    case 'queued':
    case 'running':
      paintForgeRunning(st, box);
      break;
    case 'done':
      paintForgeDone(st, box);
      break;
    case 'failed':
    case 'cancelled':
      paintForgeEnded(st, box);
      break;
    default:
      paintForgeIdle(st, box);
  }
}

function forgeNote(iconName, text, cls) {
  const n = h('div', cls ? 'forge-note ' + cls : 'forge-note');
  n.append(icon(iconName));
  n.append(h('span', null, text));
  return n;
}

function forgeUnavailable(st) {
  const wrap = h('div', 'forge-off');
  wrap.append(h('p', 'forge-lede',
    'This Ground Control server doesn’t offer artifact generation: nothing here can write to your projects.'));
  wrap.append(h('p', 'forge-hint', 'GET /api/forge/status said: ' + (forge.status.unavailable || 'no response')));
  const btn = h('button', 'btn btn-sm', 'Check again');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    loadForgeStatus(true).then(() => renderForge(st));
  });
  wrap.append(btn);
  return wrap;
}

/* ── idle: controls + primary action ──────────────────────────────────── */

function paintForgeIdle(st, box) {
  const d = st.project || {};

  box.append(h('p', 'forge-lede',
    'Build a single-file, self-contained HTML artifact for ' + (d.name || st.id) +
    ', grounded in what this repository actually contains. It is written to Ground Control’s staging area first: nothing lands in your project until you explicitly save it.'));

  if (st.saved) box.append(savedBanner(st));

  // Status hasn't answered yet: don't guess at whether `claude` is available.
  if (!forge.status) {
    const wait = h('div', 'forge-checking');
    wait.append(h('span', 'forge-spin'));
    wait.append(h('span', null, 'Checking what this machine can generate…'));
    box.append(wait);
    return;
  }

  const ready = claudeReady();
  const localReady = ollamaReady();
  if (st.controls.tier === 'authored' && !ready) st.controls.tier = localReady ? 'local' : 'template';
  if (st.controls.tier === 'local' && !localReady) st.controls.tier = ready ? 'authored' : 'template';
  // A rationale has to be checked against the code, so the server takes it
  // only from the authored tier. Keep the kind and move the tier where that is
  // possible; where it isn't, the kind is what gives.
  if (st.controls.kind !== 'onboarding' && st.controls.tier !== 'authored') {
    if (ready) st.controls.tier = 'authored';
    else st.controls.kind = 'onboarding';
  }

  const row = h('div', 'forge-controls');

  /* kind: what the document is. Decided before the tier, which is only how
   * it gets made. */
  const kindField = forgeField('Document', 'forge-kind-' + st.id);
  const kind = h('select', null);
  kind.id = 'forge-kind-' + st.id;
  kind.append(new Option('Onboarding: how to work in this project', 'onboarding'));
  const codeOpt = new Option('Code breakdown: the syntax, libraries and services', 'code');
  const designOpt = new Option('Design rationale: why it is built this way', 'design');
  // Only the authored tier reads the repository, and a rationale that isn't
  // checked against the code is just a plausible-sounding invention.
  designOpt.disabled = !ready;
  if (!ready) designOpt.title = 'Needs the authored tier: the claude CLI isn’t available on this machine.';
  kind.append(designOpt);
  // Same authored-tier requirement as the rationale document: it has to be
  // checked against real source, so it needs a tier that can read the repo.
  codeOpt.disabled = !ready;
  if (!ready) codeOpt.title = 'Needs the authored tier: the claude CLI isn’t available on this machine.';
  kind.append(codeOpt);
  kind.value = st.controls.kind;
  kind.addEventListener('change', () => {
    st.controls.kind = kind.value;
    renderForge(st);
  });
  kindField.append(kind);
  row.append(kindField);

  /* tier: a design rationale is authored-only, so the other two are off for it */
  const designOnly = st.controls.kind !== 'onboarding';
  const designOnlyWhy = 'A design rationale has to be checked against the code, so only the authored tier can write one.';
  const tierField = forgeField('Tier', 'forge-tier-' + st.id);
  const tier = h('select', null);
  tier.id = 'forge-tier-' + st.id;
  const authored = new Option('Authored: written by Claude', 'authored');
  authored.disabled = !ready;
  tier.append(authored);
  // CONTRACT-LOCAL.md §5: offered with its reason when it can't run, never
  // silently missing.
  const localOpt = new Option('Local model: runs on this machine', 'local');
  localOpt.disabled = !localReady || designOnly;
  if (designOnly) localOpt.title = designOnlyWhy;
  else if (!localReady) localOpt.title = ollamaOffReason();
  tier.append(localOpt);
  const templateOpt = new Option('Data-only: repository facts', 'template');
  templateOpt.disabled = designOnly;
  if (designOnly) templateOpt.title = designOnlyWhy;
  tier.append(templateOpt);
  tier.value = st.controls.tier;
  tier.addEventListener('change', () => {
    st.controls.tier = tier.value;
    renderForge(st);
  });
  tierField.append(tier);
  row.append(tierField);

  /* model + audience: the local tier picks from what ollama has installed */
  if (st.controls.tier === 'local') {
    const o = ollamaInfo() || {};
    const modelField = forgeField('Local model', 'forge-lmodel-' + st.id);
    const model = h('select', null);
    model.id = 'forge-lmodel-' + st.id;
    model.append(new Option('Recommended (' + (o.defaultModel || 'none') + ')', ''));
    for (const m of localModels()) model.append(new Option(m.label, m.value));
    model.value = st.controls.localModel || '';
    model.addEventListener('change', () => { st.controls.localModel = model.value; });
    modelField.append(model);
    row.append(modelField);

    const audField = forgeField('Audience hint (optional)', 'forge-laud-' + st.id);
    audField.classList.add('is-wide');
    const aud = h('input', null);
    aud.id = 'forge-laud-' + st.id;
    aud.type = 'text';
    aud.maxLength = 200;
    aud.placeholder = 'e.g. someone who has never seen this codebase';
    aud.value = st.controls.audience || '';
    aud.addEventListener('input', () => { st.controls.audience = aud.value; });
    audField.append(aud);
    row.append(audField);
  }

  /* model: only meaningful for the authored tier */
  if (st.controls.tier === 'authored') {
    const modelField = forgeField('Model', 'forge-model-' + st.id);
    const model = h('select', null);
    model.id = 'forge-model-' + st.id;
    const dflt = (forge.status && forge.status.defaultModel) || FORGE_MODELS[0];
    model.append(new Option('Server default (' + dflt + ')', ''));
    for (const m of forgeModels()) model.append(new Option(m.label, m.value));
    model.value = st.controls.model || '';
    model.addEventListener('change', () => { st.controls.model = model.value; });
    modelField.append(model);
    row.append(modelField);

    const audField = forgeField('Audience hint (optional)', 'forge-aud-' + st.id);
    audField.classList.add('is-wide');
    const aud = h('input', null);
    aud.id = 'forge-aud-' + st.id;
    aud.type = 'text';
    aud.maxLength = 200;
    aud.placeholder = 'e.g. someone who has never seen this codebase';
    aud.value = st.controls.audience || '';
    aud.addEventListener('input', () => { st.controls.audience = aud.value; });
    audField.append(aud);
    row.append(audField);
  }

  box.append(row);

  const actions = h('div', 'forge-actions');
  const go = h('button', 'btn btn-primary', null);
  go.type = 'button';
  go.append(icon('i-spark'), h('span', null, 'Create ' + kindLabel(st.controls.kind) + ' artifact'));
  go.addEventListener('click', () => startForge(st));
  actions.append(go);

  const hint = h('span', 'forge-hint',
    st.controls.tier === 'authored'
      ? 'Reads the repository with read-only tools; typically a few minutes.'
      : st.controls.tier === 'local'
        ? 'Drafts the written sections on this machine; usually under a minute or two.'
        : 'Built from repository facts alone. No model, works offline, near-instant.');
  actions.append(hint);
  box.append(actions);

  if (st.controls.tier === 'local') {
    box.append(localNote());
  } else if (!ready) {
    const v = forge.status && forge.status.claude && forge.status.claude.version;
    box.append(forgeNote('i-alert',
      'The claude CLI isn’t available on this machine, so the authored tier is off. ' +
      'The data-only artifact is always available and works offline.' + (v ? ' (found ' + v + ')' : '')));
  } else {
    box.append(billingNote());
  }

  if (!localReady) {
    box.append(forgeNote('i-alert',
      'The local-model tier is off: ' + ollamaOffReason(), 'is-quiet'));
  }
}

/**
 * CONTRACT-LOCAL.md §5: say plainly that it runs here and costs nothing.
 * There is deliberately no money figure anywhere in this tier.
 */
function localNote() {
  const fromServer = forge.status && typeof forge.status.localNote === 'string' && forge.status.localNote.trim();
  const o = ollamaInfo() || {};
  const note = forgeNote('i-check', fromServer ||
    'The model runs on this machine through ollama. It works offline, needs no API key, and costs nothing: ' +
    'it doesn’t touch your Claude subscription.', 'is-quiet');
  if (o.version) note.title = 'ollama ' + o.version + (o.host ? ' at ' + o.host : '');
  return note;
}

/**
 * §0b: never present generation as metered. This is the standing explanation
 * shown before a run; the per-run figure is worded the same way afterwards.
 */
function billingNote() {
  const fromServer = forge.status && typeof forge.status.billingNote === 'string' && forge.status.billingNote.trim();
  return forgeNote('i-check', fromServer ||
    'Generation runs through your authenticated Claude CLI, on your Claude subscription. ' +
    'There is no API key involved and nothing is billed per run.', 'is-quiet');
}

/** Human label for a document kind, in labels and announcements. */
function kindLabel(kind) {
  return kind === 'design' ? 'design rationale'
    : kind === 'code' ? 'code breakdown'
      : 'onboarding';
}

/** Human label for a tier, in tags and summaries. */
function tierLabel(tier) {
  if (tier === 'template') return 'data-only';
  if (tier === 'local') return 'local model';
  return 'authored';
}

function forgeField(label, forId) {
  const f = h('label', 'forge-field');
  f.setAttribute('for', forId);
  f.append(h('span', 'forge-field-l', label));
  return f;
}

/* ── running ──────────────────────────────────────────────────────────── */

function paintForgeRunning(st, box) {
  const job = st.job || {};

  const head = h('div', 'forge-runhead');
  const status = h('div', 'forge-status');
  status.append(h('span', 'forge-spin'));
  const label = h('span', 'forge-state',
    st.phase === 'starting' ? 'Starting…' : st.phase === 'queued' ? 'Queued…' : 'Working…');
  st.els.state = label;
  status.append(label);
  const el = h('span', 'forge-elapsed mono', fmtElapsed(Date.now() - (st.startedMs || Date.now())));
  el.title = 'Elapsed time';
  status.append(el);
  st.els.elapsed = el;
  head.append(status);

  const cancel = h('button', 'btn btn-sm', null);
  cancel.type = 'button';
  cancel.append(icon('i-x'), h('span', null, 'Cancel'));
  cancel.disabled = !st.jobId;
  cancel.addEventListener('click', () => cancelForge(st));
  head.append(cancel);
  box.append(head);

  const tier = job.tier || st.controls.tier;
  const tags = h('div', 'forge-tags');
  tags.append(h('span', 'forge-tag' + (tier === 'local' ? ' is-local' : ''), tierLabel(tier)));
  if (job.model && tier !== 'template') tags.append(h('span', 'forge-tag', job.model));
  if (job.id) tags.append(h('span', 'forge-tag is-id', job.id));
  box.append(tags);

  const log = h('div', 'forge-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Generation progress');
  st.els.log = log;
  box.append(log);
  paintForgeLog(st, { full: true });
}

function paintForgeElapsed(st) {
  if (!st.els || !st.els.elapsed) return;
  st.els.elapsed.textContent = fmtElapsed(Date.now() - (st.startedMs || Date.now()));
}

function paintForgeMeta(st) {
  if (!st.els || !st.els.meta) return;
  const meta = st.els.meta;
  clear(meta);
  if (st.streamDown) {
    meta.append(forgeNote('i-alert', 'Lost the progress stream: reconnecting. The job keeps running on the server.'));
  }
  if (st.notice) meta.append(forgeNote('i-alert', st.notice));
}

function paintForgeLog(st, opts = {}) {
  const log = st.els && st.els.log;
  if (!log) return;
  const nearBottom = !log.clientHeight || (log.scrollHeight - log.scrollTop - log.clientHeight < 40);

  if (opts.one && !opts.full) {
    const placeholder = log.querySelector('.forge-log-empty');
    if (placeholder) placeholder.remove();
    log.append(forgeLogLine(opts.one));
  } else {
    clear(log);
    if (!st.progress.length) {
      log.append(h('div', 'forge-log-empty', 'Waiting for the first progress line…'));
    } else {
      for (const item of st.progress) log.append(forgeLogLine(item));
    }
  }
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function forgeLogLine(item) {
  const row = h('div', 'forge-log-row');
  const t = fmtClock(item && item.atISO);
  row.append(h('span', 'forge-log-t', t || '-'));
  row.append(h('span', 'forge-log-x', String((item && item.text) || '')));
  return row;
}

/* ── done: preview + save / open / discard ────────────────────────────── */

function paintForgeDone(st, box) {
  const job = st.job || {};

  const head = h('div', 'forge-runhead');
  const status = h('div', 'forge-status is-ok');
  status.append(icon('i-check'));
  status.append(h('span', 'forge-state', 'Artifact ready'));
  head.append(status);

  const facts = h('div', 'forge-tags');
  if (job.bytes) facts.append(h('span', 'forge-tag', fmtBytes(job.bytes)));
  if (job.durationMs) facts.append(h('span', 'forge-tag', fmtElapsed(job.durationMs)));
  facts.append(h('span', 'forge-tag' + (job.tier === 'local' ? ' is-local' : ''), tierLabel(job.tier)));
  if (job.model && job.tier !== 'template') facts.append(h('span', 'forge-tag', job.model));
  head.append(facts);
  box.append(head);

  const usage = usageSentence(job);
  if (usage) box.append(forgeNote('i-check', usage, 'is-quiet'));

  // The local tier reports what it drafted and what verification removed. No
  // money figure: there isn't one (CONTRACT-LOCAL.md §5).
  if (job.tier === 'local') {
    box.append(forgeNote('i-check',
      'Prose drafted by ' + (job.model || 'a local model') + ' on this machine. Every path, command and figure ' +
      'on the page comes from the repository itself. Nothing was billed and nothing left this machine.', 'is-quiet'));
    const v = verificationSentence(job);
    if (v) box.append(forgeNote((job.verification && job.verification.dropped) ? 'i-alert' : 'i-check', v, 'is-quiet'));
  }

  if (st.saved) box.append(savedBanner(st));

  box.append(h('p', 'forge-lede is-tight', st.saved
    ? 'This preview is the staged copy. Saving again overwrites the file above: you will be asked to confirm.'
    : 'Nothing has been written into ' + ((st.project && st.project.name) || st.id) +
      ' yet. Read it here, then save it deliberately.'));

  const frame = h('iframe', 'forge-frame');
  frame.setAttribute('sandbox', 'allow-same-origin');   // CONTRACT-FORGE.md §9
  frame.setAttribute('title', 'Preview of the generated ' + kindLabel(job.kind) + ' artifact');
  frame.setAttribute('loading', 'lazy');
  if (st.jobId) frame.src = previewUrl(st.jobId);
  box.append(frame);

  const actions = h('div', 'forge-actions');

  const save = h('button', 'btn btn-primary', null);
  save.type = 'button';
  save.append(icon('i-save'), h('span', null, 'Save to project…'));
  save.addEventListener('click', () => openSaveDialog(st));
  actions.append(save);

  const open = h('a', 'btn', null);
  open.href = st.jobId ? previewUrl(st.jobId) : '#';
  open.target = '_blank';
  open.rel = 'noreferrer';
  open.append(h('span', null, 'Open in new tab'), icon('i-external'));
  actions.append(open);

  const again = h('button', 'btn btn-ghost btn-sm', 'Generate again');
  again.type = 'button';
  again.addEventListener('click', () => startForge(st));
  actions.append(again);

  const discard = h('button', 'btn btn-ghost btn-sm', 'Discard');
  discard.type = 'button';
  discard.title = 'Clears this preview. The staged file stays in Ground Control’s .forge/ area and is pruned by age: your project is untouched either way.';
  discard.addEventListener('click', () => discardForge(st));
  actions.append(discard);

  box.append(actions);
}

function savedBanner(st) {
  const n = h('div', 'forge-saved');
  n.append(icon('i-check'));
  const t = h('div', null);
  t.append(h('div', 'forge-saved-h', 'Saved into the project'));
  const p = h('div', 'forge-saved-p mono', st.saved.savedTo || '');
  p.title = st.saved.savedTo || '';
  t.append(p);
  if (typeof st.saved.bytes === 'number') {
    t.append(h('div', 'forge-saved-b', fmtBytes(st.saved.bytes) + ' written'));
  }
  n.append(t);
  return n;
}

/* ── failed / cancelled ───────────────────────────────────────────────── */

function paintForgeEnded(st, box) {
  const failed = st.phase === 'failed';
  const job = st.job || {};

  const head = h('div', 'forge-runhead');
  const status = h('div', 'forge-status ' + (failed ? 'is-bad' : 'is-off'));
  status.append(icon(failed ? 'i-alert' : 'i-x'));
  status.append(h('span', 'forge-state', failed ? 'Generation failed' : 'Cancelled'));
  head.append(status);
  box.append(head);

  const reason = failed
    ? (st.error || job.error || 'The server did not say why.')
    : 'You cancelled this run. Nothing was written anywhere.';
  box.append(h('p', 'forge-reason', reason));

  const usage = usageSentence(job);
  if (usage) box.append(forgeNote('i-check', usage, 'is-quiet'));

  if (st.progress.length) {
    const det = h('details', 'forge-details');
    det.append(h('summary', null, 'Progress log (' + st.progress.length + ' lines)'));
    const log = h('div', 'forge-log is-static');
    for (const item of st.progress) log.append(forgeLogLine(item));
    det.append(log);
    box.append(det);
  }

  const actions = h('div', 'forge-actions');

  const retry = h('button', 'btn btn-primary', null);
  retry.type = 'button';
  retry.append(icon('i-refresh'), h('span', null, 'Retry'));
  retry.addEventListener('click', () => startForge(st));
  actions.append(retry);

  const wasAuthored = (job.tier || st.controls.tier) !== 'template';
  const isDesign = (job.kind || st.controls.kind) === 'design';
  if (wasAuthored && !isDesign) {
    const fallback = h('button', 'btn', 'Use data-only artifact');
    fallback.type = 'button';
    fallback.title = 'Built from repository facts alone: no model, always available.';
    fallback.addEventListener('click', () => startForge(st, { tier: 'template' }));
    actions.append(fallback);
  }

  const back = h('button', 'btn btn-ghost btn-sm', 'Back to options');
  back.type = 'button';
  back.addEventListener('click', () => discardForge(st));
  actions.append(back);

  box.append(actions);
}

/* ============================================================================
 * Forge: the save flow (CONTRACT-FORGE.md §2, §9)
 *
 * Saving is the one thing in Ground Control that writes into a real project, so it is
 * modal, shows the exact absolute destination, and a 409 "exists" demands a
 * second, differently-worded confirmation before overwrite is ever sent.
 * ========================================================================= */

function validFilename(name) {
  const v = String(name || '').trim();
  if (!v) return 'Enter a file name.';
  if (v.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(v)) return 'Use a path relative to the project, not an absolute one.';
  if (v.includes('\\')) return 'Use forward slashes.';
  if (v.split('/').some((seg) => seg === '..' || seg === '.')) return 'Path segments like “..” aren’t allowed.';
  if (!/\.html?$/i.test(v)) return 'The destination must end in .html.';
  return null;
}

function openSaveDialog(st) {
  const d = st.project || {};
  const job = st.job || {};
  const root = String(d.path || '').replace(/\/+$/, '');

  const dlg = h('dialog', 'forge-dialog');
  dlg.setAttribute('aria-label', 'Save the artifact into the project');

  const form = h('div', 'fd-in');
  dlg.append(form);

  let stage = 'confirm';           // confirm | exists | saving
  let existing = null;             // { sizeBytes, mtimeISO }
  let filename = job.suggestedFilename || (job.kind === 'design' ? DESIGN_ARTIFACT_NAME : DEFAULT_ARTIFACT_NAME);
  let error = null;

  // Tear down explicitly rather than relying on the `close` event alone, so a
  // dismissed dialog can never linger in the document.
  const close = () => {
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
  };

  function destination() {
    return root + '/' + String(filename || '').trim().replace(/^\/+/, '');
  }

  function paint() {
    clear(form);

    form.append(h('h2', 'fd-h', stage === 'exists' ? 'That file already exists' : 'Save into the project'));

    if (stage === 'exists') {
      const warn = h('div', 'fd-warn');
      warn.append(icon('i-alert'));
      const wt = h('div', null);
      wt.append(h('div', 'fd-warn-h', 'Overwriting will replace the file that is there now.'));
      const bits = [];
      if (existing && typeof existing.sizeBytes === 'number') bits.push(fmtBytes(existing.sizeBytes));
      if (existing && existing.mtimeISO) bits.push('last modified ' + relTime(existing.mtimeISO) + ' (' + fmtDate(existing.mtimeISO) + ')');
      wt.append(h('div', 'fd-warn-p', bits.length ? 'Existing file: ' + bits.join(' · ') : 'Ground Control could not read the existing file’s details.'));
      warn.append(wt);
      form.append(warn);
    } else {
      form.append(h('p', 'fd-p',
        'This writes a real file into your project directory. Ground Control has not touched it so far.'));
    }

    const field = h('label', 'fd-field');
    field.setAttribute('for', 'fd-name');
    field.append(h('span', 'fd-l', 'File name'));
    const input = h('input', null);
    input.id = 'fd-name';
    input.type = 'text';
    input.value = filename;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.disabled = stage !== 'confirm';
    input.addEventListener('input', () => {
      filename = input.value;
      const bad = validFilename(filename);
      error = bad;
      // Never show a destination the server would refuse: say why instead.
      dest.textContent = bad ? '-' : destination();
      dest.classList.toggle('is-void', !!bad);
      errNode.textContent = bad || '';
      confirm.disabled = !!bad;
    });
    field.append(input);
    form.append(field);

    form.append(h('div', 'fd-destl', 'Will be written to'));
    const initialBad = validFilename(filename);
    const dest = h('div', 'fd-dest mono' + (initialBad ? ' is-void' : ''), initialBad ? '-' : destination());
    form.append(dest);

    const errNode = h('div', 'fd-err', error || '');
    form.append(errNode);

    const foot = h('div', 'fd-foot');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    foot.append(cancel);

    const confirm = h('button', stage === 'exists' ? 'btn btn-danger' : 'btn btn-primary', null);
    confirm.type = 'button';
    if (stage === 'exists') {
      confirm.append(icon('i-alert'), h('span', null, 'Overwrite the existing file'));
    } else {
      confirm.append(icon('i-save'), h('span', null, 'Write file to project'));
    }
    confirm.disabled = stage === 'saving' || !!validFilename(filename);
    confirm.addEventListener('click', () => submit(stage === 'exists'));
    foot.append(confirm);
    form.append(foot);

    if (stage === 'saving') {
      confirm.classList.add('is-busy');
      cancel.disabled = true;
    }

    // Focus the safest control: the name field first time, Cancel on the overwrite step.
    setTimeout(() => {
      if (stage === 'exists') cancel.focus();
      else if (stage === 'confirm') { input.focus(); input.select(); }
    }, 0);
  }

  async function submit(overwrite) {
    const bad = validFilename(filename);
    if (bad) { error = bad; paint(); return; }
    const prev = stage;
    stage = 'saving';
    error = null;
    paint();

    let res;
    try {
      res = await forgePost(
        '/api/forge/job/' + encodeURIComponent(st.jobId) + '/save',
        { filename: String(filename).trim(), overwrite: !!overwrite }
      );
    } catch (err) {
      stage = prev;
      error = 'Could not reach the Ground Control server (' + err.message + ').';
      paint();
      return;
    }

    const body = res.body || {};

    if (res.ok) {
      st.saved = { savedTo: body.savedTo || destination(), bytes: body.bytes };
      close();
      renderForge(st);
      announce('Artifact saved to ' + st.saved.savedTo + '.');
      refreshAfterSave(st);
      return;
    }

    if (res.status === 409 && (body.error === 'exists' || body.existing)) {
      existing = body.existing || null;
      stage = 'exists';
      paint();
      return;
    }

    stage = prev === 'saving' ? 'confirm' : prev;
    error = body.error
      ? body.error + (res.status === 403 ? ' (the destination must stay inside the project and end in .html)' : '')
      : 'The server refused the write (HTTP ' + res.status + ').';
    paint();
  }

  // A dialog-level handler runs before the app's global Escape shortcut, so
  // closing the dialog never also navigates the page.
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      if (stage === 'saving') ev.preventDefault();
    }
  });
  dlg.addEventListener('cancel', (ev) => { if (stage === 'saving') ev.preventDefault(); });
  dlg.addEventListener('close', () => dlg.remove());

  paint();
  // Belt and braces: never stack dialogs if one was left behind.
  for (const stale of document.querySelectorAll('.forge-dialog')) stale.remove();
  document.body.append(dlg);
  dlg.showModal();
}

/** After a successful write the project has a new doc: make the UI show it. */
function refreshAfterSave(st) {
  state.detailCache.delete(st.id);
  state.docCache.clear();
  loadProjects(true).then(() => {
    if (state.route.view === 'detail' && state.route.id === st.id) {
      renderDetail(st.id, { silent: true });
    }
  });
}

/* ============================================================================
 * Router
 * ========================================================================= */

function routeKeyOf(r) { return r.view + '\u0000' + (r.id || '') + '\u0000' + (r.path || ''); }

/**
 * The topbar's up-one-level arrow. Deliberately mirrors the Escape-key
 * hierarchy (reader -> project -> all projects) rather than inventing a second
 * one: the breadcrumbs already say where you are, but they live in the content
 * column and scroll away, and the topbar is sticky.
 */
function syncUpNav(route) {
  if (!el.upnav) return;
  const view = route && route.view;
  if (view === 'reader') {
    const known = route.id ? state.byId.get(route.id) : null;
    const name = (known && known.name) || route.id;
    el.upnav.href = hrefProject(route.id);
    el.upnav.hidden = false;
    el.upnav.setAttribute('aria-label', 'Up to ' + name);
    el.upnav.title = 'Up to ' + name;
  } else if (view === 'detail') {
    el.upnav.href = '#/';
    el.upnav.hidden = false;
    el.upnav.setAttribute('aria-label', 'Up to all projects');
    el.upnav.title = 'Up to all projects';
  } else {
    el.upnav.hidden = true;
    el.upnav.removeAttribute('href');
  }
}

function onLocationChange() {
  const prev = state.route;
  const prevKey = state.routeKey;
  readFilters();
  syncControlsFromState();

  const next = readRoute();
  const nextKey = routeKeyOf(next);

  if (nextKey === prevKey) {
    // Only the filter query moved.
    renderGrid();
    return;
  }

  if (prevKey) state.scroll.set(prevKey, window.scrollY);
  state.route = next;
  state.routeKey = nextKey;

  if (next.view !== 'reader') teardownReader();

  el.viewGrid.hidden = next.view !== 'grid';
  el.viewDetail.hidden = next.view !== 'detail';
  el.viewReader.hidden = next.view !== 'reader';
  syncUpNav(next);

  if (next.view === 'grid') {
    document.title = 'Ground Control';
    renderGrid();
  } else if (next.view === 'detail') {
    const known = state.byId.get(next.id);
    document.title = (known ? known.name : next.id) + ' · Ground Control';
    renderDetail(next.id);
  } else {
    document.title = next.path.split('/').pop() + ' · Ground Control';
    renderReader(next.id, next.path);
  }

  // Restore on back/forward; land at the top on a fresh navigation.
  const y = state.scroll.get(nextKey);
  const top = (prev.view && y != null) ? y : 0;
  window.scrollTo({ top, behavior: 'auto' });
  // Async views paint after this tick: settle again once they have.
  setTimeout(() => window.scrollTo({ top, behavior: 'auto' }), 0);
}

/* ============================================================================
 * SSE
 * ========================================================================= */

let es = null;
let sseAttempt = 0;
let sseTimer = 0;
let sseWasOpen = false;

function connectSSE() {
  clearTimeout(sseTimer);
  if (es) { try { es.close(); } catch { /* noop */ } es = null; }
  setLive('connecting');

  let src;
  try {
    src = new EventSource('/api/stream');
  } catch {
    scheduleSSE();
    return;
  }
  es = src;

  const opened = () => {
    if (es !== src) return;
    sseAttempt = 0;
    setLive('open');
    hideBanner('stream');
    if (sseWasOpen) loadProjects(false);   // catch up on anything missed while down
    sseWasOpen = true;
  };

  src.addEventListener('open', opened);
  src.addEventListener('hello', opened);
  src.addEventListener('ping', () => { if (es === src) setLive('open'); });
  src.addEventListener('projects', (ev) => {
    if (es !== src) return;
    try { applyData(JSON.parse(ev.data), { live: true }); } catch { /* ignore bad frame */ }
  });
  src.addEventListener('error', () => {
    if (es !== src) return;
    try { src.close(); } catch { /* noop */ }
    es = null;
    setLive('down');
    scheduleSSE();
  });
}

function scheduleSSE() {
  clearTimeout(sseTimer);
  const wait = BACKOFF[Math.min(sseAttempt, BACKOFF.length - 1)];
  sseAttempt++;
  if (sseAttempt >= 2 && !bannerReason) {
    showBanner('Lost the live connection to the Ground Control server. Reconnecting…', 'stream');
  }
  sseTimer = setTimeout(connectSSE, wait);
}

/* ============================================================================
 * Boot
 * ========================================================================= */

function cacheEls() {
  el.srcBtn = $('#src-btn');                            // Sources §5
  el.srcBtnLabel = $('#src-btn-label');
  el.srcBlank = $('#src-blank');
  el.srcBlankAdd = $('#src-blank-add');
  el.fSource = $('#f-source');
  el.fSourceWrap = $('#f-source-wrap');
  el.dropzone = $('#dropzone');
  el.counts = $('#hdr-counts');
  el.live = $('#live');
  el.liveLabel = $('#live-label');
  el.rescan = $('#rescan');
  el.banner = $('#banner');
  el.bannerText = $('#banner-text');
  el.bannerRetry = $('#banner-retry');
  el.upnav = $('#upnav');
  el.viewGrid = $('#view-grid');
  el.viewDetail = $('#view-detail');
  el.viewReader = $('#view-reader');
  el.controls = $('#controls');
  el.fQ = $('#f-q');
  el.fStatus = $('#f-status');
  el.fStack = $('#f-stack');
  el.fSort = $('#f-sort');
  el.fClear = $('#f-clear');
  el.resultLine = $('#result-line');
  el.grid = $('#grid');
  el.skeletons = $('#skeletons');
  el.gridEmpty = $('#grid-empty');
  el.gridEmptyText = $('#grid-empty-text');
  el.gridEmptyClear = $('#grid-empty-clear');
  el.footScan = $('#foot-scan');
  el.announcer = $('#announcer');
}

function wireControls() {
  let debounce = 0;
  el.fQ.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.filters.q = el.fQ.value;
      syncFilterUrl();
      renderGrid();
    }, 120);
  });
  el.controls.addEventListener('submit', (ev) => ev.preventDefault());

  el.fStack.addEventListener('change', () => {
    state.filters.stack = el.fStack.value;
    syncFilterUrl();
    renderGrid();
  });
  el.fSource.addEventListener('change', () => {         // Sources §5
    state.filters.source = el.fSource.value;
    syncFilterUrl();
    renderGrid();
  });
  el.fSort.addEventListener('change', () => {
    state.filters.sort = el.fSort.value;
    syncFilterUrl();
    renderGrid();
  });

  const clearAll = () => {
    state.filters = { q: '', status: new Set(), stack: '', sort: 'activity', agent: false, source: '' };  // Workbench §5, Sources §5
    syncControlsFromState();
    syncFilterUrl();
    renderGrid();
    el.fQ.focus();
  };
  el.fClear.addEventListener('click', clearAll);
  el.gridEmptyClear.addEventListener('click', clearAll);

  el.rescan.addEventListener('click', () => {
    announce('Rescanning projects…');
    loadProjects(true);
  });
  el.bannerRetry.addEventListener('click', () => {
    pollAttempt = 0;
    sseAttempt = 0;
    loadProjects(false);
    connectSSE();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented) return;
    const tag = (ev.target && ev.target.tagName) || '';
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || (ev.target && ev.target.isContentEditable);
    if (ev.key === '/' && !typing && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      location.hash = '#/';
      el.fQ.focus();
      el.fQ.select();
    } else if (ev.key === 'Escape') {
      if (typing && ev.target === el.fQ && el.fQ.value) {
        el.fQ.value = '';
        state.filters.q = '';
        syncFilterUrl();
        renderGrid();
      } else if (state.route.view === 'reader') {
        location.hash = hrefProject(state.route.id).slice(1);
      } else if (state.route.view === 'detail') {
        location.hash = '/';
      }
    }
  });
}

function boot() {
  // We restore scroll ourselves, per route, so the browser must not guess.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  cacheEls();
  readFilters();
  buildStatusChips();
  syncControlsFromState();
  wireControls();

  state.route = readRoute();
  state.routeKey = routeKeyOf(state.route);
  syncUpNav(state.route);
  el.viewGrid.hidden = state.route.view !== 'grid';
  el.viewDetail.hidden = state.route.view !== 'detail';
  el.viewReader.hidden = state.route.view !== 'reader';

  renderSkeletons(8);
  setLive('connecting');
  window.scrollTo(0, 0);

  window.addEventListener('hashchange', onLocationChange);
  window.addEventListener('popstate', onLocationChange);

  // Deep links render immediately; they do not wait on the project list.
  if (state.route.view === 'detail') renderDetail(state.route.id);
  else if (state.route.view === 'reader') renderReader(state.route.id, state.route.path);

  loadProjects(false);
  connectSSE();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

/* ============================================================================
 * WORKBENCH: open, hop, and watch (CONTRACT-WORKBENCH.md §5)
 *
 * Appended below the original app and below Forge. Nothing above was
 * restructured; the existing render functions gained one call line each, marked
 * `Workbench §5`, and the filter helpers gained one line each for the agent
 * chip and the "Agent activity" sort.
 *
 * Two rules shape everything here:
 *   §3: Ground Control OBSERVES agents. There is no control in this UI that stops,
 *        signals, or otherwise touches a running agent, and nothing beyond the
 *        short status labels the API returns is ever shown.
 *   §5: most cards must stay calm. A project with no agent renders nothing at
 *        all; the pulse is an accent, and it disappears under
 *        `prefers-reduced-motion`.
 * ========================================================================= */

const WB_EDITOR_ICON = {
  vscode: 'i-code', cursor: 'i-code', xcode: 'i-cpu', finder: 'i-folder', terminal: 'i-terminal',
};
/* Preference order for the primary Open action, per contract §2. */
const WB_ORDER = ['vscode', 'cursor', 'xcode', 'finder', 'terminal'];

const wb = {
  editors: null,            // global probe
  editorsPromise: null,
  byProject: new Map(),     // projectId -> { editors, at } | Promise
  detail: new Map(),        // projectId -> ActivityDetail
  menu: null,               // { node, close }
  toastTimer: 0,
  toastNode: null,
  switcher: null,
  ready: false,
};

/* ── editors ──────────────────────────────────────────────────────────── */

function wbLoadEditors() {
  if (wb.editors) return Promise.resolve(wb.editors);
  if (!wb.editorsPromise) {
    wb.editorsPromise = getJSON('/api/editors')
      .then((r) => { wb.editors = Array.isArray(r.editors) ? r.editors : []; return wb.editors; })
      .catch(() => { wb.editorsPromise = null; return []; });
  }
  return wb.editorsPromise;
}

/** Editors tailored to one project: Xcode only shows up when it can work. */
function wbProjectEditors(id) {
  const hit = wb.byProject.get(id);
  if (hit && hit.then) return hit;
  if (hit && Date.now() - hit.at < 60000) return Promise.resolve(hit.editors);
  const p = getJSON('/api/editors?id=' + encodeURIComponent(id))
    .then((r) => {
      const editors = Array.isArray(r.editors) ? r.editors : [];
      wb.byProject.set(id, { editors, at: Date.now() });
      return editors;
    })
    .catch(() => { wb.byProject.delete(id); return wbLoadEditors(); });
  wb.byProject.set(id, p);
  return p;
}

function wbSorted(editors) {
  const list = (editors || []).slice();
  list.sort((a, b) => {
    const ia = WB_ORDER.indexOf(a.id), ib = WB_ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return list;
}

function wbPrimary(editors) {
  return wbSorted(editors).find((e) => e.available) || null;
}

/* ── launching ────────────────────────────────────────────────────────── */

async function wbOpenProject(projectId, editorId, opts = {}) {
  const body = { id: projectId, editor: editorId };
  if (opts.file) body.file = opts.file;
  if (opts.line) body.line = opts.line;
  const name = (wb.editors || []).concat([]).find((e) => e.id === editorId);
  const label = (name && name.name) || editorId;
  try {
    const res = await getJSON('/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const what = opts.file ? opts.file.split('/').pop() : (state.byId.get(projectId) || {}).name || projectId;
    wbToast('Opened ' + what + ' in ' + label + '.', 'ok');
    announce('Opened ' + what + ' in ' + label + '.');
    return res;
  } catch (err) {
    wbToast('Could not open in ' + label + ' - ' + err.message, 'bad');
    announce('Could not open in ' + label + '. ' + err.message);
    return null;
  }
}

function wbToast(text, kind) {
  if (!wb.toastNode) {
    wb.toastNode = h('div', 'wb-toast');
    wb.toastNode.setAttribute('role', 'status');
    document.body.append(wb.toastNode);
  }
  const n = wb.toastNode;
  clear(n);
  n.className = 'wb-toast' + (kind ? ' is-' + kind : '');
  n.append(icon(kind === 'bad' ? 'i-alert' : 'i-check'));
  n.append(h('span', 'wb-toast-x', text));
  n.hidden = false;
  clearTimeout(wb.toastTimer);
  wb.toastTimer = setTimeout(() => { n.hidden = true; }, kind === 'bad' ? 7000 : 3400);
}

/* ── the Open control (card head + detail header) ─────────────────────── */

/**
 * Primary action opens the best available editor; the caret opens a menu with
 * the rest. Which editor the primary uses is always spelled out, and the whole
 * control is disabled with a reason when nothing is available.
 */
function wbOpenControl(projectId, opts = {}) {
  const box = h('div', 'wb-open');
  const go = h('button', 'wb-go');
  go.type = 'button';
  go.dataset.part = 'wb-open';
  go.append(icon('i-launch'), h('span', null, 'Open'));
  go.disabled = true;
  go.title = 'Looking for editors…';

  const more = h('button', 'wb-more');
  more.type = 'button';
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', 'Choose an editor');
  more.append(icon('i-chevron'));
  more.disabled = true;

  box.append(go, more);

  const stop = (ev) => { ev.preventDefault(); ev.stopPropagation(); };

  wbProjectEditors(projectId).then((editors) => {
    const primary = wbPrimary(editors);
    const any = editors.some((e) => e.available);
    go.disabled = !primary;
    more.disabled = !any;
    if (primary) {
      go.title = 'Open ' + (opts.file ? opts.file : 'this project') + ' in ' + primary.name;
      go.setAttribute('aria-label', go.title);
      if (opts.showName !== false) {
        clear(go);
        go.append(icon('i-launch'), h('span', null, opts.long ? 'Open in ' + primary.name : 'Open'));
      }
      go.addEventListener('click', (ev) => {
        stop(ev);
        wbOpenProject(projectId, primary.id, opts);
      });
    } else {
      go.title = 'No editor was found on this machine';
      go.setAttribute('aria-label', go.title);
    }
    more.addEventListener('click', (ev) => {
      stop(ev);
      wbToggleMenu(more, box, projectId, editors, opts);
    });
  });

  // Swallow the card-wide link activation so Open never navigates.
  box.addEventListener('click', (ev) => ev.stopPropagation());
  box.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') ev.stopPropagation(); });
  return box;
}

function wbCloseMenu() {
  if (wb.menu) { wb.menu.close(); wb.menu = null; }
}

function wbToggleMenu(anchor, box, projectId, editors, opts) {
  if (wb.menu && wb.menu.anchor === anchor) { wbCloseMenu(); return; }
  wbCloseMenu();

  const menu = h('div', 'wb-menu');
  menu.setAttribute('role', 'menu');
  menu.append(h('div', 'wb-menu-h', 'Open with'));

  const items = [];
  for (const e of wbSorted(editors)) {
    const b = h('button', null);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.disabled = !e.available;
    b.append(icon(WB_EDITOR_ICON[e.id] || 'i-window'));
    b.append(h('span', 'wb-mi-n', e.name));
    b.append(h('span', 'wb-mi-t', e.kind === 'cli' ? 'cli' : 'app'));
    if (e.note) b.title = e.note;
    if (e.available) {
      b.addEventListener('click', () => { wbCloseMenu(); wbOpenProject(projectId, e.id, opts); });
    }
    items.push(b);
    menu.append(b);
  }
  if (!items.some((b) => !b.disabled)) {
    menu.append(h('div', 'wb-menu-note', 'No editor was found on this machine.'));
  }

  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth || 216;
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8) + 'px';
  menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';

  anchor.setAttribute('aria-expanded', 'true');
  if (box) box.classList.add('is-open');

  const onDown = (ev) => { if (!menu.contains(ev.target) && ev.target !== anchor) wbCloseMenu(); };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); wbCloseMenu(); anchor.focus(); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const live = items.filter((b) => !b.disabled);
    if (!live.length) return;
    const i = live.indexOf(document.activeElement);
    const next = ev.key === 'ArrowDown'
      ? live[(i + 1 + live.length) % live.length]
      : live[(i - 1 + live.length) % live.length];
    next.focus();
  };
  const onScroll = () => wbCloseMenu();

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('scroll', onScroll, true);

  wb.menu = {
    anchor,
    close() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
      anchor.setAttribute('aria-expanded', 'false');
      if (box) box.classList.remove('is-open');
      menu.remove();
    },
  };

  const first = items.find((b) => !b.disabled);
  if (first) first.focus();
}

/* ── card decoration ──────────────────────────────────────────────────── */

/**
 * Called at the end of `fillCard`. A project with no agent gets nothing: only
 * `working` and `idle` draw anything at all.
 */
/* ── agent core ──────────────────────────────────────────────────────────
   A running agent is drawn as a body in orbit around the project. The count
   is readable from the figure itself (one satellite each, up to four; beyond
   that a numeral takes over), so the shape carries the information rather
   than decorating it. Every moving part is CSS transform only: 19 cards
   animate without touching layout, and all of it stops flat under
   prefers-reduced-motion.                                                  */
/** How many distinct orbits the figure draws before deferring to the count. */
const WB_MAX_ORBITS = 6;

function wbCore(live, variant) {
  // One figure for every agent state. `working` runs; `open` is the same
  // machine powered but not turning; `off` is it shut down: the shape stays
  // recognisable so the eye reads "agent here, not running" rather than
  // hunting for a different symbol.
  //
  // Each agent gets its OWN orbit, not a shared ring: two agents working in a
  // project should look different from one, and a glance at the radius count
  // should tell you how many. Adjacent orbits counter-rotate and the outer
  // ones run slower, so the cluster reads as several independent things rather
  // than one rigid pinwheel.
  const n = Math.max(0, Math.min(WB_MAX_ORBITS, live | 0));
  const NS = 'http://www.w3.org/2000/svg';
  const wrap = h('span', 'wb-core' + (variant ? ' is-' + variant : ''));
  wrap.setAttribute('data-n', String(n));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('aria-hidden', 'true');

  const circle = (cls, r) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '14');
    c.setAttribute('cy', '14');
    c.setAttribute('r', String(r));
    return c;
  };

  // Radii: one agent keeps the original single ring at 9; more than one spread
  // between 5.5 and 11 so every orbit is separately visible at 22px.
  const radii = [];
  if (n <= 1) radii.push(9);
  else for (let i = 0; i < n; i++) radii.push(5.5 + (i * (11 - 5.5)) / (n - 1));

  // With no agents there is nothing in orbit, but the figure still needs its
  // outline: that is what makes `open` and `off` read as the same machine.
  if (n === 0) svg.appendChild(circle('wb-core-ring', 9));
  else for (const r of radii) svg.appendChild(circle('wb-orbit', r));

  svg.appendChild(circle('wb-core-c', 3));

  radii.forEach((r, i) => {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'wb-orb' + (i % 2 ? ' is-rev' : ''));
    // Stagger the phase so satellites never bunch, and let the period grow
    // with the radius so the outer ones sweep more slowly.
    g.style.setProperty('--phase', ((i * (360 / n)) + i * 17) + 'deg');
    g.style.setProperty('--dur', (4 + r * 0.6).toFixed(1) + 's');
    const sat = document.createElementNS(NS, 'circle');
    sat.setAttribute('cx', '14');
    sat.setAttribute('cy', String(14 - r));
    sat.setAttribute('r', n > 4 ? '1.4' : '1.7');
    g.appendChild(sat);
    svg.appendChild(g);
  });

  wrap.appendChild(svg);
  return wrap;
}

// The live-agent strip's text, shared by wbDecorateCard's rebuild path and
// syncCards' in-place patch so the two can never drift apart.
function wbLiveLabel(a) {
  return a.currentAction || (a.live > 1 ? a.live + ' agents working here' : 'agent working here');
}
function wbLiveAria(a) {
  return (a.live === 1 ? '1 agent running' : a.live + ' agents running')
    + (a.currentAction ? ' - ' + a.currentAction : '');
}

function wbDecorateCard(card, p) {
  try {
    const head = card.querySelector('.card-head');
    if (head && !head.querySelector('.wb-open')) head.append(wbOpenControl(p.id));

    const a = p && p.agent;
    if (!a || a.state === 'none') return;

    const quiet = a.state !== 'working';
    const row = h('div', 'wb-live' + (quiet ? ' is-idle' : ''));
    // The figure appears ONLY for an agent that is working right now. A session
    // that merely exists (process alive, nothing being written) gets a line
    // of text and no symbol: the orbit is a claim about activity, and drawing
    // it for an idle session is the claim being wrong.
    if (a.state === 'working') row.append(wbCore(a.active));

    if (a.state === 'working') {
      // An explicit label plus monospace output is what separates this from the
      // commit-status line above it: that line is a state, this is a process.
      row.append(h('span', 'wb-tag', 'AGENT'));
      if (a.active > WB_MAX_ORBITS) row.append(h('span', 'wb-n', String(a.active)));
      const what = wbLiveLabel(a);
      const x = h('span', 'wb-what', what);
      x.title = what;
      row.append(x);
      row.setAttribute('aria-label', wbLiveAria(a));
    } else if (a.state === 'open') {
      // A session someone left sitting there. Say so plainly rather than
      // dressing an untouched prompt up as work in progress.
      const when = a.lastSessionRelative || relTime(a.lastSessionISO);
      const label = (a.live === 1 ? '1 session open' : a.live + ' sessions open')
        + (when ? ' · last active ' + when : '');
      const x = h('span', 'wb-what', label);
      x.title = 'A Claude Code process is running here, but nothing has been written to its transcript recently.';
      row.append(x);
    } else {
      const when = a.lastSessionRelative || relTime(a.lastSessionISO);
      // `parked` processes are alive but have written nothing for long enough
      // that calling them agents would be a lie. Name them anyway: otherwise
      // "agent ran 17 hours ago" next to seven running processes just looks
      // wrong, and the reader has no way to find out why.
      const parked = a.parked > 0
        ? ' · ' + a.parked + (a.parked === 1 ? ' idle session still open' : ' idle sessions still open')
        : '';
      const x = h('span', 'wb-what', 'agent ran ' + when + parked);
      x.title = a.parked > 0
        ? a.parked + ' Claude Code process(es) are still running here, but nothing has been '
          + 'written to their transcripts since ' + when + ': most likely editor tabs left open.'
        : 'Last Claude Code session ' + when;
      row.append(x);
    }

    const anchor = card.querySelector('.card-blurb') || card.querySelector('.card-spacer');
    if (anchor) card.insertBefore(row, anchor);
    else card.append(row);
  } catch { /* the dashboard must survive a Workbench failure */ }
}

/* ── detail header: the Open row ──────────────────────────────────────── */

function wbOpenRow(d) {
  const row = h('div', 'wb-openrow');
  try {
    row.append(wbOpenControl(d.id, { long: true }));
    const hint = h('span', 'wb-hint', 'opens this project locally');
    row.append(hint);
    wbProjectEditors(d.id).then((editors) => {
      const primary = wbPrimary(editors);
      hint.textContent = primary
        ? 'primary action uses ' + primary.name
        : 'no editor was found on this machine';
    });
  } catch { /* ignore */ }
  return row;
}

/* ── detail: the Agents panel ─────────────────────────────────────────── */

const WB_ORIGIN = { vscode: 'VS Code', desktop: 'desktop app', cli: 'terminal' };

/**
 * Stop control: click once to arm, once more to send. Deliberately not a
 * one-click action and deliberately not a modal: stopping a session is
 * destructive enough to want a second beat, and cheap enough not to warrant a
 * dialog. Arming lapses after four seconds so a stray click cannot sit primed.
 */
function wbStopControl(projectId, proc) {
  const b = h('button', 'wb-pstop', 'stop');
  b.type = 'button';
  b.title = 'Send SIGTERM to pid ' + proc.pid;
  let armed = false;
  let t = 0;

  const disarm = () => {
    armed = false;
    clearTimeout(t);
    b.textContent = 'stop';
    b.classList.remove('is-armed');
  };

  b.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!armed) {
      armed = true;
      b.textContent = 'confirm';
      b.classList.add('is-armed');
      clearTimeout(t);
      t = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(t);
    b.disabled = true;
    b.textContent = 'stopping…';
    b.classList.remove('is-armed');
    try {
      const res = await fetch('/api/agents/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: projectId, pid: proc.pid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        b.textContent = 'failed';
        b.title = data.error || ('HTTP ' + res.status);
        announce(data.error || 'Could not stop that session.');
        return;
      }
      b.textContent = 'stopped';
      b.title = data.note || 'SIGTERM sent.';
      announce('Sent stop to pid ' + proc.pid + '.');
    } catch (err) {
      b.textContent = 'failed';
      b.title = String((err && err.message) || err);
    }
  });

  return b;
}

function wbFmtUptime(ms) {
  if (!ms || !isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + hh + 'h';
  if (hh) return hh + 'h ' + mm + 'm';
  if (mm) return mm + 'm';
  return s + 's';
}

const WB_KIND_LABEL = { user: 'you', assistant: 'claude', tool: 'tool' };

function wbAgentsPanel(d) {
  const p = panel('Agents', 'i-pulse', '');
  p.classList.add('wb-agents');
  const body = p._body;
  body.classList.add('flush');
  body.style.padding = '0';
  body.append(wbLoadingRows());

  const token = state.detailToken;
  const cached = wb.detail.get(d.id);
  if (cached && Date.now() - cached.at < 4000) {
    wbPaintAgents(p, body, d, cached.data);
  } else {
    getJSON('/api/agents/' + encodeURIComponent(d.id))
      .then((data) => {
        if (token !== state.detailToken) return;
        wb.detail.set(d.id, { data, at: Date.now() });
        wbPaintAgents(p, body, d, data);
      })
      .catch(() => {
        if (token !== state.detailToken) return;
        clear(body);
        body.append(h('div', 'panel-note', 'Agent activity could not be read right now.'));
      });
  }
  return p;
}

function wbLoadingRows() {
  const box = h('div', 'wb-loading');
  box.append(h('i', null), h('i', null), h('i', null));
  return box;
}

function wbPaintAgents(p, body, d, data) {
  clear(body);

  const count = p.querySelector('.panel-h .n');
  const live = data.live || 0;
  if (count) count.textContent = live > 0 ? (live === 1 ? '1 running' : live + ' running') : '';
  p.classList.toggle('is-quiet', live === 0);

  const events = Array.isArray(data.recentEvents) ? data.recentEvents : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const procs = Array.isArray(data.processes) ? data.processes : [];

  /* Nothing has ever run here: say so plainly, do not draw an empty box. */
  if (!live && !sessions.length && !data.lastSessionISO) {
    body.append(h('div', 'panel-note', 'No coding agent has ever run in this project.'));
    return;
  }

  /* What is happening right now: said once, not repeated per process: the
   * current action comes from the newest session, not from a given PID. */
  if (live > 0) {
    const lead = h('div', 'wb-lead');
    // Same figure as the card, scaled up: one representation of a running
    // agent everywhere it appears, so the two views reinforce each other.
    lead.append(wbCore(data.active || live));
    const main = h('div', 'wb-lead-main');
    main.append(h('div', 'wb-lead-x',
      data.currentAction || (live === 1 ? 'an agent is working here' : live + ' agents are working here')));
    if (data.currentAction) main.append(h('div', 'wb-lead-s', 'latest activity in the newest session'));
    lead.append(main);
    body.append(lead);
  }

  /* The processes themselves. Ground Control now offers one action here: stopping a
   * session: with the guards described in CONTRACT-WORKBENCH.md §3. */
  if (procs.length) {
    const row = h('div', 'wb-procs');
    for (const proc of procs) {
      const tag = h('span', 'wb-ptag'
        + (proc.parked ? ' is-parked' : '')
        + (proc.isSelf ? ' is-self' : ''));
      tag.append(h('b', null, 'pid ' + proc.pid));
      const up = wbFmtUptime(proc.uptimeMs);
      if (up) tag.append(document.createTextNode(' · up ' + up));
      const origin = WB_ORIGIN[proc.origin];
      if (origin) tag.append(document.createTextNode(' · ' + origin));
      if (proc.cwdRelative && proc.cwdRelative !== '.') {
        tag.append(document.createTextNode(' · ' + proc.cwdRelative + '/'));
      }
      if (proc.startedISO) tag.title = 'started ' + fmtDate(proc.startedISO);

      if (proc.isSelf) {
        // Naming it is the point: an unexplained agent on your own project is
        // exactly the thing that reads as a bug.
        const me = h('span', 'wb-pself', 'this session');
        me.title = 'This is the Claude Code session Ground Control is running from. It cannot be stopped from here.';
        tag.append(me);
      } else {
        tag.append(wbStopControl(d.id, proc));
      }
      row.append(tag);
    }
    body.append(row);
    if (procs.some((q) => q.parked)) {
      const n = h('div', 'wb-pnote',
        'Sessions marked idle are still running but have written nothing recently: usually editor tabs left open. '
        + 'They are not counted as active agents.');
      body.append(n);
    }
  }

  /* summary tags */
  const stats = h('div', 'wb-agentstats');
  const tag = (label, value) => {
    const t = h('span', 'wb-tag');
    t.append(h('b', null, value), document.createTextNode(' ' + label));
    return t;
  };
  stats.append(tag(sessions.length === 1 || data.sessionCount === 1 ? 'session' : 'sessions',
    String(data.sessionCount || sessions.length || 0)));
  if (data.lastSessionISO) {
    const t = h('span', 'wb-tag');
    t.append(document.createTextNode('last run '), h('b', null, data.lastSessionRelative || relTime(data.lastSessionISO)));
    t.title = fmtDate(data.lastSessionISO);
    stats.append(t);
  }
  if (live > 0) stats.append(tag(live === 1 ? 'live process' : 'live processes', String(live)));
  body.append(stats);

  /* timeline */
  const tl = h('div', 'wb-tl');
  tl.append(h('div', 'wb-tl-h', 'Recent activity'));
  if (!events.length) {
    tl.append(h('div', 'wb-tl-note', 'The latest transcript has no readable events in its tail.'));
  } else {
    for (const e of events.slice().reverse()) {
      const row = h('div', 'wb-ev');
      row.dataset.kind = e.kind || 'assistant';
      row.append(h('span', 'wb-ev-k', WB_KIND_LABEL[e.kind] || e.kind || ''));
      row.append(h('span', 'wb-ev-x', e.label || ''));
      if (e.atISO) {
        const t = h('span', 'wb-ev-t', relTime(e.atISO));
        t.title = fmtDate(e.atISO);
        row.append(t);
      }
      tl.append(row);
    }
    tl.append(h('div', 'wb-tl-note',
      'Up to 25 events from the tail of the newest session, each trimmed to 120 characters. Ground Control never reads a transcript whole and never stores one.'));
  }
  body.append(tl);

  /* sessions */
  if (sessions.length) {
    const box = h('div', 'wb-sess');
    box.append(h('div', 'wb-tl-h', 'Sessions'));
    box.firstChild.style.padding = '9px 16px 8px';
    for (const s of sessions) {
      const row = h('div', 'wb-sess-row');
      row.append(h('span', 'wb-sid', String(s.id || '').slice(0, 8)));
      const when = s.endedISO ? relTime(s.endedISO) : '';
      const started = s.startedISO ? fmtDate(s.startedISO) : '';
      const w = h('span', 'wb-swhen', started ? started + ' · last touched ' + when : when);
      row.append(w);
      const meta = [];
      if (typeof s.messageCount === 'number') meta.push(fmtNum(s.messageCount) + ' msgs');
      if (typeof s.sizeBytes === 'number') meta.push(fmtBytes(s.sizeBytes));
      row.append(h('span', 'wb-smeta', meta.join(' · ')));
      box.append(row);
    }
    body.append(box);
  }
}

/* ── reader: open this document in an editor ──────────────────────────── */

function wbReaderOpen(id, docPath) {
  const b = h('button', 'wb-readopen');
  b.type = 'button';
  b.append(icon('i-launch'), h('span', null, 'open in editor'));
  b.title = 'Open ' + docPath + ' in your editor';
  b.disabled = true;
  wbProjectEditors(id).then((editors) => {
    const primary = wbPrimary(editors);
    if (!primary) { b.title = 'No editor was found on this machine'; return; }
    b.disabled = false;
    b.title = 'Open ' + docPath + ' in ' + primary.name;
    b.querySelector('span').textContent = 'open in ' + primary.name;
    b.addEventListener('click', () => wbOpenProject(id, primary.id, { file: docPath, line: 1 }));
  });
  return b;
}

/* ── agent sort + filter ──────────────────────────────────────────────── */

function wbAgentRank(p) {
  const a = p && p.agent;
  if (!a) return -Infinity;
  const last = a.lastSessionISO ? Date.parse(a.lastSessionISO) : 0;
  if (a.live > 0) return 4e15 + (a.live * 1e12) + last;
  if (a.state === 'idle') return 2e15 + last;
  if (last) return last;
  return -Infinity;
}

SORTERS.agent = (a, b) => (wbAgentRank(b) - wbAgentRank(a)) || byName(a, b);

function wbBuildChip() {
  const host = $('#wb-chips');
  if (!host) return;
  clear(host);
  const b = h('button', 'chip wb-chip');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(!!state.filters.agent));
  b.append(h('span', 'wb-dot'), h('span', null, 'Has agent'), h('span', 'chip-n', ''));
  b.title = 'Only projects with a Claude Code agent running right now';
  b.addEventListener('click', () => {
    state.filters.agent = !state.filters.agent;
    b.setAttribute('aria-pressed', String(state.filters.agent));
    syncFilterUrl();
    renderGrid();
  });
  host.append(b);
  wb.chip = b;
}

/** Keep the chip's count and pressed state honest after every grid pass. */
function wbSyncChip() {
  const b = wb.chip;
  if (!b) return;
  let n = 0;
  for (const id of state.order) {
    const p = state.byId.get(id);
    if (p && p.agent && p.agent.live > 0) n++;
  }
  b.querySelector('.chip-n').textContent = n ? String(n) : '';
  b.setAttribute('aria-pressed', String(!!state.filters.agent));
  b.disabled = n === 0 && !state.filters.agent;
}

/* ── quick switcher (Cmd+K) ───────────────────────────────────────────── */

/**
 * Subsequence match with a small score: consecutive runs and word-boundary
 * hits rank higher. Returns { score, hits } or null.
 */
function wbFuzzy(needle, hay) {
  if (!needle) return { score: 0, hits: [] };
  const n = needle.toLowerCase();
  const s = hay.toLowerCase();
  const hits = [];
  let i = 0, score = 0, run = 0;
  for (let j = 0; j < s.length && i < n.length; j++) {
    if (s[j] !== n[i]) { run = 0; continue; }
    hits.push(j);
    const boundary = j === 0 || /[^a-z0-9]/.test(s[j - 1]) || (hay[j] >= 'A' && hay[j] <= 'Z');
    score += 10 + run * 6 + (boundary ? 12 : 0);
    run++;
    i++;
  }
  if (i < n.length) return null;
  score -= s.length * 0.12;
  if (s.startsWith(n)) score += 40;
  return { score, hits };
}

function wbSwitcher() {
  if (wb.switcher) return wb.switcher;

  const dlg = h('dialog', 'wb-switch');
  dlg.setAttribute('aria-label', 'Jump to a project');
  const inner = h('div', 'wb-switch-in');

  const field = h('div', 'wb-switch-field');
  field.append(icon('i-search'));
  const input = h('input', null);
  input.type = 'text';
  input.placeholder = 'Jump to a project…';
  input.setAttribute('aria-label', 'Jump to a project');
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(input);
  inner.append(field);

  const list = h('ul', 'wb-switch-list');
  list.setAttribute('role', 'listbox');
  inner.append(list);

  const foot = h('div', 'wb-switch-foot');
  const hint = (k, t) => { const s = h('span', null); s.append(h('kbd', null, k), document.createTextNode(t)); return s; };
  foot.append(hint('↑↓', 'navigate'), hint('↵', 'open project'), hint('⌘↵', 'open in editor'), hint('esc', 'dismiss'));
  inner.append(foot);

  dlg.append(inner);
  document.body.append(dlg);

  let rows = [];
  let sel = 0;

  const render = () => {
    const q = input.value.trim();
    const scored = [];
    for (const id of state.order) {
      const p = state.byId.get(id);
      if (!p) continue;
      const m = wbFuzzy(q, p.name || p.id);
      const alt = m ? null : wbFuzzy(q, (p.stack || []).join(' ') + ' ' + (p.id || ''));
      if (!m && !alt) continue;
      let score = (m ? m.score : alt.score - 30);
      if (p.agent && p.agent.live > 0) score += 60;      // what you are mid-flow in
      else if (p.agent && p.agent.state === 'idle') score += 18;
      if (!q && p.lastActivityISO) score += 0;
      scored.push({ p, score, hits: m ? m.hits : [] });
    }
    if (!q) {
      scored.sort((a, b) => (wbAgentRank(b.p) - wbAgentRank(a.p))
        || ((Date.parse(b.p.lastActivityISO || 0) || 0) - (Date.parse(a.p.lastActivityISO || 0) || 0)));
    } else {
      scored.sort((a, b) => b.score - a.score || byName(a.p, b.p));
    }
    rows = scored.slice(0, 40);
    sel = 0;

    clear(list);
    if (!rows.length) {
      list.append(h('li', 'wb-switch-empty', 'No project matches “' + q + '”.'));
      return;
    }
    rows.forEach((r, i) => {
      const li = h('li', null);
      const b = h('button', 'wb-sw-item' + (i === 0 ? ' is-sel' : ''));
      b.type = 'button';
      b.setAttribute('role', 'option');
      const dot = h('span', 'dot');
      dot.dataset.status = r.p.status || 'dormant';
      b.append(dot);

      const main = h('div', 'wb-sw-main');
      main.append(wbHighlight(r.p.name || r.p.id, r.hits));
      const bits = [];
      if (r.p.primaryLanguage) bits.push(r.p.primaryLanguage);
      if (r.p.lastActivityRelative) bits.push(r.p.lastActivityRelative);
      if (r.p.statusReason) bits.push(r.p.statusReason);
      main.append(h('div', 'wb-sw-sub', bits.join(' · ')));
      b.append(main);

      if (r.p.agent && r.p.agent.live > 0) {
        const badge = h('span', 'wb-sw-agent');
        badge.append(h('span', 'wb-pip'), h('span', null, r.p.agent.live > 1 ? r.p.agent.live + ' agents' : 'agent'));
        b.append(badge);
      }

      b.addEventListener('click', (ev) => wbGo(r.p.id, ev.metaKey || ev.ctrlKey));
      b.addEventListener('mousemove', () => { sel = i; paintSel(); });
      li.append(b);
      list.append(li);
    });
  };

  const paintSel = () => {
    const btns = list.querySelectorAll('.wb-sw-item');
    btns.forEach((b, i) => b.classList.toggle('is-sel', i === sel));
    const cur = btns[sel];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  };

  const wbGo = (id, inEditor) => {
    close();
    if (inEditor) {
      wbProjectEditors(id).then((editors) => {
        const primary = wbPrimary(editors);
        if (primary) wbOpenProject(id, primary.id);
        else wbToast('No editor was found on this machine.', 'bad');
      });
      return;
    }
    location.hash = hrefProject(id).slice(1);
  };

  const close = () => { try { dlg.close(); } catch { /* already closed */ } };

  input.addEventListener('input', render);
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || (ev.key === 'n' && ev.ctrlKey)) {
      ev.preventDefault(); if (rows.length) { sel = (sel + 1) % rows.length; paintSel(); }
    } else if (ev.key === 'ArrowUp' || (ev.key === 'p' && ev.ctrlKey)) {
      ev.preventDefault(); if (rows.length) { sel = (sel - 1 + rows.length) % rows.length; paintSel(); }
    } else if (ev.key === 'Home') {
      ev.preventDefault(); sel = 0; paintSel();
    } else if (ev.key === 'End') {
      ev.preventDefault(); sel = Math.max(0, rows.length - 1); paintSel();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const r = rows[sel];
      if (r) wbGo(r.p.id, ev.metaKey || ev.ctrlKey);
    }
  });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) close(); });

  wb.switcher = {
    open() {
      render();
      if (!dlg.open) dlg.showModal();
      input.value = '';
      render();
      input.focus();
      input.select();
    },
    close,
    dlg,
  };
  return wb.switcher;
}

/** Build a highlighted project name without touching innerHTML. */
function wbHighlight(text, hits) {
  const box = h('div', 'wb-sw-name');
  if (!hits || !hits.length) { box.textContent = text; return box; }
  const set = new Set(hits);
  let buf = '';
  let marked = false;
  const flush = () => {
    if (!buf) return;
    if (marked) box.append(h('mark', null, buf));
    else box.append(document.createTextNode(buf));
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const isHit = set.has(i);
    if (isHit !== marked) { flush(); marked = isHit; }
    buf += text[i];
  }
  flush();
  return box;
}

/* ── boot ─────────────────────────────────────────────────────────────── */

function wbBoot() {
  if (wb.ready) return;
  wb.ready = true;
  try {
    wbBuildChip();
    wbLoadEditors();

    const jump = $('#wb-jump');
    if (jump) jump.addEventListener('click', () => wbSwitcher().open());

    document.addEventListener('keydown', (ev) => {
      if (ev.defaultPrevented) return;
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K')) {
        ev.preventDefault();
        const sw = wbSwitcher();
        if (sw.dlg.open) sw.close(); else sw.open();
      }
    });
  } catch { /* a broken Workbench must never take the dashboard with it */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wbBoot, { once: true });
} else {
  wbBoot();
}

/* ============================================================================
 * RECLAIM: flag and remove dead folders (CONTRACT-RECLAIM.md §6)
 *
 * Appended below Workbench. Nothing above was restructured: this section adds
 * its own `hashchange` listener for `#/reclaim` rather than editing the router,
 * and its own boot hook rather than editing `boot()`.
 *
 * This is the only part of Ground Control that can destroy anything, so the UI is
 * built to slow the user down rather than speed them up:
 *
 *   · No card, anywhere, ever gets a delete control. The only way in is the
 *     quiet "Review" line under the grid.
 *   · A project with any blocker is not offered the action at all: it sits in
 *     a separate group that explains what is protecting it.
 *   · Removal is modal, names the absolute path, requires the folder name
 *     typed exactly, focuses Cancel, and its confirm button says "Move to
 *     Trash": never "Delete", because nothing is deleted.
 *   · Nothing here is bound to a keyboard shortcut, and there is no
 *     multi-select and no "remove all".
 * ========================================================================= */

const RC_HASH = '#/reclaim';

const rc = {
  ready: false,
  data: null,          // { assessments, scannedAt, root }
  loading: false,
  error: null,
  open: false,         // is the reclaim view the current view?
  loadedAt: 0,
  removed: [],         // { name, trashedTo }: what this session moved
  dialog: null,
};

const RC_VERDICT = {
  dead: { label: 'Dead', note: 'nothing of value ever landed here' },
  dormant: { label: 'Dormant', note: 'small, and untouched for a long time' },
  keep: { label: 'Keep', note: 'there is enough here to hold on to' },
};

/* ── data ─────────────────────────────────────────────────────────────── */

async function rcLoad(force) {
  if (rc.loading) return;
  if (!force && rc.data && Date.now() - rc.loadedAt < 4000) return;
  rc.loading = true;
  rc.error = null;
  if (rc.open) rcRender();
  try {
    rc.data = await getJSON('/api/reclaim' + (force ? '?fresh=1' : ''));
    rc.loadedAt = Date.now();
  } catch (err) {
    rc.error = err.message || 'the assessment could not be loaded';
  } finally {
    rc.loading = false;
  }
  rcSyncSlot();
  if (rc.open) rcRender();
}

function rcList() {
  const a = rc.data && rc.data.assessments;
  if (!a) return [];
  return Object.values(a);
}

/** Removable, worst-first: highest score first, then least content. */
function rcCandidates() {
  return rcList()
    .filter((a) => !a.blockers.length && a.verdict !== 'keep')
    .sort((a, b) => (b.score - a.score) || (a.meaningfulFiles - b.meaningfulFiles)
      || a.projectName.localeCompare(b.projectName));
}

function rcBlocked() {
  return rcList()
    .filter((a) => a.blockers.length)
    .sort((a, b) => (a.blockers.length - b.blockers.length) || a.projectName.localeCompare(b.projectName));
}

function rcSafeButKept() {
  return rcList()
    .filter((a) => !a.blockers.length && a.verdict === 'keep')
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/* ── the quiet grid affordance ────────────────────────────────────────── */

function rcSyncSlot() {
  const slot = $('#rc-slot');
  if (!slot) return;
  clear(slot);
  const n = rcCandidates().length;
  if (!rc.data || !n) return;

  const line = h('a', 'rc-slot');
  line.href = RC_HASH;
  line.append(icon('i-hollow'));
  line.append(h('span', 'rc-slot-x',
    n === 1
      ? '1 folder looks reclaimable: nothing of value in it, and nothing has happened there in a long time.'
      : n + ' folders look reclaimable: nothing of value in them, and nothing has happened there in a long time.'));
  line.append(h('span', 'rc-slot-go', 'Review'));
  slot.append(line);
}

/* ── the reclaim view ─────────────────────────────────────────────────── */

function rcBox() { return $('#view-reclaim'); }

function rcRender() {
  const box = rcBox();
  if (!box) return;
  clear(box);

  /* header */
  const head = h('header', 'rc-head');
  const back = h('a', 'btn btn-ghost btn-sm rc-back');
  back.href = '#/';
  back.append(icon('i-back'), h('span', null, 'All projects'));
  head.append(back);

  const title = h('div', 'rc-title');
  title.append(h('h1', 'rc-h1', 'Reclaim'));
  title.append(h('p', 'rc-sub',
    'Folders that look finished with. Nothing here is ever deleted: anything you move goes to the macOS Trash, and you can drag it back out.'));
  head.append(title);

  const tools = h('div', 'rc-tools');
  const again = h('button', 'btn btn-sm', null);
  again.type = 'button';
  again.append(icon('i-refresh'), h('span', null, 'Re-check'));
  if (rc.loading) again.classList.add('is-busy');
  again.disabled = rc.loading;
  again.addEventListener('click', () => rcLoad(true));
  tools.append(again);
  head.append(tools);
  box.append(head);

  /* what this session already moved */
  for (const done of rc.removed) box.append(rcMovedBanner(done));

  if (rc.error) {
    const bad = h('div', 'rc-error');
    bad.append(icon('i-alert'));
    bad.append(h('span', null, rc.error));
    box.append(bad);
  }

  if (!rc.data) {
    box.append(h('p', 'rc-empty', rc.loading ? 'Measuring every folder…' : 'Nothing assessed yet.'));
    return;
  }

  const cands = rcCandidates();
  const blocked = rcBlocked();
  const kept = rcSafeButKept();

  /* --- candidates --------------------------------------------------- */
  box.append(rcGroupHead('i-hollow', 'Safe to remove', cands.length,
    'Worst first. Each one is a folder Ground Control found nothing worth keeping in.'));

  if (!cands.length) {
    const blank = h('div', 'rc-blank');
    blank.append(icon('i-check', 'rc-blank-i'));
    blank.append(h('p', 'rc-blank-h', 'Nothing here is safe to remove.'));
    blank.append(h('p', 'rc-blank-p', 'Every folder Ground Control is watching either holds real content, has git work that exists nowhere else, or has been touched recently.'));
    box.append(blank);
  } else {
    const list = h('ul', 'rc-list');
    for (const a of cands) list.append(rcRow(a, true));
    box.append(list);
  }

  /* --- blocked ------------------------------------------------------ */
  if (blocked.length) {
    box.append(rcGroupHead('i-shield', 'Not safe to remove', blocked.length,
      'These cannot be moved to the Trash, and Ground Control does not offer the option. This is what is protecting each one.'));
    const list = h('ul', 'rc-list rc-list-blocked');
    for (const a of blocked) list.append(rcRow(a, false));
    box.append(list);
  }

  /* --- kept --------------------------------------------------------- */
  if (kept.length) {
    box.append(rcGroupHead('i-folder', 'Alive', kept.length,
      'No blocker stands in the way, but there is enough real content here that Ground Control will not call these dead.'));
    const list = h('ul', 'rc-list rc-list-quiet');
    for (const a of kept) list.append(rcRow(a, false));
    box.append(list);
  }

  const foot = h('p', 'rc-foot',
    'Assessed ' + (rc.data.scannedAt ? relTime(rc.data.scannedAt) : 'just now')
    + '. File counts ignore node_modules, virtualenvs, build output and caches: a folder full of dependencies still counts as empty.');
  box.append(foot);
}

function rcGroupHead(iconName, label, count, note) {
  const wrap = h('div', 'rc-group');
  const row = h('div', 'rc-group-row');
  row.append(icon(iconName, 'rc-group-i'));
  row.append(h('h2', 'rc-group-h', label));
  row.append(h('span', 'rc-count num', String(count)));
  wrap.append(row);
  if (note) wrap.append(h('p', 'rc-group-note', note));
  return wrap;
}

function rcMovedBanner(done) {
  const box = h('div', 'rc-moved');
  box.append(icon('i-check'));
  const t = h('div', 'rc-moved-x');
  t.append(h('div', 'rc-moved-h', done.name + ' was moved to the Trash.'));
  t.append(h('div', 'rc-moved-p mono', done.trashedTo));
  t.append(h('div', 'rc-moved-n', 'Nothing was deleted. Open the Trash and drag it back out to restore it.'));
  box.append(t);
  return box;
}

/* One row. `offerAction` is false for every blocked project: the button is
 * not rendered disabled, it is not rendered at all. */
function rcRow(a, offerAction) {
  const li = h('li', 'rc-row' + (a.blockers.length ? ' is-blocked' : ''));

  const head = h('div', 'rc-row-head');
  const name = h('a', 'rc-name');
  name.href = hrefProject(a.projectId);
  name.textContent = a.projectName;
  head.append(name);

  const v = RC_VERDICT[a.verdict] || RC_VERDICT.keep;
  head.append(h('span', 'rc-verdict rc-v-' + a.verdict, v.label));

  if (offerAction) {
    const go = h('button', 'btn btn-sm rc-go', null);
    go.type = 'button';
    go.append(icon('i-trash'), h('span', null, 'Review removal…'));
    go.addEventListener('click', () => rcOpenDialog(a));
    head.append(go);
  }
  li.append(head);

  li.append(h('div', 'rc-path mono', a.path));

  /* the numbers that matter */
  const facts = h('div', 'rc-facts');
  facts.append(rcFact(a.meaningfulFiles === 1 ? '1 real file' : a.meaningfulFiles + ' real files',
    'Files that are not dependencies, build output, lockfiles, git config or empty'));
  facts.append(rcFact(fmtBytes(a.meaningfulBytes), 'Size of that real content'));
  if (a.onDiskFiles > a.meaningfulFiles) {
    facts.append(rcFact(fmtNum(a.onDiskFiles) + ' on disk', 'Every file the scanner saw, before the trivial ones were discounted'));
  }
  facts.append(rcFact(
    a.ageDays === null
      ? (a.folderAgeDays === null ? 'age unknown' : 'never used · folder ' + a.folderAgeDays + 'd old')
      : a.lastActivityRelative || (a.ageDays + ' days'),
    a.ageDays === null ? 'No work was ever recorded in this folder' : 'Last time anything in here changed'));
  li.append(facts);

  /* the specific, human reasons */
  const reasons = h('ul', 'rc-reasons');
  for (const r of a.reasons) reasons.append(h('li', null, r));
  li.append(reasons);

  /* git, in plain words */
  li.append(h('p', 'rc-git', rcGitSentence(a.gitState)));

  /* blockers, stated as what is protecting the folder */
  if (a.blockers.length) {
    const bl = h('div', 'rc-blockers');
    bl.append(h('div', 'rc-blockers-h',
      a.blockers.length === 1 ? 'What is protecting it' : 'What is protecting it (' + a.blockers.length + ')'));
    const ul = h('ul', 'rc-blocker-list');
    for (const b of a.blockers) {
      const row = h('li', 'rc-blocker');
      row.append(icon('i-lock', 'rc-blocker-i'));
      const x = h('div', null);
      x.append(h('span', 'rc-blocker-l', b.label));
      x.append(h('span', 'rc-blocker-d', b.detail));
      row.append(x);
      ul.append(row);
    }
    bl.append(ul);
    li.append(bl);
  }

  return li;
}

function rcFact(value, title) {
  const s = h('span', 'rc-fact', value);
  if (title) s.title = title;
  return s;
}

/** The git state as a sentence a person would say out loud. */
function rcGitSentence(g) {
  if (!g) return 'Git state unknown.';
  if (!g.hasGit) return 'Not a git repository: there is no history here to lose.';
  if (!g.readable) return 'This folder has a .git directory that git would not describe.';
  if (g.commitCount === 0) return 'A git repository was initialised, but nothing was ever committed.';

  const bits = [];
  bits.push(g.commitCount === 1 ? '1 commit' : g.commitCount + ' commits');
  bits.push(g.dirtyCount === 0
    ? 'a clean working tree'
    : (g.dirtyCount === 1 ? '1 uncommitted change' : g.dirtyCount + ' uncommitted changes'));
  if (!g.hasRemote) bits.push('no remote at all');
  else if (g.unpushedCommits === 0) bits.push('everything pushed to ' + (g.remote ? rcShortRemote(g.remote) : 'the remote'));
  else bits.push((g.unpushedCommits === 1 ? '1 commit' : g.unpushedCommits + ' commits') + ' that exist on no remote');
  if (g.stashCount) bits.push(g.stashCount === 1 ? '1 stash' : g.stashCount + ' stashes');
  if (g.branchesNotMerged) {
    bits.push((g.branchesNotMerged === 1 ? '1 branch' : g.branchesNotMerged + ' branches')
      + ' not merged into ' + (g.defaultBranch || 'the default branch'));
  }
  return 'Git: ' + bits.join(', ') + '.';
}

function rcShortRemote(url) {
  const m = String(url).match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : String(url);
}

/* ============================================================================
 * The removal dialog
 *
 * Reached only from a candidate row, only for one project, and only after the
 * user types the folder name exactly. Cancel holds the focus; the confirm
 * button is a destructive-styled "Move to Trash" and is disabled until the
 * typed name matches character for character.
 * ========================================================================= */

function rcOpenDialog(a) {
  // Never stack dialogs.
  for (const stale of document.querySelectorAll('.rc-dialog')) stale.remove();

  const dlg = h('dialog', 'rc-dialog');
  dlg.setAttribute('aria-label', 'Move ' + a.projectName + ' to the Trash');
  const form = h('div', 'rc-d-in');
  dlg.append(form);

  let stage = 'confirm';        // confirm | working | done | refused | override
  let typed = '';
  // Set once the user has explicitly acknowledged the soft blockers.
  let forcing = false;
  let error = null;
  let refused = null;           // { message, blockers }
  let moved = null;             // { trashedTo }

  const close = () => {
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
    rc.dialog = null;
  };

  function paint() {
    clear(form);

    if (stage === 'done') return paintDone();
    if (stage === 'refused') return paintRefused();
    if (stage === 'override') return paintOverride();

    form.append(h('h2', 'rc-d-h', 'Move this folder to the Trash?'));

    form.append(h('div', 'rc-d-label', 'Folder'));
    form.append(h('div', 'rc-d-path mono', a.path));

    /* exactly what goes */
    form.append(h('div', 'rc-d-label', 'What is in it'));
    const what = h('ul', 'rc-d-what');
    what.append(h('li', null, a.meaningfulFiles === 0
      ? 'No real files at all.'
      : (a.meaningfulFiles === 1 ? '1 real file' : a.meaningfulFiles + ' real files')
        + ' totalling ' + fmtBytes(a.meaningfulBytes) + '.'));
    if (a.onDiskFiles > a.meaningfulFiles) {
      what.append(h('li', null, fmtNum(a.onDiskFiles) + ' files on disk in total: the rest are lockfiles, git config or empty files.'));
    }
    if (a.ignoredDirs && a.ignoredDirs.length) {
      what.append(h('li', null, 'Plus dependency and build folders that were not counted: ' + a.ignoredDirs.join(', ') + '. They go too.'));
    }
    what.append(h('li', null, a.ageDays === null
      ? 'No work was ever recorded in this folder.'
      : 'Nothing in it has changed since ' + (a.lastActivityRelative || a.ageDays + ' days ago') + '.'));
    form.append(what);

    form.append(h('div', 'rc-d-label', 'Git'));
    form.append(h('p', 'rc-d-git', rcGitSentence(a.gitState)));

    const safe = h('div', 'rc-d-safe');
    safe.append(icon('i-shield'));
    safe.append(h('span', null, 'This moves the folder to the macOS Trash. Nothing is deleted: you can open the Trash and drag it back out.'));
    form.append(safe);

    /* the typed confirmation */
    const field = h('label', 'rc-d-field');
    field.setAttribute('for', 'rc-d-name');
    field.append(h('span', 'rc-d-l', 'Type the folder name to confirm'));
    const input = h('input', null);
    input.id = 'rc-d-name';
    input.type = 'text';
    input.value = typed;
    input.placeholder = a.projectName;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.disabled = stage !== 'confirm';
    field.append(input);
    form.append(field);
    form.append(h('p', 'rc-d-hint', 'It must match exactly: ' + a.projectName));

    const errNode = h('div', 'rc-d-err', error || '');
    form.append(errNode);

    const foot = h('div', 'rc-d-foot');
    // Cancel is FIRST in the DOM and holds the focus. The destructive control
    // is never the default.
    const cancel = h('button', 'btn rc-d-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.autofocus = true;
    cancel.addEventListener('click', close);
    foot.append(cancel);

    const go = h('button', 'btn btn-danger rc-d-go', null);
    go.type = 'button';
    go.append(icon('i-trash'), h('span', null, 'Move to Trash'));
    go.disabled = stage !== 'confirm' || typed !== a.projectName;
    go.addEventListener('click', submit);
    foot.append(go);
    form.append(foot);

    if (stage === 'working') { go.classList.add('is-busy'); cancel.disabled = true; }

    input.addEventListener('input', () => {
      typed = input.value;
      const ok = typed === a.projectName;
      go.disabled = !ok;
      errNode.textContent = '';
      error = null;
      input.classList.toggle('is-ok', ok);
    });
    // Enter in the name field must never be a shortcut to removal.
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.preventDefault(); });

    setTimeout(() => { if (stage === 'confirm') cancel.focus(); }, 0);
  }

  function paintDone() {
    form.append(h('h2', 'rc-d-h', a.projectName + ' is in the Trash'));
    const ok = h('div', 'rc-d-ok');
    ok.append(icon('i-check'));
    const x = h('div', null);
    x.append(h('div', 'rc-d-ok-h', 'Moved, not deleted.'));
    x.append(h('div', 'rc-d-ok-p mono', moved.trashedTo));
    x.append(h('div', 'rc-d-ok-n', 'Open the Trash in Finder and drag it back out to restore it exactly as it was. Ground Control never empties the Trash.'));
    ok.append(x);
    form.append(ok);

    const foot = h('div', 'rc-d-foot');
    const done = h('button', 'btn btn-primary', 'Done');
    done.type = 'button';
    done.addEventListener('click', close);
    foot.append(done);
    form.append(foot);
    setTimeout(() => done.focus(), 0);
  }

  /**
   * The folder is fine to remove structurally, but Ground Control judged the work
   * worth keeping. That judgement belongs to whoever owns the folder, so this
   * stage states the reasons plainly and requires the name typed a second
   * time. It is not a checkbox: retyping is the friction.
   */
  function paintOverride() {
    form.append(h('h2', 'rc-d-h', 'Override and move ' + a.projectName + ' to the Trash?'));

    const warn = h('div', 'rc-d-warn');
    warn.append(icon('i-alert'));
    const x = h('div', null);
    x.append(h('div', 'rc-d-warn-h', 'This folder was not flagged for reclamation.'));
    x.append(h('div', 'rc-d-warn-p',
      'Ground Control found reasons to keep it, listed below. Overriding moves the folder to the '
      + 'macOS Trash: it is not deleted, and you can drag it back out. Every reason you '
      + 'override is recorded in the reclaim log.'));
    warn.append(x);
    form.append(warn);

    if (refused.blockers && refused.blockers.length) {
      const ul = h('ul', 'rc-blocker-list');
      for (const b of refused.blockers) {
        const row = h('li', 'rc-blocker');
        row.append(icon('i-alert', 'rc-blocker-i'));
        const t = h('div', null);
        t.append(h('span', 'rc-blocker-l', b.label));
        t.append(h('span', 'rc-blocker-d', b.detail));
        row.append(t);
        ul.append(row);
      }
      form.append(ul);
    }

    const field = h('label', 'rc-d-field');
    field.setAttribute('for', 'rc-override-name');
    field.append(h('span', 'rc-d-label', 'Type the folder name again to override'));
    const input = h('input', 'rc-d-input');
    input.id = 'rc-override-name';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.value = '';
    field.append(input);
    form.append(field);
    form.append(h('p', 'rc-d-hint', 'It must match exactly: ' + a.projectName));

    const errNode = h('div', 'rc-d-err', error || '');
    form.append(errNode);

    const foot = h('div', 'rc-d-foot');
    const cancel = h('button', 'btn rc-d-cancel', 'Keep it');
    cancel.type = 'button';
    cancel.autofocus = true;
    cancel.addEventListener('click', close);
    foot.append(cancel);

    const go = h('button', 'btn btn-danger rc-d-go', null);
    go.type = 'button';
    go.append(icon('i-trash'), h('span', null, 'Override and move to Trash'));
    go.disabled = true;
    go.addEventListener('click', () => { forcing = true; submit(); });
    foot.append(go);
    form.append(foot);

    input.addEventListener('input', () => {
      typed = input.value;
      const ok = typed === a.projectName;
      go.disabled = !ok;
      errNode.textContent = '';
      error = null;
      input.classList.toggle('is-ok', ok);
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.preventDefault(); });

    setTimeout(() => cancel.focus(), 0);
  }

  function paintRefused() {
    form.append(h('h2', 'rc-d-h', 'Ground Control refused to move ' + a.projectName));
    const warn = h('div', 'rc-d-warn');
    warn.append(icon('i-lock'));
    const x = h('div', null);
    x.append(h('div', 'rc-d-warn-h', refused.message
      || 'Something changed since this list was built, and the folder is now protected.'));
    x.append(h('div', 'rc-d-warn-p', 'The folder was left exactly where it is.'));
    warn.append(x);
    form.append(warn);

    if (refused.blockers && refused.blockers.length) {
      const ul = h('ul', 'rc-blocker-list');
      for (const b of refused.blockers) {
        const row = h('li', 'rc-blocker');
        row.append(icon('i-lock', 'rc-blocker-i'));
        const t = h('div', null);
        t.append(h('span', 'rc-blocker-l', b.label));
        t.append(h('span', 'rc-blocker-d', b.detail));
        row.append(t);
        ul.append(row);
      }
      form.append(ul);
    }

    const foot = h('div', 'rc-d-foot');
    const close2 = h('button', 'btn', 'Close');
    close2.type = 'button';
    close2.addEventListener('click', close);
    foot.append(close2);
    form.append(foot);
    setTimeout(() => close2.focus(), 0);
  }

  async function submit() {
    if (typed !== a.projectName) return;
    stage = 'working';
    error = null;
    paint();

    let res, body;
    try {
      res = await fetch('/api/reclaim/' + encodeURIComponent(a.projectId) + '/trash', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(forcing ? { confirmName: typed, force: true } : { confirmName: typed }),
      });
      try { body = await res.json(); } catch { body = null; }
    } catch (err) {
      stage = 'confirm';
      error = 'Could not reach the Ground Control server (' + err.message + '). Nothing was moved.';
      paint();
      return;
    }

    if (res.ok && body && body.ok) {
      moved = { trashedTo: body.trashedTo };
      rc.removed.unshift({ name: a.projectName, trashedTo: body.trashedTo });
      stage = 'done';
      paint();
      announce(a.projectName + ' was moved to the Trash at ' + body.trashedTo + '. It can be restored from the Trash.');
      rcAfterRemoval();
      return;
    }

    if (res.status === 409) {
      // Soft blockers are judgement calls about whether the work matters, and
      // they are the owner's to overrule. Hard ones (Ground Control itself, a path
      // outside the root, a folder owned by another repo) are not overridable
      // and still dead-end here.
      if (body && body.overridable) {
        refused = {
          message: (body && body.error) || 'this folder has blockers',
          blockers: (body && body.softBlockers) || (body && body.blockers) || [],
          overridable: true,
        };
        stage = 'override';
        typed = '';
        paint();
        return;
      }
      refused = {
        message: (body && body.error) || 'this folder is protected',
        blockers: (body && body.blockers) || [],
        overridable: false,
      };
      stage = 'refused';
      paint();
      rcLoad(true);
      return;
    }

    stage = 'confirm';
    error = (body && body.error)
      ? body.error + ' Nothing was moved.'
      : 'The server refused the request (HTTP ' + res.status + '). Nothing was moved.';
    paint();
  }

  // Escape closes the dialog without ever reaching the app's global handler.
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      if (stage === 'working') ev.preventDefault();
    }
  });
  dlg.addEventListener('cancel', (ev) => { if (stage === 'working') ev.preventDefault(); });
  dlg.addEventListener('close', () => { dlg.remove(); rc.dialog = null; });

  paint();
  document.body.append(dlg);
  rc.dialog = dlg;
  dlg.showModal();
}

/** A folder left the dashboard: every other view has to agree. */
function rcAfterRemoval() {
  state.detailCache.clear();
  state.docCache.clear();
  loadProjects(true).catch(() => {});
  rcLoad(true);
}

/* ── routing ──────────────────────────────────────────────────────────── */

/**
 * `#/reclaim` is handled here rather than in `readRoute()`, so the original
 * router is left untouched. This listener runs after the app's own, which has
 * already shown the grid for an unrecognised hash: this hides it again.
 */
function rcOnHash() {
  const want = location.hash.replace(/\?.*$/, '') === RC_HASH;
  const box = rcBox();
  if (!box) return;

  if (!want) {
    if (rc.open) {
      rc.open = false;
      box.hidden = true;
      if (rc.dialog) { try { rc.dialog.close(); } catch { /* ignore */ } }
      /* Hand the page back to the real router.
       *
       * `#/reclaim` is an unrecognised hash as far as `readRoute()` is
       * concerned, so it reads as the grid route, which means leaving reclaim
       * for `#/` looks to `onLocationChange()` like the route did not change,
       * and it returns early without unhiding anything. Since this section was
       * the one that hid those views, it is this section's job to restore them,
       * from the route the router actually settled on. */
      syncUpNav(state.route);
      el.viewGrid.hidden = state.route.view !== 'grid';
      el.viewDetail.hidden = state.route.view !== 'detail';
      el.viewReader.hidden = state.route.view !== 'reader';
    }
    rcSyncSlot();
    return;
  }

  rc.open = true;
  el.viewGrid.hidden = true;
  el.viewDetail.hidden = true;
  el.viewReader.hidden = true;
  box.hidden = false;
  document.title = 'Reclaim · Ground Control';
  rcRender();
  rcLoad(false);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ── boot ─────────────────────────────────────────────────────────────── */

function rcBoot() {
  if (rc.ready) return;
  rc.ready = true;
  try {
    window.addEventListener('hashchange', rcOnHash);
    window.addEventListener('popstate', rcOnHash);
    rcOnHash();
    // The grid affordance needs the assessment; fetch it quietly once the
    // dashboard itself has settled.
    setTimeout(() => rcLoad(false), 400);
  } catch { /* a broken Reclaim must never take the dashboard with it */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', rcBoot, { once: true });
} else {
  rcBoot();
}

/* ============================================================================
 * SOURCES: watch any folder, anywhere (CONTRACT-SOURCES.md §5)
 *
 * Appended below Reclaim. Nothing above was restructured; the existing render
 * functions gained one call line each, marked `Sources §5`, and the filter
 * helpers gained one line each for the folder filter.
 *
 * Three rules shape everything here:
 *   §0: removing a folder from the dashboard never touches the folder. The
 *        wording says so every time, because "remove" reads as "delete" and
 *        the two must never be confused. Deleting is Reclaim's job, behind a
 *        typed-name confirmation.
 *   §1: a folder is described before it is added. The dialog says what
 *        Ground Control found and how it will read it, so nothing is a surprise.
 *   §5: with one folder watched, this feature is nearly invisible: a quiet
 *        label in the header where the root path used to be.
 * ========================================================================= */

const src = {
  list: [],                 // SourceInfo[] straight from the server
  meta: null,               // the last /api/sources payload
  panel: null,              // the open header panel, or null
  dialog: null,             // the open add-a-folder dialog, or null
  dragDepth: 0,             // dragenter/dragleave pairs, which nest
};

const srcCount = () => src.list.length;
const srcMulti = () => src.list.length > 1;
const srcById = (id) => src.list.find((s) => s.id === id) || null;

/* ── the payload keeps the list current ──────────────────────────────── */

/**
 * Every `/api/projects` response carries the source list, so the header stays
 * right without a second request: including when another window adds a folder
 * and this one hears about it over SSE.
 */
function srcApplyPayload(payload) {
  if (!payload || !Array.isArray(payload.sources)) return;
  const before = src.list.map((s) => s.id + ':' + s.path + ':' + s.kind + ':' + s.exists).join('|');
  src.list = payload.sources;
  const after = src.list.map((s) => s.id + ':' + s.path + ':' + s.kind + ':' + s.exists).join('|');
  // A folder added or removed in another window arrives over SSE; an open
  // panel must not keep showing the list as it was.
  if (before !== after && src.panel) src.panel.repaint();
}

async function srcLoad() {
  try {
    const data = await getJSON('/api/sources');
    src.meta = data;
    src.list = Array.isArray(data.sources) ? data.sources : [];
    srcRenderHeader();
    srcRenderOptions();
    return data;
  } catch {
    return null;                          // the header simply keeps what it had
  }
}

/* ── header ──────────────────────────────────────────────────────────── */

function srcShortPath(p) {
  if (!p) return '';
  const home = (src.meta && src.meta.homeDir) || '';
  return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

function srcRenderHeader() {
  if (!el.srcBtn) return;
  const list = src.list;
  const label = el.srcBtnLabel;

  if (!list.length) {
    label.textContent = 'no folders';
    el.srcBtn.title = 'Ground Control is not watching any folder yet: click to add one';
  } else {
    const primary = list.find((s) => s.primary) || list[0];
    label.textContent = srcShortPath(primary.path);
    el.srcBtn.title = list.length === 1
      ? 'Watching ' + primary.path
      : 'Watching ' + list.length + ' folders: click to manage them';
  }

  // The count badge only exists when there is more than one folder to count.
  const old = el.srcBtn.querySelector('.src-btn-n');
  if (old) old.remove();
  if (list.length > 1) {
    const n = h('span', 'src-btn-n', '+' + (list.length - 1));
    el.srcBtn.insertBefore(n, el.srcBtn.querySelector('.src-btn-c'));
  }

  const missing = list.filter((s) => !s.exists).length;
  el.srcBtn.classList.toggle('is-bad', missing > 0);
}

/** The footer's "scanned … · <where>" tail. */
function srcFootLabel() {
  const list = src.list;
  if (!list.length) return 'no folders watched';
  if (list.length === 1) return list[0].path;
  const primary = list.find((s) => s.primary) || list[0];
  return primary.path + ' +' + (list.length - 1) + ' more';
}

/* ── the folder filter ───────────────────────────────────────────────── */

function srcRenderOptions() {
  if (!el.fSource) return;
  el.fSourceWrap.hidden = !srcMulti();

  // Count what each folder actually contributes, so the option is informative.
  const counts = new Map();
  for (const id of state.order) {
    const p = state.byId.get(id);
    if (!p || !p.sourceId) continue;
    counts.set(p.sourceId, (counts.get(p.sourceId) || 0) + 1);
  }

  const sig = src.list.map((s) => s.id + ':' + s.display + ':' + (counts.get(s.id) || 0)).join(' ');
  if (el.fSource.dataset.sig !== sig) {
    el.fSource.dataset.sig = sig;
    clear(el.fSource);
    el.fSource.append(new Option('All folders', ''));
    for (const s of src.list) {
      el.fSource.append(new Option(s.display + ' (' + (counts.get(s.id) || 0) + ')', s.id));
    }
  }

  // A filter pointing at a folder that is no longer watched must not stick.
  if (state.filters.source && !srcById(state.filters.source)) {
    state.filters.source = '';
    syncFilterUrl();
  }
  el.fSource.value = state.filters.source || '';
}

/* ── card provenance ─────────────────────────────────────────────────── */

/**
 * Which folder this project came from. Drawn only when more than one folder is
 * watched: with a single source it would say the same thing on every card.
 */
function srcCardChip(card, p) {
  if (!srcMulti() || !p.sourceId) return;
  const s = srcById(p.sourceId);
  const chip = h('div', 'card-src');
  chip.append(icon(p.sourceKind === 'project' ? 'i-box' : 'i-folder'));
  chip.append(h('span', null, s ? s.display : (p.sourceLabel || '')));
  chip.title = p.sourceKind === 'project'
    ? 'Added on its own from ' + (p.sourcePath || '')
    : 'In ' + (p.sourcePath || '');
  card.append(chip);
}

/* ── the header panel ────────────────────────────────────────────────── */

function srcClosePanel() {
  if (src.panel) { src.panel.close(); src.panel = null; }
}

function srcTogglePanel() {
  if (src.panel) { srcClosePanel(); return; }

  const panel = h('div', 'src-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Folders Ground Control is watching');

  const paint = () => {
    clear(panel);

    const head = h('div', 'src-panel-h');
    head.append(h('span', null, 'Watching'));
    head.append(h('span', 'src-panel-hn',
      src.list.length === 1 ? '1 folder' : src.list.length + ' folders'));
    panel.append(head);

    if (src.meta && src.meta.configError) {
      panel.append(h('div', 'src-panel-err', src.meta.configError));
    }

    if (!src.list.length) {
      panel.append(h('div', 'src-panel-note',
        'Nothing is being watched. Add a folder full of projects, or a single project from anywhere on disk.'));
    }

    for (const s of src.list) panel.append(srcPanelItem(s, paint));

    const foot = h('div', 'src-panel-foot');
    const add = h('button', 'btn btn-primary');
    add.type = 'button';
    add.append(icon('i-folder-plus'), h('span', null, 'Add a folder'));
    add.addEventListener('click', () => { srcClosePanel(); srcOpenDialog(); });
    foot.append(add);
    panel.append(foot);

    panel.append(h('div', 'src-panel-note',
      'Removing a folder takes it off this dashboard. Nothing on disk is moved, renamed or deleted.'));
  };

  paint();
  document.body.append(panel);

  const r = el.srcBtn.getBoundingClientRect();
  const w = panel.offsetWidth || 430;
  panel.style.top = Math.min(r.bottom + 8, window.innerHeight - 40) + 'px';
  panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';

  el.srcBtn.setAttribute('aria-expanded', 'true');

  const onDown = (ev) => {
    if (panel.contains(ev.target) || el.srcBtn.contains(ev.target)) return;
    srcClosePanel();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); srcClosePanel(); el.srcBtn.focus(); }
  };
  const onMove = () => srcClosePanel();

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);

  src.panel = {
    repaint: paint,
    close() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      el.srcBtn.setAttribute('aria-expanded', 'false');
      panel.remove();
    },
  };
}

function srcPanelItem(s, repaint) {
  const row = h('div', 'src-item');
  row.classList.toggle('is-root', s.kind === 'root');
  row.classList.toggle('is-missing', !s.exists);

  row.append(icon(!s.exists ? 'i-alert' : s.kind === 'project' ? 'i-box' : 'i-folder', 'icon src-item-i'));

  const body = h('div', 'src-item-b');
  const name = h('div', 'src-item-n');
  name.append(h('span', null, s.display));
  name.append(h('span', 'src-item-k', s.kind === 'project' ? 'project' : 'folder'));
  body.append(name);

  const p = h('div', 'src-item-p', srcShortPath(s.path));
  p.title = s.path;
  body.append(p);

  const meta = h('div', 'src-item-m');
  if (!s.exists) {
    meta.classList.add('is-bad');
    meta.textContent = 'This folder is not there any more.';
  } else if (!s.readable) {
    meta.classList.add('is-bad');
    meta.textContent = 'Ground Control cannot read this folder.';
  } else if (s.kind === 'project') {
    meta.textContent = 'One project';
  } else {
    const n = s.projectCount;
    meta.textContent = n === null ? '' : n === 1 ? '1 project' : n + ' projects';
  }
  // A folder named on the command line is here for this run only. Saying so
  // beats the user wondering why it vanished on the next launch.
  if (s.ephemeral) {
    meta.textContent += (meta.textContent ? ' · ' : '') + 'this run only (--root)';
  }
  body.append(meta);
  row.append(body);

  const x = h('button', 'src-item-x');
  x.type = 'button';
  x.append(icon('i-x'));
  x.title = 'Stop watching ' + s.path + ' (the folder itself is left alone)';
  x.setAttribute('aria-label', x.title);
  x.addEventListener('click', async () => {
    x.disabled = true;
    try {
      const data = await getJSON('/api/sources/' + encodeURIComponent(s.id), { method: 'DELETE' });
      src.meta = data;
      src.list = data.sources || [];
      announce(s.display + ' is no longer being watched. The folder itself was not touched.');
      srcRenderHeader();
      srcRenderOptions();
      repaint();
      loadProjects(true);
    } catch (err) {
      x.disabled = false;
      wbToast('Could not remove that folder: ' + err.message, 'bad');
    }
  });
  row.append(x);
  return row;
}

/* ── add a folder ────────────────────────────────────────────────────── */

const SRC_KINDS = [
  { id: 'root', icon: 'i-folder', name: 'A folder of projects',
    desc: 'Every folder inside it becomes its own card.' },
  { id: 'project', icon: 'i-box', name: 'One project',
    desc: 'The folder itself becomes a single card.' },
];

/**
 * The one place a folder is added.
 *
 * `opts.path`  pre-fill the box (a drop that carried a real path)
 * `opts.hits`  candidate paths to choose between (a drop that did not)
 * `opts.name`  what was dropped, for the wording of the candidate list
 */
function srcOpenDialog(opts = {}) {
  for (const stale of document.querySelectorAll('.src-dialog')) stale.remove();
  srcClosePanel();

  const dlg = h('dialog', 'src-dialog');
  dlg.setAttribute('aria-label', 'Add a folder to Ground Control');
  const form = h('div', 'src-d-in');
  dlg.append(form);

  let typed = opts.path || '';
  let kind = null;                 // null = take the server's own reading
  let peek = null;                 // the last inspect result
  let peekFor = '';                // the path that result describes
  let error = null;
  let busy = false;
  let hits = opts.hits || null;    // candidate list from a nameless drop
  let searching = Boolean(opts.searching);
  let browsing = null;             // the browse listing, when open
  let peekSeq = 0;
  let peekTimer = 0;

  const close = () => {
    clearTimeout(peekTimer);
    peekSeq++;
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
    if (src.dialog && src.dialog.el === dlg) src.dialog = null;
  };

  /* -- the live description of whatever is in the box ----------------- */
  const runPeek = () => {
    const target = typed.trim();
    if (!target) { peek = null; peekFor = ''; paint(); return; }
    if (peekFor === target) return;
    const seq = ++peekSeq;
    getJSON('/api/sources/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ path: target, kind: kind || undefined }),
    }).then((info) => {
      if (seq !== peekSeq) return;             // a later keystroke won
      peek = info;
      peekFor = target;
      paint();
    }).catch((err) => {
      if (seq !== peekSeq) return;
      peek = { ok: false, error: err.message };
      peekFor = target;
      paint();
    });
  };

  const schedulePeek = () => {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(runPeek, 220);
  };

  /* -- submit --------------------------------------------------------- */
  const submit = async () => {
    const target = typed.trim();
    if (!target || busy) return;
    busy = true;
    error = null;
    paint();
    try {
      const data = await getJSON('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ path: target, kind: kind || undefined }),
      });
      src.meta = data;
      src.list = data.sources || [];
      const added = data.source;
      const n = data.projectsAdded;
      announce('Now watching ' + added.path + '.');
      wbToast(added.kind === 'project'
        ? 'Added ' + added.display + '.'
        : 'Added ' + added.display + ' - ' + (n === 1 ? '1 project' : (n || 0) + ' projects') + '.',
      'ok');
      close();
      srcRenderHeader();
      srcRenderOptions();
      loadProjects(true);
    } catch (err) {
      busy = false;
      error = err.message || 'That folder could not be added.';
      paint();
    }
  };

  /* -- the native chooser --------------------------------------------- *
   *
   * Inside GroundControl.app the shell owns a real NSOpenPanel, which comes up
   * frontmost and as a sheet. Outside it, the server runs `choose folder`
   * through osascript. Both hand back one absolute path or nothing at all.
   */
  const choose = async () => {
    const accept = (p) => {
      if (!p) return;
      typed = p;
      hits = null;
      browsing = null;
      peek = null;
      peekFor = '';
      paint();
      runPeek();
    };
    if (srcShellPicker()) {
      try { accept(await srcShellPicker()()); }
      catch { error = 'The folder chooser could not be opened.'; paint(); }
      return;
    }
    try {
      const data = await getJSON('/api/pick-folder', { method: 'POST' });
      if (data.cancelled || !data.ok) return;
      typed = data.path;
      hits = null;
      browsing = null;
      peek = data.inspect || null;
      peekFor = data.path;
      paint();
    } catch {
      error = 'The system folder picker could not be opened. Type or paste a path instead.';
      paint();
    }
  };

  /* -- the inline browser --------------------------------------------- */
  const browseTo = async (target) => {
    try {
      browsing = await getJSON('/api/browse?path=' + encodeURIComponent(target));
      error = null;
    } catch (err) {
      error = err.message;
    }
    paint();
  };

  /* -- paint ----------------------------------------------------------- */
  function paint() {
    clear(form);

    form.append(h('h2', 'src-d-h', 'Add a folder'));
    form.append(h('p', 'src-d-sub',
      'Point Ground Control at a folder full of projects, or at a single project living anywhere '
      + 'on disk. You can add as many as you like.'));

    /* candidates from a drop the browser would not give us a path for */
    if (searching) {
      form.append(h('div', 'src-d-peek', 'Looking for “' + (opts.name || '') + '” under your home folder…'));
    } else if (hits && hits.length) {
      form.append(h('div', 'src-d-label', 'Is this the one you dropped?'));
      const box = h('div', 'src-d-hits');
      for (const hit of hits) {
        const b = h('button', 'src-d-hit');
        b.type = 'button';
        b.append(icon(hit.kind === 'project' ? 'i-box' : 'i-folder'));
        b.append(h('span', 'src-d-hit-p', srcShortPath(hit.path)));
        if (hit.alreadyWatched) b.append(h('span', 'src-d-entry-t', 'watched'));
        b.addEventListener('click', () => {
          typed = hit.path;
          peek = hit;
          peekFor = hit.path;
          hits = null;
          paint();
        });
        box.append(b);
      }
      form.append(box);
    } else if (hits) {
      form.append(h('div', 'src-d-peek is-bad',
        'Your browser did not hand over the location of that folder'
        + (opts.name ? ' (“' + opts.name + '”)' : '')
        + ', and nothing by that name turned up under your home folder. Choose it below instead.'));
      hits = null;
    }

    /* the path box */
    form.append(h('div', 'src-d-label', 'Folder'));
    const row = h('div', 'src-d-row');
    const input = h('input', null);
    input.type = 'text';
    input.value = typed;
    input.placeholder = '/Users/you/dev/my-project';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.setAttribute('aria-label', 'Folder path');
    input.addEventListener('input', () => { typed = input.value; error = null; schedulePeek(); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); if (peek && peek.ok && !peek.alreadyWatched) submit(); }
    });
    row.append(input);

    if (!src.meta || src.meta.canPickFolder !== false) {
      const pick = h('button', 'btn');
      pick.type = 'button';
      pick.append(icon('i-folder'), h('span', null, 'Choose…'));
      pick.title = 'Open the system folder chooser';
      pick.addEventListener('click', choose);
      row.append(pick);
    }

    const browseBtn = h('button', 'btn');
    browseBtn.type = 'button';
    browseBtn.append(icon(browsing ? 'i-x' : 'i-search'), h('span', null, browsing ? 'Hide' : 'Browse'));
    browseBtn.addEventListener('click', () => {
      if (browsing) { browsing = null; paint(); return; }
      browseTo(typed.trim() || (src.meta && src.meta.homeDir) || '~');
    });
    row.append(browseBtn);
    form.append(row);

    /* the browser */
    if (browsing) {
      form.append(srcBrowsePanel(browsing, {
        onGo: browseTo,
        onPick: (p) => { typed = p; browsing = null; peekFor = ''; paint(); runPeek(); },
      }));
    }

    /* what Ground Control makes of it */
    form.append(srcPeekBox(peek, typed.trim()));

    /* how it will be read */
    if (peek && peek.ok && !peek.alreadyWatched) {
      form.append(h('div', 'src-d-label', 'Read it as'));
      const kinds = h('div', 'src-d-kinds');
      const chosen = kind || peek.kind;
      for (const k of SRC_KINDS) {
        const b = h('button', 'src-d-kind');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(chosen === k.id));
        b.append(icon(k.icon));
        const t = h('span', null);
        t.append(h('span', 'src-d-kind-n', k.name));
        t.append(h('span', 'src-d-kind-d', k.desc));
        b.append(t);
        b.addEventListener('click', () => {
          kind = k.id;
          peekFor = '';                  // re-describe under the new reading
          paint();
          runPeek();
        });
        kinds.append(b);
      }
      form.append(kinds);
    }

    form.append(h('div', 'src-d-err', error || ''));

    const foot = h('div', 'src-d-foot');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    foot.append(cancel);

    const go = h('button', 'btn btn-primary');
    go.type = 'button';
    go.append(icon('i-plus'), h('span', null, 'Add folder'));
    go.disabled = busy || !peek || !peek.ok || Boolean(peek.alreadyWatched);
    if (busy) go.classList.add('is-busy');
    go.addEventListener('click', submit);
    foot.append(go);
    form.append(foot);

    setTimeout(() => {
      if (browsing || searching) return;
      input.focus();
      try { input.setSelectionRange(typed.length, typed.length); } catch { /* not focusable yet */ }
    }, 0);
  }

  paint();
  if (typed) runPeek();
  document.body.append(dlg);
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  dlg.showModal();

  src.dialog = {
    el: dlg,
    close,
    /** The locate sweep came back: fill the candidate list in place. */
    setHits(found) {
      searching = false;
      if (found.length === 1 && !found[0].alreadyWatched) {
        hits = null;
        typed = found[0].path;
        peek = found[0];
        peekFor = found[0].path;
      } else {
        hits = found;
      }
      paint();
    },
  };
}

/** The verdict block: what Ground Control found, or why it will not take it. */
function srcPeekBox(peek, target) {
  const box = h('div', 'src-d-peek');
  if (!target) {
    box.textContent = 'Type a path, choose a folder, or drag one onto the window.';
    return box;
  }
  if (!peek) {
    box.textContent = 'Looking…';
    return box;
  }

  if (!peek.ok) {
    box.classList.add('is-bad');
    const head = h('div', 'src-d-peek-h');
    head.append(icon('i-alert'), h('span', null, 'This one will not work'));
    box.append(head);
    box.append(h('div', 'src-d-peek-p', peek.error || 'That folder cannot be added.'));
    return box;
  }
  if (peek.alreadyWatched) {
    const head = h('div', 'src-d-peek-h');
    head.append(icon('i-check'), h('span', null, 'Already on the dashboard'));
    box.append(head);
    box.append(h('div', 'src-d-peek-p',
      'Ground Control is already watching this folder'
      + (peek.watchedAs ? ' as “' + peek.watchedAs.display + '”' : '') + '.'));
    return box;
  }

  box.classList.add('is-good');
  const head = h('div', 'src-d-peek-h');
  head.append(icon('i-check'), h('span', null, peek.name));
  box.append(head);

  const isProject = peek.kind === 'project';
  const n = peek.projectCount;
  box.append(h('div', 'src-d-peek-p', isProject
    ? 'One project' + (peek.isRepo ? ', a git repository' : '') + '. It gets its own card.'
    : n === 0
      ? 'No folders inside it yet: anything you put there will show up on its own.'
      : (n === 1 ? '1 folder inside it' : n + ' folders inside it') + ', each becoming its own card.'));

  if (!isProject && peek.sample && peek.sample.length) {
    box.append(h('div', 'src-d-peek-s', peek.sample.join(' · ')
      + (n > peek.sample.length ? ' · +' + (n - peek.sample.length) + ' more' : '')));
  }
  return box;
}

/** The inline directory browser. Directory names only: no file contents. */
function srcBrowsePanel(data, handlers) {
  const box = h('div', 'src-d-browse');

  const crumb = h('div', 'src-d-crumb');
  const up = h('button', 'src-d-up');
  up.type = 'button';
  up.append(icon('i-up'));
  up.title = 'Up one level';
  up.disabled = !data.parent;
  if (data.parent) up.addEventListener('click', () => handlers.onGo(data.parent));
  crumb.append(up);

  const home = h('button', 'src-d-home');
  home.type = 'button';
  home.append(icon('i-home'));
  home.title = 'Home folder';
  home.addEventListener('click', () => handlers.onGo(data.home));
  crumb.append(home);

  const where = h('span', 'src-d-cpath', srcShortPath(data.path));
  where.title = data.path;
  crumb.append(where);

  const useThis = h('button', 'btn btn-sm');
  useThis.type = 'button';
  useThis.textContent = 'Use this';
  useThis.title = 'Use ' + data.path;
  useThis.addEventListener('click', () => handlers.onPick(data.path));
  crumb.append(useThis);
  box.append(crumb);

  const list = h('div', 'src-d-list');
  if (!data.entries.length) {
    list.append(h('div', 'src-d-empty', data.hiddenCount
      ? 'Nothing here but hidden and build folders.'
      : 'No folders in here.'));
  }
  for (const e of data.entries) {
    const b = h('button', 'src-d-entry');
    b.type = 'button';
    b.classList.toggle('is-project', e.isProject);
    b.append(icon(e.isProject ? 'i-box' : 'i-folder'));
    b.append(h('span', 'src-d-entry-n', e.name));
    if (e.watched) b.append(h('span', 'src-d-entry-t', 'watched'));
    else if (e.isProject) b.append(h('span', 'src-d-entry-t', 'project'));
    // A click walks into the folder; the + picks it.
    b.addEventListener('click', () => handlers.onGo(e.path));
    const go = h('span', 'src-d-entry-go');
    go.append(icon('i-plus'));
    go.title = 'Use ' + e.path;
    go.addEventListener('click', (ev) => { ev.stopPropagation(); handlers.onPick(e.path); });
    b.append(go);
    list.append(b);
  }
  box.append(list);
  return box;
}

/* ── drag and drop ───────────────────────────────────────────────────── *
 *
 * A Finder drag is the obvious way to add a folder, and it is also the one the
 * browser makes hardest: a dropped directory arrives as a NAME, with its
 * location deliberately withheld. Three routes are tried in order:
 *
 *   1. `text/uri-list`: Safari, and the app shell, hand over a real file://
 *      URL. This is the happy path: one confirmation and it is in.
 *   2. `window.groundControlAddFolders`, which GroundControl.app calls with the
 *      real path AppKit gave it.
 *   3. the name alone: ask the server to look for it and offer whatever it
 *      finds. Nothing is ever added on the strength of a guess.
 */

function srcDropPathsFrom(dt) {
  const out = [];
  const push = (text) => {
    if (typeof text !== 'string') return;
    for (const line of text.split(/[\n\r]+/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (/^file:\/\//i.test(t) || t.startsWith('/') || t.startsWith('~/')) {
        if (!out.includes(t)) out.push(t);
      }
    }
  };
  try { push(dt.getData('text/uri-list')); } catch { /* not offered */ }
  try { push(dt.getData('text/plain')); } catch { /* not offered */ }
  return out;
}

function srcDropNames(dt) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  const items = dt.items;
  if (items && items.length) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      let entry = null;
      try { entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch { entry = null; }
      if (entry && entry.isDirectory) { add(entry.name); continue; }
      let f = null;
      try { f = item.getAsFile ? item.getAsFile() : null; } catch { f = null; }
      // A directory dropped into a browser arrives with no MIME type.
      if (f && !f.type) add(f.name);
    }
  }
  if (!names.length && dt.files) {
    for (const f of dt.files) if (!f.type) add(f.name);
  }
  return names;
}

function srcHasFiles(dt) {
  if (!dt) return false;
  const types = dt.types ? Array.from(dt.types) : [];
  return types.includes('Files') || types.includes('text/uri-list')
    || types.includes('public.file-url');
}

/**
 * Show or hide the drop overlay.
 *
 * `dragleave` is not reliable enough to be the only way out: a drag that ends
 * in another window, or is cancelled with Escape, can leave the last leave
 * event unfired and the overlay stuck over the dashboard. `dragover` fires
 * continuously for as long as a drag is actually over the page, so its absence
 * is the liveness signal: if a second goes by without one, the drag is gone.
 */
let srcDropWatchdog = 0;

function srcShowDrop(on) {
  if (!el.dropzone) return;
  el.dropzone.hidden = !on;
  clearTimeout(srcDropWatchdog);
  if (on) srcDropWatchdog = setTimeout(() => srcShowDrop(false), 1200);
}

async function srcHandleDrop(ev) {
  const dt = ev.dataTransfer;
  if (!dt) return;

  const paths = srcDropPathsFrom(dt);
  if (paths.length) return srcOpenDialog({ path: paths[0] });

  const names = srcDropNames(dt);
  if (!names.length) return srcOpenDialog();

  // No path came with the drop. Open the dialog straight away so the drop
  // feels answered, then fill in whatever the search turns up.
  srcOpenDialog({ name: names[0], hits: [], searching: true });
  const dialog = src.dialog;
  let found = [];
  try {
    const data = await getJSON('/api/sources/locate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: names[0] }),
    });
    found = (data.matches || []).filter((m) => m.ok || m.alreadyWatched);
  } catch { /* the dialog falls back to "choose it below" */ }
  if (src.dialog === dialog && dialog) dialog.setHits(found);
  return undefined;
}

/* ── stop watching, from the project page ────────────────────────────── *
 *
 * A folder added on its own has a second, non-destructive way off the
 * dashboard, and it sits right next to the destructive one so the difference
 * is impossible to miss: "Stop watching" leaves the folder exactly where it is.
 * Only shown for a `project`-kind source: a project inside a watched folder
 * cannot be removed on its own without hiding the folder it lives in.
 */
function srcDetachAction(into, d) {
  // Decided from the project's own payload, not from `src.list`: a deep link
  // paints this page before the source list has finished loading.
  if (d.sourceKind !== 'project' || !d.sourceId) return;

  const b = h('button', 'btn btn-sm src-detach');
  b.type = 'button';
  b.append(icon('i-x'), h('span', null, 'Stop watching'));
  b.title = 'Take ' + (d.name || d.id) + ' off the dashboard. The folder stays exactly where it is.';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const data = await getJSON('/api/sources/' + encodeURIComponent(d.sourceId), { method: 'DELETE' });
      src.meta = data;
      src.list = data.sources || [];
      wbToast((d.name || d.id) + ' is off the dashboard. The folder was not touched.', 'ok');
      location.hash = '/';
      srcRenderHeader();
      loadProjects(true);
    } catch (err) {
      b.disabled = false;
      wbToast('Could not remove that folder: ' + err.message, 'bad');
    }
  });
  into.append(b);
}

/* ── the GroundControl.app bridge ────────────────────────────────────── *
 *
 * Two things the app shell can do that a page cannot: hand over the real path
 * of a dragged folder, and open a proper NSOpenPanel. Both are optional: in a
 * plain browser tab neither hook exists and the server-side equivalents are
 * used instead.
 */

/** The shell's folder chooser as a promise, or null when not in the app. */
function srcShellPicker() {
  const mh = window.webkit && window.webkit.messageHandlers;
  if (!mh || !mh.gcPickFolder) return null;
  return () => new Promise((resolve) => {
    let settled = false;
    const finish = (p) => { if (!settled) { settled = true; resolve(p || null); } };
    window.groundControlPickedFolder = finish;
    try { mh.gcPickFolder.postMessage({}); }
    catch { finish(null); }
    // The panel has no timeout of its own; this only guards against a shell
    // that went away mid-dialog, which would otherwise hang the button.
    setTimeout(() => finish(null), 10 * 60 * 1000);
  });
}

/**
 * The app shell's way in: GroundControl.app hands over the real path AppKit
 * gave it, which is the one place a drop is never ambiguous.
 */
window.groundControlAddFolders = function groundControlAddFolders(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const first = list.find((p) => typeof p === 'string' && p);
  if (first) srcOpenDialog({ path: first });
  return Boolean(first);
};

/* ── boot ────────────────────────────────────────────────────────────── */

function srcBoot() {
  el.srcBtn.addEventListener('click', srcTogglePanel);
  el.srcBlankAdd.addEventListener('click', () => srcOpenDialog());

  /* Drag-and-drop over the whole window. dragenter/dragleave nest, so they are
   * counted rather than trusted individually: otherwise crossing a child
   * element flickers the overlay off and back on. */
  window.addEventListener('dragenter', (ev) => {
    if (!srcHasFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    src.dragDepth++;
    srcShowDrop(true);
  });
  window.addEventListener('dragover', (ev) => {
    if (!srcHasFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'copy'; } catch { /* read-only here */ }
    if (src.dragDepth) srcShowDrop(true);          // keeps the watchdog fed
  });
  window.addEventListener('dragleave', (ev) => {
    if (!srcHasFiles(ev.dataTransfer)) return;
    src.dragDepth = Math.max(0, src.dragDepth - 1);
    if (!src.dragDepth) srcShowDrop(false);
  });
  window.addEventListener('drop', (ev) => {
    if (!srcHasFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    src.dragDepth = 0;
    srcShowDrop(false);
    srcHandleDrop(ev);
  });
  // A drag that ends outside the window never fires `drop`.
  window.addEventListener('dragend', () => { src.dragDepth = 0; srcShowDrop(false); });

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented) return;
    const tag = (ev.target && ev.target.tagName) || '';
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || (ev.target && ev.target.isContentEditable);
    // Cmd/Ctrl+Shift+O adds a folder from anywhere; plain F opens the list.
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && (ev.key === 'o' || ev.key === 'O')) {
      ev.preventDefault();
      srcOpenDialog();
    } else if (ev.key === 'f' && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey
      && !document.querySelector('dialog[open]')) {
      // Not while a modal is up: the panel would open behind it.
      ev.preventDefault();
      srcTogglePanel();
    }
  });

  srcLoad();
}

/* A guard flag, because the source list is also what the empty-grid state and
 * the header depend on: booting twice would double every drag listener. */
let srcReady = false;

function srcBootOnce() {
  if (srcReady) return;
  srcReady = true;
  try { srcBoot(); }
  catch (err) {
    // A broken Sources panel must never take the dashboard with it.
    console.error('[sources] boot failed:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', srcBootOnce, { once: true });
} else {
  srcBootOnce();
}
