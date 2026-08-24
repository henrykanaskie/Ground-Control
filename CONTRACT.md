# Ground Control: Build Contract

A local, zero-dependency dashboard over the folders of projects you point it at.
First run, with nothing configured, starts on `~/coding_projects`.

> **Superseded in part by `CONTRACT-SOURCES.md`.** Ground Control watches a *list*
> of folders now, not one root. Everything below still describes the shape of the
> API and the UI; wherever it says "the scanned root", read "the folder this
> project was scanned from". The additions are `sourceId` / `sourceKind` /
> `sourcePath` / `sourceLabel` on `ProjectSummary`, a `sources` array on
> `GET /api/projects`, and the `/api/sources`, `/api/browse` and
> `/api/pick-folder` routes.

**Hard rules for every agent**
- Node.js stdlib ONLY. No npm installs, no `package.json` dependencies, no CDN
  links, no external fonts. The whole thing must run offline with `node server.js`.
- Vanilla JS on the frontend. No frameworks, no build step. ES modules via
  `<script type="module">` are fine.
- Only create/modify the files you own (listed below). Never touch another
  agent's files. If you need something from another file, code against the
  contract here and assume it exists.
- Target Node 25 / modern Chrome+Safari.

---

## 1. File ownership

| Owner | Files |
|---|---|
| Agent A (backend) | `server.js`, `lib/scan.js`, `lib/git.js`, `lib/docs.js`, `lib/util.js` |
| Agent B (frontend) | `public/index.html`, `public/css/app.css`, `public/js/app.js` |
| Agent C (markdown) | `public/js/markdown.js`, `public/css/doc.css` |

Integration (package.json, bin/ground-control, README) is handled by the lead, do not create those.

---

## 2. HTTP API (Agent A implements; B/C consume)

All JSON responses are `application/json; charset=utf-8`.
Errors: HTTP status + `{ "error": "message" }`.

### `GET /` → `public/index.html`
Static files served from `public/` (`.html .css .js .svg .png .jpg .gif .webp .ico`)
with correct MIME types. Path traversal outside `public/` must be rejected.

### `GET /api/projects`
```jsonc
{
  "root": "/Users/you/coding_projects",   // the first root-kind source
  "sources": [ /* SourceInfo, see CONTRACT-SOURCES.md §3 */ ],
  "scannedAt": "2026-08-19T15:00:00.000Z",
  "durationMs": 412,
  "projects": [ /* ProjectSummary, sorted by lastActivityISO desc, nulls last */ ]
}
```

#### ProjectSummary
```jsonc
{
  "id": "anim-agent",           // url-safe slug, unique, stable across scans
  "name": "animAgent",          // directory name, displayed verbatim
  "path": "/abs/path",
  "status": "active",           // one of: active | recent | idle | dormant | empty
  "statusReason": "3 commits this week",   // short human phrase, <= 40 chars
  "isGit": true,
  "git": {                      // null when isGit === false
    "branch": "main",
    "lastCommitISO": "2026-08-14T10:00:00.000Z",
    "lastCommitSubject": "test(fixtures): capture a real session",
    "lastCommitAuthor": "Henry",
    "commitCount": 47,
    "commitsLast30d": 12,
    "dirty": true,
    "dirtyCount": 3,            // changed files in working tree
    "remote": "git@github.com:user/repo.git",  // or null
    "ahead": 2, "behind": 0     // vs upstream; 0/0 when no upstream
  },
  "lastActivityISO": "2026-08-14T10:00:00.000Z",  // max(last commit, newest tracked file mtime); null if empty
  "lastActivityRelative": "5 days ago",
  "stack": ["Swift", "Markdown"],        // detected tech, display order = confidence
  "primaryLanguage": "Swift",            // or null
  "langBreakdown": [ { "lang": "Swift", "bytes": 91234, "pct": 61.2 } ],  // top 6, pct sums <= 100
  "fileCount": 214,
  "dirCount": 31,
  "sizeBytes": 8123456,
  "docs": [ /* DocRef */ ],
  "featuredDoc": { /* DocRef or null */ },
  "blurb": "A personal tool that stores a structured record of...",  // <= 240 chars, plain text, no markdown syntax
  "todoCount": 12,
  "hasTests": true,
  "readmeBadgeCount": 0,
  // Which watched folder this came from (CONTRACT-SOURCES.md §2)
  "sourceId": "coding-projects",
  "sourceKind": "root",            // root | project
  "sourcePath": "/Users/you/coding_projects",
  "sourceLabel": "coding_projects"
}
```

#### DocRef
```jsonc
{
  "path": "docs/ONBOARDING.md",   // relative to project root, POSIX separators
  "title": "Onboarding: GrowthApp", // first H1 if markdown, else <title>, else filename
  "kind": "onboarding",           // onboarding | readme | claude | design | doc | html | notebook
  "contentType": "markdown",      // markdown | html | text
  "sizeBytes": 18422,
  "mtimeISO": "2026-08-14T10:00:00.000Z",
  "wordCount": 3200
}
```

**Status rules** (`lastActivityISO` age):
- `empty`: directory has no files at all (or only dotfiles)
- `active`: activity within 7 days
- `recent`: 7–30 days
- `idle`: 30–120 days
- `dormant`: older than 120 days

