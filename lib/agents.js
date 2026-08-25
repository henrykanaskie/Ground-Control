/**
 * Ground Control Workbench: agent activity detection (CONTRACT-WORKBENCH.md §3).
 *
 * Answers one question for every project: "is a coding agent working in here
 * right now, and what was the last thing it did?"
 *
 * Three hard rules shape every line below.
 *
 *   1. OBSERVE, NEVER MANAGE. Nothing in this module kills or signals a
 *      process; the only process work here is reading `ps` and `lsof`.
 *      `verifyAgentPid` exists for the stop endpoint but only reads; the
 *      `process.kill` lives in the HTTP handler, so this module's observe-only
 *      property stays intact and testable (CONTRACT-WORKBENCH.md §3a).
 *   2. READ-ONLY UNDER ~/.claude. Nothing here writes, moves, or deletes
 *      anything in the transcript store. Every handle is opened 'r'.
 *   3. PRIVACY. Transcripts are the user's own conversations. Only short status
 *      labels and a bounded `recentEvents` list ever leave this module, every
 *      snippet hard-truncated at 120 characters. Transcripts reach 9 MB+, so
 *      they are never read whole, only a <=256 KB tail, plus a small head slice
 *      for a session start time.
 *
 * Everything is best-effort: a missing `ps`, a missing `lsof`, an unreadable
 * ~/.claude/projects, or a malformed transcript line degrades to state "none".
 * No failure in here may ever fail a scan or crash the server.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { relativeTime, toISO, collapseWhitespace } from './util.js';

/* ------------------------------------------------------------------ *
 * Budgets and limits
 * ------------------------------------------------------------------ */

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

/** Whole-sweep budget. Overrun returns partial results, never a slow scan. */
const SWEEP_BUDGET_MS = 1500;

const PS_TIMEOUT_MS = 1000;
const LSOF_TIMEOUT_MS = 1200;
const LSOF_PID_CHUNK = 180;          // keep the argv well inside ARG_MAX

const TAIL_BYTES = 256 * 1024;       // hard cap: never read a transcript whole
const HEAD_BYTES = 32 * 1024;        // enough for the first complete JSON line
const SNIPPET_MAX = 120;             // privacy cap on every surfaced string
const MAX_EVENTS = 25;
const MAX_SESSIONS = 12;
const COUNT_MAX_BYTES = 24 * 1024 * 1024;   // per-file cap for messageCount

const IDLE_WINDOW_MS = 24 * 60 * 60 * 1000;


/**
 * How recently a session must have been written for a *running* process to
 * count as an agent presence at all.
 *
 * A `claude` process proves nothing on its own. Measured on this machine:
 * seven processes sat in groupStat with cwd set and nothing written to their
 * transcripts for two to three days, and one in rLog for six: VS Code tabs
 * left open, not work. Reporting those as agents is what makes the dashboard
 * claim an agent is running when nothing is happening, and it is the single
 * biggest source of false positives in this module.
 *
 * Beyond this window the process is treated as parked: it is still counted in
 * `parked`, so the truth stays available, but it no longer produces a live
 * agent presence. 90 minutes is deliberately generous: long enough to survive
 * a break mid-session, short enough that yesterday's abandoned tab is gone.
 */
const OPEN_WINDOW_MS = 90 * 60 * 1000;

/**
 * Upper bound on how long a session may sit mid-turn and still count as
 * working. Turn state (below) is the real signal, but it is read from a file:
 * kill a process while a tool is running and the last thing written is that
 * `tool_use`, so the transcript would claim "working" forever. Ten minutes is
 * longer than any tool call this tool cares about, short enough that a crashed
 * agent stops claiming to be busy.
 */
const STALL_WINDOW_MS = 10 * 60 * 1000;

/** Tail reads per project per sweep. Bounds the cost of turn detection. */
const TURN_READS_MAX = 6;

/* Caches. The lsof-per-PID step is the expensive part, so the process sweep is
 * batched into one call and cached; directory listings and parsed tails are
 * cached too so repeat requests inside a few seconds cost nothing.
 *
 * PROC_TTL_MS must sit ABOVE the SSE agent poller's interval (AGENT_POLL_MS,
 * 5000ms in server.js). That poller calls agentActivity with fresh:true on
 * every tick, and at a 2500ms TTL the cached sweep had always expired by the
 * time the next poll arrived, so every single poll paid a full ps + lsof
 * sweep, measured at 226ms of work versus ~0ms on a cache hit, burning
 * roughly 4-5% of a core continuously at idle. 6000ms carries one poll's
 * sweep to the next with margin for tick jitter; drop it back under 5000 and
 * the cache silently stops working. */
