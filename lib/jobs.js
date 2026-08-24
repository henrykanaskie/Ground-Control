/**
 * Ground Control Forge: the job registry.
 *
 * An in-memory map plus an EventEmitter. Deliberately dumb: it knows nothing
 * about subprocesses or HTML. `lib/generate.js` registers a canceller with
 * `setCanceller()`, which keeps the dependency one-directional
 * (generate -> jobs) and lets the server cancel without touching a child pid.
 *
 * See CONTRACT-FORGE.md §5.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const MAX_JOBS = 50;
const MAX_PROGRESS = 200;

const jobs = new Map();          // jobId -> Job
const cancellers = new Map();    // jobId -> () => void
const emitter = new EventEmitter();
emitter.setMaxListeners(0);      // SSE clients; the cap is our own cleanup, not Node's

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** The document kinds Forge can produce, and the file each one saves as. */
const KINDS = new Map([
  ['onboarding', 'ONBOARDING.html'],
  ['design', 'DESIGN.html'],
  ['code', 'CODE.html'],
]);

function normalizeKind(k) {
  return KINDS.has(k) ? k : 'onboarding';
}

function filenameForKind(k) {
  return KINDS.get(normalizeKind(k)) || 'ONBOARDING.html';
}

/** Channel for cross-job lifecycle events; job ids are `job_*`, so no clash. */
const LIFECYCLE = '*lifecycle';

function isTerminal(state) { return TERMINAL.has(state); }

/** `job_a1b2c3`: short, url-safe, unique against the live map. */
function newJobId() {
  let id;
  do {
    id = 'job_' + Math.random().toString(36).slice(2, 8);
  } while (jobs.has(id));
  return id;
}

/**
 * Create and register a job. Returns the stored object (mutated in place by
 * `update`, so callers can hold on to it).
 */
function create({ projectId, projectName, kind, tier, model, audience, stagingPath, suggestedFilename, jobId }) {
  const id = jobId || newJobId();
  const job = {
    id,
    projectId,
    projectName,
    // What document this is. `tier` is how it gets made; `kind` is what it is.
    kind: normalizeKind(kind),
    tier: tier || 'authored',
    model: model || null,
    audience: audience || null,
    state: 'queued',
    startedISO: new Date().toISOString(),
    endedISO: null,
    progress: [],
    stagingPath: stagingPath || null,
    bytes: 0,
    costUsd: null,
    durationMs: null,
    error: null,
    errorKind: null,
    suggestedFilename: suggestedFilename || filenameForKind(kind),
    savedTo: null,
  };
  jobs.set(id, job);
  persist(job);
  evict();
  emitter.emit(id, 'created', job);
  emitter.emit(LIFECYCLE, 'created', job);
  return job;
}

/**
 * Subscribe to job *lifecycle* changes across every project: a job starting,
 * and a job reaching a terminal state. Returns an unsubscribe.
 *
 * Deliberately NOT fired per progress line. The only consumer is the SSE
 * layer, where each notification costs a full project rescan; a generation
 * emits dozens of progress lines and would turn the dashboard into a scan
 * loop. Start and finish is all the grid needs to show or clear its indicator.
 */
function subscribeAll(fn) {
  if (typeof fn !== 'function') return () => {};
  const handler = (event, job) => { try { fn(event, job); } catch { /* one bad listener must not stop the rest */ } };
  emitter.on(LIFECYCLE, handler);
  return () => { emitter.off(LIFECYCLE, handler); };
}

function get(id) {
  return jobs.get(id) || null;
}

/** Newest first. */
function list() {
  return [...jobs.values()].sort((a, b) => (a.startedISO < b.startedISO ? 1 : -1));
}

function running() {
  return list().filter((j) => j.state === 'queued' || j.state === 'running');
}

/** The in-flight job for a project, or null. One per project (contract §5). */
function runningForProject(projectId) {
  return running().find((j) => j.projectId === projectId) || null;
}

/**
 * Merge `patch` into the job and notify subscribers. A job that has already
 * reached a terminal state is frozen; a late event from a dying child must
 * never resurrect a cancelled job or turn a failure into a success.
 */