**Doc discovery & `kind`** (case-insensitive filename match, search project root + `docs/` + `doc/` + `.github/`, max depth 2, skipping `node_modules .git dist build .venv *venv __pycache__ .next target Pods .pytest_cache`):
- `ONBOARDING*.md`, `GETTING_STARTED*.md`, `ONBOARD*.md` → `onboarding`
- `README*.md` → `readme`
- `CLAUDE.md`, `AGENTS.md` → `claude`
- `DESIGN*.md`, `ARCHITECTURE*.md`, `ADR-*.md`, `SPEC*.md` → `design`
- any other `*.md` → `doc`
- `*.html` at depth <= 2 → `html` (these are the "aesthetic artifact" pages)
- `*.ipynb` → `notebook`

**`featuredDoc` precedence:** `onboarding` > `claude` > `readme` > largest `design` > largest `doc`.
Prefer richer docs: if two candidates tie on kind, pick the larger `wordCount`.

**`blurb`:** from `featuredDoc`: first paragraph that is not a heading, badge,
blockquote, HTML comment, or code fence. Strip markdown syntax (links → their
text, `**bold**` → bold, backticks removed). Collapse whitespace. Truncate on a
word boundary at 240 chars with `…`.

### `GET /api/project/:id`
`ProjectSummary` plus:
```jsonc
{
  "recentCommits": [ { "sha": "a1b2c3d", "dateISO": "...", "relative": "5 days ago", "subject": "...", "author": "Henry" } ],  // up to 15
  "tree": [ { "path": "src/main.py", "type": "file", "sizeBytes": 1234, "depth": 1 } ],  // up to 300 entries, depth <= 3, same ignore list, dirs before files, alphabetical
  "dirtyFiles": [ { "path": "lib/x.js", "state": "M" } ],  // up to 40, [] when clean
  "activity": [ { "date": "2026-08-14", "count": 3 } ]      // commits/day, last 90 days, ascending; [] for non-git
}
```
404 `{ "error": "unknown project" }` for a bad id.

### `GET /api/doc?id=<projectId>&path=<relPath>`
```jsonc
{ "project": "animAgent", "path": "docs/ONBOARDING.md", "title": "...",
  "kind": "onboarding", "contentType": "markdown", "content": "<raw file text>",
  "sizeBytes": 18422, "mtimeISO": "..." }
```
- `path` MUST be resolved and verified to stay inside the project directory
  (reject `..`, absolute paths, and symlinks escaping the root) → 403.
- Files over 2 MB → 413 `{ "error": "file too large" }`.

### `GET /api/raw?id=<projectId>&path=<relPath>`
Serves raw file bytes with a correct MIME type, used to load a project's HTML
artifact into an iframe and to resolve images referenced by markdown. Same path
guards as `/api/doc`. Set `X-Content-Type-Options: nosniff`.

### `GET /api/stream`: Server-Sent Events
- On connect, immediately send `event: hello` / `data: {"ok":true}`.
- Watch every watched folder (`fs.watch`, non-recursive on the folder + one level
  down is enough) and each project's `.git/HEAD` + `.git/refs`. On any change, debounce
  **800 ms**, re-scan, then emit:
  `event: projects` / `data: <the full GET /api/projects payload>`
- Send `event: ping` / `data: {}` every 25 s so proxies/browsers hold the connection.
- Clean up watchers on client disconnect. Never let a watcher error crash the server.

### Server behavior
- `node server.js [--root <dir>] [--port <n>] [--config <file>] [--open]`
  Defaults: port `7377`; sources from `~/.ground-control/sources.json`, seeded
  with `~/coding_projects` on a first run. `--root` names the folder shown first
  and, on a run where the config already exists, applies to that run only.
  `--config` (or `GROUND_CONTROL_CONFIG`) points the source list elsewhere,
  the test suite uses it so no test can read the developer's own list.
  `--open` launches the default browser (macOS `open`).
- Cache the scan in memory; serve `/api/projects` from cache when it is < 5 s old.
  `?fresh=1` forces a rescan.
- One slow/broken project must never fail the whole scan: wrap per-project work
  in try/catch and return that project with whatever data succeeded.
- Git work uses `child_process.execFile` with an explicit timeout (5 s), never
  `exec` with an interpolated shell string.
- Log a single startup line: `Ground Control watching <where> → http://localhost:<port>`

---

## 3. Shared design tokens (Agents B and C both use these)

Agent B defines them in `public/css/app.css` on `:root`. Agent C **only consumes**
them in `doc.css` and must not redefine them.

```css
:root{
  --bg:#0a0b0d; --bg-2:#101216; --panel:#15181d; --panel-2:#1b1f26;
  --line:#252a32; --line-2:#333a45;
  --text:#e8e5df; --text-2:#a2a8b3; --text-3:#6b7280;
  --ember:#f59e0b; --ember-2:#d97706; --ember-glow:rgba(245,158,11,.18);
  --active:#4ade80; --recent:#facc15; --idle:#fb923c; --dormant:#6b7280; --empty:#3f434b;
  --radius:12px; --radius-sm:8px;
  --mono:ui-monospace,"SF Mono",Menlo,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;
}
```
Dark theme is the only theme. Aesthetic: obsidian panels, thin lines, one warm
ember accent used sparingly, generous whitespace, no drop shadows heavier than
`0 1px 2px rgba(0,0,0,.4)`. Motion: 120–200 ms ease-out, and everything inside
`@media (prefers-reduced-motion: reduce)` collapses to no transition.

