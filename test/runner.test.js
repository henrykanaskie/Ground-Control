/**
 * Run: the properties that would be expensive to regress.
 *
 * Detection decides what gets executed in someone's project, so most of this
 * is fixtures proving the right command is picked and that setup is only
 * planned when it is needed. The run tests spawn real `node` processes (the
 * one thing every machine running this suite has) to prove a busy port and
 * a never-installed dependency are cured without anyone typing anything, and
 * that Stop takes the whole process tree down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fixtureRoot, cleanupFixtures, project, write, startServer } from './helpers.js';
import * as runner from '../lib/runner.js';

process.env.GROUND_CONTROL_NO_LOGIN_SHELL = '1';
test.after(cleanupFixtures);

function svc(dir) { return runner.detectPlan(dir).services[0]; }

function waitFor(projectId, pred, ms = 20000) {
  return new Promise((resolve, reject) => {
    const run = runner.get(projectId);
    if (run && pred(run)) return resolve(run);
    const t = setTimeout(() => { off(); reject(new Error('timed out; state ' + (runner.get(projectId) || {}).state)); }, ms);
    const off = runner.subscribe(projectId, (ev, r) => { if (pred(r)) { clearTimeout(t); off(); resolve(r); } });
  });
}

/* ---- detection ----------------------------------------------------- */

test('npm: prefers dev over start, and plans an install only when node_modules is missing', () => {
  const root = fixtureRoot('rn-npm');
  const dir = project(root, 'web', { files: {
    'package.json': JSON.stringify({ scripts: { test: 'x', start: 'node s.js', dev: 'vite' }, dependencies: { vite: '1' } }),
  } });
  let s = svc(dir);
  assert.equal(s.kind, 'node');
  assert.deepEqual(s.starts[0].argv, ['npm', 'run', 'dev']);
  assert.ok(!s.starts.some((x) => x.id === 'script:test'), 'test is not a way to start a project');
  assert.equal(s.starts[0].portHint, 5173);
  assert.equal(s.setup[0].id, 'install');

  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, 'node_modules', '.package-lock.json'), later, later);
  s = svc(dir);
  assert.ok(!s.setup.some((x) => x.id === 'install'), 'a current node_modules must not be reinstalled on every Run');
});

test('the lockfile picks the package manager', () => {
  const root = fixtureRoot('rn-pm');
  const pnpm = project(root, 'p', { files: { 'package.json': '{"scripts":{"dev":"x"}}', 'pnpm-lock.yaml': '' } });
  const yarn = project(root, 'y', { files: { 'package.json': '{"scripts":{"dev":"x"}}', 'yarn.lock': '' } });
  assert.deepEqual(svc(pnpm).starts[0].argv, ['pnpm', 'run', 'dev']);
  assert.deepEqual(svc(yarn).starts[0].argv, ['yarn', 'dev']);
});

test('a package.json that only holds tooling does not hide a Python entry file', () => {
  const root = fixtureRoot('rn-mixed');
  const dir = project(root, 'bot', { files: {
    'package.json': JSON.stringify({ devDependencies: { prettier: '3' }, scripts: { format: 'prettier .' } }),
    'main.py': 'print(1)\n',
  } });
  const s = svc(dir);
  assert.equal(s.kind, 'python');
  assert.equal(s.starts[0].label, 'python main.py');
});

