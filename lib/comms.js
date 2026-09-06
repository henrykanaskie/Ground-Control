/**
 * Ground Control Comms: talking to an agent about one project.
 *
 * Everything else in Ground Control looks at projects. This module is the one
 * place you can say something to one. You pick a project, type a message, and
 * a `claude` process runs in that project's folder and answers.
 *
 * Two ways in, both landing here (CONTRACT-COMMS.md §1):
 *
 *   - a NEW chat: a session Ground Control owns, its id pinned up front with
 *     `--session-id` so every later turn can `--resume` it.
 *   - CONTINUING a session you already have: `--resume <id> --fork-session`.
 *     The fork is not optional. Resuming a session in place while it is also
 *     open in your terminal means two processes appending to one transcript,
 *     and the loser of that race loses work. Forking gives Comms its own
 *     session id seeded with the whole history, so the conversation you can
 *     see is a copy that carries the context and cannot corrupt the original.
 *
 * What this module deliberately is NOT: a way to type into a running agent.
 * A live `claude` process has no inbox. Nothing here signals, attaches to, or
 * writes anywhere near another session's transcript. Comms only ever starts
 * processes of its own, and only ever kills processes of its own.
 *
 * The agent it starts is a FULL agent: it can edit files and run commands in
 * the project (CONTRACT-COMMS.md §3). That is the user's stated intent, and it
 * is the reason for every guard in here and for the loopback check on the
 * routes in server.js. The blast radius is one watched project per chat, the
 * process is capped and killable, and nothing starts without a message typed
 * by a person on this machine.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { claudeAvailable, childEnv } from './generate.js';
import { toISO, collapseWhitespace } from './util.js';

/* ------------------------------------------------------------------ *
 * Budgets and limits
 * ------------------------------------------------------------------ */

/** Chats kept in the registry. Oldest idle chat is evicted past this. */
const MAX_CHATS = 40;
/** Turns kept per chat. The transcript on disk keeps everything; this is UI. */
const MAX_TURNS = 240;
/** Longest message a person may send in one go. */
const PROMPT_MAX = 32 * 1024;
/** Longest reply text kept per turn. */
const TEXT_MAX = 48 * 1024;
/** Ordered prose/tool entries kept per agent turn. */
const STEPS_MAX = 80;
/** One label's length in the UI. */
const LABEL_MAX = 160;
/** Chats that may be mid-turn at once, across every project. */
const MAX_CONCURRENT = 3;
/** A single turn's wall-clock ceiling. A real agent task can be slow. */
const TURN_TIMEOUT_MS = 20 * 60 * 1000;
const SIGKILL_GRACE_MS = 4000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** Live text deltas are coalesced onto this interval, not emitted per token. */
const DELTA_FLUSH_MS = 120;

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const DEFAULT_MODEL = 'claude-opus-5';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const chats = new Map();          // chatId -> Chat
const runners = new Map();        // chatId -> { stop(signal) }
const childPids = new Set();      // pids of the `claude` processes we started

const emitter = new EventEmitter();
emitter.setMaxListeners(0);       // SSE clients; our own cleanup is the cap
const LIFECYCLE = '*lifecycle';

/**
 * PIDs of the `claude` processes Comms itself is running.
 *
 * Same problem Forge has: a Comms agent runs with its cwd inside the project,
 * which to `ps` and `lsof` is indistinguishable from you opening an agent
 * there yourself. lib/agents.js excludes these, so a chat you are watching in
 * the panel does not also make the card claim an agent appeared out of
 * nowhere. The chat shows its own state; the orbit is for sessions you started
 * somewhere else (CONTRACT-COMMS.md §5).
 */
function commsPids() {
  return new Set(childPids);
}

function newChatId() {
  let id;
  do { id = 'chat_' + Math.random().toString(36).slice(2, 8); } while (chats.has(id));
  return id;
}

let turnSeq = 0;
function newTurnId() { turnSeq += 1; return 't' + turnSeq.toString(36) + Math.random().toString(36).slice(2, 5); }

function isTerminal(state) { return TERMINAL.has(state); }

function msg(err) { return String((err && err.message) || err || 'unknown error'); }

