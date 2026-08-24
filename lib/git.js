/**
 * Ground Control — git interrogation.
 *
 * Every call goes through child_process.execFile with an argv array: no shell,
 * no string interpolation, 5 s timeout. Any failure resolves to `null` rather
 * than throwing, so a broken/partial repo degrades field-by-field instead of
 * killing the scan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { relativeTime, localDateKey } from './util.js';

const GIT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 32 * 1024 * 1024;   // generous: rev-list on a big repo

const GIT_ENV = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',      // never block on credential prompts
  GIT_ASKPASS: 'echo',
  GIT_OPTIONAL_LOCKS: '0',       // don't take the index lock for status
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
});

/** Run `git <args>` in `cwd`. Resolves to trimmed stdout, or null on any failure. */
function git(cwd, args) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      execFile('git', args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: GIT_ENV,
        windowsHide: true,
        killSignal: 'SIGKILL',
      }, (err, stdout) => {
        if (err) return finish(null);
        finish(String(stdout).replace(/\n+$/, ''));
      });
    } catch {
      finish(null);
    }
  });
}

/** Cheap synchronous check — `.git` may be a dir (normal) or a file (worktree/submodule). */
function isGitRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

// Field separator inside --format strings: ASCII unit-separator, emitted by %x1f.
const SEP = '\x1f';

/**
 * The `git` block of a ProjectSummary. Returns null if this isn't a repo or if
 * even `rev-parse` fails. All sub-fields degrade independently.
 */
async function summary(dir) {
  if (!isGitRepo(dir)) return null;

  // Confirm git actually accepts this directory before firing the rest.
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return null;

  const [
    branchRaw, headRaw, countRaw, count30Raw, statusRaw, remoteRaw, upstreamRaw,
  ] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['log', '-1', '--format=%H%x1f%aI%x1f%s%x1f%an']),
    git(dir, ['rev-list', '--count', 'HEAD']),
    git(dir, ['rev-list', '--count', '--since=30.days.ago', 'HEAD']),
    git(dir, ['status', '--porcelain', '--untracked-files=normal']),
    git(dir, ['config', '--get', 'remote.origin.url']),
    git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
  ]);

  let branch = branchRaw || null;
  if (branch === 'HEAD') {
    // Detached: report the short sha so the UI shows something meaningful.
    const sha = await git(dir, ['rev-parse', '--short', 'HEAD']);
    branch = sha ? `detached@${sha}` : 'HEAD';
  }

  let lastCommitISO = null, lastCommitSubject = null, lastCommitAuthor = null;
  if (headRaw) {
    const [, iso, subject, author] = headRaw.split(SEP);
    lastCommitISO = normISO(iso);
    lastCommitSubject = subject || null;
    lastCommitAuthor = author || null;
  }

  const dirtyLines = statusRaw ? statusRaw.split('\n').filter((l) => l.trim() !== '') : [];

  // `HEAD...@{upstream}` prints "<ahead>\t<behind>" (left = HEAD-only commits).
  let ahead = 0, behind = 0;
  if (upstreamRaw) {
    const m = upstreamRaw.trim().split(/\s+/);
    if (m.length === 2) {
      ahead = Number(m[0]) || 0;
      behind = Number(m[1]) || 0;
    }
  }

  return {
    branch,
    lastCommitISO,
    lastCommitSubject,
    lastCommitAuthor,
    commitCount: countRaw != null ? Number(countRaw) || 0 : 0,
    commitsLast30d: count30Raw != null ? Number(count30Raw) || 0 : 0,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    remote: remoteRaw || null,
    ahead,
    behind,
  };
}

/** Number of commits reachable from HEAD in the last `days` days. 0 on failure. */
async function commitsSince(dir, days) {
  const out = await git(dir, ['rev-list', '--count', `--since=${days}.days.ago`, 'HEAD']);
  return out == null ? 0 : (Number(out) || 0);
}

/** Up to `limit` recent commits, newest first. */
async function recentCommits(dir, limit = 15) {
  const out = await git(dir, ['log', `-${limit}`, '--format=%h%x1f%aI%x1f%s%x1f%an']);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, iso, subject, author] = line.split(SEP);
    const dateISO = normISO(iso);
    return {
      sha: sha || '',
      dateISO,
      relative: relativeTime(dateISO),
      subject: subject || '',
      author: author || '',
    };
  });
}

/** `[{ date: 'YYYY-MM-DD', count }]` for the last `days` days, ascending, sparse. */
async function activity(dir, days = 90) {
  const out = await git(dir, ['log', `--since=${days}.days.ago`, '--date=short', '--format=%ad']);
  if (out == null) return [];
  const counts = new Map();
  for (const line of out.split('\n')) {
    const d = line.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, count]) => ({ date, count }));
}

/** Working-tree changes, up to `limit`. `state` is the two-char porcelain code, trimmed. */
async function dirtyFiles(dir, limit = 40) {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=normal']);
  if (!out) return [];
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const state = line.slice(0, 2).trim() || '?';
    let file = line.slice(3);
    // Renames read "old -> new"; report the new path.
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4);
    file = file.replace(/^"(.*)"$/, '$1');
    rows.push({ path: file, state });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Normalise a git ISO date to a strict UTC ISO-8601 string. */
function normISO(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

export {
  git, isGitRepo, summary, commitsSince, recentCommits, activity, dirtyFiles, localDateKey,
};