const PROC_TTL_MS = 6000;
const DIR_TTL_MS = 4000;
const SESS_TTL_MS = 4000;
const ACT_TTL_MS = 2000;
const TAIL_CACHE_MAX = 60;

let procCache = null;          // { at, procs }
let procInFlight = null;       // dedupe concurrent sweeps onto one `ps`
let dirCache = null;           // { at, exact:Map, normal:Map }
const sessCache = new Map();   // dirName -> { at, sessions }
let actCache = null;           // { at, key, map }
const tailCache = new Map();   // `${file}:${size}:${mtime}` -> { events }
const realpathCache = new Map();

/* ------------------------------------------------------------------ *
 * Tiny helpers
 * ------------------------------------------------------------------ */

/** execFile that never throws and never rejects. Resolves stdout or null. */
function run(cmd, args, timeout, maxBuffer) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = execFile(
        cmd, args,
        { timeout, maxBuffer, encoding: 'utf8', windowsHide: true },
        // lsof exits non-zero when a PID has gone away but still prints the
        // rest, so partial stdout is kept rather than discarded.
        (err, stdout) => done(err && !stdout ? null : (stdout || '')),
      );
    } catch {
      return done(null);
    }
    child.on('error', () => done(null));
  });
}

/** Hard privacy cap. Every string that leaves this module goes through here. */
function snippet(s, max = SNIPPET_MAX) {
  const t = collapseWhitespace(String(s == null ? '' : s));
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

function realpathOf(p) {
  const hit = realpathCache.get(p);
  if (hit !== undefined) return hit;
  let v = p;
  try { v = fs.realpathSync(p); } catch { v = p; }
  if (realpathCache.size > 400) realpathCache.clear();
  realpathCache.set(p, v);
  return v;
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** `[[dd-]hh:]mm:ss` (BSD ps etime) -> milliseconds, or null. */
function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  const [, d, hh, mm, ss] = m;
  return ((Number(d || 0) * 86400) + (Number(hh || 0) * 3600) + (Number(mm) * 60) + Number(ss)) * 1000;
}

/* ------------------------------------------------------------------ *
 * Live processes
 * ------------------------------------------------------------------ */

/**
 * One `ps` for the whole sweep.
 *
 * `comm` is used rather than `command` deliberately: a real install path is
 * `~/Library/Application Support/Claude/.../claude`, whose spaces make argv[0]
 * impossible to split out of a command line reliably, and the launcher
 * `/Applications/Claude.app/Contents/Helpers/disclaimer <path>/claude …` would
 * then be counted a second time for the same session. `comm` is the executable
 * itself, so `basename(comm) === 'claude'` is exact.
 */
async function listProcesses() {
  if (procCache && Date.now() - procCache.at < PROC_TTL_MS) return procCache.procs;
  // A sweep abandoned at the budget leaves its `ps` in flight; a later caller
  // joins that call instead of spawning a second one.
  if (procInFlight) return procInFlight;
  procInFlight = sweepProcesses().finally(() => { procInFlight = null; });
  return procInFlight;
}

/**
 * Which Claude Code install a process came from. Purely cosmetic, but it is
 * what lets a person recognise a process on sight: "VS Code extension, 3 days
 * old" reads very differently from "desktop session, 2 minutes old", and that
 * distinction is the whole difference between an abandoned tab and real work.
 */
function originOf(comm) {
  const c = String(comm || '');
  if (/\.vscode\/extensions\//.test(c) || /\.vscode-server\//.test(c)) return 'vscode';
  if (/[/.]claude\.app\//i.test(c) || /Claude\.app\//.test(c)) return 'desktop';
  if (/\.claude\/local\/|\.local\/bin\//.test(c)) return 'cli';
  return 'other';
}

/**
 * PIDs on this process's own ancestry chain.
 *
 * A claude process that is one of our ancestors is the session Ground Control is
 * being *run from*. It gets labelled in the UI so it stops reading as a
 * mystery agent, and, more importantly, the stop endpoint refuses to signal
 * it, because killing it would kill the conversation asking for the kill.
 *
 * Note the limit: when Ground Control runs as the packaged app the server is spawned
 * by GroundControl.app, so an unrelated desktop Claude session working in the same
 * project is NOT an ancestor and cannot be identified this way. The per-process
 * detail is what makes that case recognisable.
 */
function selfAncestry(parentOf) {
  const chain = new Set();
  let cur = process.pid;
  for (let hops = 0; hops < 64 && Number.isFinite(cur) && cur > 1; hops++) {
    chain.add(cur);
    const next = parentOf.get(cur);
    if (next === undefined || next === cur) break;
    cur = next;
  }
  return chain;
}

async function sweepProcesses() {
  const out = await run('ps', ['-ax', '-o', 'pid=,ppid=,stat=,etime=,comm='], PS_TIMEOUT_MS, 16 * 1024 * 1024);
  if (out == null) {
    procCache = { at: Date.now(), procs: [] };
    return procCache.procs;
  }

  const procs = [];
  // Every process, not just the claude ones: the ancestry walk below passes
  // through shells and launchers, so a claude-only table cannot resolve it.
  const parentOf = new Map();
  for (const line of out.split('\n')) {
    // `comm` is last and may itself contain spaces, so only the leading four
    // fixed-width columns are split off.
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d:-]+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    parentOf.set(Number(m[1]), Number(m[2]));
    const comm = m[5];
    const base = comm.slice(comm.lastIndexOf('/') + 1);
    if (base !== 'claude') continue;
    // A zombie has exited and is only waiting to be reaped. It is a dead
    // process that `ps` still lists, and counting it as an agent is how a
    // finished session keeps being reported as running.
    const stat = m[3];
    if (stat.charAt(0) === 'Z') continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      stat,
      uptimeMs: parseEtime(m[4]),
      comm,
      origin: originOf(comm),
      cwd: null,
    });
  }

  // Attach a working directory to each candidate. Batched: one lsof for up to
  // ~180 PIDs instead of one per PID.
  if (procs.length) {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    for (const group of chunk(procs.map((p) => p.pid), LSOF_PID_CHUNK)) {
      const txt = await run(
        'lsof', ['-a', '-p', group.join(','), '-d', 'cwd', '-Fpn'],
        LSOF_TIMEOUT_MS, 8 * 1024 * 1024,
      );
      if (!txt) continue;
      let cur = null;
      for (const line of txt.split('\n')) {
        if (!line) continue;
        const tag = line[0];
        const val = line.slice(1);
        if (tag === 'p') cur = byPid.get(Number(val)) || null;
        else if (tag === 'n' && cur && !cur.cwd) cur.cwd = val;
      }
    }
  }

  const mine = selfAncestry(parentOf);
  for (const p of procs) p.isSelf = mine.has(p.pid);

  procCache = { at: Date.now(), procs };
  return procs;
}


/**
 * Confirm, right now and without touching any cache, that `pid` is still a
 * live `claude` process whose cwd sits inside `projectPath`.
 *
 * This exists for exactly one caller: the stop endpoint, immediately before it
 * signals. Every other read in this module is allowed to be a few seconds
 * stale; a kill is not. Between a sweep and a click the operating system is
 * free to reuse a pid, and signalling on stale data is the one way this
 * feature could touch a process that was never an agent.
 */
async function verifyAgentPid(pid, projectPath) {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: 'invalid pid' };

  const psOut = await run('ps', ['-o', 'stat=,comm=', '-p', String(pid)], PS_TIMEOUT_MS, 64 * 1024);
  if (psOut == null || !psOut.trim()) {
    return { ok: false, reason: 'That process has already exited.' };
  }
  const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(psOut.split('\n')[0] || '');
  if (!m) return { ok: false, reason: 'Could not read that process.' };
  if (m[1].charAt(0) === 'Z') return { ok: false, reason: 'That process has already exited.' };
  const comm = m[2];
  if (comm.slice(comm.lastIndexOf('/') + 1) !== 'claude') {
    return { ok: false, reason: 'That pid is no longer a Claude Code process: it has been reused by something else. Nothing was signalled.' };
  }

  const lsofOut = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], LSOF_TIMEOUT_MS, 256 * 1024);
  let cwd = null;
  for (const line of String(lsofOut || '').split('\n')) {
    if (line.charAt(0) === 'n') { cwd = line.slice(1); break; }
  }
  if (!cwd) return { ok: false, reason: 'Could not confirm that process is working in this project. Nothing was signalled.' };

  const base = projectPath;
  const real = realpathOf(projectPath);
  if (!isInside(cwd, base) && !isInside(cwd, real)) {
    return { ok: false, reason: 'That process is no longer working in this project. Nothing was signalled.' };
  }

  return { ok: true, cwd, comm };
}

