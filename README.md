# Ground Control

A live dashboard over a folder full of half-finished projects — and a place to
work from, not just look at.

Point it at a directory of repos and it tells you what state everything is in,
which projects have coding agents running in them right now, and puts each
project's onboarding document one click away. It can write that document when
one doesn't exist, open any project in your editor, and help you clear out the
folders that turned out to be nothing.

## Run it as an app

```bash
./build-app.sh --install          # builds GroundControl.app into ~/Applications
```

Then launch it from Launchpad, Spotlight, or the Dock. It is a native macOS
application — its own icon, window, and menu bar — wrapping the dashboard in a
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
./bin/ground-control                      # watch ~/coding_projects, open a browser
./bin/ground-control ~/other/projects     # watch a different folder
./bin/ground-control --port 8080          # different port
./bin/ground-control --no-open            # don't launch a browser
```

Default root is `~/coding_projects`, default port `7377`.

**No dependencies.** Node standard library and vanilla browser JS — no npm
install, no build step, no CDN. `node server.js` is the whole thing.

---

## The grid

One card per project: a status dot, why it has that status ("27 commits this
week", "last commit 2 years ago"), what it's built in, an opening line pulled
from the project's own documentation, and counts of docs, TODOs, and uncommitted
files. Filter by text, status, stack, or agent activity; sort four ways. Filter
state lives in the URL, so a reload keeps your view.

Status comes from real activity — the last commit for a clean repo, the newest
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
dirty. The reader renders markdown properly — headings, tables, nested lists,
syntax-highlighted code — with a table of contents. Projects whose explainer is
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

## Forge — writing the document

When a project has no good explainer, Forge builds one: a single self-contained
HTML artifact, theme-aware, with the project's composition bar, commit heatmap,
entry points, and run commands rendered from real data.

Two tiers. **Data-only** needs no model at all and always works offline.
**Authored** shells out to the authenticated `claude` CLI with *read-only* access
to the repo (Read/Glob/Grep — never Write, Edit, or Bash), so what it writes is
grounded in code it actually read.

Authored generation runs on your **Claude subscription** via the CLI's existing
login. There is no API key anywhere in this feature, and the subprocess
environment has `ANTHROPIC_API_KEY` deliberately stripped so a key in your shell
can't silently move generation onto metered billing. The cost figure shown is a
list-price equivalent, not a charge.

Generated artifacts go to a `.forge/` staging area. **Saving into a project is a
separate, explicitly confirmed action**, and it refuses to overwrite an existing
file without a second confirmation.

## Workbench — open, hop, and watch

Every project has an **Open** control — VS Code, Cursor, Xcode (Swift projects
only), Finder, or Terminal. From the reader, "open in editor" jumps to that file
and line. `Cmd+K` opens a fuzzy switcher for hopping between projects; `Cmd+Enter`
opens the highlighted one in your editor.

Ground Control also shows which projects have **coding agents running in them right
now** — a live pulse on the card, what the agent is currently doing, and a
timeline of recent activity on the project page, read from Claude Code's own
session transcripts. It **observes only**: it never signals or kills an agent,
never writes anything under `~/.claude`, and surfaces short status labels rather
than your conversations.

## Reclaim — clearing out the dead ones

Flags folders that never really started or were long abandoned, scored on
*meaningful* content — the ignore list is applied first, so a 341 MB folder that
is 99% virtualenv is correctly seen as five real files.

**Nothing is ever permanently deleted.** Removal moves the folder to the macOS
Trash, so anything can be dragged back out. There is no `rm -rf` in this codebase
and no permanent-delete option.

Removal is refused outright — not warned about — when a folder has uncommitted
changes, unpushed commits, commits but no remote at all (the folder is the only
copy), stashed work, unmerged branches, more than 40 meaningful files or 20 MB,
activity in the last 30 days, a coding agent currently running in it, or if it is
Ground Control itself. Confirming requires typing the project name; there is no bulk
delete and no keyboard shortcut. Every removal is logged to
`.forge/reclaim-log.jsonl` before the move.

## Tests

```bash
npm test          # 39 tests, ~2.7s, no dependencies
```

Node's built-in runner — no framework, nothing to install. The suite is
weighted toward the things that would be expensive to get wrong rather than
toward coverage percentage:

- **Reclaim's blockers**, since it is the only destructive feature. Uncommitted
  changes, unpushed commits, a repo with no remote at all, substantial content,
  recent activity, and a running agent each get a fixture proving removal is
  refused.
- **Path traversal** on every file-reading route, asserting both the refusal and
  that `/etc/passwd` never appears in a response body.
- **Secret redaction** — a fixture repo containing a `.env`, a `creds.py` and a
  `.pem` is briefed, and the test fails if the secret value appears anywhere in
  the brief. The brief is handed to a model, so this one matters.
- **Regressions from real bugs**: a root README losing to a nested `CLAUDE.md`;
  `#StockPortfolio` with no space leaking in as a blurb; virtualenv bulk counting
  as meaningful content; and a live agent process being reported as *working*
  when its transcript had not been written in 23 hours.

Every fixture is built in the OS temp directory. `test/helpers.js` refuses to
return a root outside `tmp`, so no test can point at real projects.

## Layout

```
server.js               HTTP, static files, SSE, path-traversal defense
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
lib/reclaim.js          candidate scoring, safety blockers, trash
public/js/app.js        routing, grid, detail, reader, all four features' UI
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
  three ways — syntactically, after `path.resolve`, and after `fs.realpath` — so a
  symlink pointing out of the folder returns 403.
- One broken project cannot fail a scan.
- Ground Control is read-only over your projects except for two explicitly confirmed
  actions: saving a generated artifact, and moving a folder to Trash.

## API

`GET /api/projects` · `GET /api/project/:id` · `GET /api/doc` · `GET /api/raw` ·
`GET /api/stream` · `GET/POST /api/forge/*` · `GET /api/editors` ·
`POST /api/open` · `GET /api/agents[/:id]` · `GET /api/reclaim[/:id]` ·
`POST /api/reclaim/:id/trash`

Shapes are documented in the `CONTRACT*.md` files.
