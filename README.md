# Ground Control

A live dashboard over the projects you point it at, and a place to work from,
not just look at.

Give it a folder of repos, a single project from anywhere on disk, or any mix of
the two, and it tells you what state everything is in, which projects have coding
agents running in them right now, and puts each project's onboarding document one
click away. It can write that document when one doesn't exist, open any project
in your editor, and help you clear out the folders that turned out to be nothing.

## Run it as an app

```bash
./build-app.sh --install          # builds GroundControl.app into ~/Applications
```

Then launch it from Launchpad, Spotlight, or the Dock. It is a native macOS
application (its own icon, window, and menu bar) wrapping the dashboard in a
`WKWebView`. A Swift shell rather than Electron: **1.9 MB instead of ~150 MB**,
and it launches instantly.

The app owns the server. It finds Node itself (a Finder-launched app inherits
almost no `PATH`), picks a free port on every launch so it never collides with a
server you started by hand, and takes the server down when you quit. That holds
even on a force-quit: the child runs in its own process group behind a watchdog
holding a pipe the app owns, so the server dies with the app whether it exits
cleanly or is `kill -9`ed. Server output goes to `~/Library/Logs/GroundControl/server.log`.

Built locally, the bundle carries no quarantine flag and opens without a
Gatekeeper prompt.

## Or run it as a server

```bash
./bin/ground-control                      # watch the folders you've added
./bin/ground-control ~/other/projects     # also watch this one, just for this run
./bin/ground-control --port 8080          # different port
./bin/ground-control --no-open            # don't launch a browser
```

Default port `7377`. On a first run with nothing added yet it starts on
`~/coding_projects`; after that the folders you add from the dashboard are the
folders it watches, and a path on the command line is a one-off rather than a
setting.

**No dependencies.** Node standard library and vanilla browser JS: no npm
install, no build step, no CDN. `node server.js` is the whole thing.

---

## The folders it watches

Ground Control watches a **list** of folders, not one directory, and the list is
yours. Two kinds, freely mixed:

- **a folder of projects**: every folder inside it becomes a card, the way
  `~/coding_projects` always worked
- **one project**: a single folder anywhere on disk becomes a single card

Add one by **dragging it onto the window**, with the system folder chooser, by
browsing from inside the app, or by pasting a path (`~/…` and `file://` URLs
both work). Ground Control looks at the folder first and tells you what it found,
"one project, a git repository", or "11 folders inside it, each becoming its own
card", and lets you flip that reading with one click before committing.

The list lives in `~/.ground-control/sources.json` and survives restarts. System
folders and your bare home directory are refused, with a sentence explaining why,
rather than accepted and then quietly walking 200,000 files.

**Removing a folder takes it off the dashboard and does nothing else.** Nothing
on disk is moved, renamed, or deleted: that is Reclaim's job, behind a typed
confirmation.

With one folder watched, none of this is visible: the header shows its path the
way it always did. With several, cards gain a small chip naming where they came
from and the toolbar gains a folder filter.

A dragged folder is the awkward case, because browsers hand over a folder's
*name* and deliberately withhold its path. Ground Control tries the drag's
`file://` URL first, then the macOS app's own drop handler (which has the real
path), and only then falls back to searching your home directory by name, and
even then it asks you to confirm the hit rather than adding it on a guess.

## The grid

