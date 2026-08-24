#!/usr/bin/env node
/**
 * Ground Control — a local, zero-dependency dashboard over a folder of projects.
 *
 *   node server.js [--root <dir>] [--port <n>] [--open]
 *
 * Node stdlib only. See CONTRACT.md §2 for the API this implements.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import * as util from './lib/util.js';
import * as scan from './lib/scan.js';
import * as docslib from './lib/docs.js';
// Forge (CONTRACT-FORGE.md) — appended feature, routes live at the bottom.
import * as brieflib from './lib/brief.js';
import * as jobslib from './lib/jobs.js';
import * as generate from './lib/generate.js';
// The local-model tier (CONTRACT-LOCAL.md) — ollama status and model list.
import * as locallib from './lib/local.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { PathError, resolveInside, mimeFor, STATIC_EXT } = util;

/* ------------------------------------------------------------------ *
 * Never die
 * ------------------------------------------------------------------ */

process.on('uncaughtException', (err) => {
  console.error('[ground-control] uncaught exception:', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ground-control] unhandled rejection:', (reason && reason.stack) || reason);
});

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const DEFAULT_ROOT = path.join(os.homedir(), 'coding_projects');
const DEFAULT_PORT = 7377;

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, port: DEFAULT_PORT, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) { opts.root = argv[++i]; }
    else if (a.startsWith('--root=')) { opts.root = a.slice(7); }
    else if (a === '--port' && argv[i + 1]) { opts.port = Number(argv[++i]) || DEFAULT_PORT; }
    else if (a.startsWith('--port=')) { opts.port = Number(a.slice(7)) || DEFAULT_PORT; }
    else if (a === '--open') { opts.open = true; }
  }
  opts.root = path.resolve(opts.root);
  return opts;
}

const ARGS = parseArgs(process.argv.slice(2));
const ROOT = ARGS.root;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ *
 * Scan cache
 * ------------------------------------------------------------------ */

/**
 * Scan freshness window. Must sit comfortably above AGENT_POLL_MS (5000): the
 * SSE agent poller calls getScan(false) on every tick but only needs the
 * project list, not a fresh filesystem walk. A full scan takes ~800ms, so a
 * TTL near the poll interval lands the freshness check on alternating sides of
 * the boundary and triggers a synchronous 32k-dirent re-walk every ~10s even
 * when nothing on disk changed. Explicit-refresh paths pass fresh=true and
 * bypass the cache, so staleness here is not user-visible.
 */
const CACHE_TTL_MS = 30000;
let cache = null;          // { payload, at }
let inFlight = null;       // dedupe concurrent rescans

