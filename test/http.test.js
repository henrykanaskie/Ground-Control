/**
 * The server, driven over real HTTP against a fixture root.
 * Nothing here points at ~/coding_projects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRoot, cleanupFixtures, project, write, age, startServer } from './helpers.js';

let srv, root;

test.before(async () => {
  root = fixtureRoot('http');
  project(root, 'alpha', { files: { 'ONBOARDING.md': '# Taking over alpha\n\nEverything you need.\n', 'src/main.py': 'print(1)\n' } });
  project(root, 'beta', { files: { 'README.md': '# beta\n\nA second project.\n' }, state: 'clean' });
  const empty = project(root, 'hollow', { files: {} });
  age(empty, 300);
  srv = await startServer(root);
});
test.after(() => { srv?.stop(); cleanupFixtures(); });

test('the project list serves the fixture root', async () => {
  const d = await srv.json('/api/projects');
  assert.equal(d.root, root);
  assert.equal(d.projects.length, 3);
  assert.ok(d.projects.every((p) => p.id && p.name && p.status));
});

test('status classification: empty vs active', async () => {
  const d = await srv.json('/api/projects');
  const by = Object.fromEntries(d.projects.map((p) => [p.name, p]));
  assert.equal(by.hollow.status, 'empty');
  assert.equal(by.alpha.status, 'active');
});

test('an onboarding doc is discovered and featured', async () => {
  const d = await srv.json('/api/projects');
  const alpha = d.projects.find((p) => p.name === 'alpha');
  assert.equal(alpha.featuredDoc.path, 'ONBOARDING.md');
  assert.equal(alpha.featuredDoc.kind, 'onboarding');
  assert.match(alpha.blurb, /Everything you need/);
});

test('core endpoints answer', async () => {
  for (const p of ['/', '/api/projects', '/api/editors', '/api/agents', '/api/reclaim']) {
    assert.equal((await srv.get(p)).status, 200, `${p} should be 200`);
  }
});

test('unknown ids are 404, not 500', async () => {
  assert.equal((await srv.get('/api/project/no-such-thing')).status, 404);
  assert.equal((await srv.get('/api/reclaim/no-such-thing')).status, 404);
});

test('a document can be read back', async () => {
  const d = await srv.json('/api/projects');
  const id = d.projects.find((p) => p.name === 'alpha').id;
  const doc = await srv.json(`/api/doc?id=${id}&path=ONBOARDING.md`);
  assert.match(doc.content, /Taking over alpha/);
});

test('path traversal is refused on every file-reading route', async () => {
  const d = await srv.json('/api/projects');
  const id = d.projects.find((p) => p.name === 'alpha').id;
  const attacks = [
    '../../../../etc/passwd',
    '/etc/passwd',
    'src/../../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    './../../etc/passwd',
  ];
  for (const a of attacks) {
    for (const route of ['/api/doc', '/api/raw']) {
      const r = await srv.get(`${route}?id=${id}&path=${encodeURIComponent(a)}`);
      assert.ok(r.status === 403 || r.status === 404,
        `${route} with ${a} returned ${r.status}; must refuse`);
      assert.ok(!/root:/.test(r.body), `${route} with ${a} LEAKED /etc/passwd`);
    }
  }
});

test('static serving cannot escape the public directory', async () => {
  const r = await srv.get('/../server.js');
  assert.ok(r.status === 403 || r.status === 404, `got ${r.status}`);
  assert.ok(!/createServer/.test(r.body), 'served server.js through a traversal');
});

test('reclaim refuses a wrong confirmation name and changes nothing', async () => {
  const d = await srv.json('/api/projects');
  const hollow = d.projects.find((p) => p.name === 'hollow');
  const r = await srv.post(`/api/reclaim/${hollow.id}/trash`, { confirmName: 'not-the-name' });
  assert.equal(r.status, 400);
  const after = await srv.json('/api/projects');
  assert.ok(after.projects.some((p) => p.name === 'hollow'), 'the folder must still exist');
});

test('reclaim refuses a blocked project with 409 and lists why', async () => {
  const d = await srv.json('/api/projects');
  const alpha = d.projects.find((p) => p.name === 'alpha');   // recent activity
  const r = await srv.post(`/api/reclaim/${alpha.id}/trash`, { confirmName: 'alpha' });
  assert.equal(r.status, 409);
  assert.match(r.body, /blocker/i);
});

test('GET routes never mutate the root', async () => {
  const before = (await srv.json('/api/projects')).projects.map((p) => p.name).sort();
  for (const p of ['/api/projects?fresh=1', '/api/reclaim', '/api/agents', '/api/editors']) await srv.get(p);
  const after = (await srv.json('/api/projects')).projects.map((p) => p.name).sort();
  assert.deepEqual(after, before);
});
