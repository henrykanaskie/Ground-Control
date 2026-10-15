#!/usr/bin/env node
/**
 * run-doctor: why does Run fail on this machine?
 *
 * Run's failures depend on the machine it runs on (which tools are installed,
 * which PATH the app sees, what each project needs), so they cannot be fixed
 * from anywhere else without evidence. This collects that evidence for every
 * project Ground Control watches, in one go, and writes a report you can
 * paste back:
 *
 *   npm run doctor               what Run would do, and what it already sees wrong
 *   npm run doctor -- --try      actually Run each project, one at a time, ~60s each
 *   npm run doctor -- --try --only my-site,other-thing
 *
 * --try does exactly what pressing Run does (it may install dependencies into
 * node_modules or .venv), except that it never opens a browser, never starts
 * an agent, and stops each project once it has seen it start or fail.
 *
 * The report goes to ~/ground-control-run-report.md and its summary to the
 * terminal. Values that look like keys, tokens or passwords are masked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as sourceslib from '../lib/sources.js';
import * as scan from '../lib/scan.js';
import * as runner from '../lib/runner.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const TRY = args.includes('--try');
const onlyArg = args.find((a) => a.startsWith('--only'));
const ONLY = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '').split(',').filter(Boolean) : null;
const PER_PROJECT_MS = 60000;
const OUT = path.join(os.homedir(), 'ground-control-run-report.md');

function mask(text) {
  return String(text || '')
    .replace(/\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '$1-•••')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|auth)[\w-]*\s*[=:]\s*)["']?[^\s"']+/gi, '$1•••');
}

function sh(cmd, argv) {
  try { return execFileSync(cmd, argv, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (err) { return null; }
}

function hashFile(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 10); } catch { return null; }
}

/* ---- the machine ---------------------------------------------------- */

function environment() {
  const dirs = runner._internals().searchDirs();
  const tools = ['node', 'npm', 'pnpm', 'yarn', 'python3', 'python', 'pip3', 'cargo', 'go', 'swift', 'xcodebuild', 'java', 'gradle', 'mvn', 'docker', 'brew', 'make', 'flutter', 'claude'];
  const found = {};
  for (const t of tools) found[t] = runner._internals().which(t, dirs);
  const pyVersion = found.python3 ? sh(found.python3, ['--version']) : null;

  // Is the installed app running this code? It carries its own copy.
  const repoRunner = hashFile(path.join(REPO, 'lib', 'runner.js'));
  const apps = ['/Applications/GroundControl.app', path.join(os.homedir(), 'Applications', 'GroundControl.app')]
    .filter((a) => fs.existsSync(a))
    .map((a) => ({ path: a, runner: hashFile(path.join(a, 'Contents', 'Resources', 'lib', 'runner.js')) }))
    .map((a) => ({ ...a, current: a.runner === repoRunner }));

  return {
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    node: process.version,
    commit: sh('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']),
    shell: process.env.SHELL || null,
    conda: process.env.CONDA_DEFAULT_ENV || null,
    python: pyVersion,
    tools: found,
    pathDirs: dirs.length,
    apps,
  };
}

/* ---- each project --------------------------------------------------- */

function waitSettled(id, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const t = setInterval(() => {
      const r = runner.get(id);
      const starts = r ? r.steps.filter((s) => s.kind === 'start') : [];
      const upLong = starts.length && starts.every((s) => s.state === 'running' && s.startedAt && Date.now() - s.startedAt > 12000);
      if (!r || runner.isTerminal(r.state) || r.readyUrl || upLong || Date.now() - started > ms) { clearInterval(t); resolve(r); }
    }, 500);
  });
}

async function examine(project) {
  const out = { name: project.name || project.id, id: project.id, path: project.path };
  try {
    const plan = await runner.preflight(runner.detectPlan(project.path));
    out.plan = runner.planJSON(plan);
  } catch (err) {
    out.planError = String((err && err.stack) || err);
    return out;
  }
  if (!TRY || !out.plan.services.length) return out;
  try {
    await runner.start({ id: 'doctor:' + project.id, path: project.path }, { open: false });
    const r = await waitSettled('doctor:' + project.id, PER_PROJECT_MS);
    const j = runner.toJSON(r, { withLog: true });
    out.run = {
      state: j.state, readyUrl: j.readyUrl, urls: j.urls, diagnosis: j.diagnosis, fixes: j.fixes,
      steps: j.steps.map((s) => `${s.state.padEnd(8)} ${s.label}: ${s.command}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}`),
      tail: j.log.slice(-40).map((e) => (e.t === 'sys' ? '» ' : '') + e.l),
    };
    runner.stop('doctor:' + project.id, 'doctor finished looking');
    await new Promise((res) => setTimeout(res, 1500));
  } catch (err) {
    out.runError = String((err && err.message) || err);
  }
  return out;
}

