# GROUND_CONTROL SOURCES - watch any folder, anywhere

Ground Control began as a window onto one directory: `~/coding_projects`, named
by `--root`, fixed for the life of the process. That is the wrong shape for how
people actually keep code. Projects live in `~/dev`, in `~/Documents/clients`,
in a checkout on an external disk, in one folder someone cloned onto the Desktop
three weeks ago. A dashboard that can only see one shelf is a dashboard you have
to work around.

**Ground Control now watches a list of folders, and the list is the user's.**

Read `CONTRACT.md` first for the project's conventions. Everything there still
holds: Node stdlib only, vanilla JS on the frontend, no build step.

---

## 0. Rules

**§0 - Nothing here ever removes anything.** Adding and removing a *source*
edits one JSON file in `~/.ground-control/`. The folders themselves are never
moved, renamed, written to or deleted. "Remove" in this feature means "take it
off the dashboard", and the UI says so in those words every single time, because
the word reads as "delete" and the two must never be confused. Deleting a folder
is Reclaim's job, behind its own typed-name confirmation.

**§1 - A folder is described before it is accepted.** The add dialog says what
Ground Control found (one project, or a folder with eleven things in it, named)
and how it intends to read it. A refusal is a sentence that says why, not a
status code.

**§2 - Nothing is added on a guess.** A dropped folder whose path the browser
withheld triggers a *search*, and every hit is offered to the user to confirm.
The registry is never written from an inference.

**§3 - Every path guard anchors on the source, not on a global root.** A project
in an added folder is exactly as protected as one in the original root, and a
project belonging to no registered source cannot be opened, documented or
trashed at all.

**§4 - One folder is still the common case.** With a single source this feature
is a quiet label in the header where the root path used to be. The provenance
chips, the folder filter and the count badge only appear once there is more than
one folder to distinguish.

---

## 1. Model

A **source** is a folder Ground Control watches. Two kinds:

| kind | meaning | becomes |
|---|---|---|
| `root` | a folder whose immediate children are projects | one card per child |
| `project` | a single folder that *is* one project | one card |

Both kinds can be added freely, in any mix. The kind is detected, shown, and
overridable with one click.

### Detection

In falling order of confidence, a folder reads as **one project** when:

1. it carries a build or repo marker: `.git`, `package.json`, `Cargo.toml`,
   `go.mod`, `pyproject.toml`, `Package.swift`, an `.xcodeproj`, `CLAUDE.md`, …
2. it has a child directory belonging to a project's insides: `src/`, `lib/`,
   `tests/`, `app/`, `docs/`, …
3. it has loose source files at its top level
4. it has no subdirectories at all: there is nothing here to contain

Everything else reads as a **folder of projects**. That is the safe default:
being shown too many cards is obvious at a glance and one click to undo, where
being shown one card for a folder of twelve projects hides eleven of them.

### Refusals

A source is refused outright, with an explanation, when the path is:

- a system directory (`/`, `/System`, `/Library`, `/Users`, `/usr`, `/var`,
  `/home`, `/net`, …): scanning one walks tens of thousands of directories and
  produces a dashboard of noise
- the bare home directory: same reason, plus `~/Library`
- inside `~/Library`
- a build or dependency folder (`node_modules`, `.venv`, `dist`, …)
- not there, not a directory, or not readable
- already watched

`/home` and `/net` are additionally never *read*: on macOS they are autofs mount
points, and a plain `readdir` on one blocks while the automounter looks for a
server that may not exist. The refusal is decided from the path alone, before
any filesystem call that could hang.

### The registry file

`~/.ground-control/sources.json`, overridable with `--config <file>` or
`GROUND_CONTROL_CONFIG`. Written atomically (temp file + rename), mode `0600`.

```jsonc
{
  "version": 1,
  "updatedISO": "2026-08-24T08:30:51.250Z",
  "sources": [
    { "id": "coding-projects", "kind": "root",
      "path": "/Users/you/coding_projects", "label": null,
      "addedISO": "2026-08-24T08:30:51.250Z" }
  ]
}
```

A missing file seeds itself from `--root`, or from `~/coding_projects`. A
corrupt file is reported and falls back; it never stops the server.

`--root` on a run where the config **already exists** adds that folder for this
run only and does not persist it: a CLI flag is for one session, not forever.

---

## 2. `ProjectSummary` additions

Every project now says where it came from:

```jsonc
{
  "sourceId": "coding-projects",   // the source it was scanned from
  "sourceKind": "root",            // root | project
  "sourcePath": "/Users/you/coding_projects",
  "sourceLabel": "coding_projects"
}
```

`GET /api/projects` gains a `sources` array (the same shape as
`GET /api/sources`) alongside the existing `root`, which stays and now means
"the first root-kind source": the folder the header names.

Ids are assigned source by source, alphabetically within each source, so a
project keeps its id no matter what is added after it. Bookmarks and Forge
staging directories both depend on that. A project reachable through two
sources (a nested root, a symlink) appears once, owned by the first source
that claimed it.

---

## 3. HTTP API

### `GET /api/sources`
```jsonc
{
  "sources": [ /* SourceInfo */ ],
  "defaultRoot": "/Users/you/coding_projects",
  "homeDir": "/Users/you",
  "configPath": "/Users/you/.ground-control/sources.json",
  "configError": null,
  "canPickFolder": true          // the system folder chooser is available
}
```

#### SourceInfo
```jsonc
{
  "id": "coding-projects",       // url-safe slug, stable, persisted
  "kind": "root",
  "path": "/Users/you/coding_projects",
  "name": "coding_projects",     // basename
  "label": null,                 // user-set, or null
  "display": "coding_projects",  // label || name
  "addedISO": "...",
  "primary": true,               // the first root-kind source
  "ephemeral": false,            // came from --root, not persisted
  "exists": true,
  "readable": true,
  "projectCount": 12             // null when unreadable
}
```