test('python: a virtualenv is planned, packages go into it, and frameworks get their own runner', () => {
  const root = fixtureRoot('rn-py');
  const dir = project(root, 'api', { files: {
    'requirements.txt': 'fastapi\n',
    'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  } });
  const s = svc(dir);
  assert.deepEqual(s.setup.map((x) => x.id), ['venv', 'install']);
  assert.ok(s.setup[1].argv[0].includes(path.join('.venv', 'bin', 'python')) || s.setup[1].argv[0].includes('Scripts'),
    'pip must be the virtualenv\'s, never the system one');
  assert.deepEqual(s.starts[0].argv.slice(1), ['-m', 'uvicorn', 'main:app', '--reload']);

  const dj = project(root, 'site', { files: { 'manage.py': '', 'requirements.txt': 'django\n' } });
  assert.deepEqual(svc(dj).starts[0].argv.slice(1), ['manage.py', 'runserver']);
});

test('a .env is copied from the example only when there is none', () => {
  const root = fixtureRoot('rn-env');
  const dir = project(root, 'e', { files: { 'package.json': '{"scripts":{"start":"node a"}}', '.env.example': 'A=1\n' } });
  assert.equal(svc(dir).setup[0].builtin, 'copy');
  write(dir, '.env', 'A=2\n');
  assert.ok(!svc(dir).setup.some((x) => x.builtin === 'copy'), 'an existing .env must never be overwritten');
});

test('frontend/ + backend/ with nothing at the root runs both', () => {
  const root = fixtureRoot('rn-multi');
  const dir = project(root, 'full', { files: {
    'README.md': '# x',
    'frontend/package.json': '{"scripts":{"dev":"vite"}}',
    'backend/main.py': 'print(1)\n',
  } });
  const plan = runner.detectPlan(dir);
  assert.deepEqual(plan.services.map((s) => s.dir), ['backend', 'frontend']);
});

test('a folder with nothing runnable says so instead of guessing', async () => {
  const root = fixtureRoot('rn-none');
  const dir = project(root, 'notes', { files: { 'README.md': '# notes' } });
  const plan = await runner.preflight(runner.detectPlan(dir));
  assert.equal(plan.ok, false);
  assert.equal(plan.checks[0].level, 'error');
});

test('a missing tool is reported before anything runs', async () => {
  const root = fixtureRoot('rn-missing');
  const dir = project(root, 'r', { files: { 'Cargo.toml': '[package]\nname="r"\n' } });
  const plan = runner.detectPlan(dir);
  plan.services[0].starts[0].argv = ['definitely-not-a-real-tool-gc', 'run'];
  await runner.preflight(plan);
  assert.equal(plan.ok, false);
  assert.match(plan.checks[0].text, /definitely-not-a-real-tool-gc/);
});

/* ---- diagnosis ----------------------------------------------------- */

test('diagnose: the failures with a known cure are recognised', () => {
  const node = { kind: 'node', id: '.', installStep: { argv: ['npm', 'install'] } };
  const py = { kind: 'python', id: '.', python: '/x/.venv/bin/python', installStep: { argv: ['p'] } };
  const start = { kind: 'start', argv: ['npm', 'run', 'dev'] };

  assert.equal(runner.diagnose('Error: listen EADDRINUSE: address already in use :::3000', { step: start, service: node }).fix.port, 3000);
  assert.equal(runner.diagnose("Error: Cannot find module 'express'", { step: start, service: node }).fix.type, 'install');
  assert.equal(runner.diagnose('npm ERR! code ERESOLVE', { step: { id: 'install', argv: ['npm', 'install'] }, service: node }).fix.flag, '--legacy-peer-deps');

  const first = runner.diagnose("ModuleNotFoundError: No module named 'cv2'", { step: start, service: py, installedThisRun: false });
  assert.equal(first.fix.type, 'install', 'install the requirements before guessing at a package');
  const second = runner.diagnose("ModuleNotFoundError: No module named 'cv2'", { step: start, service: py, installedThisRun: true });
  assert.deepEqual(second.fix, { type: 'pip', pkg: 'opencv-python' });

  const db = runner.diagnose('Error: connect ECONNREFUSED 127.0.0.1:5432', { step: start, service: node });
  assert.match(db.title, /PostgreSQL/);
  assert.equal(db.fix, undefined, 'starting someone\'s database is not a cure Run applies by itself');
});

test('withPort moves a start command in the way its tool understands', () => {
  assert.deepEqual(runner.withPort({ argv: ['npm', 'run', 'dev'], portFlag: 'npm' }, 5174).argv, ['npm', 'run', 'dev', '--', '--port', '5174']);
  assert.deepEqual(runner.withPort({ argv: ['py', 'manage.py', 'runserver'], portFlag: 'django' }, 8001).argv, ['py', 'manage.py', 'runserver', '8001']);
  assert.equal(runner.withPort({ argv: ['node', 'a.js'] }, 4000).env.PORT, '4000');
});

/* ---- running ------------------------------------------------------- */

const SERVER_JS = `const http=require('http');const port=Number(process.env.PORT||process.argv[process.argv.indexOf('--port')+1]||0);
http.createServer((q,r)=>r.end('ok')).listen(port,()=>console.log('ready at http://localhost:'+port+'/'));`;

test('a busy port is moved without anyone typing, the address is found, and Stop ends it', async () => {
  const blocker = net.createServer();
  const busy = await new Promise((r) => blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)));
  const root = fixtureRoot('rn-port');
  const dir = project(root, 'srv', { files: {
    'package.json': JSON.stringify({ name: 'srv', scripts: { dev: 'node server.js' } }),
    'server.js': SERVER_JS.replace("process.env.PORT||", `process.env.PORT||${busy}||`),
  } });
  try {
    await runner.start({ id: 'rn-port', path: dir });
    const run = await waitFor('rn-port', (r) => r.urls.length || runner.isTerminal(r.state));
    assert.equal(run.state, 'running', JSON.stringify(run.diagnosis));
    assert.equal(run.fixes.length, 1);
    assert.match(run.fixes[0].title, new RegExp(String(busy)));
    assert.ok(!run.urls[0].includes(':' + busy + '/'), 'the address shown must be the new port');

    const pid = run.steps.find((s) => s.kind === 'start').pid;
    runner.stop('rn-port');
    await waitFor('rn-port', (r) => r.state === 'stopped');
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(pid, 0), 'Stop must take the process down');
  } finally {
    runner.stop('rn-port');
    blocker.close();
  }
});

