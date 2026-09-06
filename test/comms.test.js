/**
 * Comms: the properties that would be expensive to regress.
 *
 * A chat agent can edit files and run commands, so the argv this module builds
 * and the limits it enforces are the safety surface. Nothing here spawns a
 * `claude` process: the CLI is not a test dependency, and the interesting
 * failures are all decisions made before the spawn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureRoot, cleanupFixtures } from './helpers.js';
import * as comms from '../lib/comms.js';

test.after(cleanupFixtures);

function fixtureStore(label) {
  const file = path.join(fixtureRoot(label), 'comms.json');
  comms.setStoreFile(file);
  return file;
}

function fakeProject(dir, name = 'demo') {
  return { id: name, name, path: dir };
}

/* ---- argv: the safety surface ------------------------------------- */

test('a new chat pins its own session id and never resumes someone else', () => {
  fixtureStore('argv-new');
  const chat = comms.startChat({ project: fakeProject(fixtureRoot('proj-new')) });
  const args = comms._internals().argsFor(chat);

  assert.ok(args.includes('--session-id'), 'a fresh chat must pin an id it owns');
  assert.equal(args[args.indexOf('--session-id') + 1], chat.sessionId);
  assert.ok(!args.includes('--resume'), 'a fresh chat must not resume anything');
  assert.ok(!args.includes('--fork-session'));
  comms.remove(chat.id);
});

test('continuing an existing session ALWAYS forks it', () => {
  fixtureStore('argv-fork');
  const chat = comms.startChat({
    project: fakeProject(fixtureRoot('proj-fork')),
    resumeSessionId: '015adccc-a6ed-40e3-93fb-8aa330291535',
  });
  const args = comms._internals().argsFor(chat);

  // This is the whole reason continuing a session is safe: without the fork,
  // a session open in a terminal and a chat here append to one transcript.
  assert.ok(args.includes('--fork-session'), 'CONTINUING A SESSION WITHOUT A FORK CAN CORRUPT IT');
  assert.equal(args[args.indexOf('--resume') + 1], '015adccc-a6ed-40e3-93fb-8aa330291535');
  assert.ok(!args.includes('--session-id'), 'a fork gets its id from the CLI, it does not pin one');
  comms.remove(chat.id);
});

test('later turns resume the chat’s own session, not the original', () => {
  fixtureStore('argv-later');
  const chat = comms.startChat({
    project: fakeProject(fixtureRoot('proj-later')),
    resumeSessionId: 'original-session-id',
  });
  // What the CLI reports back after the fork.
  chat.sessionId = 'forked-session-id';
  chat.started = true;
  const args = comms._internals().argsFor(chat);

  assert.equal(args[args.indexOf('--resume') + 1], 'forked-session-id');
  assert.ok(!args.includes('--fork-session'), 'forking again every turn would lose the conversation');
  comms.remove(chat.id);
});

test('the working directory is the project and nothing is added to it', () => {
  fixtureStore('argv-cwd');
  const dir = fixtureRoot('proj-cwd');
  const chat = comms.startChat({ project: fakeProject(dir) });
  const args = comms._internals().argsFor(chat);

  assert.equal(chat.projectPath, dir);
  assert.ok(!args.includes('--add-dir'), 'a chat agent gets one folder: the project it was opened on');
  comms.remove(chat.id);
});

/* ---- limits -------------------------------------------------------- */

test('a message that is too long is refused, not truncated', () => {
  fixtureStore('limits');
  const chat = comms.startChat({ project: fakeProject(fixtureRoot('proj-limits')) });
  assert.throws(
    () => comms.send(chat.id, 'x'.repeat(comms.PROMPT_MAX + 1)),
    (err) => err.status === 413);
  assert.throws(() => comms.send(chat.id, '   '), (err) => err.status === 400);
  assert.throws(() => comms.send('chat_nope', 'hello'), (err) => err.status === 404);
  comms.remove(chat.id);
});

test('the chat cap evicts idle chats and never a running one', () => {
  fixtureStore('cap');
  const dir = fixtureRoot('proj-cap');
  const first = comms.startChat({ project: fakeProject(dir) });
  first.state = 'running';                      // as if mid-turn
  for (let i = 0; i < comms.MAX_CHATS + 4; i++) comms.startChat({ project: fakeProject(dir) });

  assert.ok(comms.get(first.id), 'A RUNNING CHAT WAS EVICTED');
  assert.ok(comms.list().length <= comms.MAX_CHATS + 1);
  first.state = 'idle';
  for (const c of comms.list()) comms.remove(c.id);
});

