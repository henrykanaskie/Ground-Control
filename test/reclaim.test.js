/**
 * Reclaim is the only destructive feature, so these are the tests that matter
 * most. Every fixture lives in the OS temp directory — see test/helpers.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureRoot, cleanupFixtures, project, write, age } from './helpers.js';
import { scanRoot } from '../lib/scan.js';
import { assessProject, isGroundControl } from '../lib/reclaim.js';

test.after(cleanupFixtures);

/** Assess one project inside a fixture root, the way the server does. */
async function assess(root, name) {
  const res = await scanRoot(root);
  const projects = res.projects || res;
  const p = projects.find((x) => x.name === name);
  assert.ok(p, `fixture project ${name} was not scanned`);
  return assessProject(p, { root, agent: { state: 'none', live: 0 } });
}
const codes = (a) => (a.blockers || []).map((b) => (typeof b === 'string' ? b : b.code));

test('an empty folder is a candidate', async () => {
  const root = fixtureRoot('empty');
  const dir = project(root, 'nothing', { files: {} });
  age(dir, 200);
  const a = await assess(root, 'nothing');
  assert.deepEqual(codes(a), [], `expected no blockers, got ${codes(a)}`);
  assert.equal(a.meaningfulFiles, 0);
});

test('uncommitted changes block removal', async () => {
  // pitwall is the real-world case: dormant 5 months, 334MB, and 5 dirty files.
  const root = fixtureRoot('dirty');
  project(root, 'work', { state: 'dirty' });
  const a = await assess(root, 'work');
  assert.ok(codes(a).includes('uncommitted-changes'), `got ${codes(a)}`);
});

test('commits that exist on no remote block removal', async () => {
  const root = fixtureRoot('unpushed');
  project(root, 'work', { state: 'unpushed' });
  const a = await assess(root, 'work');
  const c = codes(a);
  assert.ok(c.includes('unpushed-commits') || c.includes('no-remote'), `got ${c}`);
});

test('a repo with commits but no remote at all blocks removal', async () => {
  // This folder is the only copy of that work in existence.
  const root = fixtureRoot('noremote');
  project(root, 'work', { state: 'noremote' });
  const a = await assess(root, 'work');
  assert.ok(codes(a).includes('no-remote'), `got ${codes(a)}`);
});

test('substantial content blocks removal even when old', async () => {
  const root = fixtureRoot('big');
  const files = {};
  for (let i = 0; i < 60; i++) files[`src/f${i}.js`] = `// file ${i}\n`.repeat(40);
  const dir = project(root, 'big', { files });
  age(dir, 400);
  const a = await assess(root, 'big');
  assert.ok(codes(a).includes('substantial-content'), `got ${codes(a)}`);
});

test('recent activity blocks removal', async () => {
  const root = fixtureRoot('fresh');
  project(root, 'fresh', { files: { 'a.txt': 'x' } });
  const a = await assess(root, 'fresh');
  assert.ok(codes(a).includes('recent-activity'), `got ${codes(a)}`);
});

test('a running agent blocks removal', async () => {
  const root = fixtureRoot('agent');
  const dir = project(root, 'busy', { files: {} });
  age(dir, 300);
  const res = await scanRoot(root);
  const p = (res.projects || res).find((x) => x.name === 'busy');
  const a = await assessProject(p, { root, agent: { state: 'working', live: 2 } });
  assert.ok(codes(a).includes('agent-running'), `got ${codes(a)}`);
});

test('virtualenv bulk does not count as meaningful content', async () => {
  // water_potability: 11,557 files on disk, 5 that matter.
  const root = fixtureRoot('venv');
  const files = { 'model.py': 'print(1)\n' };
  for (let i = 0; i < 80; i++) files[`pot-venv/lib/python3.12/site-packages/m${i}.py`] = 'x\n'.repeat(50);
  const dir = project(root, 'sci', { files });
  age(dir, 300);
  const a = await assess(root, 'sci');
  assert.ok(a.meaningfulFiles < 10, `venv contents leaked into the count: ${a.meaningfulFiles}`);
  assert.ok(!codes(a).includes('substantial-content'), `got ${codes(a)}`);
});

test('Ground Control refuses to identify anything but itself as itself', () => {
  assert.equal(isGroundControl({ path: '/tmp/some/other/place' }), false);
});

test('Ground Control protects its own directory by real path, not by name', () => {
  // The folder was renamed sauron -> ground-control; this must not depend on the name.
  const self = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.equal(isGroundControl({ path: self }), true);
});
