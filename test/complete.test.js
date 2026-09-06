/**
 * Complete — the project you finished on purpose (CONTRACT-COMPLETE.md).
 *
 * Every server here runs with `--config` pointed at a throwaway file inside a
 * tmp fixture, and the marks file is written beside it, so no test can read or
 * write the developer's real completed list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fixtureRoot, cleanupFixtures, project, age, startServer } from './helpers.js';
import { Marks, marksPathFor, keyOf } from '../lib/marks.js';
import { scanRoot } from '../lib/scan.js';
import { assessProject } from '../lib/reclaim.js';

test.after(cleanupFixtures);

/* ------------------------------------------------------------------ *
 * Unit — the registry
 * ------------------------------------------------------------------ */

function marksIn(label = 'marks') {
  return new Marks({ file: path.join(fixtureRoot(label), 'marks.json') });
}

test('the marks file sits beside whatever sources file it was given', () => {
  assert.equal(marksPathFor('/tmp/x/sources.json'), '/tmp/x/marks.json');
  assert.equal(marksPathFor('/tmp/x/other-name.json'), '/tmp/x/marks.json');
  // No sources file: fall back to the real config directory, not the cwd.
  assert.ok(path.isAbsolute(marksPathFor('', '/Users/tester')));
  assert.equal(marksPathFor(null, '/Users/tester'), '/Users/tester/.ground-control/marks.json');
});

test('only an absolute path can carry a mark', () => {
  assert.equal(keyOf('/a/b'), '/a/b');
  assert.equal(keyOf('/a/b/'), '/a/b');
  assert.equal(keyOf('/a/./b'), '/a/b');
  assert.equal(keyOf('relative/path'), null);
  assert.equal(keyOf(''), null);
  assert.equal(keyOf(null), null);
  assert.equal(keyOf('/a/\0b'), null);
});

test('a mark survives a restart', () => {
  const dir = fixtureRoot('marks-persist');
  const file = path.join(dir, 'marks.json');

  const first = new Marks({ file });
  assert.equal(first.has('/projects/done-thing'), false);
  const set = first.set('/projects/done-thing', true);
  assert.equal(set.completed, true);
  assert.ok(set.completedISO);

  // A second registry over the same file is exactly a restart.
  const second = new Marks({ file });
  assert.equal(second.has('/projects/done-thing'), true);
  assert.equal(second.markedISO('/projects/done-thing'), set.completedISO);
  assert.equal(second.count(), 1);
});

test('unmarking removes the row rather than storing a false', () => {
  const m = marksIn('marks-unset');
  m.set('/projects/a', true);
  m.set('/projects/b', true);
  const off = m.set('/projects/a', false);
  assert.equal(off.completed, false);
  assert.equal(off.completedISO, null);
  assert.equal(m.count(), 1);

  const saved = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  assert.deepEqual(saved.completed.map((r) => r.path), ['/projects/b']);
});

test('marking twice keeps the original timestamp', () => {
  const m = marksIn('marks-idem');
  const first = m.set('/projects/a', true);
  const again = m.set('/projects/a', true);
  assert.equal(again.completed, true);
  assert.equal(again.completedISO, first.completedISO);
  assert.equal(m.count(), 1);
});

test('a corrupt or alien marks file means nothing is marked, never a crash', () => {
  const dir = fixtureRoot('marks-bad');

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json at all');
  const a = new Marks({ file: broken });
  assert.equal(a.count(), 0);
  assert.ok(a.loadError);

  const alien = path.join(dir, 'alien.json');
  fs.writeFileSync(alien, JSON.stringify({ version: 1, somethingElse: [] }));
  const b = new Marks({ file: alien });
  assert.equal(b.count(), 0);
  assert.ok(b.loadError);

  // A missing file is the normal first run, and is not an error.
  const c = new Marks({ file: path.join(dir, 'nope.json') });
  assert.equal(c.count(), 0);
  assert.equal(c.loadError, null);
});

test('junk rows inside a well-formed file are skipped, good ones kept', () => {
  const dir = fixtureRoot('marks-junk');
  const file = path.join(dir, 'marks.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    completed: [
      { path: '/projects/good', completedISO: '2026-01-02T03:04:05.000Z' },
      { path: 'relative/bad' },
      { path: '/projects/no-date' },
      null,
      'nonsense',
      { path: '/projects/good', completedISO: '2020-01-01T00:00:00.000Z' },  // dupe
    ],
  }));
  const m = new Marks({ file });
  assert.equal(m.count(), 2);
  assert.equal(m.markedISO('/projects/good'), '2026-01-02T03:04:05.000Z');
  assert.ok(m.has('/projects/no-date'));
});

test('applyTo stamps completed onto a project list, in place', () => {
  const m = marksIn('marks-apply');
  m.set('/projects/done', true);
  const projects = [
    { id: 'done', path: '/projects/done' },
    { id: 'live', path: '/projects/live' },
    null,
  ];
  m.applyTo(projects);
  assert.equal(projects[0].completed, true);
  assert.ok(projects[0].completedISO);
  assert.equal(projects[1].completed, false);
  assert.equal(projects[1].completedISO, null);
});

/* ------------------------------------------------------------------ *
 * Unit — Reclaim must not offer to bin a finished project
 * ------------------------------------------------------------------ */

