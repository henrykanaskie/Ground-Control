/**
 * Ground Control: the completed-project marks (CONTRACT-COMPLETE.md).
 *
 * Every other fact on a card is derived. Ground Control looks at a folder and
 * reports what it finds there. "Finished" is the one thing it cannot see: a
 * project that is done looks exactly like a project that was abandoned, and
 * from the outside a deliberate stopping point is indistinguishable from
 * neglect. Only the person who wrote it knows which one it is, so this is the
 * single fact that travels the other way, from the user into the dashboard.
 *
 * There is a second declaration beside it: "ongoing". Some projects are never
 * meant to be finished (a personal site, a profile repo, a dotfiles folder)
 * and are kept current for as long as they exist. Left unmarked, one of those
 * looks dropped whenever it goes quiet between updates; marked complete, it
 * would be lying. Ongoing says "this is maintained on purpose and will never be
 * done". A project is complete, ongoing, or neither, never both: setting one
 * clears the other.
 *
 * The marks live in a small JSON file beside the source registry, keyed by
 * absolute path. Path, not project id: an id is a slug derived from the folder
 * name, and `uniqueSlug` can hand the same folder a different id once a
 * sibling of the same name appears. The path is what the mark is actually
 * about.
 *
 * Everything here is defensive in the way `lib/sources.js` is. A missing,
 * unreadable or malformed file never stops the server; it just means nothing
 * is marked. A failed write is reported and remembered, never thrown at a
 * request.
 *
 * Node stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_VERSION = 1;

/** Marks sit beside the source registry, so `--config` isolates them too. */
function defaultMarksPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.ground-control', 'marks.json');
}

/**
 * The marks file that belongs with a given sources file: same directory,
 * fixed name. The test suite points `--config` at a throwaway sources.json,
 * and this puts the marks in the same throwaway directory without the caller
 * having to pass a second flag.
 */
function marksPathFor(sourcesFile, homeDir = os.homedir()) {
  if (typeof sourcesFile !== 'string' || !sourcesFile.trim()) return defaultMarksPath(homeDir);
  return path.join(path.dirname(path.resolve(sourcesFile)), 'marks.json');
}

/** The key a mark is stored under. Null for anything that is not a real path. */
function keyOf(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.indexOf('\0') !== -1) return null;
  if (!path.isAbsolute(s)) return null;
  const abs = path.resolve(s);
  // A trailing separator would make `/a/b/` and `/a/b` two different marks.
  return abs.length > 1 && abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

/** An ISO string, or null. Rejects anything Date cannot parse. */
function isoOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * The set of projects the user has declared finished.
 *
 * Read on construction, written on every change. Small enough that the whole
 * file is rewritten each time: a few hundred bytes, once per click.
 */
class Marks {
  constructor(opts = {}) {
    this.homeDir = opts.homeDir || os.homedir();
    this.file = opts.file
      ? path.resolve(opts.file)
      : marksPathFor(opts.sourcesFile, this.homeDir);
    this.marks = new Map();      // absolute path -> ISO string (complete)
    this.ongoing = new Map();    // absolute path -> ISO string (ongoing)
    this.loadError = null;
    this.saveError = null;
    this.load();
  }

