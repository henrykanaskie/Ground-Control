# Ground Control Complete - Mark a Project Finished

Let the user say "this one is done", and show that on the card.

Read `CONTRACT.md` first (all its hard rules apply). This feature is appended in
the manner of Forge, Workbench, Reclaim and Sources: a new `lib/` file plus
clearly-marked sections at the end of the shared files.

---

## 0. The governing principle

**Every other field on a project is observed. This one is declared.**

Ground Control's whole method is to look at a folder and report what it finds:
commits, file counts, activity dates, running agents. That method has one blind
spot it cannot reason its way out of. A project that was finished on purpose and
a project that was quietly dropped produce **identical evidence**: no commits,
no file changes, nothing running, months of silence.

```
                 what the folder looks like
                            |
        +-------------------+-------------------+
        |                                       |
   finished on purpose                    abandoned
        |                                       |
   no commits, nothing running,   no commits, nothing running,
   silent for 8 months            silent for 8 months
        |                                       |
        +-------------------+-------------------+
                            |
                   indistinguishable
```

Only the person who wrote it knows which is which, so this is the one fact that
travels from the user into Ground Control rather than the other way round.

Two consequences follow, and neither is negotiable:

1. **Marking never touches the project.** Nothing is written into the folder: no
   dotfile, no marker, no metadata. The mark lives entirely in Ground Control's
   own config directory. Un-marking is therefore always possible and always
   free, and uninstalling Ground Control leaves no trace in any project.
2. **The mark is an answer, not evidence.** Where anything else in Ground
   Control weighs a signal, this overrides. See §5.

---

## 1. File ownership

- `lib/marks.js` (new): the registry, its file format, and its defences
- `server.js`: an import, the registry beside `SOURCES`, one line in
  `getScan()`, one dispatch block in `route()`, and an appended handler section
- `lib/reclaim.js`: one blocker (§5)
- `public/js/app.js`, `public/css/app.css`, `public/index.html`: an appended
  `cmpl*` section, an appended CSS block, one sprite symbol

Do not restructure existing code in any of them.

---

## 2. Where the mark lives

A small JSON file **beside the source registry**, so `--config` and
`GROUND_CONTROL_CONFIG` isolate it for the test suite without a second flag:

```
~/.ground-control/sources.json      the folders being watched
~/.ground-control/marks.json        the projects declared finished
```

```jsonc
{
  "version": 1,
  "updatedISO": "2026-09-05T19:04:11.000Z",
  "completed": [
    { "path": "/Users/you/coding_projects/groupStat",
      "completedISO": "2026-09-05T19:04:11.000Z" }
  ]
}
```

**Keyed by absolute path, not by project id.** An id is a slug derived from the
folder name, and `uniqueSlug` can hand the same folder a different id once a
sibling of the same name appears. The path is what the mark is actually about.

Un-marking **removes the row** rather than storing `completed: false`. The file
is a set of the finished, not a table of every project.

Defences, matching `lib/sources.js` exactly: a missing file is a normal first
run and not an error; an unreadable or malformed one sets `loadError` and means
nothing is marked this run; junk rows inside a well-formed file are skipped
individually; a failed write sets `saveError` and is reported, never thrown at a
request.

---

## 3. HTTP API

Mutations are loopback-only, for the same reason adding a folder is: they write
to a file in the user's home directory. Reading the list back is not.

### `GET /api/complete`
```jsonc
{ "completed": [ { "path": "...", "completedISO": "..." } ],
  "count": 1, "file": "/Users/you/.ground-control/marks.json", "saveError": null }
```

### `POST /api/complete/:id`  ·  `DELETE /api/complete/:id`
POST marks, DELETE clears. A POST body of `{ "completed": false }` is honoured,
so a client that would rather send one method can.

```jsonc
{ "id": "group-stat", "name": "groupStat", "path": "/abs/path",
  "completed": true, "completedISO": "2026-09-05T19:04:11.000Z",
  "saveError": null }
```

`:id` is a project id and is validated as a slug before any lookup: anything
containing a separator, a `..` segment or a NUL is refused with 404, exactly as
in Reclaim and Sources. **The request never names a path**, so there is no
user-supplied path to guard: the path written is the one the scan already holds.

Unknown id → 404. Non-loopback mutation → 403.

### `ProjectSummary` gains two fields

```jsonc
{ "completed": false, "completedISO": null }
```