async function getScan(fresh) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const payload = await scan.scanRoot(ROOT);
      cache = { payload, at: Date.now() };
      return payload;
    } catch (err) {
      console.error('[ground-control] scan failed:', (err && err.stack) || err);
      // Serve the last good payload rather than blanking the dashboard.
      if (cache) return cache.payload;
      return { root: ROOT, scannedAt: new Date().toISOString(), durationMs: 0, projects: [] };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Find a ProjectSummary by id, refreshing the scan if the id is unknown. */
async function findProject(id) {
  let payload = await getScan(false);
  let p = payload.projects.find((x) => x.id === id);
  if (!p) {
    payload = await getScan(true);       // maybe it appeared since the last scan
    p = payload.projects.find((x) => x.id === id);
  }
  return p || null;
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

/** decodeURIComponent that returns null instead of throwing on malformed input. */
function safeDecode(str) {
  try { return decodeURIComponent(str); } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * Static files (public/)
 * ------------------------------------------------------------------ */

async function serveStatic(res, urlPath) {
  let rel = safeDecode(urlPath);
  if (rel === null) return sendError(res, 400, 'bad request');
  if (rel === '/' || rel === '') rel = '/index.html';
  rel = rel.replace(/^\/+/, '');

  let abs;
  try {
    abs = resolveInside(PUBLIC_DIR, rel);
  } catch {
    return sendError(res, 403, 'forbidden');
  }

  const ext = path.extname(abs).toLowerCase();
  if (!STATIC_EXT.has(ext)) return sendError(res, 404, 'not found');

  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    // public/index.html may simply not exist yet during parallel development.
    return sendError(res, 404, 'not found');
  }
  if (!st.isFile()) return sendError(res, 404, 'not found');

  res.writeHead(200, {
    'Content-Type': mimeFor(abs),
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  const stream = fs.createReadStream(abs);
  stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
}

/* ------------------------------------------------------------------ *
 * /api/doc and /api/raw
 * ------------------------------------------------------------------ */

const DOC_MAX_BYTES = 2 * 1024 * 1024;

async function handleDoc(res, query) {
  const id = query.get('id');
  const rel = query.get('path');
  if (!id || !rel) return sendError(res, 400, 'id and path are required');

  const project = await findProject(id);
  if (!project) return sendError(res, 404, 'unknown project');

  let abs;
  try {
    abs = resolveInside(project.path, rel);
  } catch (err) {
    return sendError(res, err instanceof PathError ? 403 : 400, 'forbidden path');
  }

  let st;
  try { st = await fsp.stat(abs); } catch { return sendError(res, 404, 'not found'); }
  if (!st.isFile()) return sendError(res, 404, 'not found');
  if (st.size > DOC_MAX_BYTES) return sendError(res, 413, 'file too large');

  let content;
  try { content = await fsp.readFile(abs, 'utf8'); }
  catch { return sendError(res, 500, 'unreadable file'); }

  const relPosix = path.relative(project.path, abs).split(path.sep).join('/');
  const known = project.docs.find((d) => d.path === relPosix);
  const kind = known ? known.kind : (docslib.classify(relPosix) || 'doc');
  const contentType = known ? known.contentType : docslib.contentTypeFor(relPosix);

  let title = known ? known.title : null;
  if (!title) {
    if (contentType === 'markdown') title = docslib.markdownTitle(content);
    else if (contentType === 'html') title = docslib.htmlTitle(content);
    if (!title) title = path.basename(relPosix);
  }

  sendJSON(res, 200, {
    project: project.name,
    path: relPosix,
    title,
    kind,
    contentType,
    content,
    sizeBytes: st.size,
    mtimeISO: new Date(st.mtimeMs).toISOString(),
  });
}

async function handleRaw(req, res, query) {
  const id = query.get('id');
  const rel = query.get('path');
  if (!id || !rel) return sendError(res, 400, 'id and path are required');

  const project = await findProject(id);
  if (!project) return sendError(res, 404, 'unknown project');

  let abs;
  try {
    abs = resolveInside(project.path, rel);
  } catch (err) {
    return sendError(res, err instanceof PathError ? 403 : 400, 'forbidden path');
  }

  let st;
  try { st = await fsp.stat(abs); } catch { return sendError(res, 404, 'not found'); }
  if (!st.isFile()) return sendError(res, 404, 'not found');

  res.writeHead(200, {
    'Content-Type': mimeFor(abs),
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(abs);
  stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
}

/* ------------------------------------------------------------------ *
 * /api/stream — Server-Sent Events
 * ------------------------------------------------------------------ */

const DEBOUNCE_MS = 800;
const PING_MS = 25000;

function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const watchers = [];
  let debounceTimer = null;
  let pingTimer = null;
  let unwatchAgents = null;                                 // Workbench §4
  let unwatchForge = null;                                  // Forge build indicator

  const send = (event, data) => {
    if (closed) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (unwatchAgents) { try { unwatchAgents(); } catch { /* ignore */ } unwatchAgents = null; }
    if (unwatchForge) { try { unwatchForge(); } catch { /* ignore */ } unwatchForge = null; }
    for (const w of watchers) {
      try { w.close(); } catch { /* already dead */ }
    }
    watchers.length = 0;
    try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  res.on('close', cleanup);

  send('hello', { ok: true });

  pingTimer = setInterval(() => { send('ping', {}); }, PING_MS);
  if (typeof pingTimer.unref === 'function') pingTimer.unref();

  const rescan = () => {
    debounceTimer = null;
    if (closed) return;
    getScan(true)
      .then((payload) => withAgents(payload))               // Workbench §4
      .then((payload) => { send('projects', payload); })
      .catch((err) => { console.error('[ground-control] stream rescan failed:', err && err.message); });
  };

  const onChange = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(rescan, DEBOUNCE_MS);
  };

  /**
   * fs.watch throws on missing paths, hits EMFILE, and emits 'error' when a
   * watched directory is deleted. Every watcher is therefore wrapped and
   * failures are silently skipped — a dashboard is not worth a crash.
   */
  const watch = (target) => {
    if (watchers.length >= 400) return;      // fd budget guard
    try {
      if (!fs.existsSync(target)) return;
      const w = fs.watch(target, { persistent: false }, onChange);
      w.on('error', () => { try { w.close(); } catch { /* ignore */ } });
      watchers.push(w);
    } catch { /* ENOENT / EMFILE / EPERM — skip this path */ }
  };

  // A project gaining or losing a live agent re-emits `projects` on the same
  // 800 ms debounce as a filesystem change. (Workbench §4)
  unwatchAgents = workbenchWatchAgents(onChange);

  // A Forge job starting or finishing re-emits `projects` on the same debounce,
  // so the dashboard's build indicator appears and clears without polling.
  unwatchForge = jobslib.subscribeAll(() => onChange());

  // Root, each project directory, and each repo's HEAD + refs.
  watch(ROOT);
  let names = [];
  try { names = scan.listProjectDirs(ROOT); } catch { names = []; }
  for (const name of names) {
    const dir = path.join(ROOT, name);
    watch(dir);
    watch(path.join(dir, '.git', 'HEAD'));
    watch(path.join(dir, '.git', 'refs'));
    watch(path.join(dir, '.git', 'refs', 'heads'));
  }
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

async function route(req, res) {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch {
    return sendError(res, 400, 'bad request');
  }
  const pathname = parsed.pathname;
  const query = parsed.searchParams;

  // Forge (CONTRACT-FORGE.md §6). Dispatched before the read-only method guard
  // because generate/cancel/save are POSTs; the handler checks methods itself.
  if (pathname.startsWith('/api/forge/')) return handleForge(req, res, pathname);

  // Workbench (CONTRACT-WORKBENCH.md §4). Also dispatched before the read-only
  // method guard because /api/open is a POST; the handler checks methods itself.
  if (pathname === '/api/editors' || pathname === '/api/open' || pathname === '/api/agents'
      || pathname.startsWith('/api/agents/')) {
    return handleWorkbench(req, res, pathname, query);
  }

  // Reclaim (CONTRACT-RECLAIM.md §5). Dispatched before the read-only method
  // guard because the trash route is a POST; the handler checks methods itself.
  if (pathname === '/api/reclaim' || pathname.startsWith('/api/reclaim/')) {
    return handleReclaim(req, res, pathname, query);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'method not allowed');
  }

  if (pathname === '/api/projects') {
    const payload = await getScan(query.get('fresh') === '1');
    return sendJSON(res, 200, await withAgents(payload));   // Workbench §4

  }

  if (pathname.startsWith('/api/project/')) {
    const id = safeDecode(pathname.slice('/api/project/'.length));
    if (!id) return sendError(res, id === null ? 400 : 404, id === null ? 'bad request' : 'unknown project');
    const summary = await findProject(id);
    if (!summary) return sendError(res, 404, 'unknown project');
    const detail = await scan.projectDetail(summary);
    return sendJSON(res, 200, await withAgent(detail));     // Workbench §4
  }

  if (pathname === '/api/doc') return handleDoc(res, query);
  if (pathname === '/api/raw') return handleRaw(req, res, query);
  if (pathname === '/api/stream') return handleStream(req, res);

  if (pathname.startsWith('/api/')) return sendError(res, 404, 'unknown endpoint');

  return serveStatic(res, pathname);
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      console.error('[ground-control] request error:', (err && err.stack) || err);
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else { try { res.end(); } catch { /* ignore */ } }
    });
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
});

server.listen(ARGS.port, () => {
  console.log(`Ground Control watching ${ROOT} → http://localhost:${ARGS.port}`);
  // Warm the cache so the first page load is instant.
  getScan(true).catch(() => {});
  // Rebuild the Forge registry from disk. Without this a generated-but-unsaved
  // artifact becomes unreachable the moment Ground Control restarts: the staged HTML
  // survives, but nothing maps a project back to it. FORGE_DIR is declared
  // further down the module; this callback runs after evaluation, so it is set.
  try {
    jobslib.setPersistDir(FORGE_DIR);
    const rec = jobslib.hydrate(FORGE_DIR);
    if (rec.restored || rec.dropped) {
      console.log(`[forge] restored ${rec.restored} job(s)`
        + (rec.interrupted ? `, ${rec.interrupted} interrupted by the restart` : '')
        + (rec.dropped ? `, ${rec.dropped} dropped (staged file gone)` : ''));
    }
  } catch (err) {
    console.error('[forge] job restore failed:', (err && err.message) || err);
  }
  if (ARGS.open) {
    try {
      execFile('open', [`http://localhost:${ARGS.port}`], () => {});
    } catch { /* not macOS, or `open` unavailable */ }
  }
});

server.on('error', (err) => {
  console.error(`[ground-control] server error: ${err && err.message}`);
  if (err && err.code === 'EADDRINUSE') process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { server.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}

export { server, getScan, ROOT };

/* ================================================================== *
 * GROUND_CONTROL FORGE — artifact generation (CONTRACT-FORGE.md §6)
 *
 * Appended below the original server. Nothing above this line was
 * restructured; `route()` gained one dispatch line for `/api/forge/`.
 *
 * Safety posture (contract §2): generation only ever writes into
 * `<ground-control>/.forge/<projectId>/<jobId>.html`. Writing into a real project is a
 * separate, explicit POST that re-runs the same three path gates as /api/doc,
 * accepts `.html` only, and refuses to overwrite without `overwrite: true`.
 * ================================================================== */

const FORGE_DIR = path.join(__dirname, '.forge');
const FORGE_BODY_LIMIT = 64 * 1024;
const FORGE_PING_MS = 25000;

// Agent F owns the canonical DEFAULT_MODEL. Pick it up if the module is there,
// otherwise fall back so Forge still works during parallel development.
let FORGE_DEFAULT_MODEL = generate.FALLBACK_MODEL;
const FORGE_MODELS = ['claude-opus-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
import('./lib/house-style.js')
  .then((m) => { if (m && typeof m.DEFAULT_MODEL === 'string') FORGE_DEFAULT_MODEL = m.DEFAULT_MODEL; })
  .catch(() => { /* not built yet — the fallback stands */ });

// Stop any in-flight generation when the server goes down, so no orphaned
// `claude` process outlives it. `exit` is used as well as the signals because
// the existing signal handler above calls process.exit() straight away, and
// child.kill() is synchronous so it still lands.
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => { try { jobslib.cancelAll(); } catch { /* ignore */ } });
}

/** Read and parse a JSON request body. Resolves to `{}` for an empty body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > FORGE_BODY_LIMIT) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => reject(Object.assign(new Error('bad request'), { status: 400 })));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
  });
}

/** Staging path for a job: `<ground-control>/.forge/<projectId>/<jobId>.html`. */
function stagingPathFor(projectId, jobId) {
  const safeProject = String(projectId).replace(/[^a-z0-9._-]/gi, '-').slice(0, 80) || 'project';
  const safeJob = String(jobId).replace(/[^a-z0-9._-]/gi, '-').slice(0, 40) || 'job';
  return path.join(FORGE_DIR, safeProject, `${safeJob}.html`);
}

async function handleForge(req, res, pathname) {
  const rest = pathname.slice('/api/forge/'.length);

  if (rest === 'status') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
    return forgeStatus(res);
  }

  if (rest === 'generate') {
    if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
    return forgeGenerate(req, res);
  }

  if (rest.startsWith('job/')) {
    const parts = rest.slice('job/'.length).split('/');
    const jobId = safeDecode(parts[0] || '');
    if (!jobId) return sendError(res, 400, 'bad request');
    const action = parts[1] || '';

    const job = jobslib.get(jobId);
    if (!job) return sendError(res, 404, 'unknown job');

    if (!action) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
      return sendJSON(res, 200, forgeJobJSON(job));
    }
    if (action === 'stream') {
      if (req.method !== 'GET') return sendError(res, 405, 'method not allowed');
      return forgeStream(req, res, job);
    }
    if (action === 'preview') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
      return forgePreview(req, res, job);
    }
    if (action === 'cancel') {
      if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
      const updated = jobslib.cancel(jobId);
      return sendJSON(res, 200, forgeJobJSON(updated));
    }
    if (action === 'save') {
      if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
      return forgeSave(req, res, job);
    }
    return sendError(res, 404, 'unknown endpoint');
  }

  return sendError(res, 404, 'unknown endpoint');
}

