/**
 * Ground Control Reclaim — flag and remove dead folders (CONTRACT-RECLAIM.md).
 *
 * This is the only destructive code in Ground Control, so read the three rules that
 * shape every line below before changing anything.
 *
 *   0. NOTHING IS EVER PERMANENTLY DELETED. The one and only exit for a project
 *      directory is `~/.Trash`, reached with `fs.rename`. There is no `rm -rf`
 *      here, no "permanent delete" option, and no flag that turns one on. The
 *      single `fs.rm` call in this file removes the ORIGINAL only after a
 *      cross-volume copy into the Trash has been made and verified byte-for-byte
 *      — that is the fallback the contract mandates for EXDEV, and if any part
 *      of the copy fails the original is left completely untouched.
 *
 *      `osascript`/Finder automation is deliberately NOT used: it triggers a
 *      macOS TCC prompt that hangs a headless server indefinitely.
 *
 *   1. BLOCKERS ARE HARD REFUSALS. A non-empty `blockers` array makes removal
 *      impossible. `trashProject()` re-runs the assessment at call time and
 *      refuses on any blocker; a client-supplied assessment is never trusted.
 *      Anything this module cannot verify (git that will not answer, an agent
 *      sweep that fails) becomes a blocker too — fail closed, always.
 *
 *   2. DO NOT BE FOOLED BY RAW FILE COUNTS. `water_potability` looks like 11,557
 *      files / 341 MB and is almost entirely `pot-venv/`; `shed_stats` looks
 *      like 861 files and holds exactly 1 real one. Scoring therefore runs on
 *      MEANINGFUL content only, using `util.isIgnoredDir` — the same ignore list
 *      `lib/scan.js` applies — and never shells out to `du` or `find`.
 *
 * Everything else follows from "default to keep": a false `dead` verdict is far
 * worse than a missed one.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as util from './util.js';
import * as gitlib from './git.js';
import { MAX_DEPTH, MAX_ENTRIES } from './scan.js';

const { isIgnoredDir, PathError, resolveInside, relativeTime } = util;

/** The Ground Control checkout itself — never removable, and home of the reclaim log. */
const GROUND_CONTROL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECLAIM_LOG = path.join(GROUND_CONTROL_DIR, '.forge', 'reclaim-log.jsonl');

const TRASH_DIR = path.join(os.homedir(), '.Trash');

/* ------------------------------------------------------------------ *
 * Thresholds (contract §3)
 * ------------------------------------------------------------------ */

const SUBSTANTIAL_FILES = 40;                     // > this ⇒ blocker
const SUBSTANTIAL_BYTES = 20 * 1024 * 1024;       // > this ⇒ blocker
const RECENT_DAYS = 30;                           // ≤ this ⇒ blocker
const DORMANT_DAYS = 90;
const DEAD_DAYS = 180;

/* ------------------------------------------------------------------ *
 * "Meaningful content" — contract §2
 * ------------------------------------------------------------------ */

/**
 * Files that exist only to satisfy tooling. A directory holding nothing but
 * these is, for our purposes, empty.
 */
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'bun.lock', 'deno.lock',
  'poetry.lock', 'pipfile.lock', 'uv.lock', 'pdm.lock', 'conda-lock.yml',
  'gemfile.lock', 'podfile.lock', 'cargo.lock', 'composer.lock', 'mix.lock',
  'go.sum', 'flake.lock', 'package.resolved', '.terraform.lock.hcl',
]);

/** Git bookkeeping and OS droppings — never evidence that work happened. */
const TRIVIAL_NAMES = new Set([
  '.gitignore', '.gitattributes', '.gitkeep', '.gitmodules', '.keep',
  '.placeholder', '.ds_store', '.localized', 'thumbs.db', 'desktop.ini',
]);

function isTrivialFile(nameLower, size) {
  if (size === 0) return true;                    // an empty file is not content
  if (TRIVIAL_NAMES.has(nameLower)) return true;
  if (LOCKFILES.has(nameLower)) return true;
  return false;
}

/**
 * One walk over a project, applying `lib/scan.js`'s ignore list and its depth /
 * entry budgets, producing both the "on disk, minus dependencies" figures and
 * the meaningful subset. Never throws; unreadable entries are skipped.
 *
 * Symlinks are counted but never descended into, and a realpath set stops any
 * loop — the same guard `scan.walkProject` uses.
 */