function trim(s, max) {
  const t = collapseWhitespace(String(s == null ? '' : s));
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/* ------------------------------------------------------------------ *
 * Starting a chat
 * ------------------------------------------------------------------ */

/**
 * Open a chat against a project. Nothing is spawned here: a chat with no
 * messages costs nothing, so the CLI is not touched until someone speaks.
 *
 * `resumeSessionId` picks the "continue an existing session" path. It is only
 * ever a session id, never a path: this module builds no filenames from it and
 * hands it to the CLI, which does its own lookup.
 */
function startChat({ project, resumeSessionId = null, model = null } = {}) {
  if (!project || !project.id || !project.path) {
    throw Object.assign(new Error('a project is required'), { status: 400 });
  }
  const chat = {
    id: newChatId(),
    projectId: project.id,
    projectName: project.name || project.id,
    projectPath: project.path,
    model: MODELS.includes(model) ? model : DEFAULT_MODEL,
    // The session this chat writes to. Pinned up front for a new chat so the
    // first turn and every later one address the same conversation; learned
    // from the CLI's init event when we are forking someone else's session.
    sessionId: resumeSessionId ? null : randomUUID(),
    resumeFrom: resumeSessionId || null,
    started: false,             // true once the CLI has told us a session id
    title: resumeSessionId ? 'Continued session' : 'New chat',
    state: 'idle',
    error: null,
    runningPid: null,
    createdISO: new Date().toISOString(),
    updatedISO: new Date().toISOString(),
    turns: [],
    costUsd: 0,
  };
  chats.set(chat.id, chat);
  evict();
  persistSoon();
  emitter.emit(LIFECYCLE, 'created', chat);
  emitter.emit(chat.id, 'chat', chat);
  return chat;
}

function get(id) { return chats.get(id) || null; }

/** A project's chats, newest first. */
function listForProject(projectId) {
  return [...chats.values()]
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => (a.updatedISO < b.updatedISO ? 1 : -1));
}

function list() {
  return [...chats.values()].sort((a, b) => (a.updatedISO < b.updatedISO ? 1 : -1));
}

function running() {
  return [...chats.values()].filter((c) => c.state === 'running');
}

/**
 * Forget a chat. Deliberately does NOT touch the transcript under ~/.claude:
 * that is the user's conversation, and Comms is a reader there, never a
 * writer. Removing a chat removes the panel's record of it and nothing else
 * (CONTRACT-COMMS.md §4).
 */
function remove(id) {
  const chat = chats.get(id);
  if (!chat) return null;
  stop(id, 'chat closed');
  chats.delete(id);
  emitter.removeAllListeners(id);
  persistSoon();
  emitter.emit(LIFECYCLE, 'removed', chat);
  return chat;
}

function evict() {
  if (chats.size <= MAX_CHATS) return;
  const idle = [...chats.values()]
    .filter((c) => c.state !== 'running')
    .sort((a, b) => (a.updatedISO < b.updatedISO ? -1 : 1));
  while (chats.size > MAX_CHATS && idle.length) {
    const victim = idle.shift();
    chats.delete(victim.id);
    emitter.removeAllListeners(victim.id);
  }
}

/* ------------------------------------------------------------------ *
 * Subscriptions
 * ------------------------------------------------------------------ */

/** One chat's events: `fn(event, chat, extra?)`. Returns an unsubscribe. */
function subscribe(id, fn) {
  if (typeof fn !== 'function') return () => {};
  const handler = (...args) => { try { fn(...args); } catch { /* one bad listener must not stop a turn */ } };
  emitter.on(id, handler);
  return () => { try { emitter.off(id, handler); } catch { /* ignore */ } };
}

/**
 * Chat lifecycle across every project: created, removed, and a turn starting
 * or finishing. Not fired per delta: the only consumer is the dashboard's SSE
 * layer, where each notification is cheap but not free.
 */
function subscribeAll(fn) {
  if (typeof fn !== 'function') return () => {};
  const handler = (event, chat) => { try { fn(event, chat); } catch { /* ignore */ } };
  emitter.on(LIFECYCLE, handler);
  return () => { emitter.off(LIFECYCLE, handler); };
}

