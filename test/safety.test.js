/**
 * Two properties that are easy to regress silently:
 *   1. the brief must never carry secrets out of a repository
 *   2. the artifact must escape everything it interpolates
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRoot, cleanupFixtures, project, write } from './helpers.js';
import { scanRoot } from '../lib/scan.js';
import { buildBrief, briefToMarkdown } from '../lib/brief.js';
import { renderArtifact } from '../lib/artifact-template.js';
import { encodeProjectPath } from '../lib/agents.js';

test.after(cleanupFixtures);

test('the brief names secret files but never reads them', async () => {
  // ML_quantitative_research really does contain a committed API key; the brief
  // is handed to a model, so its contents must never travel.
  const root = fixtureRoot('secrets');
  const SECRET = 'sk-live-THISMUSTNEVERAPPEAR-9f83aa21';
  project(root, 'app', {
    files: {
      'README.md': '# app\n\nA project.\n',
      '.env': `API_KEY=${SECRET}\n`,
      'config/creds.py': `ALPACA_SECRET = "${SECRET}"\n`,
      'private.pem': `-----BEGIN KEY-----\n${SECRET}\n`,
      'main.py': 'print("hello")\n',
    },
  });
  const res = await scanRoot(root);
  const p = (res.projects || res).find((x) => x.name === 'app');
  const brief = await buildBrief(p, {});
  const text = briefToMarkdown(brief) + JSON.stringify(brief);
  assert.ok(!text.includes(SECRET), 'THE BRIEF LEAKED A SECRET VALUE');
});

test('the artifact escapes hostile repository content', async () => {
  const root = fixtureRoot('xss');
  project(root, 'evil', {
    files: {
      'README.md': '# <script>alert(1)</script>\n\nA "><img src=x onerror=alert(1)> project.\n',
      '<weird>name.md': 'x\n',
    },
  });
  const res = await scanRoot(root);
  const p = (res.projects || res).find((x) => x.name === 'evil');
  const brief = await buildBrief(p, {});
  const html = renderArtifact(brief, { tier: 'template', generatedAtISO: '2026-01-01T00:00:00Z' });
  assert.ok(!/<script/i.test(html), 'artifact emitted a script tag');
  assert.ok(!/onerror=/i.test(html), 'artifact emitted an event handler');
  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), 'artifact contains placeholder junk');
});

test('the artifact renders an empty project without inventing content', async () => {
  const root = fixtureRoot('bare');
  project(root, 'nothing', { files: {} });
  const res = await scanRoot(root);
  const p = (res.projects || res).find((x) => x.name === 'nothing');
  const html = renderArtifact(await buildBrief(p, {}), { tier: 'template' });
  assert.ok(html.length > 2000, 'should still be a real page');
  assert.ok(/<title>/i.test(html) && /<style/i.test(html), 'must be self-contained');
  assert.ok(!/https?:\/\//.test(html.match(/(src|href)="[^"]*"/g)?.join(' ') || ''),
    'artifact must not reference anything remote');
});

test('transcript directory encoding survives underscores and dots', () => {
  // /Users/x/coding_projects/ML_quantitative_research
  //   -> -Users-x-coding-projects-ML-quantitative-research
  const enc = encodeProjectPath('/Users/x/coding_projects/ML_quantitative_research');
  assert.ok(!enc.includes('_'), `underscores must be encoded: ${enc}`);
  assert.ok(!enc.includes('/'), `slashes must be encoded: ${enc}`);
});

test('a live process alone does not mean an agent is working', async () => {
  // Regression 1: 12 of 13 claude processes on this machine were parked at a
  // prompt with transcripts last written 23-62 HOURS earlier, and all of them
  // were reported as "working". Liveness is not the signal.
  //
  // Regression 2: transcript RECENCY was not the signal either. A session that
  // finished replying thirty seconds ago has a fresh mtime and is doing
  // nothing, so a recency window still lit the indicator over an idle prompt.
  // The signal is the transcript's TURN STATE: a trailing `tool` or `user`
  // event means mid-turn, a trailing `assistant` text event means the turn
  // ended and it is waiting for input.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../lib/agents.js', import.meta.url), 'utf8'));

  assert.match(src, /function turnStateOf/,
    'turn-state detection must exist: mtime alone cannot tell working from idle');
  assert.match(src, /STALL_WINDOW_MS/,
    'a mid-turn session must stop counting as working once it has stalled');
  assert.match(src, /a\.active = Math\.min\(a\.live, workingCount\)/,
    'orbits must be bounded by BOTH live processes and sessions actually mid-turn');
  assert.match(src, /if \(a\.active > 0\) a\.state = 'working'/,
    'state "working" must require a session that is genuinely mid-turn');
  assert.match(src, /'open'/, 'there must be an "open" state for parked sessions');
});

test('the agent poller notices a state change, not just a process count', async () => {
  // Regression: the SSE poller diffed a fingerprint built from `live` alone.
  // When a session finishes its turn the process is still alive, so `live`
  // stays 1 and only `state` and `active` move: the poller concluded nothing
  // had changed and never pushed a payload. The indicator could turn on (via
  // an unrelated filesystem rescan) but could not turn OFF.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = src.indexOf('function agentSigOf');
  const body = src.slice(start, src.indexOf('async function pollAgentState'));
  // eslint-disable-next-line no-new-func
  const agentSigOf = new Function(`${body}; return agentSigOf;`)();

  const mk = (state, live, active) => new Map([['p', { state, live, active, parked: 0 }]]);

  assert.notEqual(
    agentSigOf(mk('working', 1, 1)), agentSigOf(mk('open', 1, 0)),
    'a session finishing its turn must move the signature, or the indicator can never turn off',
  );
  assert.notEqual(
    agentSigOf(mk('open', 1, 0)), agentSigOf(mk('none', 0, 0)),
    'a process exiting must move the signature',
  );
  assert.equal(
    agentSigOf(mk('working', 1, 1)), agentSigOf(mk('working', 1, 1)),
    'an unchanged state must NOT move the signature, or every poll forces a rescan',
  );
  assert.ok(!/currentAction/.test(body),
    'currentAction must stay out of the signature: it changes on every transcript '
    + 'write and would force a full rescan on every poll while an agent works');
});

test('turn state distinguishes a running tool from a finished reply', async () => {
  // The decision function itself, not just its presence in the source: this is
  // what stops the orbit spinning over a session that is waiting for input.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/agents.js', import.meta.url), 'utf8');
  const start = src.indexOf('function turnStateOf');
  const body = src.slice(start, src.indexOf('/* ---', start));
  // eslint-disable-next-line no-new-func
  const turnStateOf = new Function(`${body}; return turnStateOf;`)();

  assert.equal(turnStateOf([{ kind: 'user' }, { kind: 'tool' }, { kind: 'assistant' }]), 'idle',
    'a reply that ended in text means the turn is over');
  assert.equal(turnStateOf([{ kind: 'user' }, { kind: 'assistant' }, { kind: 'tool' }]), 'working',
    'a reply that ended by calling a tool is still mid-turn');
  assert.equal(turnStateOf([{ kind: 'assistant' }, { kind: 'user' }]), 'working',
    'a user message the model has not answered is mid-turn');
  assert.equal(turnStateOf([{ kind: 'tool' }]), 'working',
    'a long tool call writes nothing while it runs and must not flicker to idle');
  assert.equal(turnStateOf([]), 'idle',
    'an empty transcript claims nothing');
});

test('an agent working in a subfolder is still found', async () => {
  // Regression: Claude Code keys its transcript store on the SESSION'S cwd, so
  // an agent working in `ideas/team_dispatch` writes to
  // `-…-ideas-team-dispatch`, not `-…-ideas`. Resolving only the project root
  // made that project's store look untouched, which parked it, which zeroed
  // `live`, which meant the step that decides "working" never ran for it. An
  // actively working agent was reported as parked — "it isn't finding agents
  // in folders". The same failure hits a folder renamed mid-session.
  const ag = await import('../lib/agents.js');

  // Injected resolver: the encoding Claude Code uses, without depending on
  // whatever happens to exist in ~/.claude/projects on this machine.
  const encode = (p) => String(p).replace(/[/_.]/g, '-');

  const project = '/Users/x/coding_projects/ideas';
  const procs = [
    { cwd: '/Users/x/coding_projects/ideas/team_dispatch' },
    { cwd: '/Users/x/coding_projects/ideas' },
  ];

  const got = ag.transcriptDirsFor(project, procs, encode);
  assert.equal(got.root, encode(project), 'the project root store is still resolved');
  assert.ok(got.dirs.includes(encode('/Users/x/coding_projects/ideas/team_dispatch')),
    "a live process's own subfolder store must be included");
  assert.equal(got.dirs.length, 2, 'each distinct store appears exactly once');

  // A project with no live processes still resolves its own store.
  const bare = ag.transcriptDirsFor(project, [], encode);
  assert.deepEqual(bare.dirs, [encode(project)]);

  // A process whose cwd resolves to nothing must not poison the set.
  const withNull = ag.transcriptDirsFor(project, [{ cwd: '/nope' }], () => null);
  assert.deepEqual(withNull.dirs, [], 'unresolvable paths contribute nothing');
});

test('several agents in one folder are counted separately, not collapsed to one', async () => {
  // Regression: two agents started in the SAME directory share one transcript
  // store and write two session files into it. Turn detection read only the
  // newest session per store, so `workingCount` could never exceed 1 and the
  // card drew a single orbit no matter how many agents were running. The count
  // has to come from as many sessions as there are live processes.
  const ag = await import('../lib/agents.js');

  const now = Date.now();
  const mk = (id, ageMs) => ({ id, file: '/tmp/' + id + '.jsonl', mtimeMs: now - ageMs });
  const store = {
    '-Users-x-proj': [mk('a', 1000), mk('b', 4000), mk('c', 9000)],
    '-Users-x-proj-sub': [mk('d', 2000)],
  };
  const sessions = (d) => store[d] || [];

  const one = ag.turnCandidates(['-Users-x-proj'], 1, now, sessions);
  assert.deepEqual(one.map((s) => s.id), ['a'],
    'one live process still reads one session per store');

  const three = ag.turnCandidates(['-Users-x-proj'], 3, now, sessions);
  assert.deepEqual(three.map((s) => s.id), ['a', 'b', 'c'],
    'three live processes in one folder must offer three sessions to count');

  const both = ag.turnCandidates(['-Users-x-proj', '-Users-x-proj-sub'], 2, now, sessions);
  assert.deepEqual(both.map((s) => s.id), ['a', 'd', 'b'],
    'sessions from every store compete, newest first');

  // A session silent past the stall window cannot be mid-turn, so it never
  // costs a read: this is what stops an abandoned transcript adding an orbit.
  const stale = { '-Users-x-proj': [mk('old', 60 * 60 * 1000), mk('fresh', 1000)] };
  const kept = ag.turnCandidates(['-Users-x-proj'], 4, now, (d) => stale[d] || []);
  assert.deepEqual(kept.map((s) => s.id), ['fresh'], 'stalled sessions are dropped, not read');

  // The read budget is still bounded however many processes are running.
  const many = Array.from({ length: 40 }, (_, i) => mk('s' + i, i * 10));
  const capped = ag.turnCandidates(['-Users-x-proj'], 40, now, () => many);
  assert.ok(capped.length <= 6, `tail reads must stay bounded, got ${capped.length}`);

  // And a store that cannot be listed must not sink the sweep.
  assert.deepEqual(ag.turnCandidates(['-boom'], 2, now, () => { throw new Error('x'); }), []);
});