/* ---- GET /api/forge/status ---------------------------------------- */

async function forgeStatus(res) {
  let claude = { available: false, version: null, path: null };
  try { claude = generate.claudeAvailable(); } catch { /* reported as unavailable */ }

  // CONTRACT-LOCAL.md §5: `local` appears in `tiers` only when ollama is
  // actually reachable, and never throws if it is not.
  let ollama = { available: false, version: null, models: [], defaultModel: null, error: 'the local-model tier is unavailable' };
  try { ollama = await locallib.ollamaStatus(); } catch (err) {
    ollama = { available: false, version: null, models: [], defaultModel: null, error: String((err && err.message) || err) };
  }

  const tiers = ['template', 'authored'];
  if (ollama.available) tiers.push('local');

  sendJSON(res, 200, {
    claude: { available: Boolean(claude.available), version: claude.version || null },
    ollama: {
      available: Boolean(ollama.available),
      version: ollama.version || null,
      host: ollama.host || null,
      models: Array.isArray(ollama.models) ? ollama.models : [],
      defaultModel: ollama.defaultModel || null,
      error: ollama.error || null,
    },
    tiers,
    defaultModel: FORGE_DEFAULT_MODEL,
    models: FORGE_MODELS,
    runningJobs: jobslib.running().map(forgeJobJSON),
    // Plain wording, per contract §0b.4: nothing here is billed per run.
    billingNote: 'Generation runs through your authenticated Claude CLI and counts toward your Claude subscription. Cost figures are list-price equivalents, not money charged.',
    // CONTRACT-LOCAL.md §5: never a money figure for the local tier.
    localNote: 'The local tier runs a model on this machine through ollama. It works offline and costs nothing — no API key, no subscription usage.',
  });
}

/**
 * The Job as the API reports it, plus the local tier's verification summary
 * (CONTRACT-LOCAL.md §3) when there is one. `lib/jobs.js` is not ours to
 * change, so the extra field is added here.
 */
function forgeJobJSON(job) {
  const out = jobslib.toJSON(job);
  if (out && job && job.verification) out.verification = job.verification;
  return out;
}

/* ---- POST /api/forge/generate ------------------------------------- */