/* ------------------------------------------------------------------ *
 * Sending a message
 * ------------------------------------------------------------------ */

/**
 * What the agent is told about where it is. Appended to the default system
 * prompt, so this is a normal Claude Code session that happens to know it is
 * answering into a small panel rather than a terminal.
 */
function systemNote(chat) {
  return [
    'You are being talked to through Ground Control, a dashboard the user is running on this machine.',
    `Your working directory is the project "${chat.projectName}" at ${chat.projectPath}.`,
    'Your reply is rendered in a narrow chat panel, not a terminal: keep it short and concrete,',
    'lead with the answer, and use markdown sparingly. The user cannot see your tool output,',
    'so when you change a file or run a command, say plainly what you did and what came back.',
  ].join('\n');
}

/**
 * Send one message and run the turn. Returns `{ chat, turn }` immediately; the
 * turn fills in over the subscription while the process runs.
 *
 * One turn at a time per chat, and MAX_CONCURRENT across all of them. Both
 * limits are refusals with a sentence, never a queue: a chat that silently
 * banks your messages and replays them minutes later is worse than one that
 * says it is busy.
 */
function send(id, text) {
  const chat = chats.get(id);
  if (!chat) throw Object.assign(new Error('unknown chat'), { status: 404 });

  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) throw Object.assign(new Error('a message is required'), { status: 400 });
  if (body.length > PROMPT_MAX) {
    throw Object.assign(new Error(`a message can be at most ${Math.floor(PROMPT_MAX / 1024)} KB`), { status: 413 });
  }
  if (chat.state === 'running') {
    throw Object.assign(new Error('this chat is still working on the previous message'), { status: 409 });
  }
  if (runners.size >= MAX_CONCURRENT) {
    throw Object.assign(
      new Error(`${MAX_CONCURRENT} chats are already running. Wait for one to finish, or stop it.`),
      { status: 429 });
  }

  const avail = claudeAvailable();
  if (!avail || !avail.available || !avail.path) {
    throw Object.assign(
      new Error('The `claude` CLI is not available on this machine, so there is nothing to talk to.'),
      { status: 503 });
  }

  const now = new Date().toISOString();
  const you = { id: newTurnId(), role: 'user', text: body.slice(0, TEXT_MAX), atISO: now, state: 'done' };
  const turn = {
    id: newTurnId(),
    role: 'agent',
    atISO: now,
    state: 'running',
    steps: [],          // ordered: { kind: 'text' | 'tool', ... }
    partial: '',        // the in-flight tail of the current text block
    truncated: false,
    costUsd: null,
    durationMs: null,
    error: null,
    errorKind: null,
  };
  chat.turns.push(you, turn);
  if (chat.turns.length > MAX_TURNS) chat.turns.splice(0, chat.turns.length - MAX_TURNS);
  if (chat.title === 'New chat' || chat.title === 'Continued session') {
    chat.title = trim(body, 60);
  }
  chat.state = 'running';
  chat.error = null;
  chat.updatedISO = now;

  emitter.emit(id, 'turn', chat, turn);
  emitter.emit(LIFECYCLE, 'running', chat);

  runTurn(chat, turn, body, avail);
  return { chat, turn };
}

/** The argv for one turn. See the header for why the fork is not optional. */
function argsFor(chat) {
  const args = [
    '-p',
    '--model', chat.model,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // CONTRACT-COMMS.md §3. A full agent in headless mode cannot answer a
    // permission prompt: there is no terminal to answer it in, so anything not
    // pre-approved fails mid-turn and the agent explains that it is unable to
    // work. The user chose a delegate that can edit and run commands, so the
    // permission decision is made here, once, and stated everywhere it shows.
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', systemNote(chat),
  ];
  if (chat.started && chat.sessionId) {
    args.push('--resume', chat.sessionId);
  } else if (chat.resumeFrom) {
    args.push('--resume', chat.resumeFrom, '--fork-session');
  } else {
    args.push('--session-id', chat.sessionId);
  }
  return args;
}

