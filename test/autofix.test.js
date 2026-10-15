/**
 * Autofix: the loop that lets an agent fix a project and re-runs it.
 *
 * No `claude` and no real runs: comms and runner are stand-ins, so what is
 * tested is the loop's own promise: it re-runs after every agent turn, stops
 * as soon as the project runs, and never goes past its round limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAutofix, MAX_ROUNDS } from '../lib/autofix.js';

function fakes(outcomes) {
  const ev = new EventEmitter();
  const sent = [];
  const states = [];
  let current = { projectId: 'p', state: 'failed', steps: [], fixes: [], diagnosis: { title: 'boom', needs: 'agent' } };
  const comms = {
    startChat: () => ({ id: 'chat1' }),
    send: (id, text) => { sent.push(text); setImmediate(() => ev.emit('c:' + id, 'settled', { state: 'idle' })); return { turn: {} }; },
    subscribe: (id, fn) => { const h = (...a) => fn(...a); ev.on('c:' + id, h); return () => ev.off('c:' + id, h); },
    stop: () => {},
  };
  const runner = {
    isTerminal: (s) => s === 'done' || s === 'failed' || s === 'stopped',
    get: () => current,
    logTail: () => 'the log',
    setAgent: (_, info) => states.push(info && info.state),
    subscribe: (id, fn) => { const h = (...a) => fn(...a); ev.on('r', h); return () => ev.off('r', h); },
    start: async () => {
      const ok = outcomes.shift();
      current = ok ? { projectId: 'p', state: 'running', readyUrl: 'http://localhost:3000/', steps: [], fixes: [] }
        : { projectId: 'p', state: 'failed', steps: [], fixes: [], diagnosis: { title: 'still boom', needs: 'agent' } };
      setImmediate(() => ev.emit('r', 'state', current));
      return current;
    },
  };
  return { comms, runner, sent, states, failed: () => current };
}

function settled(af, id = 'p') {
  return new Promise((resolve) => {
    const t = setInterval(() => { const l = af.get(id); if (l && ['fixed', 'gave-up', 'stopped'].includes(l.state)) { clearInterval(t); resolve(l); } }, 5);
  });
}

test('the agent fixes it on the second attempt, and the loop stops there', async () => {
  const f = fakes([false, true]);
  const af = createAutofix({ comms: f.comms, runner: f.runner, findProject: async () => ({ id: 'p', path: '/x' }) });
  await af.begin('p', f.failed());
  const loop = await settled(af);
  assert.equal(loop.state, 'fixed');
  assert.equal(loop.round, 2);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1], /still fails/);
  assert.match(f.sent[0], /Do NOT start the app/, 'the agent must not hold the port Run is about to use');
});

test('it gives up after the round limit instead of looping', async () => {
  const f = fakes([false, false, false, false, false]);
  const af = createAutofix({ comms: f.comms, runner: f.runner, findProject: async () => ({ id: 'p', path: '/x' }) });
  await af.begin('p', f.failed());
  const loop = await settled(af);
  assert.equal(loop.state, 'gave-up');
  assert.equal(f.sent.length, MAX_ROUNDS);
});