async function forgeGenerate(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.message || 'bad request'); }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return sendError(res, 400, 'id is required');

  const project = await findProject(id);
  if (!project) return sendError(res, 404, 'unknown project');

  const existing = jobslib.runningForProject(project.id);
  if (existing) {
    return sendJSON(res, 409, {
      error: 'a generation is already running for this project',
      jobId: existing.id,
      job: forgeJobJSON(existing),
    });
  }

  // What document to make. Orthogonal to `tier`, with one hard interaction
  // enforced below: only the authored tier can write a rationale.
  if (body.kind !== undefined && !jobslib.KINDS.has(body.kind)) {
    return sendError(res, 400, `kind must be one of: ${[...jobslib.KINDS.keys()].join(', ')}`);
  }
  const kind = jobslib.normalizeKind(body.kind);

  const tier = (body.tier === 'template' || body.tier === 'local') ? body.tier : 'authored';

  // Only onboarding has a deterministic floor. The rationale and code-breakdown
  // documents must be checkable against the real source, and only the authored
  // tier can read it (CONTRACT-FORGE.md §0).
  if (kind !== 'onboarding' && tier !== 'authored') {
    const what = kind === 'design' ? 'design rationale document' : 'code breakdown';
    return sendJSON(res, 400, {
      error: `The ${what} requires the authored tier. It has to be checked against the actual code: the data-only tier involves no model at all, and the local tier writes from the brief alone with no access to the repository.`,
      kind,
      tier,
      requiredTier: 'authored',
    });
  }
  const requestedModel = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim().slice(0, 80)
    : '';
  // The local tier's models are ollama tags, not Claude models, so the Claude
  // default must never be substituted in for it (CONTRACT-LOCAL.md §5).
  const model = tier === 'local' ? requestedModel : (requestedModel || FORGE_DEFAULT_MODEL);
  // Free text, treated strictly as data when it reaches the prompt.
  const audience = typeof body.audience === 'string'
    ? body.audience.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200)
    : null;

  if (tier === 'authored') {
    const claude = generate.claudeAvailable();
    if (!claude.available) {
      return sendJSON(res, 503, {
        error: 'the claude CLI is not available, so the authored tier cannot run',
        tier: 'authored',
        fallbackTier: 'template',
      });
    }
  }

  // CONTRACT-LOCAL.md §5: reject with a clear message when ollama is
  // unreachable, and never hang. `ollamaStatus()` has its own short timeout and
  // resolves to `available:false` rather than throwing.
  let localModel = model;
  if (tier === 'local') {
    let ollama;
    try { ollama = await locallib.ollamaStatus(); }
    catch (err) { ollama = { available: false, models: [], error: String((err && err.message) || err) }; }

    if (!ollama.available) {
      return sendJSON(res, 503, {
        error: `The local model tier cannot run. ${ollama.error || 'Ollama is not reachable on this machine.'} The data-only artifact is still available.`,
        tier: 'local',
        fallbackTier: 'template',
      });
    }
    const names = (ollama.models || []).map((m) => m.name);
    if (localModel && !names.includes(localModel) && !names.some((n) => n.split(':')[0] === localModel.split(':')[0])) {
      return sendJSON(res, 400, {
        error: `ollama does not have a model called "${localModel}". Installed: ${names.join(', ') || 'none'}.`,
        tier: 'local',
        models: names,
      });
    }
    if (!localModel) localModel = ollama.defaultModel;
  }

  const jobId = jobslib.newJobId();
  const stagingPath = stagingPathFor(project.id, jobId);

  const job = jobslib.create({
    projectId: project.id,
    projectName: project.name,
    kind,
    tier,
    model: tier === 'authored' ? model : (tier === 'local' ? localModel : null),
    audience,
    stagingPath,
    suggestedFilename: jobslib.filenameForKind(kind),
    jobId,
  });

  // Respond immediately; the brief and the subprocess run behind the response.
  sendJSON(res, 202, forgeJobJSON(job));

  generate.pruneStaging(FORGE_DIR).catch(() => {});

  (async () => {
    jobslib.appendProgress(job.id,
      kind === 'design' ? `gathering ${project.name}'s recorded reasoning`
        : kind === 'code' ? `mapping ${project.name}'s code surface`
          : `gathering facts about ${project.name}`);
    let brief;
    try {
      brief = await brieflib.buildBrief(project, { audience, kind });
    } catch (err) {
      return jobslib.update(job.id, {
        state: 'failed',
        errorKind: 'brief',
        error: `the repository brief could not be built: ${(err && err.message) || err}`,
      });
    }
    if (jobslib.get(job.id) && jobslib.get(job.id).state === 'cancelled') return;
    if (kind === 'code' && brief.code) {
      const c = brief.code;
      jobslib.appendProgress(job.id,
        `brief ready — ${c.imports.length} external librar(ies), ${c.constructs.length} construct(s), `
        + `${c.hosts.length} external host(s), ${c.envVars.length} environment variable(s)`);
    } else if (kind === 'design' && brief.design) {
      const d = brief.design;
      jobslib.appendProgress(job.id,
        `brief ready — ${d.designDocs.length} design document(s), ${d.rationale.length} explanatory comment(s), `
        + `${d.constants.length} constant(s) (${d.undocumentedConstants} undocumented), `
        + `${d.commitRationale.length} commit message(s) with a body`);
    } else {
      jobslib.appendProgress(job.id, `brief ready — ${brief.composition.fileCount} files, ${brief.prose.length} existing document(s)`);
    }
    generate.startGeneration({
      project, brief, kind, tier, audience, jobId: job.id, stagingPath,
      model: tier === 'local' ? localModel : model,
    });
  })().catch((err) => {
    console.error('[forge] generate failed:', (err && err.stack) || err);
    jobslib.update(job.id, { state: 'failed', errorKind: 'internal', error: String((err && err.message) || err) });
  });
}

/* ---- GET /api/forge/job/:id/stream -------------------------------- */

function forgeStream(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  let unsubscribe = null;
  let pingTimer = null;

  const send = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      cleanup();
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
    try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  res.on('close', cleanup);

  // Replay current state so a reconnecting client is never behind.
  send('hello', { ok: true, job: forgeJobJSON(job) });

  pingTimer = setInterval(() => send('ping', {}), FORGE_PING_MS);
  if (typeof pingTimer.unref === 'function') pingTimer.unref();

  if (jobslib.isTerminal(job.state)) {
    send(job.state === 'done' ? 'done' : 'failed', forgeJobJSON(job));
    return cleanup();
  }

  unsubscribe = jobslib.subscribe(job.id, (event, updated) => {
    if (closed) return;
    if (event === 'done' || event === 'failed') {
      send(event, forgeJobJSON(updated));
      cleanup();
    } else {
      send('progress', forgeJobJSON(updated));
    }
  });
}