Folded in **inside `getScan()`**, at the single point every consumer passes
through, so `/api/projects`, `/api/project/:id`, the SSE payload and the Reclaim
sweep all see it without any of them knowing where marks are stored.

When a mark changes, the cached scan payload is **patched in place** rather than
dropped. A full filesystem re-walk to flip one boolean is pure waste; the SSE
watchers are then notified so other open tabs catch up.

---

## 4. The UI

**Quiet on purpose.** A finished project is not an urgent project.

- The card gets a green border and an inset ring, plus a small `COMPLETE` badge
  beside the name. Nothing else changes: no reordering, no filter of its own, no
  lifted background, no motion.
- The green is `--done: #5fae7f`, deliberately dimmer than `--active: #4ade80`.
  An agent working right now must stay the loudest green on the page.
- The ring is inset rather than a thicker border, so a marked card is exactly
  the same size as an unmarked one and marking does not nudge the layout.
- The badge carries the **word** "complete" as well as the colour. A green
  border alone says nothing to anyone who cannot see green.
- The detail view gets a matching `Complete` pill in the status row and the
  toggle button in the action row beside Move to Trash.

No confirmation in either direction. This writes one line to Ground Control's
own config and nothing else, and the undo is the same button.

---

## 5. Reclaim must not offer to bin a finished project

Reclaim flags folders with nothing of value in them that nothing has touched in
a long time. **A finished project matches that description exactly**, so without
this section the feature would hand the user a "safe to remove" list built
largely out of the projects they had just declared done.

`lib/reclaim.js` therefore adds one blocker:

```
marked-complete   This project is marked complete: finished on purpose,
                  not abandoned.
```

A blocker rather than a score penalty, because the mark is an answer and not
evidence (§0): no amount of emptiness outweighs it. A blocked project reports
`verdict: "keep"` and cannot be trashed without the explicit override that every
other blocker already requires.

---

## 6. Tests

`test/complete.test.js`, using the fixtures in `test/helpers.js`. Every server
runs with `--config` pointed at a throwaway file, so the marks file lands in the
same throwaway directory and no test can touch the developer's real list.

Covered: the file location rule; path keying and rejection; survival across a
restart; un-marking removing the row; re-marking keeping the original timestamp;
corrupt, alien and missing files; junk rows; the fold onto a project list; the
Reclaim blocker as a unit and over HTTP; the full mark/read/unmark round trip;
id validation; and that marking leaves the project folder byte-for-byte
untouched.

---

## 7. Ongoing: the project that is never finished

Some projects are never meant to be done: a personal site, a profile README, a
dotfiles folder. They are kept up to date for as long as they exist, and they go
quiet between updates. Unmarked, one of them looks abandoned; marked complete,
it would be lying. **Ongoing** is the second declaration, and it says "this is
maintained on purpose and will never be finished".

```
                    what the user declares
                            |
        +-------------------+-------------------+
        |                   |                   |
     complete            ongoing             neither
   finished, done    kept current forever   Ground Control
                                            judges by evidence
```

A project carries **one of the two or neither, never both**. Setting either one
clears the other, in `Marks.setKind()`, so no caller can produce the
contradiction. A hand-edited file that names a path in both lists loads it as
complete.

Everything in §0 to §5 applies unchanged, with these differences:

- **Storage**: a second array in the same `marks.json`. A file written before
  this existed has no `ongoing` key, and that is a normal load.
  ```jsonc
  { "version": 1, "completed": [ ... ],
    "ongoing": [ { "path": "/abs/path", "ongoingISO": "..." } ] }
  ```
- **API**: `GET /api/ongoing`, `POST /api/ongoing/:id`, `DELETE /api/ongoing/:id`,
  with the same guards as §3. A POST body of `{ "ongoing": false }` is honoured.
  Both `/api/complete/:id` and `/api/ongoing/:id` answer with **both** marks, so
  the client can repaint the one that was just cleared.
- **`ProjectSummary`** gains `ongoing` and `ongoingISO` beside `completed`.
- **UI**: violet, `--ongoing: #a594e8`, with an infinity icon and the word
  "ongoing". Not green, because it is not an end state. On an unmarked card both
  grey pills fade in on hover; on a marked card only its own badge shows, and
  pressing it clears the mark. The detail view always shows both buttons, so
  switching from one to the other is a single press there.
- **Reclaim**: one more blocker, for the same reason as §5.
  ```
  marked-ongoing   This project is marked ongoing: kept up to date on purpose,
                   never meant to be finished.
  ```