function update(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  if (isTerminal(job.state) && patch.state && patch.state !== job.state) return job;
  if (isTerminal(job.state) && !patch.state) {
    // Allow post-terminal bookkeeping (savedTo) but nothing else meaningful.
    if (!('savedTo' in patch)) return job;
  }

  Object.assign(job, patch);
  if (patch.state && isTerminal(patch.state) && !job.endedISO) {
    job.endedISO = new Date().toISOString();
  }
  if (patch.state && isTerminal(patch.state)) cancellers.delete(id);

  // Only on a real transition or post-terminal bookkeeping, never per
  // progress line. The terminal write carries the whole progress array.
  if (patch.state || 'savedTo' in patch) persist(job);

  emitter.emit(id, patch.state && isTerminal(patch.state)
    ? (patch.state === 'done' ? 'done' : 'failed')
    : 'progress', job);
  // Lifecycle only: a terminal transition clears the grid's indicator.
  if (patch.state && isTerminal(patch.state)) emitter.emit(LIFECYCLE, patch.state, job);
  return job;
}

/** Append one progress line (capped at 200, oldest dropped) and notify. */
function appendProgress(id, text) {
  const job = jobs.get(id);
  if (!job || isTerminal(job.state)) return null;
  const line = { atISO: new Date().toISOString(), text: String(text).slice(0, 400) };
  job.progress.push(line);
  if (job.progress.length > MAX_PROGRESS) job.progress.splice(0, job.progress.length - MAX_PROGRESS);
  emitter.emit(id, 'progress', job, line);
  return line;
}

/** Register the function that stops the underlying work for this job. */
function setCanceller(id, fn) {
  if (typeof fn === 'function') cancellers.set(id, fn);
}

/**
 * Cancel a job: kill the child, mark it `cancelled`.
 * Returns the job, or null if unknown. Cancelling a finished job is a no-op.
 */
function cancel(id, reason = 'cancelled by user') {
  const job = jobs.get(id);
  if (!job) return null;
  if (isTerminal(job.state)) return job;

  const fn = cancellers.get(id);
  cancellers.delete(id);
  if (fn) { try { fn(); } catch { /* the child may already be gone */ } }

  appendProgress(id, reason);
  return update(id, { state: 'cancelled', error: reason, errorKind: 'cancelled' });
}

/**
 * Subscribe to one job's events. `fn(event, job, line?)` where event is
 * `created | progress | done | failed`. Returns an unsubscribe function.
 */
function subscribe(id, fn) {
  const handler = (...args) => {
    try { fn(...args); } catch { /* a broken subscriber must not stop the job */ }
  };
  emitter.on(id, handler);
  return () => { try { emitter.off(id, handler); } catch { /* ignore */ } };
}

/** Keep at most MAX_JOBS, evicting the oldest finished job first. */
function evict() {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => isTerminal(j.state))
    .sort((a, b) => (a.endedISO || a.startedISO) < (b.endedISO || b.startedISO) ? -1 : 1);
  while (jobs.size > MAX_JOBS && finished.length) {
    const victim = finished.shift();
    forget(victim);
    jobs.delete(victim.id);
    cancellers.delete(victim.id);
    emitter.removeAllListeners(victim.id);
  }
  // Everything still running and still over cap: drop the oldest regardless.
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => (a.startedISO < b.startedISO ? -1 : 1))[0];
    if (!oldest) break;
    forget(oldest);
    jobs.delete(oldest.id);
    cancellers.delete(oldest.id);
    emitter.removeAllListeners(oldest.id);
  }
}


/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * The registry is in memory, which used to mean a generated-but-unsaved
 * artifact became unreachable the moment the app restarted: the staged HTML
 * was still on disk, but nothing mapped a project back to it, so the card
 * showed no artifact and the file was orphaned forever.
 *
 * Each job therefore gets a JSON sidecar written next to its staged HTML:
 * `<staging>/<projectId>/<jobId>.json` beside `<jobId>.html`. Deriving the
 * path from `stagingPath` rather than rebuilding it from `projectId` means the
 * two can never disagree, and the sidecar inherits whatever path validation
 * the caller already applied to the staging path.
 *
 * Writes are synchronous and happen only on create and on state transitions
 * (never per progress line), so this is a handful of small writes per job. The
 * final `done` transition carries the whole progress array with it.
 */