/* ---- GET /api/forge/job/:id/preview -------------------------------- */

async function forgePreview(req, res, job) {
  if (job.state !== 'done' || !job.stagingPath) return sendError(res, 404, 'not ready');

  let st;
  try { st = await fsp.stat(job.stagingPath); } catch { return sendError(res, 404, 'not found'); }
  if (!st.isFile()) return sendError(res, 404, 'not found');

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(job.stagingPath);
  stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
}

/* ---- POST /api/forge/job/:id/save ---------------------------------- */

/**
 * Copy the staged artifact into the user's project.
 *
 * This is the only place Ground Control writes outside `.forge/`, so every guard runs
 * here: `.html` only, the three path gates from `resolveInside()` (syntactic,
 * post-resolve, post-realpath), and a hard 409 when the destination exists and
 * `overwrite` was not passed.
 */
async function forgeSave(req, res, job) {
  if (job.state !== 'done' || !job.stagingPath) {
    return sendError(res, 409, 'this job has no finished artifact to save');
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.message || 'bad request'); }

  const project = await findProject(job.projectId);
  if (!project) return sendError(res, 404, 'unknown project');

  const filename = typeof body.filename === 'string' && body.filename.trim()
    ? body.filename.trim()
    : (job.suggestedFilename || 'ONBOARDING.html');

  // Gate 0: extension. Only ever `.html`, so a save can never overwrite source.
  if (!/\.html$/i.test(filename)) {
    return sendError(res, 403, 'only .html destinations are allowed');
  }

  // Gate 0b: shape. Percent-encoding is rejected outright rather than decoded —
  // `..%2f..%2fevil.html` is contained by the gates below either way, but it
  // has no business becoming a literal filename in someone's repository.
  if (filename.length > 200 || /%|\\|\0/.test(filename)) {
    return sendError(res, 403, 'invalid filename');
  }
  const segs = filename.split('/').filter((s) => s !== '');
  if (!segs.length || segs.length > 4
      || !segs.every((s) => /^[A-Za-z0-9_][A-Za-z0-9._ -]*$/.test(s) && s !== '..')
      || !/^[A-Za-z0-9_][A-Za-z0-9._ -]*\.html$/i.test(segs[segs.length - 1])) {
    return sendError(res, 403, 'invalid filename');
  }

  // Gates 1–3: syntactic, post-path.resolve, post-fs.realpath — the same
  // resolveInside() used by /api/doc. Rejects `..`, absolute paths and
  // symlinks that escape the project root.
  let dest;
  try {
    dest = resolveInside(project.path, filename);
  } catch {
    return sendError(res, 403, 'forbidden path');
  }

  // Belt and braces: the resolved destination must still be inside the project
  // and must not be inside the staging directory.
  const projectReal = (() => { try { return fs.realpathSync(project.path); } catch { return path.resolve(project.path); } })();
  if (dest !== projectReal && !path.resolve(dest).startsWith(projectReal + path.sep)
      && !path.resolve(dest).startsWith(path.resolve(project.path) + path.sep)) {
    return sendError(res, 403, 'forbidden path');
  }

  let html;
  try { html = await fsp.readFile(job.stagingPath, 'utf8'); }
  catch { return sendError(res, 410, 'the staged artifact is no longer available'); }

  let existing = null;
  try {
    const st = await fsp.stat(dest);
    if (st.isDirectory()) return sendError(res, 403, 'destination is a directory');
    existing = { sizeBytes: st.size, mtimeISO: new Date(st.mtimeMs).toISOString() };
  } catch { /* does not exist — the happy path */ }

  if (existing && body.overwrite !== true) {
    return sendJSON(res, 409, { error: 'exists', existing });
  }

  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, html, 'utf8');
  } catch (err) {
    return sendError(res, 500, `could not write the file: ${(err && err.message) || err}`);
  }

  const bytes = Buffer.byteLength(html, 'utf8');
  const relPosix = path.relative(project.path, dest).split(path.sep).join('/');
  jobslib.update(job.id, { savedTo: dest });

  // Refresh the scan so the new artifact shows up in `docs` immediately.
  getScan(true).catch(() => {});

  sendJSON(res, 200, {
    savedTo: dest,
    relativePath: relPosix,
    projectId: project.id,
    bytes,
    overwrote: Boolean(existing),
  });
}


/* ================================================================== *
 * GROUND_CONTROL WORKBENCH — open, hop, and watch (CONTRACT-WORKBENCH.md)
 *
 * Appended below Forge. Nothing above was restructured; `route()` gained one
 * dispatch line for `/api/editors`, `/api/open` and `/api/agents`, the two
 * project payload sites gained an `await withAgents(...)`, and `handleStream()`
 * gained a watcher registration so a project gaining or losing a live agent
 * re-emits `projects` on the existing 800 ms debounce.
 *
 * Safety posture:
 *   §3 — Ground Control OBSERVES agents, with exactly one exception: POST
 *        /api/agents/stop sends SIGTERM to a session, under the four guards in
 *        CONTRACT-WORKBENCH.md §3a (the pid must already be attributed to the
 *        project; it is re-verified against a live ps/lsof immediately before
 *        the signal; the session Ground Control itself runs from is refused; SIGTERM
 *        only, never SIGKILL). Nothing else here signals a process, nothing
 *        writes anywhere under ~/.claude, and no endpoint returns raw
 *        transcript content.
 *   §2 — /api/open executes a local application with a user-supplied path. It
 *        runs execFile with an argv array (never a shell string) and puts the
 *        target through the same three gates as /api/doc — syntactic,
 *        post-path.resolve, post-fs.realpath — anchored on the scanned root.
 * ================================================================== */

import * as agentslib from './lib/agents.js';
import * as editorslib from './lib/editors.js';

/** Agent sweep budget. Overrun returns partial data rather than a slow scan. */
const AGENT_BUDGET_MS = 1500;
/** How often the SSE watcher re-checks which projects have live agents. */
const AGENT_POLL_MS = 5000;

/* ---- folding Activity into the project payloads -------------------- */