function measureContent(root) {
  const acc = {
    walkedFiles: 0,          // non-ignored files (matches scan's fileCount)
    walkedBytes: 0,
    meaningfulFiles: 0,
    meaningfulBytes: 0,
    /* Newest mtime among MEANINGFUL files only.
     *
     * This is deliberate. `.DS_Store` is rewritten every time a Finder window
     * looks at a folder, and a directory's own inode mtime moves for the same
     * kind of non-reasons — neither is evidence that anyone did any work.
     * `shed_stats` is the live example: its only entries are `.DS_Store`,
     * `.gitignore` and a `.venv`, and its `.DS_Store` was touched two days ago.
     * Treating that as "activity" would protect a folder that holds nothing. */
    newestMtimeMs: 0,
    ignoredDirs: new Set(),  // e.g. { 'pot-venv', 'node_modules' }
    symlinks: 0,
    truncated: false,
    sampleNames: [],         // up to 8 meaningful file names, for human reasons
  };

  let entries = 0;
  const visited = new Set();
  const stack = [{ abs: root, depth: 0 }];

  while (stack.length) {
    if (entries >= MAX_ENTRIES) { acc.truncated = true; break; }
    const cur = stack.pop();

    let real;
    try { real = fs.realpathSync(cur.abs); } catch { continue; }
    if (visited.has(real)) continue;
    visited.add(real);

    let list;
    try { list = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }

    for (const d of list) {
      if (++entries > MAX_ENTRIES) { acc.truncated = true; break; }

      const name = d.name;
      const abs = path.join(cur.abs, name);
      const nameLower = name.toLowerCase();

      let isDir = d.isDirectory();
      let isFile = d.isFile();
      let st = null;
      if (d.isSymbolicLink()) {
        acc.symlinks++;
        // A symlink is one entry, never a doorway: classify it, never follow it.
        try { st = fs.lstatSync(abs); } catch { continue; }
        acc.walkedFiles++;
        acc.walkedBytes += st.size;
        continue;
      }

      if (isDir) {
        if (isIgnoredDir(name)) { acc.ignoredDirs.add(name); continue; }
        if (cur.depth + 1 <= MAX_DEPTH) stack.push({ abs, depth: cur.depth + 1 });
        continue;
      }
      if (!isFile) continue;

      try { st = fs.statSync(abs); } catch { continue; }

      if (nameLower === '.ds_store') continue;      // invisible, exactly as scan.js treats it

      acc.walkedFiles++;
      acc.walkedBytes += st.size;

      if (isTrivialFile(nameLower, st.size)) continue;

      acc.meaningfulFiles++;
      acc.meaningfulBytes += st.size;
      if (st.mtimeMs > acc.newestMtimeMs) acc.newestMtimeMs = st.mtimeMs;
      if (acc.sampleNames.length < 8) acc.sampleNames.push(name);
    }
  }

  return acc;
}

/* ------------------------------------------------------------------ *
 * Git state — everything that could make this folder the only copy
 * ------------------------------------------------------------------ */

function emptyGitState() {
  return {
    hasGit: false,
    dirtyCount: 0,
    unpushedCommits: 0,
    hasRemote: false,
    stashCount: 0,
    branchesNotMerged: 0,
    // extras, for honest human reasons in the UI
    commitCount: 0,
    branch: null,
    defaultBranch: null,
    remote: null,
    lastCommitISO: null,
    unmergedBranchNames: [],
    readable: true,          // false ⇒ we could not interrogate it ⇒ blocker
    insideOtherRepo: false,  // the folder is part of a LARGER repo ⇒ blocker
  };
}

function countLines(out) {
  if (!out) return 0;
  return out.split('\n').filter((l) => l.trim() !== '').length;
}

/**
 * Interrogate the repository. Every failure degrades to `readable: false`,
 * which the blocker pass turns into a hard refusal.
 */
async function readGitState(dir) {
  const g = emptyGitState();
  if (!gitlib.isGitRepo(dir)) return g;

  g.hasGit = true;

  const inside = await gitlib.git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') { g.readable = false; return g; }

  // The folder must BE the repository, not a subdirectory of a bigger one:
  // removing a tracked subtree of someone else's repo is never safe.
  const topRaw = await gitlib.git(dir, ['rev-parse', '--show-toplevel']);
  if (topRaw) {
    let here = dir;
    try { here = fs.realpathSync(dir); } catch { /* keep the literal path */ }
    let top = topRaw;
    try { top = fs.realpathSync(topRaw); } catch { /* keep git's answer */ }
    if (path.resolve(top) !== path.resolve(here)) g.insideOtherRepo = true;
  } else {
    g.readable = false;
  }

  const [
    statusRaw, remotesRaw, stashRaw, branchRaw, countRaw, headRaw,
  ] = await Promise.all([
    gitlib.git(dir, ['status', '--porcelain', '--untracked-files=normal']),
    gitlib.git(dir, ['remote']),
    gitlib.git(dir, ['stash', 'list']),
    gitlib.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitlib.git(dir, ['rev-list', '--count', '--all']),
    gitlib.git(dir, ['log', '-1', '--format=%aI']),
  ]);

  // `git status` returning null means the command failed outright — we cannot
  // prove the tree is clean, so we must not pretend that it is.
  if (statusRaw === null || remotesRaw === null || stashRaw === null) g.readable = false;

  g.dirtyCount = countLines(statusRaw);
  g.hasRemote = countLines(remotesRaw) > 0;
  g.stashCount = countLines(stashRaw);
  g.branch = branchRaw || null;
  g.commitCount = countRaw != null ? (Number(countRaw) || 0) : 0;
  g.lastCommitISO = headRaw ? new Date(Date.parse(headRaw)).toISOString() : null;
  if (headRaw && !Number.isFinite(Date.parse(headRaw))) g.lastCommitISO = null;

  if (g.hasRemote) {
    const url = await gitlib.git(dir, ['config', '--get', 'remote.origin.url']);
    g.remote = url || null;
  }

  if (g.commitCount > 0) {
    // Commits on ANY local ref that are on NO remote. With no remotes at all
    // this counts everything, which is exactly right: the folder is the only copy.
    const unpushed = await gitlib.git(dir, ['rev-list', '--count', '--all', '--not', '--remotes']);
    if (unpushed === null) g.readable = false;
    g.unpushedCommits = unpushed != null ? (Number(unpushed) || 0) : 0;

    g.defaultBranch = await defaultBranchOf(dir);
    if (g.defaultBranch) {
      const notMerged = await gitlib.git(dir, [
        'branch', '--format=%(refname:short)', '--no-merged', g.defaultBranch,
      ]);
      if (notMerged === null) {
        g.readable = false;
      } else {
        const names = notMerged.split('\n').map((s) => s.trim()).filter(Boolean)
          .filter((n) => n !== g.defaultBranch);
        g.unmergedBranchNames = names.slice(0, 10);
        g.branchesNotMerged = names.length;
      }
    }
  }

  return g;
}