/* ------------------------------------------------------------------ *
 * Transcript directories
 * ------------------------------------------------------------------ */

/** Claude Code's directory encoding: `/`, `_` and `.` all collapse to `-`. */
function encodeProjectPath(p) {
  return String(p).replace(/[/_.]/g, '-');
}

/**
 * The encoding above is lossy: three different characters map to one, so an
 * exact lookup can silently miss. Every candidate is therefore also reduced to
 * a normalized form (lowercase, every run of non-alphanumerics -> `-`) and the
 * directory listing is matched on that too.
 */
function normalizeKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
}

function listTranscriptDirs() {
  if (dirCache && Date.now() - dirCache.at < DIR_TTL_MS) return dirCache;

  const exact = new Map();     // dirName -> dirName
  const normal = new Map();    // normalized -> [dirName]
  let entries = [];
  try { entries = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true }); } catch { entries = []; }

  for (const d of entries) {
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(CLAUDE_PROJECTS, d.name)).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;
    exact.set(d.name, d.name);
    const key = normalizeKey(d.name);
    if (!normal.has(key)) normal.set(key, []);
    normal.get(key).push(d.name);
  }

  dirCache = { at: Date.now(), exact, normal };
  return dirCache;
}

/** Transcript directory name for an absolute project path, or null. */
function transcriptDirFor(absPath) {
  const dirs = listTranscriptDirs();
  if (!dirs.exact.size) return null;

  const candidates = [absPath];
  const real = realpathOf(absPath);
  if (real !== absPath) candidates.push(real);

  for (const c of candidates) {
    const enc = encodeProjectPath(c);
    if (dirs.exact.has(enc)) return enc;
  }
  // Lossy-encoding fallback: match on the normalized form instead.
  for (const c of candidates) {
    const hits = dirs.normal.get(normalizeKey(encodeProjectPath(c)));
    if (hits && hits.length) {
      if (hits.length === 1) return hits[0];
      // Ambiguous normalization: take the one touched most recently.
      let best = hits[0], bestAt = -1;
      for (const nm of hits) {
        let mt = 0;
        try { mt = fs.statSync(path.join(CLAUDE_PROJECTS, nm)).mtimeMs; } catch { mt = 0; }
        if (mt > bestAt) { bestAt = mt; best = nm; }
      }
      return best;
    }
  }
  return null;
}