/**
 * Add an `agent` field to every ProjectSummary in a `/api/projects` payload.
 * Best-effort by construction: a failed or over-budget sweep returns the
 * payload untouched rather than delaying or breaking the response.
 */
async function withAgents(payload) {
  if (!payload || !Array.isArray(payload.projects)) return payload;
  let map;
  try {
    map = await agentslib.agentActivity(payload.projects, {
      budgetMs: AGENT_BUDGET_MS,
      excludePids: generate.forgePids(),      // never report Forge as the user's agent
    });
  } catch (err) {
    console.error('[workbench] agent sweep failed:', (err && err.message) || err);
    return payload;
  }
  return Object.assign({}, payload, {
    agentScannedAt: map.scannedAt || null,
    agentBudgetExceeded: Boolean(map.budgetExceeded),
    forgeFolded: true,
    projects: payload.projects.map((p) => Object.assign({}, p, {
      agent: map.get(p.id) || null,
      forge: forgeStateFor(p.id),
    })),
  });
}

/**
 * Is Forge building something for this project right now?
 *
 * Folded into the grid payload so the dashboard can show a project being
 * documented without the client having to hold a job subscription for every
 * card. Null when nothing is running — the common case, and cheap.
 */
function forgeStateFor(projectId) {
  let job = null;
  try { job = jobslib.runningForProject(projectId); } catch { job = null; }
  if (!job) return null;
  const last = job.progress && job.progress.length
    ? job.progress[job.progress.length - 1]
    : null;
  return {
    running: true,
    jobId: job.id,
    kind: job.kind || 'onboarding',
    tier: job.tier,
    state: job.state,
    phase: last ? last.text : null,
  };
}

/** The same fold for a single ProjectSummary / detail object. */
async function withAgent(summary) {
  if (!summary) return summary;
  try {
    const map = await agentslib.agentActivity([summary], {
      budgetMs: AGENT_BUDGET_MS,
      excludePids: generate.forgePids(),
    });
    return Object.assign({}, summary, { agent: map.get(summary.id) || null });
  } catch {
    return summary;
  }
}

/* ---- SSE: re-emit when a project gains or loses a live agent -------- */

const agentWatchers = new Set();
let agentPollTimer = null;
let agentSignature = null;

/**
 * The fingerprint the poller diffs to decide whether to push a fresh payload.
 *
 * It must cover every agent field the grid actually renders. It used to be the
 * `live` count alone, which made the indicator impossible to turn OFF: when a
 * session finishes its turn the process is still alive, so `live` stays 1 and
 * only `state` (working -> open) and `active` (1 -> 0) change. The signature
 * did not move, the poller concluded nothing had happened, and the card kept
 * claiming an agent was working until some unrelated filesystem event happened
 * to trigger a rescan. The same omission is why it only turned ON after a
 * rescan too.
 *
 * `currentAction` is deliberately excluded. It changes on every transcript
 * write, so including it would force a full rescan on every 5s poll for the
 * whole time an agent is working. It refreshes on the next payload anyway, and
 * a working agent is editing files, which triggers the watcher on its own.
 */
function agentSigOf(map) {
  const bits = [];
  for (const [id, a] of map) {
    const x = a || {};
    bits.push(`${id}:${x.state || 'none'}:${x.live || 0}:${x.active || 0}:${x.parked || 0}`);
  }
  bits.sort();
  return bits.join('|');
}

async function pollAgentState() {
  try {
    const payload = await getScan(false);
    const map = await agentslib.agentActivity(payload.projects, {
      budgetMs: AGENT_BUDGET_MS, fresh: true, excludePids: generate.forgePids(),
    });
    const sig = agentSigOf(map);
    if (agentSignature !== null && sig !== agentSignature) {
      for (const cb of agentWatchers) {
        try { cb(); } catch { /* one bad listener must not stop the rest */ }
      }
    }
    agentSignature = sig;
  } catch { /* never let the poller throw */ }
}

/**
 * Register an SSE connection's change callback. Returns an unsubscribe.
 * The poller only runs while at least one client is listening.
 */
function workbenchWatchAgents(cb) {
  if (typeof cb !== 'function') return () => {};
  agentWatchers.add(cb);
  if (!agentPollTimer) {
    agentPollTimer = setInterval(() => { pollAgentState(); }, AGENT_POLL_MS);
    if (typeof agentPollTimer.unref === 'function') agentPollTimer.unref();
    pollAgentState();
  }
  return () => {
    agentWatchers.delete(cb);
    if (!agentWatchers.size && agentPollTimer) {
      clearInterval(agentPollTimer);
      agentPollTimer = null;
      agentSignature = null;
    }
  };
}

/* ---- router -------------------------------------------------------- */

async function handleWorkbench(req, res, pathname, query) {
  if (pathname === '/api/editors') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
    return workbenchEditors(res, query);
  }

  if (pathname === '/api/open') {
    if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
    return workbenchOpen(req, res);
  }

  if (pathname === '/api/agents') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
    return workbenchAgents(res, query);
  }

  // The one mutating agent route (CONTRACT-WORKBENCH.md §3). Checked before
  // the read-only prefix match below, which would otherwise 405 it.
  if (pathname === '/api/agents/stop') {
    if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
    return workbenchAgentStop(req, res);
  }

  if (pathname.startsWith('/api/agents/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
    const id = safeDecode(pathname.slice('/api/agents/'.length));
    if (id === null) return sendError(res, 400, 'bad request');
    return workbenchAgentDetail(res, id);
  }

  return sendError(res, 404, 'unknown endpoint');
}


/* ---- POST /api/agents/stop ----------------------------------------- *
 * CONTRACT-WORKBENCH.md §3 — the one place Ground Control signals a process.
 *
 * Everything else in the Workbench observes. This endpoint deliberately does
 * not, so it carries the guards that the "never signal" rule used to provide:
 *
 *   1. The pid must be one Ground Control itself currently attributes to the named
 *      project. A caller cannot nominate an arbitrary pid.
 *   2. The pid is re-verified immediately before the signal — still alive,
 *      still a `claude` binary, still with its cwd inside that project. A pid
 *      recycled between the sweep and the click is the one way this could hit
 *      an unrelated process, and this closes it.
 *   3. The session Ground Control is running from is never signalled. Killing it
 *      would kill whatever is asking for the kill.
 *   4. SIGTERM only. Claude Code flushes its transcript on term; SIGKILL would
 *      drop the current turn's work, and no button here escalates to it.
 * ------------------------------------------------------------------- */