let persistDir = null;

function setPersistDir(dir) {
  persistDir = dir || null;
}

function sidecarFor(job) {
  if (!persistDir || !job || typeof job.stagingPath !== 'string') return null;
  if (!job.stagingPath.endsWith('.html')) return null;
  return job.stagingPath.slice(0, -'.html'.length) + '.json';
}

function persist(job) {
  const file = sidecarFor(job);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(job), 'utf8');
  } catch { /* persistence is best-effort; never break a generation over it */ }
}

function forget(job) {
  const file = sidecarFor(job);
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
}

/** Shape check: a truncated or hand-edited sidecar must not enter the map. */
function looksLikeJob(o) {
  return o && typeof o === 'object'
    && typeof o.id === 'string' && o.id
    && typeof o.projectId === 'string' && o.projectId
    && typeof o.state === 'string'
    && typeof o.stagingPath === 'string';
}

/**
 * Rebuild the registry from the sidecars under `forgeRoot`. Returns a summary.
 *
 * Two rules matter here:
 *
 *   1. A job that was still `queued` or `running` when the process died is NOT
 *      restored as running. Its subprocess went with the process, nothing will
 *      ever finish it, and leaving it running would block the project's
 *      one-job-at-a-time rule forever. It comes back `failed`, saying so.
 *   2. A `done` job whose staged HTML has since been pruned is dropped
 *      entirely rather than restored, because preview and save would both 404
 *      on it and an artifact you cannot open is worse than one that is absent.
 */
function hydrate(forgeRoot) {
  const summary = { restored: 0, interrupted: 0, dropped: 0 };
  if (!forgeRoot) return summary;

  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(forgeRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(forgeRoot, d.name));
  } catch { return summary; }

  const found = [];
  for (const dir of projectDirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
      catch { continue; }
      if (!looksLikeJob(parsed)) continue;
      found.push(parsed);
    }
  }

  // Newest first, so the MAX_JOBS cap keeps the most useful ones.
  found.sort((a, b) => (String(b.startedISO || '')).localeCompare(String(a.startedISO || '')));

  for (const job of found) {
    if (jobs.size >= MAX_JOBS) break;
    if (jobs.has(job.id)) continue;

    let staged = false;
    try { staged = fs.statSync(job.stagingPath).isFile(); } catch { staged = false; }

    if (!isTerminal(job.state)) {
      job.state = 'failed';
      job.errorKind = 'interrupted';
      job.error = 'Ground Control restarted while this generation was still running, so it never finished. Generate it again.';
      if (!job.endedISO) job.endedISO = new Date().toISOString();
      summary.interrupted++;
    } else if (job.state === 'done' && !staged) {
      forget(job);
      summary.dropped++;
      continue;
    }

    if (!Array.isArray(job.progress)) job.progress = [];
    job.restored = true;
    jobs.set(job.id, job);
    summary.restored++;
    persist(job);
  }

  return summary;
}

/** Public view of a job: the shape the API returns (contract §4). */
function toJSON(job) {
  if (!job) return null;
  return {
    id: job.id,
    projectId: job.projectId,
    projectName: job.projectName,
    kind: job.kind || 'onboarding',
    restored: Boolean(job.restored),
    tier: job.tier,
    model: job.model,
    state: job.state,
    startedISO: job.startedISO,
    endedISO: job.endedISO,
    progress: job.progress,
    stagingPath: job.stagingPath,
    bytes: job.bytes,
    costUsd: job.costUsd,
    durationMs: job.durationMs,
    error: job.error,
    errorKind: job.errorKind,
    suggestedFilename: job.suggestedFilename,
    savedTo: job.savedTo,
  };
}

/** Cancel everything in flight: used on server shutdown. */
function cancelAll(reason = 'server shutting down') {
  for (const j of running()) cancel(j.id, reason);
}

export {
  create, get, list, running, runningForProject, update, appendProgress,
  setPersistDir, hydrate, subscribeAll,
  KINDS, normalizeKind, filenameForKind,
  setCanceller, cancel, cancelAll, subscribe, toJSON, newJobId, isTerminal,
  MAX_JOBS, MAX_PROGRESS,
};
