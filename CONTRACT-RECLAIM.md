# Ground Control Reclaim - Flag and Remove Dead Folders

Find folders that are genuinely dead (never really started, or long abandoned
with nothing of value in them) and make them safe to get rid of.

This is the only destructive feature in Ground Control. Read `CONTRACT.md` first (all its
hard rules apply). `CONTRACT-FORGE.md` and `CONTRACT-WORKBENCH.md` cover separate
features; do not modify their code.

---

## 0. The governing principle

**Nothing is ever permanently deleted. Everything goes to the macOS Trash.**

There is no `rm -rf` anywhere in this feature, no "permanent delete" option, and
no flag that enables one. The user recovers anything by opening Trash and
dragging it out. If that constraint ever seems to be in the way, the answer is
still no.

Verified on this machine: moving a directory to `~/.Trash` with `fs.rename` is
instant and needs no permissions prompt. **Do not use `osascript`/Finder
automation**: it triggers a macOS TCC prompt that hangs a headless server
indefinitely (this was tested; it deadlocked until killed).

---

## 1. File ownership

- `lib/reclaim.js` (new): candidate scoring, safety checks, trash operation
- `server.js`, `public/js/app.js`, `public/css/app.css`, `public/index.html`:
  append a clearly-marked Reclaim section; **never restructure existing code**

Do not touch any other `lib/` file, `public/js/markdown.js`, `public/css/doc.css`,
`README.md`, or any CONTRACT file. Forge and Workbench already occupy parts of
`server.js` and `app.js`: leave every line of both alone.

---

## 2. Measuring "not much content" - do not be fooled

Raw file counts and directory sizes are **actively misleading** here. Measured on
this machine:

| Project | `find` says | Reality |
|---|---|---|
| `water_potability` | 11,557 files / 341 MB | almost entirely `pot-venv/` |
| `pitwall` | 12,255 files / 334 MB | almost entirely `.venv/` |
| `shed_stats` | 861 files / 12 MB | Ground Control's own scan sees **1 real file** |

So **score on meaningful content only**, reusing the counts `lib/scan.js` already
produces (it applies the ignore list: `node_modules`, `.git`, virtualenvs, build
output, caches, dot-directories). Never call `du`/`find` yourself for this.

`meaningfulFiles` counts files that are not: ignored-directory contents,
`.DS_Store`, `.gitignore`/`.gitattributes` alone, empty files, or lockfiles.

---

## 3. Safety checks - `lib/reclaim.js`

```js
export async function assessProject(project) -> Assessment
export async function trashProject(project, opts) -> {ok, trashedTo, manifest}
```

### `Assessment`
```jsonc
{
  "projectId": "n8n",
  "meaningfulFiles": 0,
  "meaningfulBytes": 0,
  "ageDays": 412,
  "score": 92,                  // 0-100, higher = safer to remove
  "verdict": "dead|dormant|keep",
  "reasons": [ "no files at all", "never touched in 14 months" ],
  "blockers": [ Blocker ],      // EMPTY = permitted; HARD = never; SOFT = needs force:true
  "gitState": { "hasGit": true, "dirtyCount": 5, "unpushedCommits": 1,
                "hasRemote": true, "stashCount": 0, "branchesNotMerged": 0 }
}
```

### Blockers - HARD ones make removal impossible; SOFT ones require an override

Blockers divide in two, because they answer different questions.

**HARD blockers are structural.** They are never overridable, by any flag, and
no UI offers to lift them:

| code | why it is absolute |
|---|---|
| `is-ground-control` | removing the running application's own folder |
| `not-a-direct-child` | path gate: the target is not a plain child of the folder it was scanned from |
| `inside-other-repo` | the folder belongs to a repository that is not itself |

**Every other blocker is a judgement** about whether the work matters:
`recent-activity`, `substantial-content`, `uncommitted-changes`,
`unpushed-commits`, `no-remote`, `stashed-work`, `unmerged-branches`,
`agent-running`, `git-unreadable`, `agent-unknown`. These are the owner's calls
to overrule. They are lifted only by `force: true` on the trash request, which
the UI reaches through a second, separately typed confirmation naming each
reason being overridden.

This exists because the original rule (any blocker makes removal impossible)
meant a perfectly ordinary folder could never be trashed from Ground Control at all,
only ones the sweep had already judged dead. That is a strange thing for a tool
that manages a folder of projects to refuse.

What keeps it safe is the destination, not the refusal: §4 moves a folder into
`~/.Trash` with `fs.rename`. Nothing here deletes. Every override is written to
the reclaim log with the codes it lifted (`forced: true`, `overrodeBlockers`),
so an override is never silent.

### Original note: a non-empty `blockers` array