test('a dependency that was never installed is installed, then the start retried', async () => {
  const root = fixtureRoot('rn-dep');
  const dir = project(root, 'dep', { files: {
    'package.json': JSON.stringify({ name: 'dep', scripts: { start: 'node index.js' }, dependencies: { 'gc-local-dep': 'file:./vendor/d' } }),
    'vendor/d/package.json': JSON.stringify({ name: 'gc-local-dep', version: '1.0.0', main: 'i.js' }),
    'vendor/d/i.js': 'module.exports = () => "installed"',
    'index.js': 'console.log(require("gc-local-dep")())',
  } });
  // An empty node_modules newer than package.json looks installed to the
  // planner, so the start fails first and troubleshooting has to catch it.
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, 'node_modules'), later, later);

  await runner.start({ id: 'rn-dep', path: dir });
  const run = await waitFor('rn-dep', (r) => runner.isTerminal(r.state), 60000);
  assert.equal(run.state, 'done', JSON.stringify(run.diagnosis));
  assert.match(run.fixes[0].action, /Installing the dependencies/);
  assert.ok(run.log.some((e) => e.l === 'installed'));
});

test('a failure with no known cure ends with a diagnosis, not a loop', async () => {
  const root = fixtureRoot('rn-fail');
  const dir = project(root, 'bad', { files: { 'package.json': JSON.stringify({ scripts: { start: 'node -e "process.exit(3)"' } }) } });
  await runner.start({ id: 'rn-fail', path: dir });
  const run = await waitFor('rn-fail', (r) => runner.isTerminal(r.state));
  assert.equal(run.state, 'failed');
  assert.ok(run.diagnosis && run.diagnosis.title);
  assert.equal(run.fixes.length, 0);
});

/* ---- the routes ---------------------------------------------------- */

test('the run routes plan a watched project and refuse unknown ones', async () => {
  const root = fixtureRoot('rn-http');
  project(root, 'site', { files: { 'package.json': '{"scripts":{"dev":"vite"}}' } });
  const srv = await startServer(root);
  try {
    const plan = await srv.json('/api/run/site/plan');
    assert.equal(plan.services[0].starts[0].command, 'npm run dev');
    assert.equal((await srv.get('/api/run/nope/plan')).status, 404);
    assert.equal((await srv.get('/api/run/site/start')).status, 405, 'starting is a POST');
    // A caller picks an index; a command line in the body is never read.
    const r = await srv.postJson('/api/run/site/start', { choices: { '.': 0 }, command: 'touch /tmp/gc-pwned' });
    assert.equal(r.status, 202);
    assert.ok(!fs.existsSync('/tmp/gc-pwned'));
    await srv.post('/api/run/site/stop');
  } finally {
    srv.stop();
  }
});

test('a cure that did not work is not recommended again', async () => {
  const root = fixtureRoot('rn-still');
  const dir = project(root, 'still', { files: { 'package.json': JSON.stringify({ name: 'still', scripts: { start: 'node -e "require(\'gc-absent-mod\')"' } }) } });
  await runner.start({ id: 'rn-still', path: dir });
  const run = await waitFor('rn-still', (r) => runner.isTerminal(r.state), 60000);
  assert.equal(run.state, 'failed');
  assert.equal(run.fixes.length, 1, 'the install is tried once, never in a loop');
  assert.match(run.diagnosis.hint, /npm install gc-absent-mod/);
});