test('a project marked complete is blocked from removal', async () => {
  const root = fixtureRoot('complete-reclaim');
  const dir = project(root, 'finished', { files: {} });
  age(dir, 200);

  const res = await scanRoot(root);
  const summary = (res.projects || res).find((x) => x.name === 'finished');
  assert.ok(summary, 'the fixture project was scanned');
  const quiet = { root, agent: { state: 'none', live: 0 } };

  const before = await assessProject(summary, quiet);
  assert.equal(before.verdict, 'dead', 'an old empty folder is the reclaim case');
  assert.deepEqual(before.blockers, []);

  const after = await assessProject(Object.assign({}, summary, { completed: true }), quiet);
  assert.equal(after.verdict, 'keep');
  assert.ok(after.blockers.some((b) => b.code === 'marked-complete'),
    'the mark itself must be the stated reason');
});

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

test('a project can be marked, read back, and unmarked over HTTP', async () => {
  const root = fixtureRoot('complete-http');
  project(root, 'alpha', { files: { 'README.md': '# alpha\n' } });
  const srv = await startServer(root);
  try {
    const first = await srv.json('/api/projects');
    const alpha = first.projects.find((p) => p.name === 'alpha');
    assert.ok(alpha, 'the fixture project is in the scan');
    assert.equal(alpha.completed, false, 'nothing is marked to begin with');
    assert.equal(alpha.completedISO, null);

    const marked = await srv.postJson('/api/complete/' + alpha.id, { completed: true });
    assert.equal(marked.status, 200);
    assert.equal(marked.json.completed, true);
    assert.ok(marked.json.completedISO);
    assert.equal(marked.json.path, alpha.path);

    // The grid payload, not just the answer to the POST.
    const second = await srv.json('/api/projects?fresh=1');
    assert.equal(second.projects.find((p) => p.id === alpha.id).completed, true);

    // The detail payload too.
    const detail = await srv.json('/api/project/' + alpha.id);
    assert.equal(detail.completed, true);

    const list = await srv.json('/api/complete');
    assert.equal(list.count, 1);
    assert.deepEqual(list.completed.map((r) => r.path), [alpha.path]);

    const cleared = await srv.del('/api/complete/' + alpha.id);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.completed, false);

    const third = await srv.json('/api/projects?fresh=1');
    assert.equal(third.projects.find((p) => p.id === alpha.id).completed, false);
  } finally {
    srv.stop();
  }
});

test('the mark is written beside the source list it was configured with', async () => {
  const root = fixtureRoot('complete-file');
  project(root, 'beta');
  const config = path.join(fixtureRoot('complete-config'), 'sources.json');
  const srv = await startServer(root, { config });
  try {
    const payload = await srv.json('/api/projects');
    const beta = payload.projects.find((p) => p.name === 'beta');
    await srv.postJson('/api/complete/' + beta.id, { completed: true });

    const marksFile = path.join(path.dirname(config), 'marks.json');
    assert.ok(fs.existsSync(marksFile), 'marks land beside the throwaway sources file');
    const saved = JSON.parse(fs.readFileSync(marksFile, 'utf8'));
    assert.deepEqual(saved.completed.map((r) => r.path), [beta.path]);
  } finally {
    srv.stop();
  }
});

test('a marked project is no longer offered for removal', async () => {
  const root = fixtureRoot('complete-sweep');
  const dir = project(root, 'stale', { files: {} });
  age(dir, 200);
  const srv = await startServer(root);
  try {
    /* `assessments` is keyed by project id, not a list. */
    const before = await srv.json('/api/reclaim');
    const ids = Object.keys(before.assessments);
    const id = ids.find((k) => before.assessments[k].projectName === 'stale');
    assert.ok(id, 'the stale folder is assessed');
    assert.equal(before.assessments[id].verdict, 'dead');

    const marked = await srv.postJson('/api/complete/' + id, { completed: true });
    assert.equal(marked.status, 200);

    const after = await srv.json('/api/reclaim?fresh=1');
    const kept = after.assessments[id];
    assert.equal(kept.verdict, 'keep');
    assert.ok(kept.blockers.some((b) => b.code === 'marked-complete'),
      'and it says why');
  } finally {
    srv.stop();
  }
});

test('an unknown project, or an id shaped like a path, is refused', async () => {
  const root = fixtureRoot('complete-guard');
  project(root, 'gamma');
  const srv = await startServer(root);
  try {
    const missing = await srv.postJson('/api/complete/no-such-project', { completed: true });
    assert.equal(missing.status, 404);

    const traversal = await srv.postJson('/api/complete/..%2F..%2Fetc', { completed: true });
    assert.equal(traversal.status, 404);

    const bare = await srv.get('/api/complete/');
    assert.equal(bare.status, 404);
  } finally {
    srv.stop();
  }
});

test('marking never touches the project folder', async () => {
  const root = fixtureRoot('complete-untouched');
  const dir = project(root, 'delta', { files: { 'README.md': '# delta\n', 'src/a.js': 'x\n' } });
  const srv = await startServer(root);
  try {
    const before = fs.readdirSync(dir).sort();
    const payload = await srv.json('/api/projects');
    const delta = payload.projects.find((p) => p.name === 'delta');

    await srv.postJson('/api/complete/' + delta.id, { completed: true });

    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no file was added or removed');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# delta\n');
  } finally {
    srv.stop();
  }
});