/** `.jsonl` transcripts in a transcript directory, newest first. */
function sessionsIn(dirName) {
  if (!dirName) return [];
  const hit = sessCache.get(dirName);
  if (hit && Date.now() - hit.at < SESS_TTL_MS) return hit.sessions;

  const abs = path.join(CLAUDE_PROJECTS, dirName);
  const sessions = [];
  let list = [];
  try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch { list = []; }
  for (const d of list) {
    if (!d.name.endsWith('.jsonl')) continue;
    if (!d.isFile() && !d.isSymbolicLink()) continue;
    let st;
    try { st = fs.statSync(path.join(abs, d.name)); } catch { continue; }
    if (!st.isFile()) continue;
    sessions.push({
      id: d.name.slice(0, -6),
      file: path.join(abs, d.name),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (sessCache.size > 200) sessCache.clear();
  sessCache.set(dirName, { at: Date.now(), sessions });
  return sessions;
}

/* ------------------------------------------------------------------ *
 * Transcript reading: bounded, read-only, never whole
 * ------------------------------------------------------------------ */

/** Read at most `bytes` from the end of a file. Returns complete lines only. */
async function readTail(file, bytes = TAIL_BYTES) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    if (!st.size) return [];
    const want = Math.min(bytes, st.size);
    const start = st.size - want;
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, start);
    let text = buf.toString('utf8', 0, bytesRead);
    // A mid-line start is discarded so only complete JSON lines are parsed.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text.split('\n');
  } catch {
    return [];
  } finally {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
  }
}

/** Read at most `bytes` from the start of a file. Complete lines only. */
async function readHead(file, bytes = HEAD_BYTES) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const lines = text.split('\n');
    if (lines.length > 1) lines.pop();       // last one may be truncated
    return lines;
  } catch {
    return [];
  } finally {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
  }
}

/** Count newlines without holding the file in memory. Best-effort. */
function countLines(file, maxBytes = COUNT_MAX_BYTES) {
  return new Promise((resolve) => {
    let n = 0;
    let seen = 0;
    let stream;
    try {
      stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    } catch { return resolve(null); }
    stream.on('data', (buf) => {
      seen += buf.length;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
      if (seen >= maxBytes) { try { stream.destroy(); } catch { /* ignore */ } }
    });
    stream.on('error', () => resolve(null));
    stream.on('close', () => resolve(n));
    stream.on('end', () => resolve(n));
  });
}

/* ---- turning transcript lines into short, safe labels -------------- */

const NOISE_TYPES = new Set([
  'summary', 'system', 'attachment', 'queue-operation', 'last-prompt',
  'ai-title', 'file-history-snapshot', 'progress', 'compact-boundary',
]);

/** `/abs/project/lib/scan.js` -> `lib/scan.js` when it is inside the project. */
function relToProject(p, projectPath) {
  const s = String(p || '');
  if (!s) return '';
  if (projectPath && (s === projectPath || s.startsWith(projectPath + path.sep))) {
    const r = s.slice(projectPath.length + 1);
    return r || path.basename(s);
  }
  // Anything outside the project is reduced to a basename rather than leaking a
  // full filesystem path into the UI.
  return s.length > 48 ? path.basename(s) : s;
}

