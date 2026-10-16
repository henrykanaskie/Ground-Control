/**
 * Shared fixtures for the Forge tests: a small demo repository, and a fake
 * `claude` CLI that prints canned stream-json so the whole authored path
 * (write, repair, review, re-review, gates) runs in milliseconds and costs
 * nothing. Every directory comes from `fixtureRoot`, so it lives in tmp.
 *
 * The fake reads each prompt from stdin and decides which canned answer to
 * give by what kind of turn it is:
 *
 *   a review turn (the prompt carries the review title)   FAKE_REVIEW, then FAKE_REVIEW2
 *                                                         (default: every listed part 5/5)
 *   a resumed turn asking for parts to be taught again     FAKE_TEACH
 *   a resumed turn asking for the whole document again     FAKE_WHOLE
 *   any other resumed turn (the coverage repair)           FAKE_REPAIR
 *   the first turn (and a fresh retry of it)               FAKE_FIRST
 *
 * FAKE_FIRST_FAILS=n makes the first n fresh turns exit 1; FAKE_LIMIT=1 makes
 * every turn report a usage limit.
 *
 * Every prompt is appended to FAKE_LOG under a `=== KIND ===` header.
 */
import fs from 'node:fs';
import path from 'node:path';

import { fixtureRoot, project, write } from './helpers.js';
import { scanRoot } from '../lib/scan.js';
import { buildBrief } from '../lib/brief.js';
import { startGeneration } from '../lib/generate.js';
import { REVIEW_TITLE } from '../lib/teaching.js';
import * as jobs from '../lib/jobs.js';

/** A source file with a real header comment and named functions behind it. */
export const code = (header, n, stem = 'helperValue') => `/**\n * ${header}\n */\n`
  + Array.from({ length: n }, (_, i) => `export function ${stem}${i}(a, b) { return a + b * ${i}; }`).join('\n') + '\n';

export const DEMO = {
  'package.json': JSON.stringify({ name: 'demo', main: 'server.js', scripts: { test: 'node --test' } }),
  'README.md': '# demo\n\nA demo service that answers requests from a store.\n',
  '.gitignore': 'node_modules\n',
  'server.js': code('Demo server: answers HTTP requests from the store.', 80, 'serveRequest'),
  'src/store.js': code('The store: keeps every record in one JSON file.', 120, 'storeRecord'),
  'src/router.js': code('Routing: maps a URL to a handler.', 70, 'routeUrl'),
  'src/util/strings.js': code('String helpers for the router.', 3, 'formatText'),
  'src/util/dates.js': code('Date helpers for the router.', 3, 'formatDate'),
  'test/store.test.js': code('Tests for the store.', 10, 'checkStore'),
  'docs/guide.md': '# A guide to the demo\n\nRead this.\n',
  'data/sample.csv': 'a,b\n1,2\n',
};

export async function briefFor(files, name = 'demo', state = 'clean') {
  const root = fixtureRoot('coverage');
  project(root, name, { files, state });
  const res = await scanRoot(root);
  const p = (res.projects || res).find((x) => x.name === name);
  return { project: p, brief: await buildBrief(p, {}) };
}

export const words = (n) => 'word '.repeat(n).trim();

/** A real-looking page: over 2 KB, a title, a style, and the given body. */
export function page(body) {
  return `<!DOCTYPE html><html><head><title>Taking over demo</title><style>${'body{margin:0}\n'.repeat(160)}</style></head>`
    + `<body><main class="wrap">${body}</main><footer><div class="wrap">end</div></footer></body></html>`;
}

/** Another part with a real path, for a section to connect to. */
function neighbour(parts, p) {
  const o = parts.find((x) => x.id !== p.id && x.path !== '.');
  return o ? o.path : '';
}

/**
 * One part's section, taught to the standard its importance needs. `omit`
 * drops elements, to build a section that fails a specific check:
 * 'grounding', 'trade-off', 'connection', 'learner check'.
 */
export function section(parts, p, omit = []) {
  const no = (k) => omit.includes(k);
  const bits = [`<h2 class="sec">${p.path}</h2>`, `<p class="body">${words(p.importance === 'core' ? 70 : 12)}</p>`];
  if (p.importance !== 'minor') {
    if (!no('grounding')) bits.push(`<p class="body">Open <code>${(p.scope || [])[0]}</code> first.</p>`);
    if (!no('connection')) bits.push(`<p class="body">It hands its result to <code>${neighbour(parts, p)}</code>.</p>`);
  }
  if (p.importance === 'core') {
    if (!no('trade-off')) bits.push('<div class="decide"><h3 class="dq">Why a file and not a server?</h3></div>');
    if (!no('learner check')) bits.push('<details class="guess"><summary>What happens on a second write?</summary><div class="gbody"><p>it waits</p></div></details>');
  }
  return `<section data-part="${p.id}">${bits.join('')}</section>`;
}