function runTurn(chat, turn, prompt, avail) {
  const startedAt = Date.now();
  const state = { stdout: '', stderr: '', settled: false, killed: false, timedOut: false, result: null };

  let child;
  try {
    child = spawn(avail.path, argsFor(chat), {
      cwd: chat.projectPath,       // the whole point: the agent works in the project
      env: childEnv(),             // API keys stripped, so this stays on the subscription
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,              // its own process group, so stop() reaches the tree
    });
  } catch (err) {
    return failTurn(chat, turn, 'spawn', `could not start the claude CLI: ${msg(err)}`, startedAt);
  }

  if (child.pid) childPids.add(child.pid);
  const unregister = () => { if (child.pid) childPids.delete(child.pid); };

  /* The child is detached into its own process group, so it does not die with
   * this server: only the shutdown hook reaps it, and a `kill -9` gets past
   * that (CONTRACT-COMMS.md §4a). Writing the pid down NOW, not on the usual
   * debounce, is what lets the next start find the orphan and stop it. */
  chat.runningPid = child.pid || null;
  persistNow();

  /* Signal the child's whole process group: an agent's Bash tool leaves
   * grandchildren, and killing only the parent leaves them holding the pipe. */
  const stopChild = (signal) => {
    state.killed = true;
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* already gone */ } }
  };
  runners.set(chat.id, { stop: stopChild, pid: child.pid });

  const timeoutTimer = setTimeout(() => {
    state.timedOut = true;
    stopChild('SIGTERM');
    const t = setTimeout(() => stopChild('SIGKILL'), SIGKILL_GRACE_MS);
    if (t.unref) t.unref();
  }, TURN_TIMEOUT_MS);
  if (timeoutTimer.unref) timeoutTimer.unref();

  /* Live text is coalesced: a token-per-event SSE stream is a lot of frames
   * for a panel that repaints on a rAF anyway. */
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (state.settled) return;
    emitter.emit(chat.id, 'delta', chat, turn);
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, DELTA_FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
  };

  child.on('error', (err) => {
    unregister();
    clearTimeout(timeoutTimer);
    if (state.settled) return;
    state.settled = true;
    runners.delete(chat.id);
    failTurn(chat, turn, 'spawn', `the claude CLI could not be run: ${msg(err)}`, startedAt);
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    try { onStdout(chunk); } catch { /* a bad chunk must never be fatal */ }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    // Hook warnings and MCP noise land here routinely and are not failures.
    state.stderr = (state.stderr + chunk).slice(-32 * 1024);
  });

  function onStdout(chunk) {
    state.stdout += chunk;
    if (state.stdout.length > MAX_STDOUT_BYTES) state.stdout = state.stdout.slice(-MAX_STDOUT_BYTES);
    let nl;
    while ((nl = state.stdout.indexOf('\n')) !== -1) {
      const line = state.stdout.slice(0, nl);
      state.stdout = state.stdout.slice(nl + 1);
      handleLine(line);
    }
  }

  function handleLine(line) {
    const t = line.trim();
    if (!t) return;
    let evt;
    try { evt = JSON.parse(t); } catch { return; }     // malformed: skip, never fatal
    if (!evt || typeof evt !== 'object') return;

    // The session id arrives here on the very first event, which is how a
    // forked session learns the id it will be resumed by from now on.
    if (typeof evt.session_id === 'string' && evt.session_id) {
      if (!chat.sessionId || chat.resumeFrom) chat.sessionId = evt.session_id;
      chat.started = true;
    }

    if (evt.type === 'stream_event' && evt.event) {
      const e = evt.event;
      if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'text') {
        turn.partial = '';
      } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        turn.partial = (turn.partial + String(e.delta.text || '')).slice(-4096);
        scheduleFlush();
      }
      return;
    }

    if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
      for (const b of evt.message.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          pushStep(turn, { kind: 'text', text: b.text.slice(0, TEXT_MAX) });
        } else if (b.type === 'tool_use') {
          pushStep(turn, { kind: 'tool', id: b.id || null, name: b.name || 'tool', label: toolLabel(b.name, b.input), state: 'running' });
        }
      }
      // A complete block landed, so the live tail is no longer the newest thing.
      turn.partial = '';
      emitter.emit(chat.id, 'turn', chat, turn);
      return;
    }

    if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
      for (const b of evt.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const step = turn.steps.find((s) => s.kind === 'tool' && s.id && s.id === b.tool_use_id);
        if (step) step.state = b.is_error ? 'failed' : 'done';
      }
      emitter.emit(chat.id, 'turn', chat, turn);
      return;
    }

    if (evt.type === 'result') state.result = evt;
  }

  let exitTimer = null;
  const settle = (code, signal) => {
    clearTimeout(timeoutTimer);
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (state.settled) return;
    state.settled = true;
    runners.delete(chat.id);
    if (state.stdout.trim()) { try { handleLine(state.stdout); } catch { /* ignore */ } }
    for (const s of [child.stdout, child.stderr, child.stdin]) {
      try { if (s && !s.destroyed) s.destroy(); } catch { /* ignore */ }
    }
    try { child.unref(); } catch { /* ignore */ }
    finish(code, signal);
  };

  /* `close` waits for every stream to close, which a surviving grandchild of a
   * Bash call can hold open. `exit` fires when the process itself is gone, so
   * take whichever comes first and give `close` a moment to flush the tail. */
  child.on('close', (code, signal) => { unregister(); settle(code, signal); });
  child.on('exit', (code, signal) => {
    if (state.settled || exitTimer) return;
    exitTimer = setTimeout(() => { exitTimer = null; unregister(); settle(code, signal); }, 1500);
    if (exitTimer.unref) exitTimer.unref();
  });

  // The message goes over stdin, never in an argv the OS might truncate and
  // never through a shell.
  try {
    child.stdin.on('error', () => { /* EPIPE if the child dies early */ });
    child.stdin.end(prompt, 'utf8');
  } catch (err) {
    stopChild('SIGKILL');
    return failTurn(chat, turn, 'spawn', `could not send the message: ${msg(err)}`, startedAt);
  }

  function finish(code, signal) {
    const r = state.result || {};
    turn.partial = '';
    turn.costUsd = Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null;
    turn.durationMs = Number.isFinite(r.duration_ms) ? r.duration_ms : (Date.now() - startedAt);
    if (Number.isFinite(turn.costUsd)) chat.costUsd = (chat.costUsd || 0) + turn.costUsd;

    for (const s of turn.steps) if (s.kind === 'tool' && s.state === 'running') s.state = 'unknown';

    if (turn.state === 'cancelled') return endTurn(chat, turn);   // stop() already spoke

    if (state.timedOut) {
      return failTurn(chat, turn, 'timeout',
        `The agent was still working after ${Math.round(TURN_TIMEOUT_MS / 60000)} minutes and was stopped.`, startedAt);
    }
    if (state.killed) {
      turn.state = 'cancelled';
      turn.error = 'Stopped before it finished.';
      return endTurn(chat, turn);
    }
    if (code !== 0) {
      const tail = state.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      return failTurn(chat, turn, 'cli-error',
        `The claude CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}.${tail ? ` Last stderr: ${tail}` : ''}`, startedAt);
    }
    if (r.is_error) {
      return failTurn(chat, turn, 'model-error',
        String(r.result || r.error || 'the model reported an error with no detail').slice(0, 400), startedAt);
    }
    // A turn that produced no prose at all still counts as an answer if the
    // result carried one: some turns end with tool work and a one-line result.
    if (!turn.steps.some((s) => s.kind === 'text') && typeof r.result === 'string' && r.result.trim()) {
      pushStep(turn, { kind: 'text', text: r.result.slice(0, TEXT_MAX) });
    }
    turn.state = 'done';
    return endTurn(chat, turn);
  }
}