One card per project: a status dot, why it has that status ("27 commits this
week", "last commit 2 years ago"), what it's built in, an opening line pulled
from the project's own documentation, and counts of docs, TODOs, and uncommitted
files. Filter by text, status, stack, or agent activity; sort four ways. Filter
state lives in the URL, so a reload keeps your view.

Status comes from real activity: the last commit for a clean repo, the newest
file for a dirty or non-git folder:

| | |
|---|---|
| `active` | touched in the last 7 days |
| `recent` | 7–30 days |
| `idle` | 30–120 days |
| `dormant` | older than 120 days |
| `empty` | no files yet |

A project page adds a 90-day commit heatmap, language composition, every
document grouped by kind, the file tree, recent commits, and which files are
dirty. The reader renders markdown properly: headings, tables, nested lists,
syntax-highlighted code: with a table of contents. Projects whose explainer is
a rendered HTML page open that page in a sandboxed frame.

## Finding the onboarding doc

Discovery searches the project root and any one subdirectory (skipping
`node_modules`, virtualenvs, build output, and dot-directories), then picks one
document to feature:

1. Anything named `ONBOARDING` / `GETTING_STARTED` wins, at any depth.
2. Otherwise the best root-level document, preferring `CLAUDE.md` → `README` →
   `DESIGN`/`ARCHITECTURE`/`ADR` → other markdown → an HTML artifact.
3. Only if the root has nothing, a nested document.

The card blurb is the first real paragraph of that document, with badges,
headings, and code fences skipped.

## Forge: writing the document

When a project has no good explainer, Forge builds one: a single self-contained
HTML artifact, theme-aware, with the project's composition bar, commit heatmap,
entry points, and run commands rendered from real data.

Two tiers. **Data-only** needs no model at all and always works offline.
**Authored** shells out to the authenticated `claude` CLI with *read-only* access
to the repo (Read/Glob/Grep: never Write, Edit, or Bash), so what it writes is
grounded in code it actually read.

Authored generation runs on your **Claude subscription** via the CLI's existing
login. There is no API key anywhere in this feature, and the subprocess
environment has `ANTHROPIC_API_KEY` deliberately stripped so a key in your shell
can't silently move generation onto metered billing. The cost figure shown is a
list-price equivalent, not a charge.

### What the document has to do

The point is not an inventory. A document that says "it stores sessions in
SQLite" has told you a fact you could have got from the imports; one that says
what SQLite buys here, what it costs here, and what Postgres or a JSON file
would have done instead has taught you something you can take elsewhere. So
every document is required to weigh its decisions, in a **decision card** with a
slot for the alternatives and what each would have cost.

That works because of one distinction. A *motive* is a claim about what a person
was thinking ("the author chose SQLite because they wanted zero-config
deployment"), and without a comment or a commit saying so, Forge will not write
it. A *trade-off* is a claim about what the technologies are ("SQLite is a file,
so there is no server to run; it gives up concurrent writers"), which needs no
evidence from your repository because it is true everywhere. The second is the
part readers want, and it was going missing because the rule against inventing
reasons had been over-applied into silence.

The other half is shape. Documents kept coming out as unbroken columns of
paragraphs, so the house style now carries countable rules (never more than
three consecutive paragraphs, none longer than about 90 words, every section
carrying something that is not prose) and three components that hold the
content: the decision card, an option comparison table, and a **predict-then-read
block** that poses a question and hides the answer behind a `<details>` until
you have made a guess.

And Forge now counts. Every finished artifact is measured (words, reading time,
diagrams, decision cards, folds, reveals, longest paragraph, longest unbroken
run of prose), the numbers are shown next to its size, and a document of 1500
words or more with **no diagram and no decision anywhere in it** is refused
rather than staged. The prompts had asked for diagrams since the beginning; a
real artifact still came out at 3810 words with zero. Asking harder is not a
mechanism.

Generated artifacts go to a `.forge/` staging area. **Saving into a project is a
separate, explicitly confirmed action**, and it refuses to overwrite an existing
file without a second confirmation.

## Workbench: open, hop, and watch

Every project has an **Open** control: VS Code, Cursor, Xcode (Swift projects
only), Finder, or Terminal. From the reader, "open in editor" jumps to that file
and line. `Cmd+K` opens a fuzzy switcher for hopping between projects; `Cmd+Enter`
opens the highlighted one in your editor.

Ground Control also shows which projects have **coding agents running in them right
now**: a live pulse on the card, what the agent is currently doing, and a
timeline of recent activity on the project page, read from Claude Code's own
session transcripts. It **observes only**: it never signals or kills an agent,
never writes anything under `~/.claude`, and surfaces short status labels rather
than your conversations.

## Comms: talking to a project

Every project page has a chat. Type a message and an agent starts in that
project's folder: it reads the code, answers, and if you ask it to, changes
things and runs commands there. Replies stream in a sentence at a time, with a
compact strip of what it actually did (`Read agents.js`, `npm test`) between
them, and a Stop control the whole time it is working.

Two ways in. **A new chat** is a session Ground Control owns. **Continuing a
session** picks one of the sessions the Agents panel already lists and carries
its whole history into the chat: that one is a *fork*, always, so a session open
in a terminal right now cannot be corrupted by two processes writing one
transcript. You are talking to a copy that knows everything the original knows.

There is no way to type into a running agent: a live `claude` process has no
inbox. Continuing a session is the closest honest thing, and the panel says so.

A chat's process is spawned into its own process group, so stopping it also
reaches whatever its `Bash` calls left behind. That means it does not die with
the server for free: the shutdown hook reaps it on a quit, a Ctrl+C, or an app
force-quit (the app's watchdog sends SIGTERM, which the hook catches). A
`kill -9` on the server gets past all of that, so the pid of a running turn is
written down, and the next start finds that agent, checks it really is the one
it thinks it is, stops it, and tells you the turn's agent had kept working
rather than pretending it simply stopped.

**A chat agent can edit files and run commands.** It runs with permissions
bypassed, because headless mode has no terminal to answer a permission prompt
in. So: every chat route refuses anyone who is not on this machine, the agent's
folder comes from the scan rather than from the request, one turn runs at a
time (three across the app, 20 minutes each), every child is killable and dies
with the server, and the sentence saying all of this sits under the box you
type into. Closing a chat forgets Ground Control's record of it and touches
nothing under `~/.claude`.

## Reclaim: clearing out the dead ones

Flags folders that never really started or were long abandoned, scored on
*meaningful* content: the ignore list is applied first, so a 341 MB folder that
is 99% virtualenv is correctly seen as five real files.

**Nothing is ever permanently deleted.** Removal moves the folder to the macOS
Trash, so anything can be dragged back out. There is no `rm -rf` in this codebase
and no permanent-delete option.

Removal is refused outright (not warned about) when a folder has uncommitted
changes, unpushed commits, commits but no remote at all (the folder is the only
copy), stashed work, unmerged branches, more than 40 meaningful files or 20 MB,
activity in the last 30 days, a coding agent currently running in it, or if it is
Ground Control itself. Confirming requires typing the project name; there is no bulk
delete and no keyboard shortcut. Every removal is logged to
`.forge/reclaim-log.jsonl` before the move.

## Tests

```bash
npm test          # 99 tests, ~5s, no dependencies
```

Node's built-in runner: no framework, nothing to install. The suite is
weighted toward the things that would be expensive to get wrong rather than
toward coverage percentage:

- **Reclaim's blockers**, since it is the only destructive feature. Uncommitted
  changes, unpushed commits, a repo with no remote at all, substantial content,
  recent activity, and a running agent each get a fixture proving removal is
  refused.
- **Path traversal** on every file-reading route, asserting both the refusal and
  that `/etc/passwd` never appears in a response body.
- **Secret redaction**: a fixture repo containing a `.env`, a `creds.py` and a
  `.pem` is briefed, and the test fails if the secret value appears anywhere in
  the brief. The brief is handed to a model, so this one matters.
- **The source list**: that a folder added outside the root is scanned and
  path-confined exactly like one inside it, that project ids stay stable when a
  folder is added after them, that the same folder reached two ways yields one
  card, that removal leaves the folder on disk untouched, and that the list
  survives a restart.
- **That continuing a session always forks it.** A chat that resumed a session
  in place would let two processes append to one transcript, and the loser of
  that race loses work. The test asserts `--fork-session` is in the argv, that
  later turns resume the fork rather than the original, and that a chat agent is
  never handed a folder beyond the project it was opened on.
- **Regressions from real bugs**: a root README losing to a nested `CLAUDE.md`;
  `#StockPortfolio` with no space leaking in as a blurb; virtualenv bulk counting
  as meaningful content; and a live agent process being reported as *working*
  when its transcript had not been written in 23 hours.

Every fixture is built in the OS temp directory. `test/helpers.js` refuses to
return a root outside `tmp`, so no test can point at real projects.

## Layout

```
server.js               HTTP, static files, SSE, path-traversal defense
lib/sources.js          the watched-folder registry, detection, browse, picker
lib/scan.js             one walk per project: files, sizes, languages, TODOs, mtimes
lib/git.js              branch, commits, dirty state, 90-day activity
lib/docs.js             doc discovery, classification, featured pick, blurb
lib/util.js             relative time, formatting, slugs
lib/brief.js            the deterministic repo brief Forge writes from
lib/generate.js         the `claude` subprocess, streaming, output validation
lib/jobs.js             generation job registry
lib/house-style.js      art direction + the authoring prompt
lib/artifact-*.js       the deterministic artifact and its components
lib/agents.js           running-agent detection, transcript tails
lib/editors.js          editor detection and launching
lib/comms.js            per-project chats: the `claude` turn, streaming, the registry
lib/reclaim.js          candidate scoring, safety blockers, trash
public/js/app.js        routing, grid, detail, reader, every feature's UI
public/js/markdown.js   from-scratch markdown renderer + highlighting
public/css/             app.css (shell + tokens), doc.css (document typography)
app/GroundControl.swift        the macOS application shell (AppKit + WKWebView)
build-app.sh            compiles and assembles GroundControl.app
test/                   the suite (node --test), fixtures confined to tmp
CONTRACT*.md            the specs the build agents worked against
```

## Notes

- A full scan of 19 projects takes ~0.55s, including agent detection. Results are
  cached 5s; `?fresh=1` forces a rescan.
- Everything renders untrusted input. Markdown is escaped rather than passed
  through, `javascript:` and `data:` URLs are rejected, and every path is checked
  three ways (syntactically, after `path.resolve`, and after `fs.realpath`) so a
  symlink pointing out of the folder returns 403.
- One broken project cannot fail a scan.
- Ground Control is read-only over your projects except where you ask otherwise:
  saving a generated artifact and moving a folder to Trash are both explicitly
  confirmed, and a **Comms chat is a full agent** that edits files and runs
  commands in the one project you opened it on. Everything else, scanning,
  Forge, Reclaim's scoring, the Workbench, only reads. Adding and removing
  watched folders writes only to `~/.ground-control/sources.json`, and chats
  are indexed in `~/.ground-control/comms.json`.

## API

`GET /api/projects` · `GET /api/project/:id` · `GET /api/doc` · `GET /api/raw` ·
`GET /api/stream` · `GET/POST /api/forge/*` · `GET /api/editors` ·
`POST /api/open` · `GET /api/agents[/:id]` · `GET /api/reclaim[/:id]` ·
`POST /api/reclaim/:id/trash` · `GET/POST/DELETE /api/comms/*` ·
`GET/POST /api/sources` ·
`DELETE /api/sources/:id` · `POST /api/sources/{inspect,locate,reorder}` ·
`GET /api/browse` · `POST /api/pick-folder`

Shapes are documented in the `CONTRACT*.md` files.