async function workbenchAgentStop(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.message || 'bad request'); }

  const id = typeof body.id === 'string' ? body.id : '';
  const pid = Number(body.pid);
  if (!id) return sendError(res, 400, 'id is required');
  if (!Number.isInteger(pid) || pid <= 1) return sendError(res, 400, 'a valid pid is required');

  const project = await findProject(id);
  if (!project) return sendError(res, 404, 'unknown project');

  // Guard 1 — Ground Control must already believe this pid belongs to this project.
  let map;
  try {
    map = await agentslib.agentActivity([project], {
      budgetMs: AGENT_BUDGET_MS, fresh: true, excludePids: generate.forgePids(),
    });
  } catch (err) {
    return sendError(res, 500, `could not read agent state: ${(err && err.message) || err}`);
  }
  const activity = map.get(project.id);
  const known = activity && (activity.processes || []).find((p) => p.pid === pid);
  if (!known) {
    return sendJSON(res, 409, {
      error: 'That process is not one of the agents Ground Control currently sees in this project. It may have already exited — refresh and try again.',
      pid,
    });
  }

  // Guard 3 — never signal the session Ground Control is being operated from.
  if (known.isSelf) {
    return sendJSON(res, 409, {
      error: 'That is the Claude Code session Ground Control is running from. Stopping it would end the session asking for it, so Ground Control will not signal it.',
      pid,
      isSelf: true,
    });
  }

  // Guard 2 — re-verify the pid right now, immediately before signalling.
  const ok = await agentslib.verifyAgentPid(pid, project.path);
  if (!ok.ok) {
    return sendJSON(res, 409, { error: ok.reason, pid });
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = err && err.code;
    if (code === 'ESRCH') return sendJSON(res, 409, { error: 'That process has already exited.', pid });
    if (code === 'EPERM') return sendJSON(res, 403, { error: 'Not permitted to signal that process.', pid });
    return sendError(res, 500, `could not stop the process: ${(err && err.message) || err}`);
  }

  return sendJSON(res, 200, {
    stopped: true,
    pid,
    projectId: project.id,
    signal: 'SIGTERM',
    note: 'SIGTERM sent. Claude Code exits on its own terms; if the process is mid-turn it may take a few seconds to go.',
  });
}

/* ---- GET /api/editors ---------------------------------------------- */

async function workbenchEditors(res, query) {
  const id = query ? query.get('id') : null;
  let editors;
  try {
    if (id) {
      const project = await findProject(id);
      if (!project) return sendError(res, 404, 'unknown project');
      editors = editorslib.editorsForProject(project.path);
    } else {
      editors = editorslib.detectEditors().map((e) => Object.assign({}, e));
    }
  } catch (err) {
    console.error('[workbench] editor detection failed:', (err && err.message) || err);
    editors = [];
  }
  return sendJSON(res, 200, { editors });
}

/* ---- POST /api/open ------------------------------------------------ */

/**
 * Open a project — or one file inside it — in a local editor.
 *
 * 403 a path that escapes the project, 404 an unknown project/editor/file,
 * 409 an editor that is not available here.
 */
async function workbenchOpen(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.message || 'bad request'); }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return sendError(res, 400, 'id is required');

  const project = await findProject(id);
  if (!project) return sendError(res, 404, 'unknown project');

  const editorId = typeof body.editor === 'string' && body.editor ? body.editor : 'vscode';
  const available = editorslib.editorsForProject(project.path);
  const editor = available.find((e) => e.id === editorId);
  if (!editor) return sendError(res, 404, 'unknown editor');
  if (!editor.available) {
    return sendError(res, 409, editor.note || `${editor.name} is not available on this machine`);
  }

  /* Gate 1–3 on the project directory itself: it must resolve, and realpath,
   * inside the scanned root. */
  let projectAbs;
  try {
    const rel = path.relative(ROOT, project.path);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new PathError('forbidden path');
    projectAbs = resolveInside(ROOT, rel.split(path.sep).join('/'));
  } catch {
    return sendError(res, 403, 'forbidden path');
  }

  /* Gate 1–3 on the optional file, anchored on the project. Identical to the
   * guard /api/doc uses: rejects `..`, absolute paths and escaping symlinks. */
  let fileAbs = null;
  if (body.file != null) {
    if (typeof body.file !== 'string' || !body.file) return sendError(res, 400, 'file must be a string');
    try {
      fileAbs = resolveInside(project.path, body.file);
    } catch (err) {
      return sendError(res, err instanceof PathError ? 403 : 400, 'forbidden path');
    }
    let st;
    try { st = await fsp.stat(fileAbs); } catch { return sendError(res, 404, 'not found'); }
    if (!st.isFile()) return sendError(res, 404, 'not found');
  }

  const line = Number.isFinite(Number(body.line)) && Number(body.line) > 0
    ? Math.min(Math.floor(Number(body.line)), 1_000_000)
    : null;

  let result;
  try {
    result = await editorslib.openIn(editor.id, projectAbs, { root: ROOT, file: fileAbs, line });
  } catch (err) {
    return sendError(res, 500, `the editor could not be launched: ${(err && err.message) || err}`);
  }
  if (!result.ok) return sendError(res, result.status || 500, result.error || 'the editor could not be launched');

  return sendJSON(res, 200, { ok: true, opened: result.opened, editor: result.editor });
}

/* ---- GET /api/agents ----------------------------------------------- */

async function workbenchAgents(res, query) {
  const payload = await getScan(query && query.get('fresh') === '1');
  let map;
  try {
    map = await agentslib.agentActivity(payload.projects, {
      budgetMs: AGENT_BUDGET_MS,
      excludePids: generate.forgePids(),      // never report Forge as the user's agent
    });
  } catch (err) {
    console.error('[workbench] agent sweep failed:', (err && err.message) || err);
    return sendJSON(res, 200, { activity: {}, scannedAt: new Date().toISOString(), budgetExceeded: true });
  }
  const activity = {};
  for (const [id, a] of map) activity[id] = a;
  return sendJSON(res, 200, {
    activity,
    scannedAt: map.scannedAt || new Date().toISOString(),
    budgetExceeded: Boolean(map.budgetExceeded),
  });
}

/* ---- GET /api/agents/:id ------------------------------------------- */