function verdict(p) {
  if (p.planError) return 'CRASH  planning threw';
  if (!p.plan.services.length) return 'NONE   nothing runnable detected';
  const err = (p.plan.checks || []).find((c) => c.level === 'error');
  if (!p.run) return err ? `BLOCK  ${err.text}` : `OK?    would run: ${p.plan.services.map((s) => s.starts[s.startIndex].command).join(' + ')}`;
  if (p.run.readyUrl) return `OK     serving ${p.run.readyUrl}`;
  if (p.run.state === 'running' || p.run.state === 'done') return `OK     ${p.run.state}`;
  if (p.runError) return `CRASH  ${p.runError}`;
  return `FAIL   ${p.run.diagnosis ? p.run.diagnosis.title : p.run.state}`;
}

/* ---- main ------------------------------------------------------------ */

async function main() {
  const env = environment();
  const SOURCES = new sourceslib.Registry({ seedRoot: sourceslib.defaultRoot() });
  const payload = await scan.scanSources(SOURCES.all());
  let projects = payload.projects || [];
  if (ONLY) projects = projects.filter((p) => ONLY.some((o) => p.id === o || p.name === o));

  console.log(`Ground Control run-doctor: ${projects.length} project(s)${TRY ? ', running each' : ', planning only (add --try to run them)'}\n`);
  const results = [];
  for (const p of projects) {
    const r = await examine(p);
    results.push(r);
    console.log(`${verdict(r)}   ← ${r.name}`);
  }
  runner.stopAll();

  const lines = [];
  lines.push('# Ground Control run report', '');
  lines.push(`- platform: ${env.platform}`, `- node: ${env.node}`, `- commit: ${env.commit}`, `- shell: ${env.shell}`, `- conda env: ${env.conda || 'none'}`, `- python3: ${env.python || 'not found'}`);
  lines.push(`- installed app: ${env.apps.length ? env.apps.map((a) => `${a.path} (${a.current ? 'CURRENT' : 'STALE: rebuild it'})`).join('; ') : 'not installed'}`);
  lines.push('- tools: ' + Object.entries(env.tools).map(([k, v]) => `${k}=${v ? v : '✗'}`).join(' '), '');
  lines.push('## Summary', '', '```');
  for (const r of results) lines.push(`${verdict(r)}   ← ${r.name}`);
  lines.push('```', '');
  for (const r of results) {
    lines.push(`## ${r.name}`, '', `\`${r.path}\``, '');
    if (r.planError) { lines.push('```', r.planError, '```', ''); continue; }
    for (const s of r.plan.services) {
      lines.push(`- **${s.stack}**${s.dir ? ` in ${s.dir}/` : ''}`);
      for (const st of s.setup) lines.push(`  - setup: \`${st.command}\``);
      lines.push(`  - start: \`${s.starts[s.startIndex].command}\`${s.starts.length > 1 ? ` (of ${s.starts.length})` : ''}`);
    }
    for (const c of r.plan.checks || []) lines.push(`- check (${c.level}): ${c.text}${c.hint ? ' ' + c.hint : ''}`);
    if (r.run) {
      lines.push('', `**Result: ${r.run.state}**${r.run.diagnosis ? ` — ${r.run.diagnosis.title} (${r.run.diagnosis.needs})` : ''}`);
      for (const f of r.run.fixes || []) lines.push(`- fixed: ${f.title}. ${f.action}`);
      lines.push('', '```', ...r.run.steps, '---', ...r.run.tail.map(mask), '```');
    }
    if (r.runError) lines.push('', '```', r.runError, '```');
    lines.push('');
  }
  fs.writeFileSync(OUT, mask(lines.join('\n')) + '\n');
  const stale = env.apps.filter((a) => !a.current);
  console.log(`\nFull report: ${OUT}`);
  if (stale.length) console.log(`\n⚠ Your installed app is running OLD code (${stale.map((a) => a.path).join(', ')}). Rebuild it: ./build-app.sh --install`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