/** The one interesting argument of a tool call, as a short string. */
function toolArg(name, input, projectPath) {
  if (!input || typeof input !== 'object') return '';
  const n = String(name || '');
  if (typeof input.file_path === 'string') return relToProject(input.file_path, projectPath);
  if (typeof input.notebook_path === 'string') return relToProject(input.notebook_path, projectPath);
  if (typeof input.path === 'string') return relToProject(input.path, projectPath);
  if (n === 'Bash' && typeof input.command === 'string') return input.command;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description;
  if (typeof input.skill === 'string') return input.skill;
  if (typeof input.prompt === 'string') return input.prompt;
  return '';
}

/** Text out of a message `content` that may be a string or a block array. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const bits = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') bits.push(b.text);
  }
  return bits.join(' ');
}

/**
 * Parse transcript lines into at most `MAX_EVENTS` short events.
 * Malformed lines are skipped silently; tool *results* are deliberately
 * dropped: they are bulk output, not a timeline entry.
 */
function parseEvents(lines, projectPath, limit = MAX_EVENTS) {
  const events = [];
  for (const raw of lines) {
    if (!raw || raw.charCodeAt(0) !== 123 /* '{' */) continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (NOISE_TYPES.has(o.type)) continue;
    if (o.isSidechain === true) continue;

    const at = typeof o.timestamp === 'string' ? o.timestamp : null;
    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          events.push({ atISO: at, kind: 'assistant', label: snippet(b.text) });
        } else if (b.type === 'tool_use') {
          const nm = snippet(b.name || 'tool', 40);
          const arg = snippet(toolArg(b.name, b.input, projectPath), SNIPPET_MAX - nm.length - 1);
          events.push({ atISO: at, kind: 'tool', label: snippet(arg ? `${nm} ${arg}` : nm), tool: nm });
        }
      }
      continue;
    }

    if (msg.role === 'user') {
      // Skip pure tool-result turns: those are output being fed back in.
      if (Array.isArray(msg.content) && msg.content.every((b) => b && b.type !== 'text')) continue;
      const t = textOf(msg.content);
      if (!t.trim()) continue;
      if (/^<(command-name|local-command|command-message)/.test(t.trim())) continue;
      events.push({ atISO: at, kind: 'user', label: snippet(t) });
    }
  }
  return events.slice(-limit);
}

/** Cached parse of a transcript tail, keyed on size+mtime so edits invalidate. */
async function tailEvents(session, projectPath) {
  const key = `${session.file}:${session.sizeBytes}:${Math.round(session.mtimeMs)}`;
  const hit = tailCache.get(key);
  if (hit) return hit;
  const lines = await readTail(session.file, TAIL_BYTES);
  const events = parseEvents(lines, projectPath, MAX_EVENTS);
  if (tailCache.size > TAIL_CACHE_MAX) tailCache.clear();
  tailCache.set(key, events);
  return events;
}

const ACTION_VERB = {
  Edit: 'editing', MultiEdit: 'editing', Write: 'writing', NotebookEdit: 'editing',
  Read: 'reading', Grep: 'searching', Glob: 'looking for', Bash: 'running',
  BashOutput: 'watching', WebFetch: 'fetching', WebSearch: 'searching the web for',
  Task: 'delegating', Agent: 'delegating', TodoWrite: 'planning',
  Skill: 'running skill', SlashCommand: 'running',
};

/** A short "what is it doing right now" phrase, or null. */
function currentActionFrom(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'tool') {
      const sp = e.label.indexOf(' ');
      const name = sp === -1 ? e.label : e.label.slice(0, sp);
      const arg = sp === -1 ? '' : e.label.slice(sp + 1);
      const verb = ACTION_VERB[name];
      if (verb) return snippet(arg ? `${verb} ${arg}` : verb);
      return snippet(arg ? `${name} ${arg}` : name);
    }
    if (e.kind === 'assistant' && e.label) return snippet(e.label);
  }
  return null;
}

/**
 * Is this session mid-turn, or waiting for its human?
 *
 * An mtime cannot answer this. A session that finished replying thirty seconds
 * ago has a fresh mtime and is doing nothing at all: exactly the false
 * positive that kept the orbit spinning over an idle prompt.
 *
 * The transcript does answer it, from the shape of its last event:
 *
 *   - `tool`:      a tool was invoked; it is running, or its result is about
 *                   to come back. WORKING. This is also why a long tool call
 *                   does not flicker: nothing is written for its whole
 *                   duration, but the last event stays `tool`.
 *   - `user`:      a human said something the model has not answered yet.
 *                   WORKING.
 *   - `assistant`: the model emitted text and stopped. The turn is over and it
 *                   is waiting for input. IDLE.
 *
 * This relies on an ordering property of `parseEvents`: an assistant message's
 * text block is pushed *before* any `tool_use` in the same message, so a reply
 * that ends by calling a tool correctly reads as `tool`, not `assistant`.
 */
function turnStateOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i] && events[i].kind;
    if (k === 'tool' || k === 'user') return 'working';
    if (k === 'assistant') return 'idle';
  }
  return 'idle';
}

/* ------------------------------------------------------------------ *
 * Activity: the cheap, per-scan shape
 * ------------------------------------------------------------------ */

function emptyActivity() {
  return {
    live: 0,
    active: 0,
    parked: 0,
    state: 'none',
    // Every claude process attributed to this project, parked or not, so a
    // person can see exactly what Ground Control is reacting to.
    processes: [],
    lastSessionISO: null,
    lastSessionRelative: null,
    sessionCount: 0,
    currentAction: null,
    pids: [],
  };
}

/** cwd is inside project path (or is it). */
function isInside(cwd, base) {
  return cwd === base || cwd.startsWith(base + path.sep);
}

/**
 * Activity for every project in one sweep.
 *
 * Returns `Map<projectId, Activity>`. The Map also carries two own properties
 * for the HTTP layer: `budgetExceeded` and `scannedAt`.
 */
async function agentActivity(projects, opts = {}) {
  const list = Array.isArray(projects) ? projects.filter((p) => p && p.id && p.path) : [];
  const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : SWEEP_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const cacheKey = list.map((p) => p.id + '\u0000' + p.path).join('\u0001');

  if (!opts.fresh && actCache && actCache.key === cacheKey && Date.now() - actCache.at < ACT_TTL_MS) {
    return actCache.map;
  }

  const map = new Map();
  Object.defineProperty(map, 'budgetExceeded', { value: false, writable: true, enumerable: false });
  Object.defineProperty(map, 'scannedAt', { value: new Date().toISOString(), writable: true, enumerable: false });
  for (const p of list) map.set(p.id, emptyActivity());
  if (!list.length) return map;

  try {
    /* --- 1. live processes ---------------------------------------- */
    // `ps` + `lsof` carry their own timeouts, but the budget is the outer
    // authority: if they have not answered by the deadline the sweep returns
    // without them. The call keeps running and lands in the cache, so the next
    // request gets the answer for free.
    let procs = [];
    try {
      const OVERDUE = Symbol('overdue');
      const wait = Math.max(60, deadline - Date.now());
      let timer = null;
      const raced = await Promise.race([
        listProcesses(),
        new Promise((r) => { timer = setTimeout(() => r(OVERDUE), wait); }),
      ]);
      if (timer) clearTimeout(timer);
      if (raced === OVERDUE) { map.budgetExceeded = true; procs = []; }
      else procs = raced || [];
    } catch { procs = []; }

    // Longest matching project path wins, so a nested project keeps its own
    // agents instead of them rolling up into the parent.
    const bases = list
      .map((p) => ({ id: p.id, path: p.path, real: realpathOf(p.path) }))
      .sort((a, b) => b.path.length - a.path.length);

    // Forge shells out to `claude` inside the very project it is documenting.
    // Without this, generating an artifact makes that project report an agent:
    // Ground Control detecting itself and presenting it as the user's work.
    const skipPids = opts.excludePids instanceof Set
      ? opts.excludePids
      : new Set(Array.isArray(opts.excludePids) ? opts.excludePids : []);

    for (const proc of procs) {
      if (!proc.cwd) continue;
      if (skipPids.size && (skipPids.has(proc.pid) || skipPids.has(proc.ppid))) continue;
      let owner = null;
      let ownerLen = -1;
      for (const b of bases) {
        if (isInside(proc.cwd, b.path) && b.path.length > ownerLen) { owner = b; ownerLen = b.path.length; }
        if (b.real !== b.path && isInside(proc.cwd, b.real) && b.real.length > ownerLen) { owner = b; ownerLen = b.real.length; }
      }
      if (!owner) continue;                 // an agent outside every watched folder
      const a = map.get(owner.id);
      if (!a) continue;
      a.live++;
      a.pids.push(proc.pid);
      if (a.processes.length < 12) {
        a.processes.push({
          pid: proc.pid,
          origin: proc.origin || 'other',
          uptimeMs: proc.uptimeMs || 0,
          isSelf: Boolean(proc.isSelf),
        });
      }
      if (!a._procs) a._procs = [];
      a._procs.push(proc);
    }

    /* --- 2. transcripts ------------------------------------------- */
    const now = Date.now();
    for (const p of list) {
      const a = map.get(p.id);
      if (Date.now() > deadline) { map.budgetExceeded = true; break; }
      let dir = null;
      try { dir = transcriptDirFor(p.path); } catch { dir = null; }
      a._dir = dir;
      if (!dir) continue;
      let sessions = [];
      try { sessions = sessionsIn(dir); } catch { sessions = []; }
      a.sessionCount = sessions.length;
      if (sessions.length) {
        a.lastSessionISO = toISO(sessions[0].mtimeMs);
        a.lastSessionRelative = relativeTime(a.lastSessionISO, now);
      }
    }

    /* --- 3. state ------------------------------------------------- */
    for (const p of list) {
      const a = map.get(p.id);
      const sessionAge = a.lastSessionISO ? now - Date.parse(a.lastSessionISO) : Infinity;

      // A running process whose session has been silent for longer than
      // OPEN_WINDOW_MS is parked, not working. It stops counting as presence;
      // `parked` keeps the fact available without asserting activity.
      if (a.live > 0 && sessionAge > OPEN_WINDOW_MS) {
        a.parked = a.live;
        a.live = 0;
        a.pids = [];
        a._procs = [];
        // `processes` is deliberately kept: it is the evidence for the claim,
        // and it is what the stop control acts on.
        for (const q of a.processes) q.parked = true;
      }

      // A live process is only ever `open` at this stage. Whether it is
      // actually WORKING is decided in step 4 from the transcript's turn
      // state: the only thing separating an agent running a tool from one
      // sitting at a finished prompt with a fresh mtime.
      a.active = 0;
      if (a.live > 0) a.state = 'open';
      else if (sessionAge < IDLE_WINDOW_MS) a.state = 'idle';
      else a.state = 'none';
    }

    /* --- 4. current action, live projects only -------------------- */
    // Only projects with a running agent pay for a transcript tail read.
    // Freshest session first. If the budget runs out partway, this loop stops
    // and every project it never reached keeps active=0 — i.e. it silently
    // reports `open` instead of `working`, which looks exactly like detection
    // being broken for "some other project". Ordering by recency means the
    // ones most likely to be mid-turn are resolved before the budget can bite.
    const liveProjects = list
      .filter((p) => map.get(p.id).live > 0)
      .sort((x, y) => {
        const ax = Date.parse(map.get(x.id).lastSessionISO || 0) || 0;
        const ay = Date.parse(map.get(y.id).lastSessionISO || 0) || 0;
        return ay - ax;
      });
    for (const p of liveProjects) {
      // Truncating here is a claim about NOTHING, not a claim of "idle": mark
      // the sweep partial so the caller knows the answer is incomplete.
      if (Date.now() > deadline) { map.budgetExceeded = true; break; }
      const a = map.get(p.id);
      try {
        // Prefer the transcript directory of the process's own cwd: an agent
        // running in a subdirectory writes its session there, not under the
        // project root's encoded name.
        const dirs = new Set();
        for (const proc of a._procs || []) {
          const d = transcriptDirFor(proc.cwd);
          if (d) dirs.add(d);
        }
        if (a._dir) dirs.add(a._dir);

        // Newest session per transcript directory, capped: a project with four
        // live agents pays four cached tail reads, not one per session in its
        // whole history.
        const candidates = [];
        for (const d of dirs) {
          const sess = sessionsIn(d)[0];
          if (sess) candidates.push(sess);
        }
        candidates.sort((x, y) => y.mtimeMs - x.mtimeMs);
        if (!candidates.length) continue;

        const nowMs = Date.now();
        let workingCount = 0;
        let actionFrom = null;

        for (const sess of candidates.slice(0, TURN_READS_MAX)) {
          const events = await tailEvents(sess, p.path);
          // Mid-turn but silent too long means the process died holding the
          // pen; a stale `tool_use` must not spin forever.
          const stalled = nowMs - sess.mtimeMs > STALL_WINDOW_MS;
          if (turnStateOf(events) === 'working' && !stalled) {
            workingCount++;
            if (!actionFrom) actionFrom = events;
          }
        }

        // One orbit per agent genuinely mid-turn, never more than the
        // processes actually running.
        a.active = Math.min(a.live, workingCount);
        if (a.active > 0) a.state = 'working';

        // The action label describes work in progress, so it belongs only to a
        // working session. An idle prompt makes no claim about what it is doing.
        a.currentAction = actionFrom ? currentActionFrom(actionFrom) : null;
      } catch { /* a bad transcript must not sink the sweep */ }
    }
  } catch {
    // Total failure still returns a complete, inert shape.
    map.budgetExceeded = true;
  }

  for (const a of map.values()) { delete a._procs; delete a._dir; }

  actCache = { at: Date.now(), key: cacheKey, map };
  return map;
}