/* ---- persistence --------------------------------------------------- */

test('a chat that was mid-turn when the server died comes back idle and says so', () => {
  const file = fixtureStore('hydrate');
  const dir = fixtureRoot('proj-hydrate');
  const chat = comms.startChat({ project: fakeProject(dir) });
  chat.state = 'running';
  chat.turns.push(
    { id: 'u1', role: 'user', text: 'hello', atISO: new Date().toISOString(), state: 'done' },
    { id: 'a1', role: 'agent', atISO: new Date().toISOString(), state: 'running', steps: [], partial: 'half a sen' });
  comms.persistNow();
  for (const c of comms.list()) comms.remove(c.id);
  assert.equal(comms.list().length, 0);

  comms.setStoreFile(file);
  const summary = comms.hydrate();
  assert.equal(summary.restored, 1);
  assert.equal(summary.interrupted, 1);

  const back = comms.get(chat.id);
  assert.equal(back.state, 'idle', 'A RESTORED CHAT MUST NEVER CLAIM TO BE RUNNING');
  const turn = back.turns.find((t) => t.id === 'a1');
  assert.equal(turn.state, 'failed');
  assert.equal(turn.partial, '', 'the half-written tail is not an answer');
  assert.match(turn.error, /restarted/);
  comms.remove(chat.id);
});

test('the store is written 0600 and readable back', () => {
  const file = fixtureStore('perms');
  const chat = comms.startChat({ project: fakeProject(fixtureRoot('proj-perms')) });
  comms.persistNow();
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'the chat index carries the user’s own words');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).chats.length >= 1);
  comms.remove(chat.id);
});

/* ---- orphans (CONTRACT-COMMS.md §4a) ------------------------------- */

const SESSION = 'aa009e71-a929-4f9a-b9db-23d833b3edc2';

/** A chat persisted mid-turn, with `runningPid` written down. */
function storeWithOrphan(label, pid, overrides = {}) {
  const file = fixtureStore(label);
  const chat = comms.startChat({ project: fakeProject(fixtureRoot('proj-' + label)) });
  Object.assign(chat, { sessionId: SESSION, started: true, state: 'running' }, overrides);
  chat.runningPid = pid;
  chat.turns.push(
    { id: 'u1', role: 'user', text: 'go', atISO: new Date().toISOString(), state: 'done' },
    { id: 'a1', role: 'agent', atISO: new Date().toISOString(), state: 'running', steps: [], partial: 'half' });
  comms.persistNow();
  for (const c of comms.list()) comms.remove(c.id);
  comms.setStoreFile(file);
  return { id: chat.id, file };
}

const OUR_COMMAND = '/Users/me/.local/bin/claude -p --model claude-opus-5 --output-format stream-json '
  + '--verbose --include-partial-messages --permission-mode bypassPermissions --resume ' + SESSION;

test('an agent that outlived the server is found and stopped, and the turn says so', () => {
  const { id } = storeWithOrphan('orphan-live', 4242);
  const killed = [];
  const summary = comms.hydrate({
    inspect: (pid) => (pid === 4242 ? OUR_COMMAND : null),
    kill: (pid) => { killed.push(pid); return true; },
  });

  assert.equal(summary.reaped, 1);
  assert.deepEqual(killed, [4242]);
  const turn = comms.get(id).turns.find((t) => t.id === 'a1');
  assert.equal(turn.errorKind, 'orphaned');
  assert.match(turn.error, /carried on/, 'a turn whose agent kept working must not read as one that stopped');
  assert.match(turn.error, /check this project for changes/);
  comms.remove(id);
});

test('a pid the OS handed to someone else is NEVER signalled', () => {
  const { id } = storeWithOrphan('orphan-recycled', 4242);
  const killed = [];
  // Same pid, but the process is now a `claude` belonging to the user, running
  // a different session. This is the case that would be a real bug.
  const someoneElse = '/Users/me/.local/bin/claude -p --resume 11111111-2222-3333-4444-555555555555';
  const summary = comms.hydrate({
    inspect: () => someoneElse,
    kill: (pid) => { killed.push(pid); return true; },
  });

  assert.equal(killed.length, 0, 'COMMS SIGNALLED A PROCESS THAT WAS NOT ITS OWN');
  assert.equal(summary.reaped, 0);
  const turn = comms.get(id).turns.find((t) => t.id === 'a1');
  assert.equal(turn.errorKind, 'interrupted', 'nothing was reaped, so the plain message is the honest one');
  comms.remove(id);
});