function pushStep(turn, step) {
  turn.steps.push(step);
  if (turn.steps.length > STEPS_MAX) {
    turn.steps.splice(0, turn.steps.length - STEPS_MAX);
    turn.truncated = true;
  }
}

function failTurn(chat, turn, kind, reason, startedAt) {
  turn.state = 'failed';
  turn.errorKind = kind;
  turn.error = reason;
  turn.partial = '';
  if (turn.durationMs == null) turn.durationMs = Date.now() - startedAt;
  chat.error = reason;
  return endTurn(chat, turn);
}

function endTurn(chat, turn) {
  chat.runningPid = null;
  chat.state = turn.state === 'failed' ? 'error' : 'idle';
  chat.updatedISO = new Date().toISOString();
  runners.delete(chat.id);
  persistSoon();
  emitter.emit(chat.id, 'turn', chat, turn);
  emitter.emit(chat.id, 'settled', chat, turn);
  emitter.emit(LIFECYCLE, 'settled', chat);
  return turn;
}

/**
 * Stop the turn in flight. SIGTERM first so the CLI flushes its transcript,
 * SIGKILL only after a grace period. The chat stays usable: the next message
 * resumes the same session, which is exactly what makes stopping safe to do.
 */
function stop(id, reason = 'stopped') {
  const chat = chats.get(id);
  if (!chat) return null;
  const runner = runners.get(id);
  if (!runner) return chat;

  const turn = [...chat.turns].reverse().find((t) => t.role === 'agent' && t.state === 'running');
  if (turn) { turn.state = 'cancelled'; turn.error = reason; }
  try { runner.stop('SIGTERM'); } catch { /* already gone */ }
  const t = setTimeout(() => { try { runner.stop('SIGKILL'); } catch { /* ignore */ } }, SIGKILL_GRACE_MS);
  if (t.unref) t.unref();
  return chat;
}