/* ------------------------------------------------------------------ *
 * ActivityDetail: the detail view only
 * ------------------------------------------------------------------ */

/** First timestamp in a transcript, from a bounded head read. */
async function sessionStart(file) {
  const lines = await readHead(file, HEAD_BYTES);
  for (const raw of lines) {
    if (!raw || raw.charCodeAt(0) !== 123) continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (o && typeof o.timestamp === 'string') return o.timestamp;
  }
  return null;
}

/**
 * Activity + a bounded `recentEvents` timeline + a session list.
 *
 * `recentEvents` is capped at 25 entries drawn from a <=256 KB tail of the
 * newest transcript, every label truncated at 120 chars. There is deliberately
 * no way to get more than this out of the module.
 */
async function projectAgentDetail(project) {
  const detail = Object.assign(emptyActivity(), {
    projectId: project && project.id ? project.id : null,
    recentEvents: [],
    sessions: [],
    processes: [],
    transcriptDir: null,
    budgetExceeded: false,
  });
  if (!project || !project.path) return detail;

  const deadline = Date.now() + SWEEP_BUDGET_MS * 2;

  let map;
  try { map = await agentActivity([project]); } catch { map = new Map(); }
  const base = map.get(project.id) || emptyActivity();
  Object.assign(detail, base);
  detail.projectId = project.id;
  detail.recentEvents = [];
  detail.sessions = [];
  detail.processes = [];

  /* live processes, with uptime */
  try {
    const procs = await listProcesses();
    const real = realpathOf(project.path);
    for (const proc of procs) {
      if (!proc.cwd) continue;
      if (!isInside(proc.cwd, project.path) && !isInside(proc.cwd, real)) continue;
      // Owner check against the activity's own attribution. `pids` holds only
      // live agents, so a parked process must be matched through `processes`
      // as well: those are precisely the ones worth showing and stopping.
      const attributed = base.pids.includes(proc.pid)
        || (base.processes || []).some((q) => q.pid === proc.pid);
      if (!attributed) continue;
      const known = (base.processes || []).find((q) => q.pid === proc.pid);
      detail.processes.push({
        pid: proc.pid,
        uptimeMs: proc.uptimeMs,
        startedISO: proc.uptimeMs ? toISO(Date.now() - proc.uptimeMs) : null,
        cwdRelative: proc.cwd === project.path ? '.' : relToProject(proc.cwd, project.path),
        origin: proc.origin || 'other',
        isSelf: Boolean(proc.isSelf),
        parked: Boolean(known && known.parked),
      });
    }
  } catch { /* best effort */ }

  /* sessions + recent events */
  try {
    const dir = transcriptDirFor(project.path);
    detail.transcriptDir = dir;
    const dirs = new Set();
    if (dir) dirs.add(dir);
    for (const p of detail.processes) { /* keep the shape stable */ void p; }
    const procs = await listProcesses();
    for (const proc of procs) {
      if (proc.cwd && detail.pids.includes(proc.pid)) {
        const d = transcriptDirFor(proc.cwd);
        if (d) dirs.add(d);
      }
    }

    let all = [];
    for (const d of dirs) all = all.concat(sessionsIn(d));
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    detail.sessionCount = all.length;

    const take = all.slice(0, MAX_SESSIONS);
    for (const s of take) {
      if (Date.now() > deadline) { detail.budgetExceeded = true; break; }
      const [startedISO, messageCount] = await Promise.all([
        sessionStart(s.file).catch(() => null),
        s.sizeBytes <= COUNT_MAX_BYTES ? countLines(s.file).catch(() => null) : Promise.resolve(null),
      ]);
      detail.sessions.push({
        id: s.id,
        startedISO,
        endedISO: toISO(s.mtimeMs),
        sizeBytes: s.sizeBytes,
        messageCount,
      });
    }

    if (all.length) {
      const events = await tailEvents(all[0], project.path);
      detail.recentEvents = events.map((e) => ({
        atISO: e.atISO,
        kind: e.kind,
        label: snippet(e.label),
      }));
      if (!detail.lastSessionISO) {
        detail.lastSessionISO = toISO(all[0].mtimeMs);
        detail.lastSessionRelative = relativeTime(detail.lastSessionISO);
      }
    }
  } catch { /* best effort */ }

  return detail;
}

/** Test/diagnostic surface. Read-only, like everything else here. */
function _internals() {
  return { encodeProjectPath, normalizeKey, parseEtime, parseEvents, currentActionFrom, snippet, CLAUDE_PROJECTS };
}

export {
  agentActivity,
  projectAgentDetail,
  verifyAgentPid,
  listProcesses,
  transcriptDirFor,
  encodeProjectPath,
  normalizeKey,
  SWEEP_BUDGET_MS,
  CLAUDE_PROJECTS,
  _internals,
};