test('a pid that is gone is not signalled and reads as a plain interruption', () => {
  const { id } = storeWithOrphan('orphan-gone', 4242);
  const killed = [];
  const summary = comms.hydrate({ inspect: () => null, kill: (pid) => { killed.push(pid); return true; } });

  assert.equal(killed.length, 0);
  assert.equal(summary.reaped, 0);
  assert.equal(summary.vanished, 1);
  assert.match(comms.get(id).turns.find((t) => t.id === 'a1').error, /restarted/);
  comms.remove(id);
});

test('the reaped pid is dropped from the store, so a later start cannot re-signal it', () => {
  const { id, file } = storeWithOrphan('orphan-stale', 4242);
  comms.hydrate({ inspect: () => OUR_COMMAND, kill: () => true });
  assert.equal(comms.get(id).runningPid, null);

  // A pid is reused within hours on a busy machine, so a stale one left in the
  // file would eventually name someone else's process.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.chats.find((c) => c.id === id).runningPid, null,
    'A STALE PID SURVIVED IN THE STORE');
  comms.remove(id);
});

test('the orphan match needs a claude command AND one of the chat’s own ids', () => {
  const { isOurOrphan } = comms._internals();
  const chat = { sessionId: SESSION, resumeFrom: null };

  assert.equal(isOurOrphan(OUR_COMMAND, chat), true);
  assert.equal(isOurOrphan('/usr/bin/node server.js -p ' + SESSION, chat), false, 'not a claude process');
  assert.equal(isOurOrphan('/Users/me/.local/bin/claude -p --resume other-id', chat), false, 'not our session');
  assert.equal(isOurOrphan('/Users/me/.local/bin/claudius -p ' + SESSION, chat), false, 'name must not match by prefix');
  assert.equal(isOurOrphan(null, chat), false);
  assert.equal(isOurOrphan(OUR_COMMAND, { sessionId: null, resumeFrom: null }), false, 'no ids means no match');

  // A forked chat has not learned its own id yet: the argv carries the original.
  assert.equal(
    isOurOrphan('/Users/me/.local/bin/claude -p --resume ' + SESSION + ' --fork-session',
      { sessionId: null, resumeFrom: SESSION }),
    true);
});

/* ---- observing our own children ------------------------------------ */

test('commsPids is a copy, so a caller cannot edit the live set', () => {
  const pids = comms.commsPids();
  pids.add(999999);
  assert.ok(!comms.commsPids().has(999999));
});

/* ---- tool labels --------------------------------------------------- */

test('tool labels are short, human, and never the whole input', () => {
  const { toolLabel } = comms._internals();
  assert.equal(toolLabel('Read', { file_path: '/a/b/lib/agents.js' }), 'Read agents.js');
  assert.equal(toolLabel('Edit', { file_path: '/a/b/server.js' }), 'Edited server.js');
  assert.equal(toolLabel('Bash', { description: 'run the tests', command: 'npm test' }), 'run the tests');
  assert.equal(toolLabel('Mystery', {}), 'Mystery');
  const long = toolLabel('Bash', { command: 'x'.repeat(500) });
  assert.ok(long.length <= 161, 'a label must stay one line');
});

/* ---- pruning ------------------------------------------------------- */

test('a chat whose project stopped being watched is dropped, unless it is running', () => {
  fixtureStore('prune');
  const dir = fixtureRoot('proj-prune');
  const gone = comms.startChat({ project: fakeProject(dir, 'gone') });
  const busy = comms.startChat({ project: fakeProject(dir, 'busy') });
  busy.state = 'running';

  comms.pruneMissing(new Set(['something-else']));
  assert.equal(comms.get(gone.id), null);
  assert.ok(comms.get(busy.id), 'A RUNNING CHAT WAS PRUNED OUT FROM UNDER ITS AGENT');
  busy.state = 'idle';
  comms.remove(busy.id);
});