  load() {
    this.marks = new Map();
    this.ongoing = new Map();
    this.loadError = null;

    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this.loadError = `The completed list at ${this.file} could not be read (${err.message}). Nothing is marked complete this run.`;
      }
      return;
    }

    const rows = parsed && Array.isArray(parsed.completed) ? parsed.completed : null;
    // A file written before ongoing existed has no such key; that is normal.
    const ongoingRows = parsed && Array.isArray(parsed.ongoing) ? parsed.ongoing : [];
    if (!rows) {
      this.loadError = `The completed list at ${this.file} is not in a shape Ground Control understands. Nothing is marked complete this run.`;
      return;
    }

    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const key = keyOf(raw.path);
      if (!key || this.marks.has(key)) continue;
      this.marks.set(key, isoOrNull(raw.completedISO) || new Date(0).toISOString());
    }

    for (const raw of ongoingRows) {
      if (!raw || typeof raw !== 'object') continue;
      const key = keyOf(raw.path);
      // A hand-edited file could name a path in both lists; complete wins.
      if (!key || this.ongoing.has(key) || this.marks.has(key)) continue;
      this.ongoing.set(key, isoOrNull(raw.ongoingISO) || new Date(0).toISOString());
    }
  }

  /** Atomic write, the same shape as the source registry's. */
  persist() {
    const body = JSON.stringify({
      version: CONFIG_VERSION,
      updatedISO: new Date().toISOString(),
      completed: [...this.marks.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([p, iso]) => ({ path: p, completedISO: iso })),
      ongoing: [...this.ongoing.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([p, iso]) => ({ path: p, ongoingISO: iso })),
    }, null, 2) + '\n';

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.saveError = null;
      return true;
    } catch (err) {
      this.saveError = `The completed list could not be saved to ${this.file} (${(err && err.message) || err}).`;
      console.error('[marks] save failed:', this.saveError);
      return false;
    }
  }

  has(projectPath) {
    const key = keyOf(projectPath);
    return key ? this.marks.has(key) : false;
  }

  /** When it was marked, or null when it is not marked at all. */
  markedISO(projectPath) {
    const key = keyOf(projectPath);
    if (!key) return null;
    return this.marks.get(key) || null;
  }

  /**
   * Turn the mark on or off. Returns the resulting state, or null when the
   * path is not one that can carry a mark. Writing through on every change is
   * the point: a mark that survives a restart is the whole feature.
   */
  set(projectPath, on) {
    return this.setKind(projectPath, 'completed', on);
  }

  /** The same, for the ongoing mark. */
  setOngoing(projectPath, on) {
    return this.setKind(projectPath, 'ongoing', on);
  }

  /**
   * Turning either mark on clears the other: a project is finished or it is
   * kept up to date forever, and saying both would mean nothing.
   */
  setKind(projectPath, kind, on) {
    const key = keyOf(projectPath);
    if (!key) return null;
    const own = kind === 'ongoing' ? this.ongoing : this.marks;
    const other = kind === 'ongoing' ? this.marks : this.ongoing;
    const want = Boolean(on);
    if (want !== own.has(key)) {
      if (want) {
        own.set(key, new Date().toISOString());
        other.delete(key);
      } else {
        own.delete(key);
      }
      this.persist();
    }
    return this.stateOf(key);
  }

  /** Both marks for one path, in the shape the API and the tests read. */
  stateOf(projectPath) {
    const key = keyOf(projectPath);
    if (!key) return null;
    return {
      path: key,
      completed: this.marks.has(key),
      completedISO: this.marks.get(key) || null,
      ongoing: this.ongoing.has(key),
      ongoingISO: this.ongoing.get(key) || null,
    };
  }

  isOngoing(projectPath) {
    const key = keyOf(projectPath);
    return key ? this.ongoing.has(key) : false;
  }

  count() { return this.marks.size; }

  ongoingCount() { return this.ongoing.size; }

  allOngoing() {
    return [...this.ongoing.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([p, iso]) => ({ path: p, ongoingISO: iso }));
  }

  all() {
    return [...this.marks.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([p, iso]) => ({ path: p, completedISO: iso }));
  }

  /**
   * Fold the marks into a list of ProjectSummary objects, in place.
   *
   * Called on the way out of every scan, so `completed` is on the payload the
   * grid renders, the payload the detail view renders, AND the payload the
   * Reclaim sweep assesses, without any of the three knowing this file exists.
   */
  applyTo(projects) {
    if (!Array.isArray(projects)) return projects;
    for (const p of projects) {
      if (!p || typeof p !== 'object') continue;
      const st = this.stateOf(p.path);
      p.completed = Boolean(st && st.completed);
      p.completedISO = (st && st.completedISO) || null;
      p.ongoing = Boolean(st && st.ongoing);
      p.ongoingISO = (st && st.ongoingISO) || null;
    }
    return projects;
  }
}

export { Marks, CONFIG_VERSION, defaultMarksPath, marksPathFor, keyOf };