---

## 4. Frontend module contract

`public/js/markdown.js` (Agent C) is an ES module with these named exports:

```js
export function render(markdown, opts = {}) -> string   // trusted-safe HTML
export function headings(markdown) -> Array<{ level:number, text:string, id:string }>
export function plainText(markdown, maxChars) -> string
```

`opts`: `{ rawBase: "/api/raw?id=foo&path=", docBase: "/api/doc?id=foo&path=", basePath: "docs/" }`
- Relative image `src` and link `href` are rewritten against `rawBase` + resolved
  relative path. Links to `.md` files instead get `docBase` and the attribute
  `data-doc="<resolved rel path>"` so Agent B can intercept the click for in-app
  navigation. Anchor links (`#foo`) and absolute URLs (`http(s)://`, `mailto:`)
  pass through untouched; external links get `target="_blank" rel="noreferrer"`.
- Headings get stable slug `id`s (lowercase, non-alphanumerics → `-`, deduped
  with `-2`, `-3`). `headings()` must return the identical ids.
- **HTML in the source must be escaped, not passed through**, this renders
  files from disk, so treat all input as untrusted. Escape `< > &` in text; never
  emit a raw `<script>`, `<iframe>`, `on*=` attribute, or `javascript:` URL.

Required markdown support: ATX headings, paragraphs, bold/italic/strikethrough,
inline code, fenced code blocks with a language class (`<pre><code class="language-py">`),
indented code, ordered/unordered/nested lists, task lists (`- [x]`), blockquotes,
horizontal rules, tables (GFM, with alignment), links, images, autolinks,
reference links, footnotes optional, and HTML comments stripped.

Agent B calls it as:
```js
import { render, headings } from './markdown.js';
docEl.innerHTML = render(res.content, { rawBase, docBase, basePath });
```

`doc.css` (Agent C) styles only elements **inside** `.ground-control-doc`: headings,
paragraphs, lists, tables, `pre/code`, blockquotes, images, hr, task lists,
plus a `.ground-control-doc-toc` list. Include lightweight token colors for fenced code
(keywords/strings/comments/numbers) applied via classes Agent C's renderer emits.
Long code blocks and wide tables scroll inside their own container, the page
must never scroll horizontally.

---

## 5. Frontend UX (Agent B)

Single page, no router library; state in the URL hash.
- `#/`: the grid of all projects.
- `#/p/<id>`: project detail.
- `#/p/<id>/doc/<encoded rel path>`: a document open in the reader.
Back/forward and a hard refresh on any of those must restore the same view.

**Header:** the name "GROUND_CONTROL", the watched-folder control (CONTRACT-SOURCES.md §5),
project + status counts,
a live-connection dot (green when SSE is open, dim when reconnecting), and a
"rescan" button hitting `/api/projects?fresh=1`.

**Controls:** text filter (matches name, stack, blurb, debounced 120 ms),
status filter chips, stack filter, a folder filter once more than one folder is
watched, and a sort select (last activity / name / size / commits). Filter state
lives in the URL query so it survives reload.

**Grid:** responsive card grid, `minmax(300px, 1fr)`. Each card shows the project
name, a status dot + `statusReason`, relative last activity, stack chips,
the blurb, a doc-count/TODO/dirty indicator row, and (when `featuredDoc` exists)
a prominent "Onboarding" affordance. Empty projects render visibly muted.
Cards are keyboard reachable (`tabindex`, Enter opens) and are real links.

**Detail view:** header with name/status/git summary, a 90-day commit heatmap
strip from `activity`, the doc list grouped by kind (onboarding first), the file
tree, recent commits, and dirty files. Clicking a doc opens the reader.

**Reader:** rendered markdown in a centered column (max ~72ch) with a sticky
right-hand TOC from `headings()`, the doc title, a back control, and a link to
the raw file. `kind === "html"` docs open in a sandboxed iframe
(`sandbox="allow-same-origin"`) pointed at `/api/raw`, with a note that it is a
project artifact. Notebooks may fall back to a "raw" JSON view.

**Live updates:** subscribe to `/api/stream`; on a `projects` event, diff against
current state and update in place without losing scroll or filter state. Briefly
pulse the ember accent on cards whose `lastActivityISO` or `status` changed, and
animate additions/removals. Reconnect with backoff (1s → 2s → 5s, cap 15s) if the
stream drops.

**States:** skeleton cards while first loading, a clear empty state when filters
match nothing, and a non-fatal error banner if the API is unreachable
(keep retrying, do not blank the page).

Accessibility: real semantic elements, visible `:focus-visible` ring in ember,
`aria-live="polite"` on the live-update announcement, contrast >= 4.5:1 for text.