/** origin/HEAD → main → master → the current branch. Null if nothing resolves. */
async function defaultBranchOf(dir) {
  const originHead = await gitlib.git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead) return originHead;
  for (const name of ['main', 'master', 'trunk', 'develop']) {
    const ok = await gitlib.git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (ok) return name;
  }
  const cur = await gitlib.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur && cur !== 'HEAD' ? cur : null;
}

/* ------------------------------------------------------------------ *
 * Agent activity — a live coding agent pins the folder in place
 * ------------------------------------------------------------------ */

let agentsModule = null;
let agentsTried = false;

async function loadAgents() {
  if (agentsTried) return agentsModule;
  agentsTried = true;
  try { agentsModule = await import('./agents.js'); }
  catch { agentsModule = null; }
  return agentsModule;
}

/**
 * `Map<projectId, Activity>` for a list of projects, or `null` when the sweep
 * could not be done at all. `null` is deliberately distinct from "no agents":
 * the caller turns it into a blocker rather than a green light.
 */
async function agentMapFor(projects) {
  const mod = await loadAgents();
  if (!mod || typeof mod.agentActivity !== 'function') return null;
  try {
    return await mod.agentActivity(projects);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Assessment
 * ------------------------------------------------------------------ */

const BLOCKER_LABEL = {
  'uncommitted-changes': 'Uncommitted changes',
  'unpushed-commits': 'Unpushed commits',
  'no-remote': 'No remote — this folder is the only copy',
  'stashed-work': 'Stashed work',
  'unmerged-branches': 'Unmerged branches',
  'substantial-content': 'Substantial content',
  'recent-activity': 'Recent activity',
  'is-ground-control': 'This is Ground Control',
  'agent-running': 'A coding agent is working here',
  // Fail-closed additions. Not in the contract's table, and they only ever
  // REFUSE more than it requires — never fewer.
  'agent-unknown': 'Agent activity could not be checked',
  'git-unreadable': 'Git state could not be read',
  'inside-other-repo': 'Part of a larger git repository',
  'not-a-direct-child': 'Not a plain folder in the scanned root',
};

/**
 * Blockers split in two.
 *
 * HARD blockers are structural: overriding them would break Ground Control itself or
 * reach outside the folder the user is actually talking about. No flag lifts
 * them, and no UI offers to.
 *
 * Everything else is a *judgement* about whether the work matters — recent
 * activity, uncommitted changes, substantial content, no remote. Those are
 * exactly the calls the owner of the folder is entitled to overrule, and
 * refusing to let them is what made it impossible to trash a folder that was
 * simply not flagged for reclamation. They lift only with an explicit
 * `force`, and every one lifted is recorded by code in the reclaim log.
 *
 * The stakes are bounded by the destination: this moves a folder to the macOS
 * Trash with `fs.rename`. Nothing here deletes, and recovery is dragging it
 * back out.
 */
const HARD_BLOCKERS = new Set([
  'is-ground-control',            // removing the running app's own folder
  'not-a-direct-child',    // path gate — never negotiable
  'inside-other-repo',     // the folder belongs to a repository that isn't it
]);

function isHardBlocker(b) {
  return Boolean(b && HARD_BLOCKERS.has(b.code));
}

function blocker(code, detail) {
  return { code, label: BLOCKER_LABEL[code] || code, detail };
}

function daysBetween(fromMs, now) {
  if (!Number.isFinite(fromMs) || fromMs <= 0) return null;
  return Math.max(0, Math.floor((now - fromMs) / 86400000));
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function plural(n, word) {
  if (n === 1) return `${n} ${word}`;
  // Enough English to keep "1 stash / 2 stashes" and "1 branch / 2 branches"
  // reading like a sentence a person wrote.
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${n} ${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${n} ${word.slice(0, -1)}ies`;
  return `${n} ${word}s`;
}

/**
 * Is `project.path` a plain directory that is a direct child of `root`?
 *
 * Runs the three gates the contract demands — syntactic, post-`path.resolve`,
 * post-`fs.realpath` — plus a symlink refusal. Returns
 * `{ ok, abs, reason }`; never throws.
 */
function checkDirectChild(root, project) {
  const out = { ok: false, abs: null, reason: null };
  try {
    const rootResolved = path.resolve(root);
    const name = String(project && project.name ? project.name : '');
    const projPath = String(project && project.path ? project.path : '');
    if (!name || !projPath) { out.reason = 'the project has no name or path'; return out; }

    // Gate 1 (syntactic): the name must be one plain segment.
    if (name !== path.basename(projPath)) { out.reason = 'the folder name does not match the project'; return out; }
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      out.reason = 'the folder name is not a single path segment';
      return out;
    }

    // Gate 2 (post-path.resolve): resolveInside proves it lands under the root.
    let abs;
    try { abs = resolveInside(rootResolved, name); }
    catch { out.reason = 'the path does not resolve inside the scanned root'; return out; }
    if (path.resolve(projPath) !== abs) { out.reason = 'the project path is not <root>/<name>'; return out; }
    if (abs === rootResolved) { out.reason = 'that is the scanned root itself'; return out; }
    if (path.dirname(abs) !== rootResolved) { out.reason = 'it is nested, not a direct child of the scanned root'; return out; }

    // Never the Ground Control checkout, whatever it happens to be called.
    let groundControlReal = GROUND_CONTROL_DIR;
    try { groundControlReal = fs.realpathSync(GROUND_CONTROL_DIR); } catch { /* keep the literal */ }

    // Gate 3 (post-fs.realpath): no symlink may stand in for the folder, and
    // the real target must still be a direct child of the real root.
    let lst;
    try { lst = fs.lstatSync(abs); } catch { out.reason = 'the folder is not there any more'; return out; }
    if (lst.isSymbolicLink()) { out.reason = 'it is a symlink, not a real folder'; return out; }
    if (!lst.isDirectory()) { out.reason = 'it is not a directory'; return out; }

    let realRoot = rootResolved;
    try { realRoot = fs.realpathSync(rootResolved); } catch { /* keep the literal */ }
    let realTarget;
    try { realTarget = fs.realpathSync(abs); } catch { out.reason = 'the folder could not be resolved'; return out; }
    if (path.dirname(realTarget) !== realRoot) {
      out.reason = 'it resolves outside the scanned root';
      return out;
    }
    if (realTarget === groundControlReal || path.resolve(abs) === groundControlReal) {
      out.reason = 'that is Ground Control itself';
      return out;
    }

    out.ok = true;
    out.abs = abs;
    return out;
  } catch (err) {
    out.reason = `the path could not be checked (${(err && err.message) || err})`;
    return out;
  }
}

/** True when this project IS the Ground Control checkout. */
function isGroundControl(project) {
  try {
    let groundControlReal = GROUND_CONTROL_DIR;
    try { groundControlReal = fs.realpathSync(GROUND_CONTROL_DIR); } catch { /* literal */ }
    const p = path.resolve(String((project && project.path) || ''));
    if (p === GROUND_CONTROL_DIR || p === groundControlReal) return true;
    try { if (fs.realpathSync(p) === groundControlReal) return true; } catch { /* gone */ }
  } catch { /* fall through */ }
  return false;
}

/**
 * Assess one project.
 *
 * `opts.root`  — the scanned root (needed for the direct-child gate).
 * `opts.agent` — a pre-computed Activity for this project, so a whole-root
 *                assessment costs exactly one agent sweep.
 * `opts.agentSweepFailed` — the sweep could not run at all ⇒ fail closed.
 */
async function assessProject(project, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const root = opts.root || path.dirname(String((project && project.path) || ''));

  const content = measureContent(project.path);
  const gitState = await readGitState(project.path);

  /* --- when did anyone last DO something here? ---------------------- *
   * The latest of: the scan's own answer, the newest meaningful-file mtime,
   * the last commit, and the last agent session. Taking the MAX is the
   * conservative direction — it can only make a folder look more alive.
   *
   * What is deliberately NOT in this list is the folder's own inode mtime and
   * `.DS_Store`. Both move when Finder merely looks at a directory, and a
   * folder holding no content cannot have had work done in it. That evidence
   * is kept separately as `folderTouchedMs` and used only to describe how long
   * the folder has sat there — plus one narrow guard below, so a folder
   * created today is never called dead.
   */
  const candidates = [];
  if (project.lastActivityISO) candidates.push(Date.parse(project.lastActivityISO));
  if (content.newestMtimeMs) candidates.push(content.newestMtimeMs);
  if (gitState.lastCommitISO) candidates.push(Date.parse(gitState.lastCommitISO));

  let agent = opts.agent || null;
  let agentSweepFailed = Boolean(opts.agentSweepFailed);
  if (!agent && !('agent' in opts)) {
    const map = await agentMapFor([project]);
    if (!map) agentSweepFailed = true;
    else agent = map.get(project.id) || null;
  }
  /* A FINISHED agent session is deliberately not counted as activity. Its
   * transcript lives under ~/.claude, not in the folder, so trashing the folder
   * loses nothing from it — and if the session had actually produced work, the
   * files it wrote would be carrying recent mtimes anyway. A session that ran
   * two days ago and left an empty directory behind is evidence of abandonment,
   * not of work in progress. A RUNNING agent is a different matter entirely and
   * is refused outright by the `agent-running` blocker below. The session date
   * is still reported, so the user sees it. */

  let folderTouchedMs = 0;
  try { folderTouchedMs = fs.statSync(project.path).mtimeMs || 0; } catch { /* gone */ }

  const valid = candidates.filter((t) => Number.isFinite(t) && t > 0);
  const lastActivityMs = valid.length ? Math.max(...valid) : 0;
  const ageDays = daysBetween(lastActivityMs, now);
  const folderAgeDays = daysBetween(folderTouchedMs, now);
  const lastRel = lastActivityMs ? relativeTime(lastActivityMs, now) : null;
  // Scoring needs *some* sense of age; when nothing has ever happened in the
  // folder, how long the folder itself has sat there is the honest stand-in.
  const effectiveAge = ageDays !== null ? ageDays : folderAgeDays;

  /* --- blockers: any one of these makes removal impossible ---------- */
  const blockers = [];

  if (isGroundControl(project)) {
    blockers.push(blocker('is-ground-control', 'Ground Control will not remove its own installation.'));
  }

  const gate = checkDirectChild(root, project);
  if (!gate.ok) {
    blockers.push(blocker('not-a-direct-child',
      `Reclaim only ever touches a plain folder sitting directly in the scanned root — ${gate.reason}.`));
  }

  if (agentSweepFailed) {
    blockers.push(blocker('agent-unknown',
      'Ground Control could not check whether a coding agent is working in this folder, so it refuses to touch it.'));
  } else if (agent && (agent.live > 0 || agent.state === 'working')) {
    const n = agent.live || 1;
    blockers.push(blocker('agent-running',
      `${plural(n, 'coding agent process')} ${n === 1 ? 'has' : 'have'} this folder as its working directory right now.`));
  }

  if (gitState.hasGit && !gitState.readable) {
    blockers.push(blocker('git-unreadable',
      'This folder has a .git directory that git would not describe, so its state cannot be proven safe.'));
  }
  if (gitState.insideOtherRepo) {
    blockers.push(blocker('inside-other-repo',
      'This folder is tracked inside a larger git repository — removing it would change that repository.'));
  }
  if (gitState.dirtyCount > 0) {
    blockers.push(blocker('uncommitted-changes',
      `${plural(gitState.dirtyCount, 'file')} in the working tree ${gitState.dirtyCount === 1 ? 'has' : 'have'} changes that were never committed.`));
  }
  if (gitState.unpushedCommits > 0 && gitState.hasRemote) {
    blockers.push(blocker('unpushed-commits',
      `${plural(gitState.unpushedCommits, 'commit')} ${gitState.unpushedCommits === 1 ? 'exists' : 'exist'} here and on no remote.`));
  }
  if (gitState.hasGit && gitState.commitCount > 0 && !gitState.hasRemote) {
    blockers.push(blocker('no-remote',
      `${plural(gitState.commitCount, 'commit')} and no remote configured — this folder is the only copy of that history.`));
  }
  if (gitState.stashCount > 0) {
    blockers.push(blocker('stashed-work',
      `${plural(gitState.stashCount, 'stash')} ${gitState.stashCount === 1 ? 'is' : 'are'} waiting in this repository.`));
  }
  if (gitState.branchesNotMerged > 0) {
    const names = gitState.unmergedBranchNames.slice(0, 3).join(', ');
    blockers.push(blocker('unmerged-branches',
      `${plural(gitState.branchesNotMerged, 'local branch')} not merged into ${gitState.defaultBranch || 'the default branch'}${names ? ` (${names})` : ''}.`));
  }
  if (content.truncated) {
    blockers.push(blocker('substantial-content',
      `The folder is large enough that the scan hit its ${MAX_ENTRIES}-entry budget, so its contents were never fully measured.`));
  } else if (content.meaningfulFiles > SUBSTANTIAL_FILES || content.meaningfulBytes > SUBSTANTIAL_BYTES) {
    blockers.push(blocker('substantial-content',
      `${plural(content.meaningfulFiles, 'real file')} totalling ${fmtBytes(content.meaningfulBytes)} — too much to call this folder empty.`));
  }
  if (ageDays !== null && ageDays <= RECENT_DAYS) {
    blockers.push(blocker('recent-activity',
      `Something here changed ${lastRel || 'recently'} — well inside the ${RECENT_DAYS}-day protection window.`));
  } else if (ageDays === null && folderAgeDays !== null && folderAgeDays < 1) {
    // Nothing has ever been done in this folder, but it appeared today. That is
    // somebody starting something, not something abandoned.
    blockers.push(blocker('recent-activity',
      `This folder itself was created or changed ${relativeTime(folderTouchedMs, now) || 'today'}, so it looks like something just started.`));
  }

  /* --- score & verdict (only meaningful when blockers is empty) ------ */
  const score = scoreOf(content, effectiveAge, gitState);
  const verdict = blockers.length ? 'keep' : verdictOf(content, effectiveAge, gitState);
  const reasons = reasonsFor({
    content, gitState, ageDays, folderAgeDays, folderTouchedMs, now, lastRel, verdict, blockers, agent,
  });

  return {
    projectId: project.id,
    projectName: project.name,
    path: project.path,
    meaningfulFiles: content.meaningfulFiles,
    meaningfulBytes: content.meaningfulBytes,
    onDiskFiles: content.walkedFiles,
    onDiskBytes: content.walkedBytes,
    reportedFiles: typeof project.fileCount === 'number' ? project.fileCount : content.walkedFiles,
    reportedBytes: typeof project.sizeBytes === 'number' ? project.sizeBytes : content.walkedBytes,
    ignoredDirs: [...content.ignoredDirs].sort().slice(0, 8),
    ageDays,
    folderAgeDays,
    lastActivityISO: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    lastActivityRelative: lastRel,
    folderTouchedISO: folderTouchedMs ? new Date(folderTouchedMs).toISOString() : null,
    folderTouchedRelative: folderTouchedMs ? relativeTime(folderTouchedMs, now) : null,
    score,
    verdict,
    reasons,
    blockers,
    gitState,
    agent: agent ? {
      live: agent.live || 0,
      state: agent.state || 'none',
      sessionCount: agent.sessionCount || 0,
      lastSessionISO: agent.lastSessionISO || null,
      lastSessionRelative: agent.lastSessionRelative || null,
    } : null,
  };
}

/** 0–100, higher = safer to remove. Blocked projects report 0: nothing is safe. */
function scoreOf(content, ageDays, gitState) {
  let s = 0;

  const f = content.meaningfulFiles;
  if (f === 0) s += 50;
  else if (f === 1) s += 40;
  else if (f <= 3) s += 33;
  else if (f <= 10) s += 22;
  else if (f <= 25) s += 12;
  else if (f <= SUBSTANTIAL_FILES) s += 5;

  if (ageDays === null) s += 0;
  else if (ageDays >= 730) s += 32;
  else if (ageDays >= 365) s += 28;
  else if (ageDays >= DEAD_DAYS) s += 22;
  else if (ageDays >= DORMANT_DAYS) s += 14;
  else if (ageDays > RECENT_DAYS) s += 5;

  const gitSafe = !gitState.hasGit
    ? content.meaningfulFiles <= 3
    : (gitState.commitCount === 0
      || (gitState.hasRemote && gitState.unpushedCommits === 0 && gitState.dirtyCount === 0
        && gitState.stashCount === 0 && gitState.branchesNotMerged === 0));
  if (gitSafe) s += 12;

  const b = content.meaningfulBytes;
  if (b === 0) s += 6;
  else if (b < 64 * 1024) s += 4;
  else if (b < 1024 * 1024) s += 2;

  return Math.max(0, Math.min(100, s));
}

/** `dead` / `dormant` / `keep`. Everything that is not clearly one of the first two is `keep`. */
function verdictOf(content, ageDays, gitState) {
  const f = content.meaningfulFiles;
  const b = content.meaningfulBytes;
  const neverAnyGit = !gitState.hasGit || gitState.commitCount === 0;

  // dead — nothing of substance ever landed here.
  if (f === 0) return 'dead';
  // A couple of scraps and nothing else. The byte ceiling is deliberately tiny:
  // one 37 KB CSV is real data, and calling that "dead" would be the exact kind
  // of false positive this feature must not produce.
  if (f <= 2 && b < 16 * 1024 && ageDays !== null && ageDays >= DEAD_DAYS) return 'dead';
  if (neverAnyGit && ageDays !== null && ageDays >= DEAD_DAYS && f <= 5 && b < 512 * 1024) return 'dead';

  // dormant — small, nothing unique at risk, untouched for a season.
  if (f <= 15 && b <= 2 * 1024 * 1024 && ageDays !== null && ageDays >= DORMANT_DAYS) return 'dormant';

  return 'keep';
}

/** Specific, human sentences — never a bare score. */
function reasonsFor({ content, gitState, ageDays, folderAgeDays, folderTouchedMs, now, lastRel, verdict, blockers, agent }) {
  const out = [];
  const rel = lastRel;

  /* what is actually in there */
  if (content.meaningfulFiles === 0) {
    if (content.walkedFiles === 0) out.push('no files at all');
    else out.push(`${plural(content.walkedFiles, 'file')} on disk, but every one is a lockfile, a git config file, or empty — no real content`);
  } else if (content.meaningfulFiles === 1) {
    out.push(`1 real file (${content.sampleNames[0] || 'unnamed'}, ${fmtBytes(content.meaningfulBytes)})`);
  } else {
    out.push(`${plural(content.meaningfulFiles, 'real file')} totalling ${fmtBytes(content.meaningfulBytes)}`);
  }

  if (content.ignoredDirs.size) {
    const names = [...content.ignoredDirs].sort().slice(0, 3).join(', ');
    out.push(`the bulk of what is on disk lives in ${names}${content.ignoredDirs.size > 3 ? ' and other dependency folders' : ''}, which is not project content`);
  }

  /* how long since anything happened */
  if (ageDays === null) {
    const folderRel = folderTouchedMs ? relativeTime(folderTouchedMs, now) : null;
    out.push(folderRel
      ? `no work was ever recorded here — the folder itself was last touched ${folderRel}`
      : 'no work was ever recorded here, and the folder carries no usable timestamp');
  } else if (rel) {
    out.push(`nothing has changed here since ${rel}`);
  }

  /* what git says */
  if (!gitState.hasGit) {
    out.push('no git repository, so there is no history to lose');
  } else if (gitState.commitCount === 0) {
    out.push('a git repository was initialised but nothing was ever committed');
  } else if (gitState.hasRemote && gitState.unpushedCommits === 0) {
    out.push(`all ${plural(gitState.commitCount, 'commit')} ${gitState.commitCount === 1 ? 'is' : 'are'} pushed to ${gitState.remote ? shortRemote(gitState.remote) : 'the remote'}`);
  } else if (gitState.unpushedCommits > 0) {
    out.push(`${plural(gitState.unpushedCommits, 'commit')} ${gitState.unpushedCommits === 1 ? 'exists' : 'exist'} nowhere else`);
  }

  /* what the agent record says — context, never a blocker on its own */
  if (agent && agent.sessionCount > 0 && agent.lastSessionRelative) {
    out.push(content.meaningfulFiles === 0
      ? `a coding agent ran ${plural(agent.sessionCount, 'session')} here (last ${agent.lastSessionRelative}) and left no files behind`
      : `a coding agent last worked here ${agent.lastSessionRelative}`);
  }

  if (blockers.length) {
    out.push(blockers.length === 1
      ? 'one thing is protecting this folder, so it cannot be removed'
      : `${blockers.length} things are protecting this folder, so it cannot be removed`);
  } else if (verdict === 'keep') {
    out.push('there is enough here that Ground Control will not call it dead');
  }

  return out;
}

function shortRemote(url) {
  const s = String(url);
  const m = s.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : s;
}

/**
 * Assess every project in one pass — one agent sweep for the whole root.
 * Never rejects: a project that blows up comes back blocked and inert.
 */
async function assessAll(projects, opts = {}) {
  const list = Array.isArray(projects) ? projects : [];
  const now = Date.now();

  const map = await agentMapFor(list);
  const sweepFailed = map === null;

  const assessments = {};
  for (const p of list) {
    try {
      assessments[p.id] = await assessProject(p, {
        root: opts.root,
        now,
        agent: map ? (map.get(p.id) || null) : null,
        agentSweepFailed: sweepFailed,
      });
    } catch (err) {
      assessments[p.id] = {
        projectId: p.id,
        projectName: p.name,
        path: p.path,
        meaningfulFiles: 0,
        meaningfulBytes: 0,
        onDiskFiles: 0,
        onDiskBytes: 0,
        reportedFiles: 0,
        reportedBytes: 0,
        ignoredDirs: [],
        ageDays: null,
        lastActivityISO: null,
        lastActivityRelative: null,
        score: 0,
        verdict: 'keep',
        reasons: ['Ground Control could not assess this folder, so it is treated as untouchable'],
        blockers: [blocker('git-unreadable', `The assessment failed: ${(err && err.message) || err}`)],
        gitState: emptyGitState(),
        agent: null,
      };
    }
  }

  return { assessments, scannedAt: new Date(now).toISOString() };
}

/* ------------------------------------------------------------------ *
 * The trash operation (contract §4)
 * ------------------------------------------------------------------ */

class ReclaimError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'ReclaimError';
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

/**
 * Pick a destination inside `~/.Trash` that does not exist yet:
 * `name`, then `name 2`, `name 3`, … — the same shape Finder uses.
 */
function trashDestinationFor(name) {
  const base = String(name);
  for (let n = 1; n <= 500; n++) {
    const candidate = path.join(TRASH_DIR, n === 1 ? base : `${base} ${n}`);
    let exists = true;
    try { fs.lstatSync(candidate); } catch { exists = false; }
    if (!exists) return candidate;
  }
  throw new ReclaimError(500, `there are already 500 items called "${base}" in the Trash`);
}

/** Total files and bytes under a tree, following nothing. Used to verify a copy. */
function treeFingerprint(root) {
  let files = 0, dirs = 0, links = 0, bytes = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let list;
    try { list = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const d of list) {
      const abs = path.join(cur, d.name);
      if (d.isSymbolicLink()) { links++; continue; }
      if (d.isDirectory()) { dirs++; stack.push(abs); continue; }
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      files++;
      bytes += st.size;
    }
  }
  return { files, dirs, links, bytes };
}

/**
 * The EXDEV fallback: recursive copy, verified, and only then the original is
 * removed. If ANY part of the copy or the verification fails, the original is
 * left completely untouched and the failure is reported.
 *
 * Exported so the destructive path can be exercised directly in tests without
 * needing two volumes.
 */
async function copyThenRemove(src, dest) {
  // `fs.cp` will happily MERGE into an existing directory, so refuse one up
  // front rather than relying on `errorOnExist` to catch every shape.
  let destExists = true;
  try { fs.lstatSync(dest); } catch { destExists = false; }
  if (destExists) {
    return { ok: false, method: 'copy+remove', error: `something is already at ${dest}, so nothing was moved` };
  }

  const before = treeFingerprint(src);

  try {
    // `dereference: false` keeps symlinks as symlinks and `verbatimSymlinks`
    // keeps their targets exactly as written, so a relative link still points
    // where it did if the folder is dragged back out of the Trash.
    // `force: false` + `errorOnExist` means we never write over anything
    // already sitting in the Trash.
    await fsp.cp(src, dest, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
  } catch (err) {
    return { ok: false, method: 'copy+remove', error: `the copy into the Trash failed: ${(err && err.message) || err}`, partialAt: dest };
  }

  const after = treeFingerprint(dest);
  if (after.files !== before.files || after.bytes !== before.bytes
      || after.dirs !== before.dirs || after.links !== before.links) {
    return {
      ok: false,
      method: 'copy+remove',
      error: `the copy into the Trash did not match the original (${before.files} files / ${before.bytes} bytes in, ${after.files} / ${after.bytes} out) — the original was left untouched`,
      partialAt: dest,
    };
  }

  // The copy is complete and verified; the original may now go. This is the
  // only removal in Ground Control, and by this point a full copy is already in the
  // Trash, so nothing is actually lost.
  try {
    await fsp.rm(src, { recursive: true, force: false });
  } catch (err) {
    return {
      ok: false,
      method: 'copy+remove',
      error: `the copy into the Trash succeeded but the original could not be removed: ${(err && err.message) || err}`,
      copiedTo: dest,
    };
  }

  return { ok: true, method: 'copy+remove' };
}

/** Append one JSON line to `<ground-control>/.forge/reclaim-log.jsonl`. */
async function appendLog(record) {
  await fsp.mkdir(path.dirname(RECLAIM_LOG), { recursive: true });
  await fsp.appendFile(RECLAIM_LOG, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Move one project folder to the macOS Trash.
 *
 * `opts.confirmName` must equal `project.name` exactly.
 * `opts.root`        is the scanned root; the folder must be a direct child.
 * `opts.force`       overrides soft blockers (see HARD_BLOCKERS). Hard blockers
 *                    are never overridden. Everything lifted is logged.
 *
 * Throws `ReclaimError` with a `.status` of 409 (blockers), 400 (name
 * mismatch), 403 (path gates) or 500. Resolves to `{ ok, trashedTo, manifest }`.
 */
async function trashProject(project, opts = {}) {
  if (!project || !project.name || !project.path) {
    throw new ReclaimError(404, 'unknown project');
  }
  const root = opts.root;
  if (!root) throw new ReclaimError(500, 'the scanned root is unknown, so nothing can be removed');

  /* 1. Re-assess RIGHT NOW. The UI's view of the world is never trusted; a
   *    blocker that appeared one second ago still stops this. */
  const assessment = await assessProject(project, { root });
  const hard = assessment.blockers.filter(isHardBlocker);
  const soft = assessment.blockers.filter((b) => !isHardBlocker(b));

  if (hard.length) {
    throw new ReclaimError(409, 'this project cannot be removed', {
      blockers: hard, hardBlockers: hard, softBlockers: soft, overridable: false, assessment,
    });
  }
  if (soft.length && opts.force !== true) {
    throw new ReclaimError(409, 'this project has blockers that must be overridden explicitly', {
      blockers: soft, hardBlockers: [], softBlockers: soft, overridable: true, assessment,
    });
  }

  /* 2. The typed name must match exactly. */
  if (typeof opts.confirmName !== 'string' || opts.confirmName !== project.name) {
    throw new ReclaimError(400, `type the folder name exactly ("${project.name}") to confirm`);
  }

  /* 3. The three path gates again, independently of the assessment. */
  const gate = checkDirectChild(root, project);
  if (!gate.ok) throw new ReclaimError(403, `forbidden path — ${gate.reason}`);
  const abs = gate.abs;
  if (isGroundControl(project)) throw new ReclaimError(403, 'forbidden path — that is Ground Control itself');

  /* 4. Decide where it goes, then write the manifest BEFORE anything moves. */
  await fsp.mkdir(TRASH_DIR, { recursive: true }).catch(() => {});
  const dest = trashDestinationFor(project.name);

  const manifest = {
    event: 'trash',
    atISO: new Date().toISOString(),
    projectId: project.id,
    project: project.name,
    path: abs,
    trashedTo: dest,
    meaningfulFiles: assessment.meaningfulFiles,
    meaningfulBytes: assessment.meaningfulBytes,
    onDiskFiles: assessment.onDiskFiles,
    onDiskBytes: assessment.onDiskBytes,
    ageDays: assessment.ageDays,
    lastActivityISO: assessment.lastActivityISO,
    score: assessment.score,
    verdict: assessment.verdict,
    reasons: assessment.reasons,
    gitState: assessment.gitState,
    // The whole point of the log is that an override is never silent.
    forced: soft.length > 0,
    overrodeBlockers: soft.map((b) => ({ code: b.code, label: b.label, detail: b.detail })),
    recoverable: 'open the Trash and drag it back out',
  };

  try {
    await appendLog(manifest);
  } catch (err) {
    // No durable record ⇒ nothing moves. The log is the point.
    throw new ReclaimError(500, `the reclaim log could not be written, so nothing was moved: ${(err && err.message) || err}`);
  }

  /* 5. Move. rename first; the copy-then-remove fallback only on EXDEV. */
  let method = 'rename';
  try {
    await fsp.rename(abs, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      const res = await copyThenRemove(abs, dest);
      method = res.method;
      if (!res.ok) {
        await appendLog({ event: 'trash-failed', atISO: new Date().toISOString(), project: project.name, path: abs, trashedTo: dest, error: res.error }).catch(() => {});
        throw new ReclaimError(500, res.error);
      }
    } else {
      await appendLog({ event: 'trash-failed', atISO: new Date().toISOString(), project: project.name, path: abs, trashedTo: dest, error: String((err && err.message) || err) }).catch(() => {});
      throw new ReclaimError(500, `the folder could not be moved to the Trash: ${(err && err.message) || err}`);
    }
  }

  manifest.method = method;
  await appendLog({ event: 'trash-complete', atISO: new Date().toISOString(), project: project.name, path: abs, trashedTo: dest, method }).catch(() => {});

  return { ok: true, trashedTo: dest, manifest };
}

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

export {
  assessProject,
  assessAll,
  trashProject,
  HARD_BLOCKERS,
  isHardBlocker,
  copyThenRemove,
  measureContent,
  readGitState,
  checkDirectChild,
  trashDestinationFor,
  treeFingerprint,
  isGroundControl,
  ReclaimError,
  BLOCKER_LABEL,
  GROUND_CONTROL_DIR,
  RECLAIM_LOG,
  TRASH_DIR,
  SUBSTANTIAL_FILES,
  SUBSTANTIAL_BYTES,
  RECENT_DAYS,
};