These are hard refusals, not warnings. The API must reject the trash request
with `409` and the UI must not offer the action at all:

| Blocker | Condition |
|---|---|
| `uncommitted-changes` | git working tree is dirty |
| `unpushed-commits` | commits exist that are on no remote |
| `no-remote` | repo has commits but no remote at all: this folder is the only copy |
| `stashed-work` | `git stash list` is non-empty |
| `unmerged-branches` | a local branch not merged into the default branch |
| `substantial-content` | `meaningfulFiles > 40` or `meaningfulBytes > 20 MB` |
| `recent-activity` | any activity within the last 30 days |
| `is-ground-control` | the project is Ground Control itself: never removable |
| `agent-running` | a coding agent currently has this project as its cwd (see `lib/agents.js` when present; treat as a blocker if unavailable-but-detectable) |

**`pitwall` is the live proof this matters**: dormant 5 months, 334 MB, and it
has 1 unpushed commit and 5 dirty files. It must be blocked. Verify that it is.

### Scoring (only meaningful when `blockers` is empty)
- `dead`: zero or near-zero meaningful files, or never any git history and
  untouched for 180+ days.
- `dormant`: small, no unique value at risk, untouched for 90+ days.
- `keep`: everything else. **Default to `keep`.** A false "dead" is far worse
  than a missed one.

`reasons` must be specific and human ("no files at all"; "1 file, last touched
7 months ago"; "all 6 commits are pushed to origin"), never a bare score.

---

## 4. The trash operation

```js
trashProject(project, { confirmName })
```

1. Re-run `assessProject` **at call time** and abort if any blocker appeared
   since the UI last looked. Never trust a client-supplied assessment.
2. Require `confirmName === project.name`, exact match. Mismatch → `400`.
3. Validate the target through the three gates (syntactic, post-`path.resolve`,
   post-`fs.realpath`), and require it to be a **direct child of the scanned
   root**, never the root itself, never a nested path, never a symlink.
4. Write a manifest **before** moving: project name, absolute path, timestamp,
   file/byte counts, git state, and the assessment reasons. Append it to
   `<ground-control>/.forge/reclaim-log.jsonl` so there is a durable record of what was
   removed and why.
5. Move with `fs.rename` to `~/.Trash/<name>`, de-duplicating with
   `<name> 2`, `<name> 3`… on collision. On `EXDEV` (different volume), fall
   back to a recursive copy followed by removal of the original, and if the copy
   fails at any point, leave the original untouched and report failure.
6. Return the trash destination so the UI can tell the user exactly where it went.

**Never** delete anything from `~/.Trash`. **Never** offer "empty trash".
**Never** operate on more than one project per request: no bulk delete.

---

## 5. HTTP API

| Route | Behavior |
|---|---|
| `GET /api/reclaim` | Assessments for every project: `{ assessments: {<id>: Assessment}, scannedAt }` |
| `GET /api/reclaim/:id` | One `Assessment`; `404` unknown project |
| `POST /api/reclaim/:id/trash` | Body `{ confirmName, force? }`. Moves to Trash. `409` with `{ blockers, hardBlockers, softBlockers, overridable }`: `overridable: true` means only soft blockers stand and `force: true` will lift them; `overridable: false` means a hard blocker stands and no flag helps. `400` on name mismatch, `403` on a path that fails the gates. Returns `{ ok, trashedTo, manifest }` and triggers a rescan. |

`GET` routes are read-only and must never mutate. There is no bulk endpoint.

---

## 6. UI

- **Grid**: a quiet "Review" affordance surfaces the count of `dead`/`dormant`
  candidates. Do not decorate individual cards with delete controls: this must
  never be a one-click-from-anywhere action.
- **A Reclaim view** listing candidates worst-first, each showing meaningful
  file count and size, age, the specific `reasons`, and its git state. Projects
  with blockers appear in a separate, visually distinct "Not safe to remove"
  group that states *why*, so the user learns what is protecting them.
- **Removal flow** (only for a candidate with no blockers):
  1. A dialog naming the exact absolute path, the real content that will go, and
     the git state in plain words.
  2. A required text field: the user types the project name exactly. The confirm
     button stays disabled until it matches.
  3. Confirm is worded "Move to Trash", never "Delete". It is styled as a
     destructive action, and is never the default focus; Cancel is.
  4. After success: confirm what moved and where, state plainly that it can be
     restored from Trash, and refresh the grid.
- Nothing in this feature may be triggered by a keyboard shortcut, and no
  multi-select or "remove all" affordance may exist.

Follow `CONTRACT.md` §3 tokens and §5 conventions; build DOM with
`createElement`/`textContent`, never `innerHTML` with server data.