### `POST /api/sources` → `201`
Body `{ path, kind?, label? }`. `path` may be absolute, `~`-prefixed, a
`file://` URL, quoted, or shell-escaped. Responds with the full
`GET /api/sources` payload plus `{ ok, source, projectsAdded, saved }`.

`400` malformed or refused · `404` not there · `409` already watched
(with `source`).

### `POST|GET /api/sources/inspect`
Body `{ path, kind? }` or `?path=&kind=`. Pure read: one `stat` and one
directory listing. Returns what the add dialog shows before anything is
committed to:

```jsonc
{ "ok": true, "error": null, "path": "/abs", "exists": true, "isDir": true,
  "name": "gamma", "kind": "project", "detectedKind": "project",
  "projectCount": 1, "sample": ["docs", "src"], "isRepo": true,
  "alreadyWatched": false, "watchedAs": null }
```

### `DELETE /api/sources/:id` (also `POST /api/sources/:id/remove`)
Takes the folder off the dashboard. **Does not touch the folder.** Returns the
full source payload plus `{ ok, removed }`. `404` for an unknown id; an id
containing a path separator is refused before any lookup.

### `POST /api/sources/:id`
Body `{ label?, kind? }`: rename, or re-read a folder the other way.

### `POST /api/sources/reorder`
Body `{ ids }`: the header order and the primary root are the user's.

### `POST /api/sources/locate`
Body `{ name }`. The drag-and-drop fallback (§4). Searches the watched folders
first, then a bounded sweep of the home directory: depth ≤ 4, 40 000 dirents,
1.5 s, 12 hits, skipping dot-directories, ignored directories, `~/Library` and
`~/Applications`. Returns `{ name, matches: [ inspect + alreadyWatched ] }`,
shallowest path first. Nothing is added: the user picks.

### `GET /api/browse?path=`
The in-app folder picker. Subdirectory **names** only: no file contents, no
sizes, no file entries at all. Pointed at a file, it lists that file's folder.
Returns `{ ok, path, name, parent, home, entries: [{ name, path, isProject,
watched }], hiddenCount, truncated, watched, self }`, capped at 400 entries.

### `POST /api/pick-folder`
Runs the real macOS folder chooser through `osascript`. Ground Control is a local
app, so the system picker is available and is far less annoying than typing a
path. `{ ok, path, inspect }`, or `{ ok: false, cancelled: true }`, or `501`
off macOS. Cancelling is a normal outcome, not an error.

### `GET /api/stream`
Unchanged in shape. The watcher set is now rebuilt from the whole source list,
and adding or removing a folder re-emits `projects` immediately rather than
waiting for the scan cache to lapse.

---

## 4. Getting a real path out of a drop

Dragging a folder from Finder is the obvious way to add one, and it is also the
one the browser makes hardest: a dropped directory arrives as a **name**, with
its location deliberately withheld. Three routes, tried in order:

1. **`text/uri-list`**: Safari and the app shell hand over a real `file://`
   URL. One confirmation and it is in.
2. **`window.groundControlAddFolders(paths)`**: GroundControl.app registers the
   content view for `.fileURL` drags and calls this with the paths AppKit gave
   it. Unambiguous by construction.
3. **the name alone**: `POST /api/sources/locate`. The dialog opens
   immediately so the drop feels answered, then fills in whatever the search
   found. One hit pre-fills the box; several are offered as a list; none says so
   and points at the picker.

The app shell also exposes `window.webkit.messageHandlers.gcPickFolder`, which
opens a real `NSOpenPanel` as a sheet, frontmost and focus-correct, where the
server's `osascript` fallback is a dialog owned by another process. The page
uses it when it is there and falls back to `/api/pick-folder` when it is not.

---

## 5. UI

**Header.** The static root path becomes a button: the primary folder's path,
plus a `+N` badge once there is more than one. It opens a panel listing every
watched folder with its kind, its path, its project count, and an `×` that says
in its tooltip that the folder itself is left alone. "Add a folder" sits at the
bottom, above a standing note that removal is not deletion.

**Add dialog.** A path box that accepts `~`, `file://` URLs and pasted paths;
"Choose…" for the system picker; "Browse" for an inline directory walk. Below
it, a live verdict (the folder's name, what was found, a sample of what would
become cards) and a two-way toggle for how it will be read. The Add button is
disabled until the verdict is good.

**Grid.** A "folders" filter select appears once there is more than one source,
and each card carries a small provenance chip naming the folder it came from.
Both vanish when the list is back to one. `?source=<id>` joins the other filters
in the URL, and a filter pointing at a folder that is no longer watched clears
itself rather than hiding everything.

**Empty.** With no folder watched at all, the grid is replaced by a panel that
explains what a folder can be and offers to add one, because widening a filter
is not the fix.

**Drag.** A window-wide overlay on `dragenter`, counted rather than toggled so
crossing a child element does not flicker it.

**Keyboard.** `⌘⇧O` adds a folder from anywhere; `F` opens the folder list.
In the app, File ▸ Add Folder… is the same `⌘⇧O`.

---

## 6. What did not change

- `/api/doc`, `/api/raw` and Forge's save route still anchor on
  `project.path` and run the same three `resolveInside()` gates. They were
  never root-relative.
- Reclaim's direct-child gate still runs, now against the project's own source
  (for a `project`-kind source, its parent). A project whose source is the
  folder itself is still removable under every existing guard (typed name,
  agent check, git state) and its registry entry is dropped afterwards so the
  dashboard does not keep a folder that is now in the Trash.
- Workbench's `/api/open` re-verifies containment against the project's source
  before spawning an editor, exactly as it did against the single root.