async function workbenchAgentDetail(res, id) {
  if (!id) return sendError(res, 404, 'unknown project');
  const project = await findProject(id);
  if (!project) return sendError(res, 404, 'unknown project');
  let detail;
  try {
    detail = await agentslib.projectAgentDetail(project);
  } catch (err) {
    console.error('[workbench] agent detail failed:', (err && err.message) || err);
    return sendError(res, 500, 'agent detail unavailable');
  }
  return sendJSON(res, 200, Object.assign({ projectId: project.id, projectName: project.name }, detail));
}


/* ================================================================== *
 * GROUND_CONTROL RECLAIM — flag and remove dead folders (CONTRACT-RECLAIM.md §5)
 *
 * Appended below Workbench. Nothing above was restructured; `route()` gained
 * one dispatch block for `/api/reclaim`.
 *
 * This is the only destructive endpoint in Ground Control. Its posture:
 *
 *   §0 — Nothing is ever permanently deleted. `lib/reclaim.js` moves a folder
 *        to `~/.Trash` with `fs.rename`. There is no permanent-delete route,
 *        no query parameter that enables one, and no "empty trash".
 *   §3 — Blockers are hard refusals. The assessment is re-run inside
 *        `trashProject()` at call time; a client-supplied assessment is never
 *        read, and any blocker returns 409 with the list.
 *   §4 — One project per request. There is deliberately no bulk endpoint.
 *   §5 — Both GET routes are pure reads: they scan and assess, and mutate
 *        nothing on disk.
 * ================================================================== */

import * as reclaimlib from './lib/reclaim.js';

async function handleReclaim(req, res, pathname, query) {
  /* GET /api/reclaim — every assessment, one agent sweep. */
  if (pathname === '/api/reclaim') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
    return reclaimAll(res, query);
  }

  const rest = pathname.slice('/api/reclaim/'.length);
  if (!rest) return sendError(res, 404, 'unknown endpoint');

  /* POST /api/reclaim/:id/trash */
  if (rest.endsWith('/trash')) {
    const id = safeDecode(rest.slice(0, -'/trash'.length));
    if (id === null) return sendError(res, 400, 'bad request');
    if (!id) return sendError(res, 404, 'unknown project');
    if (!reclaimIdIsPlain(id)) return sendError(res, 403, 'forbidden path');
    if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
    return reclaimTrash(req, res, id);
  }

  /* GET /api/reclaim/:id */
  if (rest.indexOf('/') !== -1) return sendError(res, 404, 'unknown endpoint');
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
  const id = safeDecode(rest);
  if (id === null) return sendError(res, 400, 'bad request');
  if (!id) return sendError(res, 404, 'unknown project');
  if (!reclaimIdIsPlain(id)) return sendError(res, 403, 'forbidden path');
  return reclaimOne(res, id);
}

/**
 * A project id is a slug. Anything that decodes into a path — a separator, a
 * `..` segment, a NUL — is refused outright rather than handed to a lookup,
 * so `/api/reclaim/..%2F..%2Fetc/trash` never even reaches the scan.
 */
function reclaimIdIsPlain(id) {
  if (typeof id !== 'string' || !id || id.length > 200) return false;
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return false;
  if (id === '.' || id === '..') return false;
  return true;
}

/* ---- GET /api/reclaim ---------------------------------------------- */

async function reclaimAll(res, query) {
  const payload = await getScan(query && query.get('fresh') === '1');
  let result;
  try {
    result = await reclaimlib.assessAll(payload.projects, { root: ROOT });
  } catch (err) {
    console.error('[reclaim] assessment failed:', (err && err.stack) || err);
    return sendError(res, 500, 'the reclaim assessment could not be run');
  }
  return sendJSON(res, 200, {
    root: ROOT,
    assessments: result.assessments,
    scannedAt: result.scannedAt,
  });
}

/* ---- GET /api/reclaim/:id ------------------------------------------ */

async function reclaimOne(res, id) {
  const project = await findProject(id);
  if (!project) return sendError(res, 404, 'unknown project');
  let assessment;
  try {
    assessment = await reclaimlib.assessProject(project, { root: ROOT });
  } catch (err) {
    console.error('[reclaim] assessment failed:', (err && err.stack) || err);
    return sendError(res, 500, 'the reclaim assessment could not be run');
  }
  return sendJSON(res, 200, assessment);
}

/* ---- POST /api/reclaim/:id/trash ----------------------------------- *
 *
 * The one destructive call. Everything that decides whether it proceeds lives
 * in `lib/reclaim.js` and runs again here, at call time: the assessment, the
 * typed-name match, and the three path gates. Nothing in the request body
 * influences any of them except `confirmName`, which is only ever compared for
 * equality against the project's real directory name.
 */

async function reclaimTrash(req, res, id) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.message || 'bad request'); }

  const project = await findProject(id);
  if (!project) return sendError(res, 404, 'unknown project');

  /* The three path gates, before anything else is even discussed: the target
   * must be a plain directory sitting directly in the scanned root — not the
   * root, not nested, not a symlink, not Ground Control. `trashProject()` runs the
   * identical check again; this one is here so the refusal is a 403 that names
   * the reason, rather than being folded into the blocker list. */
  const gate = reclaimlib.checkDirectChild(ROOT, project);
  if (!gate.ok) return sendError(res, 403, `forbidden path — ${gate.reason}`);

  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : null;
  // Explicit override of the soft (judgement) blockers, so a folder that was
  // never flagged for reclamation can still be trashed by its owner. Hard
  // blockers ignore this entirely — see HARD_BLOCKERS in lib/reclaim.js.
  const force = body.force === true;

  let result;
  try {
    result = await reclaimlib.trashProject(project, { confirmName, root: ROOT, force });
  } catch (err) {
    const status = Number(err && err.status) || 500;
    if (status === 409) {
      return sendJSON(res, 409, {
        error: err.message || 'this project cannot be removed',
        blockers: err.blockers || [],
        hardBlockers: err.hardBlockers || [],
        softBlockers: err.softBlockers || [],
        // Tells the client whether to offer an override at all.
        overridable: Boolean(err.overridable),
        assessment: err.assessment || null,
      });
    }
    if (status >= 500) console.error('[reclaim] trash failed:', (err && err.stack) || err);
    return sendError(res, status, (err && err.message) || 'the folder could not be moved to the Trash');
  }

  // The project is gone from the root — make every other view agree.
  getScan(true).catch(() => {});

  return sendJSON(res, 200, {
    ok: true,
    trashedTo: result.trashedTo,
    manifest: result.manifest,
    restoreHint: 'Open the Trash and drag it back out to restore it.',
  });
}