/** Stop every turn in flight: used on server shutdown. */
function stopAll(reason = 'Ground Control is shutting down') {
  for (const chat of running()) stop(chat.id, reason);
}

/* ------------------------------------------------------------------ *
 * Tool labels
 * ------------------------------------------------------------------ */

function baseOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

/** One short human line for a tool call. Never the tool's full input. */
function toolLabel(name, input) {
  const n = String(name || 'tool');
  const i = input && typeof input === 'object' ? input : {};
  switch (n) {
    case 'Read': return 'Read ' + baseOf(i.file_path);
    case 'Write': return 'Wrote ' + baseOf(i.file_path);
    case 'Edit': return 'Edited ' + baseOf(i.file_path);
    case 'NotebookEdit': return 'Edited ' + baseOf(i.notebook_path || i.file_path);
    case 'Bash': return trim(i.description || i.command || 'ran a command', LABEL_MAX);
    case 'Glob': return 'Searched for ' + trim(i.pattern, 60);
    case 'Grep': return 'Searched ' + trim(i.pattern, 60);
    case 'Task': return trim(i.description || 'ran a subagent', LABEL_MAX);
    case 'WebFetch': return 'Fetched ' + trim(i.url, 80);
    case 'WebSearch': return 'Searched the web for ' + trim(i.query, 60);
    case 'TodoWrite': return 'Updated its plan';
    default: return n;
  }
}

/* ------------------------------------------------------------------ *
 * The API shape
 * ------------------------------------------------------------------ */

function turnJSON(t) {
  if (!t) return null;
  if (t.role === 'user') {
    return { id: t.id, role: 'user', text: t.text, atISO: t.atISO, state: 'done' };
  }
  return {
    id: t.id,
    role: 'agent',
    atISO: t.atISO,
    state: t.state,
    steps: (t.steps || []).map((s) => (s.kind === 'text'
      ? { kind: 'text', text: s.text }
      : { kind: 'tool', name: s.name, label: s.label, state: s.state })),
    partial: t.partial || '',
    truncated: Boolean(t.truncated),
    costUsd: t.costUsd,
    durationMs: t.durationMs,
    error: t.error,
    errorKind: t.errorKind,
  };
}

/** The chat without its turns: what a list of chats needs. */
function summaryJSON(chat) {
  if (!chat) return null;
  return {
    id: chat.id,
    projectId: chat.projectId,
    projectName: chat.projectName,
    title: chat.title,
    model: chat.model,
    state: chat.state,
    error: chat.error,
    sessionId: chat.sessionId,
    resumeFrom: chat.resumeFrom,
    createdISO: chat.createdISO,
    updatedISO: chat.updatedISO,
    messageCount: chat.turns.filter((t) => t.role === 'user').length,
    costUsd: chat.costUsd || 0,
    interrupted: Boolean(chat.interrupted),
  };
}