/** Sections teaching every part on the map except those in `skip`. */
export function teach(parts, skip = [], weaken = {}) {
  return parts.filter((p) => !skip.includes(p.id)).map((p) => section(parts, p, weaken[p.id] || [])).join('\n');
}

/** The rubric JSON a reviewer would return. */
export function review(scores) {
  return JSON.stringify({ parts: Object.entries(scores).map(([id, s]) => ({
    id, scores: typeof s === 'number' ? { accurate: s, why: s, followable: s, connected: s } : s,
    problems: (typeof s === 'number' ? s : Math.min(...Object.values(s))) < 4 ? ['the trade-off is asserted, not argued'] : [],
  })) });
}

const FAKE = String.raw`
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const resume = argv.includes('--resume');
  const isReview = input.includes(process.env.FAKE_REVIEW_TITLE);
  const isTeach = resume && input.includes('not yet taught well enough');
  const isWhole = resume && input.includes('cannot be used as it is');
  const kind = isReview ? 'REVIEW' : isTeach ? 'TEACH' : isWhole ? 'WHOLE' : resume ? 'REPAIR' : 'FIRST';
  fs.appendFileSync(process.env.FAKE_LOG, '=== ' + kind + ' ===\n' + input + '\n');
  const firsts = (fs.readFileSync(process.env.FAKE_LOG, 'utf8').match(/=== FIRST ===/g) || []).length;
  if (process.env.FAKE_LIMIT === '1') {
    console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm.', session_id: 's', total_cost_usd: 0, duration_ms: 1 }));
    process.exit(1);
  }
  if (kind === 'FIRST' && firsts <= Number(process.env.FAKE_FIRST_FAILS || 0)) {
    console.error('transient failure'); process.exit(1);
  }
  let out = '';
  const read = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  if (isReview) {
    const n = (fs.readFileSync(process.env.FAKE_LOG, 'utf8').match(/=== REVIEW ===/g) || []).length;
    out = read(n > 1 ? process.env.FAKE_REVIEW2 : process.env.FAKE_REVIEW);
    if (out == null) {
      const ids = [...input.matchAll(/^- \x60([^\x60]+)\x60 \(/gm)].map((m) => m[1]);
      out = JSON.stringify({ parts: ids.map((id) => ({ id, scores: { accurate: 5, why: 5, followable: 5, connected: 5 }, problems: [] })) });
    }
  } else {
    out = read(isTeach ? process.env.FAKE_TEACH : isWhole ? process.env.FAKE_WHOLE : resume ? process.env.FAKE_REPAIR : process.env.FAKE_FIRST) || '';
  }
  const sid = 'sess-fake-1';
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: out,
    session_id: sid, total_cost_usd: 0.01, duration_ms: 5 }));
});
`;

/** Put the fake first on PATH for this test process. Returns its path. */
export function installFakeClaude() {
  const bin = fixtureRoot('fakebin');
  write(bin, 'claude', `#!${process.execPath}\n${FAKE}`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_REVIEW_TITLE = REVIEW_TITLE;
  return path.join(bin, 'claude');
}

/**
 * Run one authored generation against the fake. `answers` holds the canned
 * outputs: { first, repair, teach, review, review2 }, each optional.
 */
export async function generate(brief, proj, answers) {
  const dir = fixtureRoot('forge');
  const env = { FAKE_LOG: path.join(dir, 'prompts.log') };
  for (const [k, file] of [['first', 'FAKE_FIRST'], ['repair', 'FAKE_REPAIR'], ['teach', 'FAKE_TEACH'], ['whole', 'FAKE_WHOLE'], ['review', 'FAKE_REVIEW'], ['review2', 'FAKE_REVIEW2']]) {
    env[file] = path.join(dir, `${k}.txt`);
    if (answers[k] != null) fs.writeFileSync(env[file], answers[k]);
  }
  env.FAKE_FIRST_FAILS = String(answers.firstFails || 0);
  env.FAKE_LIMIT = answers.limit ? '1' : '0';
  Object.assign(process.env, env);

  const jobId = jobs.newJobId();
  startGeneration({ project: proj, brief, tier: 'authored', kind: 'onboarding', model: 'fake', jobId, stagingPath: path.join(dir, `${jobId}.html`) });
  const deadline = Date.now() + 20_000;
  let job;
  while (Date.now() < deadline) {
    job = jobs.get(jobId);
    if (job && jobs.isTerminal(job.state)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const log = fs.existsSync(env.FAKE_LOG) ? fs.readFileSync(env.FAKE_LOG, 'utf8') : '';
  const count = (kind) => (log.match(new RegExp(`=== ${kind} ===`, 'g')) || []).length;
  return { job, log, count, staged: job && job.state === 'done' ? fs.readFileSync(job.stagingPath, 'utf8') : '' };
}
