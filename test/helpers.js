/**
 * Ground Control test helpers.
 *
 * Everything here builds throwaway fixtures under the OS temp directory.
 * NO TEST MAY EVER TOUCH ~/coding_projects — Reclaim moves folders to the
 * Trash, and a test pointed at a real root would be unrecoverable in the worst
 * case and confusing in the best.  `fixtureRoot()` is the only sanctioned way
 * to get a root, and it refuses to hand back a path outside tmp.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.realpathSync(os.tmpdir());
const made = [];

/** A fresh, empty root that is guaranteed to be inside the temp directory. */
export function fixtureRoot(label = 'root') {
  const dir = fs.mkdtempSync(path.join(TMP, `ground-control-test-${label}-`));
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP + path.sep)) {
    throw new Error(`refusing to use a fixture root outside tmp: ${real}`);
  }
  made.push(real);
  return real;
}

/** Remove every fixture this process created. Safe by construction: tmp only. */
export function cleanupFixtures() {
  for (const dir of made.splice(0)) {
    if (dir.startsWith(TMP + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a file, creating parents. Returns the absolute path. */
export function write(root, rel, content = '') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** Backdate a path so age-based rules (idle/dormant) can be exercised. */
export function age(target, days) {
  const t = new Date(Date.now() - days * 86400_000);
  fs.utimesSync(target, t, t);
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A project directory in a chosen git state.
 *
 * `state` is one of:
 *   'none'      no repository at all
 *   'clean'     one commit, everything committed, a remote that "has" it
 *   'dirty'     committed, then an uncommitted edit
 *   'unpushed'  a commit that exists on no remote
 *   'noremote'  commits but no remote configured at all
 */
export function project(root, name, { files = { 'README.md': '# x\n' }, state = 'none' } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  if (state === 'none') return dir;

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'initial');

  if (state === 'clean' || state === 'dirty' || state === 'unpushed') {
    // A bare repo standing in for a remote, so "pushed" is a real fact.
    const remote = path.join(root, `.remotes-${name}.git`);
    git(root, 'init', '-q', '--bare', remote);
    git(dir, 'remote', 'add', 'origin', remote);
    if (state !== 'unpushed') git(dir, 'push', '-q', 'origin', 'main');
    else write(dir, 'later.txt', 'committed but never pushed'),
         git(dir, 'add', '-A'), git(dir, 'commit', '-qm', 'unpushed work');
  }
  if (state === 'dirty') write(dir, 'README.md', '# x\nedited, never committed\n');
  return dir;
}

/** Start the real server on an ephemeral port against a fixture root. */
export async function startServer(root) {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const port = await new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const serverPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server.js');
  const child = spawn(process.execPath, [serverPath, '--port', String(port), '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (Date.now() > deadline) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} throw new Error('server did not start'); }
    try { const r = await fetch(`${base}/api/projects`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return {
    base, port,
    async get(p) { const r = await fetch(base + p); return { status: r.status, body: await r.text() }; },
    async json(p) { const r = await fetch(base + p); return r.json(); },
    async post(p, body) {
      const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      return { status: r.status, body: await r.text() };
    },
    stop() { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } },
  };
}