function toJSON(chat) {
  if (!chat) return null;
  return Object.assign(summaryJSON(chat), { turns: chat.turns.map(turnJSON) });
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * The registry is in memory, which without this would mean every chat vanishes
 * on restart while its session sits on disk under ~/.claude, unreachable
 * because nothing remembers the id. So a small JSON file next to sources.json
 * keeps the index: ids, titles, session ids, and the turns as displayed.
 *
 * Writes are debounced and atomic (temp file + rename, 0600) and happen on
 * chat creation, removal, and turn completion. Never per delta: a chat
 * streaming a long answer must not write the file once per token.
 */
let storeFile = path.join(os.homedir(), '.ground-control', 'comms.json');
let persistTimer = null;

function setStoreFile(file) { if (file) storeFile = file; }

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 400);
  if (persistTimer.unref) persistTimer.unref();
}

function persistNow() {
  if (!storeFile) return;
  const body = JSON.stringify({
    version: 1,
    chats: list().slice(0, MAX_CHATS).map((c) => ({
      id: c.id,
      projectId: c.projectId,
      projectName: c.projectName,
      projectPath: c.projectPath,
      model: c.model,
      sessionId: c.sessionId,
      resumeFrom: c.resumeFrom,
      started: c.started,
      title: c.title,
      createdISO: c.createdISO,
      updatedISO: c.updatedISO,
      costUsd: c.costUsd,
      // The `claude` process this chat has in flight, if any. See §4a: it is
      // the only handle a later start has on a turn that outlived its server.
      runningPid: c.runningPid || null,
      // A chat that was mid-turn when the process died comes back idle, never
      // running: nothing in this process will ever finish that turn.
      state: c.state === 'running' ? 'idle' : c.state,
      turns: c.turns.slice(-MAX_TURNS),
    })),
  });
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const tmp = `${storeFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, storeFile);
  } catch { /* best effort: never break a chat over its index */ }
}

/* ------------------------------------------------------------------ *
 * Orphans (CONTRACT-COMMS.md §4a)
 * ------------------------------------------------------------------ */

/**
 * A turn's child is spawned into its own process group so that stopping it
 * reaches the grandchildren an agent's `Bash` calls leave behind. The price is
 * that it does not die with this server for free: the shutdown hook is what
 * reaps it, and `kill -9` on the server gets past the hook. Measured: the
 * child survives, is reparented to PID 1, and keeps working.
 *
 * So the next start looks for it. Anything else would be worse than the
 * orphan itself, because the restored chat would say "interrupted" about a
 * turn that is in fact still running and still editing files.
 */

/** `ps` for one pid, or null. Synchronous: hydrate runs before the listener. */
function inspectPid(pid) {
  try {
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, windowsHide: true,
    });
    if (!r || r.status !== 0) return null;
    const line = String(r.stdout || '').trim();
    return line || null;
  } catch { return null; }
}

/**
 * Is this command line OUR child, or a pid the OS handed to someone else?
 *
 * A pid recycled between the crash and the restart is the one way this could
 * signal an unrelated process, so the match is deliberately narrow: the
 * command must be a `claude` invocation AND carry one of this chat's own
 * session ids. Those are UUIDs, so a coincidental match is not a thing that
 * happens. A plain "is it named claude" check would not be good enough: the
 * user may well have started their own agent since.
 */
function isOurOrphan(command, chat) {
  if (!command || !chat) return false;
  if (!/(^|\/)claude\b/.test(command)) return false;
  if (!command.includes('-p')) return false;
  const ids = [chat.sessionId, chat.resumeFrom].filter((x) => typeof x === 'string' && x.length >= 8);
  return ids.some((id) => command.includes(id));
}

/** SIGTERM the orphan's whole group, as Stop does. Never SIGKILL: it flushes. */
function killOrphan(pid) {
  try { process.kill(-pid, 'SIGTERM'); return true; }
  catch {
    try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
  }
}

function looksLikeChat(o) {
  return o && typeof o === 'object'
    && typeof o.id === 'string' && o.id
    && typeof o.projectId === 'string' && o.projectId
    && typeof o.projectPath === 'string' && o.projectPath;
}

/** Rebuild the registry from disk. Returns a small summary. */
function hydrate(opts = {}) {
  // Injected so the orphan path is testable without spawning anything.
  const inspect = typeof opts.inspect === 'function' ? opts.inspect : inspectPid;
  const kill = typeof opts.kill === 'function' ? opts.kill : killOrphan;

  const summary = { restored: 0, interrupted: 0, reaped: 0, vanished: 0 };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return summary; }
  const found = Array.isArray(parsed && parsed.chats) ? parsed.chats : [];
  for (const raw of found) {
    if (chats.size >= MAX_CHATS) break;
    if (!looksLikeChat(raw) || chats.has(raw.id)) continue;
    const chat = {
      id: raw.id,
      projectId: raw.projectId,
      projectName: raw.projectName || raw.projectId,
      projectPath: raw.projectPath,
      model: MODELS.includes(raw.model) ? raw.model : DEFAULT_MODEL,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      resumeFrom: typeof raw.resumeFrom === 'string' ? raw.resumeFrom : null,
      started: Boolean(raw.started),
      title: typeof raw.title === 'string' ? raw.title : 'Chat',
      state: 'idle',
      error: null,
      runningPid: null,
      createdISO: raw.createdISO || new Date().toISOString(),
      updatedISO: raw.updatedISO || raw.createdISO || new Date().toISOString(),
      turns: Array.isArray(raw.turns) ? raw.turns.slice(-MAX_TURNS) : [],
      costUsd: Number.isFinite(raw.costUsd) ? raw.costUsd : 0,
      interrupted: false,
    };

    /* Was a turn still in flight, and did its process outlive the server? */
    const pid = Number(raw.runningPid);
    let reaped = false;
    if (Number.isInteger(pid) && pid > 1) {
      const command = inspect(pid);
      if (isOurOrphan(command, chat)) {
        reaped = Boolean(kill(pid));
        if (reaped) summary.reaped++;
      } else {
        summary.vanished++;
      }
    }

    for (const t of chat.turns) {
      if (t && t.role === 'agent' && t.state === 'running') {
        t.state = 'failed';
        t.errorKind = reaped ? 'orphaned' : 'interrupted';
        // Two different truths, and saying the wrong one is the whole reason
        // the pid is written down: a turn whose agent kept working must not be
        // reported as one that simply stopped.
        t.error = reaped
          ? 'Ground Control was killed while this answer was being written, and the agent carried on '
            + 'without it. It has now been stopped, but it had already been working: check this project '
            + 'for changes before sending the message again.'
          : 'Ground Control restarted while this answer was still being written, so it never finished. '
            + 'Send the message again.';
        t.partial = '';
        chat.interrupted = true;
        summary.interrupted++;
      }
    }
    chats.set(chat.id, chat);
    summary.restored++;
  }
  // The pids in the file are now stale whatever happened to them.
  if (summary.restored) persistNow();
  return summary;
}

/** Drop chats whose project is no longer watched. Called after a scan. */
function pruneMissing(knownProjectIds) {
  if (!knownProjectIds || typeof knownProjectIds.has !== 'function') return 0;
  let dropped = 0;
  for (const chat of [...chats.values()]) {
    if (knownProjectIds.has(chat.projectId)) continue;
    if (chat.state === 'running') continue;      // never yank a chat mid-turn
    chats.delete(chat.id);
    emitter.removeAllListeners(chat.id);
    dropped++;
  }
  if (dropped) persistSoon();
  return dropped;
}

/** Test/diagnostic surface. */
function _internals() {
  return { toolLabel, argsFor, systemNote, isOurOrphan, inspectPid, chats, MAX_CONCURRENT, MAX_CHATS, PROMPT_MAX, TURN_TIMEOUT_MS };
}

export {
  startChat, send, stop, stopAll, remove, get, list, listForProject, running,
  subscribe, subscribeAll, toJSON, summaryJSON, turnJSON,
  commsPids, setStoreFile, hydrate, persistNow, pruneMissing, isTerminal,
  MODELS, DEFAULT_MODEL, MAX_CONCURRENT, MAX_CHATS, PROMPT_MAX, TURN_TIMEOUT_MS,
  _internals,
};
