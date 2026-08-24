# Ground Control Forge - Artifact Generation Contract

Ground Control can already *find* a project's onboarding document. Forge **creates** one:
a single-file, self-contained HTML artifact (a genuine resource, not a markdown
dump) grounded in what the repository actually contains.

Read `CONTRACT.md` first; this extends it. All its hard rules still apply
(Node stdlib only, vanilla browser JS, no npm, no CDN, no build step).

---

## 0. How generation works

The user has no `ANTHROPIC_API_KEY`, but the authenticated **`claude` CLI**
(v2.1.235) is on PATH. Generation shells out to it in headless mode, so it uses
the user's existing auth and adds no dependency. It is spawned with read-only
tool access scoped to the project, so the artifact can be verified against real
code rather than hallucinated from a summary.

Generation has two axes: **tier** (how the document is produced) and **kind**
(which document it is). They are orthogonal, with exactly one exception, stated
below.

Two tiers, and **for the onboarding kind the deterministic tier always exists**:

| Tier | Needs | Produces |
|---|---|---|
| `template` | nothing | A real artifact built purely from repo facts: composition, commit timeline, doc index, entry points, file map, stats. Always available, works offline. |
| `authored` | `claude` on PATH | The full thing: a written explanation of what the project is, how it works, where to start, and what will bite you, with the deterministic visuals embedded. |

(`CONTRACT-LOCAL.md` adds a third tier, `local`, on the same axis.)

Three kinds:

| Kind | Tiers | Produces |
|---|---|---|
| `onboarding` (default) | any tier | The document above: what this project is, how to run it, where to start, what will bite you. For a developer who has to **operate** the codebase. |
| `design` | `authored` only | A design-rationale document: why the codebase is built the way it is, the decisions, the forces behind them, the alternatives rejected, what each one costs. For a developer who wants to **learn** from the codebase. |
| `code` | `authored` only | A code breakdown: the syntax, idioms, libraries and services this project actually uses. For a developer who wants to **read** this code fluently and write code that fits in. Saves as `CODE.html`. |

**Hard rule: every kind except `onboarding` requires the `authored` tier.**
This is a deliberate exception to the guarantee stated above.
`POST /api/forge/generate` with `kind:"design"` or `kind:"code"` and either
`tier:"template"` or `tier:"local"` returns `400`. The reason is one principle,
and it applies twice:

- The `template` tier involves no model at all, and rationale cannot be derived
  from repository facts: no amount of file-walking tells you *why* a timeout is
  800ms.
- The `local` tier (`CONTRACT-LOCAL.md`) generates from the brief alone with no
  repository tool access, and emits a fixed onboarding-shaped JSON schema
  (`one_paragraph`, `core_idea`, `how_it_works`, `current_state`, `gotchas`,
  `unknowns`, `start_here`) that `lib/artifact-template.js` renders. It is the
  wrong shape and it is blind.

Both fail the same requirement: **a rationale document must be able to check its
claims against the actual code**, because its defining failure mode is inventing
a plausible motive, and an invented motive is unfalsifiable (§7b). Only the
`authored` tier has read-only `Read`/`Glob`/`Grep` access to the repository, so
only it can meet that bar.

If `claude` is missing or generation fails, the **onboarding** kind falls back to
`template` and says so plainly. The **design** kind has **no fallback tier of any
kind**: it cannot run at all, and it fails honestly rather than substituting a
document it did not promise. Neither kind ever reports success for a failed
generation.

---

## 0b. Billing - this runs on the user's Claude subscription

Verified on this machine: `ANTHROPIC_API_KEY` is **unset**, the `claude` CLI is
authenticated via its OAuth account, and the rate-limit tier is
`default_claude_max_5x`: a **Claude Max subscription**. Headless `claude -p`
therefore draws on that subscription. There is no metered API key anywhere in
this feature, and none must be introduced.

Requirements that follow:

1. **Never require, prompt for, read, or set `ANTHROPIC_API_KEY`.**
2. **Actively strip it from the child environment.** Build the subprocess env as
   a copy of `process.env` with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and
   `ANTHROPIC_BASE_URL` **deleted**. A key set in the parent shell would shadow
   the OAuth profile and silently move generation onto metered billing: that is
   exactly the failure this deletion prevents. Comment it as such.
3. **Never pass `--bare`**: it forces API-key auth and would break generation
   outright for this user.
4. **Do not present `total_cost_usd` as money charged.** The CLI reports a
   list-price equivalent; on a subscription nothing is billed per run. Surface it
   as usage, worded plainly, e.g. *"~$0.42 of list-price usage; counts toward
   your Claude subscription, not billed separately."* Never render it as a charge,
   an invoice, or a running total of money spent.
5. **Handle subscription limits as a first-class outcome.** If the CLI exits with
   a usage/rate-limit condition (non-zero exit, or a `result` event with
   `is_error` and a message mentioning limit/quota/usage), the job fails with a
   clear, non-alarming message: *"Claude usage limit reached; this resets on a
   rolling window. The data-only artifact is still available."*, and the UI
   offers the `template` tier. Do not retry automatically in a loop.

---

## 1. File ownership

| Owner | Files |
|---|---|
| Agent D (generation backend) | `lib/brief.js`, `lib/generate.js`, `lib/jobs.js`, plus the Forge routes inside `server.js` |
| Agent E (generation UI) | Forge additions to `public/js/app.js`, `public/css/app.css`, `public/index.html` |
| Agent F (art direction) | `lib/house-style.js`, `lib/artifact-template.js`, `lib/artifact-parts.js` |

Nobody else edits `lib/scan.js`, `lib/git.js`, `lib/docs.js`, `lib/util.js`,
`public/js/markdown.js`, `public/css/doc.css`, `README.md`, or either CONTRACT.
Agents D and E both touch `server.js` / `app.js` only in their own areas:
**append new code, never restructure existing code.**

---

## 2. Safety rules (non-negotiable)

Ground Control has been read-only until now. Forge changes that, so:

1. **Generation never writes into the user's project.** Output goes to a staging
   directory: `<ground-control>/.forge/<projectId>/<jobId>.html`.
2. **Saving into a project is a separate, explicit user action** (`POST …/save`),
   and the UI must confirm before calling it.
3. **Never overwrite silently.** If the destination exists, `save` returns
   `409` with the existing file's size and mtime unless `overwrite: true` was
   passed. The UI must surface that and require a second confirmation.
4. **Destination is validated** with the same three gates as `/api/doc`
   (syntactic, post-`path.resolve`, post-`fs.realpath`) and must land inside the
   project. Only `.html` destinations are allowed. Reject anything else with 403.
5. **The subprocess gets read-only tools.** Allow `Read`, `Glob`, `Grep` only,
   never `Write`, `Edit`, or `Bash`. The artifact HTML comes back over stdout;
   Ground Control writes the file, not the model.
6. **Nothing is deleted, ever.** Staging files are pruned only by age
   (7 days) and only from `.forge/`.
7. `.forge/` goes in `.gitignore`.

---

## 3. The repo brief - `lib/brief.js` (Agent D)

```js
export async function buildBrief(project, opts) -> Brief   // opts.kind: "onboarding" (default) | "design"
export function briefToMarkdown(brief) -> string           // compact; <= ~40KB onboarding, <= ~90KB design
```

`project` is the `ProjectSummary` from `lib/scan.js` (plus `path`). The brief is
gathered deterministically (no model involved) and must include:

- **Identity**: name, path, status, last activity, git remote/branch.
- **Composition**: language byte breakdown, file/dir counts, size.
- **Manifests, parsed**: `package.json` (name, description, scripts, deps,
  bin, type), `pyproject.toml` / `requirements.txt`, `Package.swift`,
  `Cargo.toml`, `go.mod`, `Gemfile`, `*.xcodeproj`, `Makefile` targets,
  `Dockerfile`. Parse what's cheap; fall back to raw head otherwise.
- **How to run it**: every runnable command found: npm scripts, Makefile
  targets, `if __name__ == "__main__"` entry files, `main.swift`, `bin/*`.
- **Entry points**: the most likely "start reading here" files, ranked
  (manifest `main`/`bin`, `index.*`, `main.*`, `app.*`, `cli.*`, `server.*`,
  largest source file in the shallowest source dir).
- **Structure**: directory tree to depth 3, with a per-directory file count and
  dominant extension, so the shape is legible without listing 19,681 files.
- **Existing prose**: full text of the featured doc plus `README`/`CLAUDE.md`
  (each capped at 24KB, noted when truncated). This is the single most valuable
  input: the author must build on what the user already wrote, not ignore it.
- **History**: commit count, first/last commit dates, up to 40 recent subjects,
  the 90-day activity array, and top-5 most-changed files (`git log --name-only`,
  bounded).
- **Signals**: TODO/FIXME count with up to 15 samples (`file:line - text`),
  test layout, dirty files, config/env files present (names only: **never read
  `.env`, `creds*`, `*secret*`, `*key*`, `*.pem`; list the filename and stop**).

### 3b. The `design` block (`opts.kind === "design"`)

When `opts.kind` is `"design"` the Brief gains a `design` block. It gathers the
repository's **own recorded reasoning**: every entry is something a human in
this repository actually wrote. Nothing in it is inferred, and no model is
involved in producing it.

- **`rationale[]`**: explanatory comment blocks, each paired with the
  declaration it sits above: `{path, line, text, subject}`, where `subject` is
  that declaration. Harvested **inside the existing text scan**, so it costs no
  extra I/O.
- **`constants[]`**: named SCREAMING_SNAKE constants with literal values:
  `{path, line, name, value, documented}`. `documented` records whether a comment
  explains the value. **Undocumented constants are reported as a finding**: a
  magic number nobody explained is a decision whose reason was lost, and that is
  exactly what the design document exists to surface.
- **`designDocs[]`**: ADR / RFC / CONTRACT / DESIGN / ARCHITECTURE documents,
  **read in full** (capped). `collectProse` deliberately does not reach these;
  the design kind does, because this is where reasoning gets written down.
- **`commitRationale[]`**: commit messages that have a **body**. A subject says
  what changed; a body is where an author records why. Costs one extra `git log`.
- **`coverage`**: how many candidate files were actually opened, so silence can
  be told apart from "not scanned". Absence of evidence must itself be
  reportable.

**The extra cost is paid only when `kind === "design"`.** Reading design docs in
full and the second `git log` do not run for an onboarding brief.

`briefToMarkdown` renders this as clean markdown for the prompt. Budget it:
if it would exceed ~40KB, drop the lowest-value sections first (commit subjects,
then TODO samples, then tree depth) and note what was dropped.

A **design** brief renders under a larger budget (**~90KB**) and sheds in a
different order: the onboarding-shaped sections go first (directory tree, file
inventory, TODO samples), the author's own reasoning last. Note what was
dropped, as always.

---

### 3c. The `code` block (`opts.kind === "code"`)

An **index of coordinates, not a copy of the code**: the authoring model has
Read/Glob/Grep, so the useful thing to hand it is precise locations to open.

- `imports[]`: external libraries actually imported (`{name, count, sites[]}`),
  collapsed to bare package roots, sorted by frequency. Usage is a different
  fact from a manifest declaration.
- `localImports[]`: first-party modules by import count. Distinguishing these
  matters: `from src.contract import ...` looks exactly like a third-party
  package until you notice `src/` is a directory in the repository.
- `constructs[]`: teachable language constructs with a file:line for each
  (`{label, count, sites[]}`). One file is a curiosity; thirty is house style.
- `declaredNotImported[]` / `importedNotDeclared[]`: the gap between manifest
  and reality, reported rather than smoothed over.
- `hosts[]`: external services, **hostname only**. Paths and query strings are
  never collected, because that is where credentials hide.
- `envVars[]`: environment variable **names only**; no value is ever read.
- `coverage`: files opened vs available, so absence is distinguishable from
  "not scanned".

Harvested inside the existing text scan (a regex sweep, no extra I/O) and only
assembled when `kind === "code"`. Renders under a 60KB budget, shedding prose
and tree depth before the import and construct tables, which are the document's
whole subject.

---

## 4. The generator - `lib/generate.js` (Agent D)

```js
export function claudeAvailable() -> {available: bool, version: string|null, path: string|null}
export function startGeneration(opts) -> Job      // returns immediately
```

`opts`: `{ project, brief, kind, tier, model, audience, jobId, stagingPath }`.
`kind` defaults to `"onboarding"` and selects the prompt builder: `authoringPrompt`
(§7) for onboarding, `designPrompt` (§7b) for design. Everything else about the
spawn is identical: same argv, same read-only tools, same validation.

**Spawn contract**: `child_process.spawn`, argv array, never a shell string:

```
claude -p
  --model <model>                     default "claude-opus-5"
  --output-format stream-json --verbose
  --add-dir <project.path>
  --allowedTools Read Glob Grep
  --permission-mode acceptEdits
  --append-system-prompt <house style spec from lib/house-style.js>
```

The prompt (stdin or argv) is the authoring instruction plus the brief.
- `cwd` is the **project directory**, so relative reads resolve naturally.
- Do **not** pass `--bare`: it forces API-key auth and this user has none.
- Env: pass through `process.env`; never inject secrets.
- **Timeout 20 minutes**, then SIGTERM, then SIGKILL after 10s. A timed-out job
  reports `failed` with a clear reason: never a partial file presented as done.
- Parse `stream-json` line-delimited events; surface a readable progress line per
  event (`reading src/main.py`, `writing…`). Malformed lines are skipped, never
  fatal. The final `result` event carries `result`, `total_cost_usd`,
  `duration_ms`, `is_error`: record all of them.
- `stderr` is captured for diagnostics but is not failure on its own (hook
  warnings appear there routinely).

**Output handling.** The model returns the artifact on stdout. Before staging:
1. Strip a wrapping ```html fence if present.
2. Trim anything before the first `<` and after the last `>`.
3. Validate: non-empty, ≥ 2KB, contains `<title>` and `<style>`, and has no
   `<script src=`, no `http://`/`https://` in `src`/`href` on `link`/`script`/
   `img` (self-contained rule), and no obviously unclosed `<style>`.
4. On validation failure → job `failed` with the reason; the raw output is kept
   at `<jobId>.raw.txt` for debugging. **Never stage invalid HTML as success.**

`Job` (also the shape reported by the API):

```jsonc
{
  "id": "job_a1b2c3", "projectId": "r-log", "projectName": "rLog",
  "kind": "onboarding", "tier": "authored", "model": "claude-opus-5",
  "state": "queued|running|done|failed|cancelled",
  "startedISO": "...", "endedISO": null,
  "progress": [ { "atISO": "...", "text": "reading CLAUDE.md" } ],  // capped at 200
  "stagingPath": "/abs/.forge/r-log/job_a1b2c3.html",
  "bytes": 48210,
  "costUsd": 0.42, "durationMs": 91000,
  "error": null,
  "suggestedFilename": "ONBOARDING.html"   // "DESIGN.html" when kind is "design"
}
```

---

## 5. Job registry - `lib/jobs.js` (Agent D)

In-memory map plus an event emitter. `create`, `get`, `list`, `update`,
`appendProgress`, `cancel` (kills the child), `subscribe(jobId, fn)`.
Cap at 50 retained jobs, evicting oldest finished first. One in-flight job per
project: a second request for the same project returns `409` with the running
job's id.

---

## 6. HTTP API (Agent D implements; E consumes)

| Route | Behavior |
|---|---|
| `GET /api/forge/status` | `{ claude: {available, version}, tiers: ["template","authored"], defaultModel, runningJobs: [...] }` |
| `POST /api/forge/generate` | Body `{ id, kind?, tier?, model?, audience? }`: `kind` is one of `onboarding` (default), `design`, `code`;. `kind` is `"onboarding"` (default) or `"design"`. Starts a job, returns the `Job` (202). `404` unknown project; `409` if one is already running for it; **`400` for `kind:"design"` with `tier:"template"` or `tier:"local"`**: the design kind requires the `authored` tier (§0), and the error says so rather than quietly downgrading. |
| `GET /api/forge/job/:jobId` | The `Job`. |
| `GET /api/forge/job/:jobId/stream` | SSE: `progress`, `done`, `failed` events. Same ping/cleanup discipline as `/api/stream`. |
| `GET /api/forge/job/:jobId/preview` | Serves the staged HTML (`text/html`, `nosniff`). 404 until `done`. |
| `POST /api/forge/job/:jobId/cancel` | Kills it; job becomes `cancelled`. |
| `POST /api/forge/job/:jobId/save` | Body `{ filename?, overwrite? }`. Default filename `ONBOARDING.html` for the onboarding kind, `DESIGN.html` for the design kind. Writes into the project per §2. Returns `{ savedTo, bytes }`, or `409 {error:"exists", existing:{sizeBytes,mtimeISO}}`. On success, trigger a rescan so the artifact appears in `docs` immediately. |

`audience` is a free-text hint (≤ 200 chars), e.g. "someone who has never seen
this codebase". Sanitize into the prompt as data, never as instructions.

---

## 7. Art direction - `lib/house-style.js` (Agent F)

```js
export const HOUSE_STYLE       // the art-direction spec, as a string
export function authoringPrompt({ brief, project, audience }) -> string   // kind "onboarding"
export function designPrompt({ brief, project, audience }) -> string      // kind "design", §7b
export const DEFAULT_MODEL = 'claude-opus-5'
```

**The look is drawn from the artifacts this user already writes** (see
`~/coding_projects/ideas/blender-30-days.html`: read it before writing this
file). It is deliberately *not* the Ground Control dashboard's obsidian/ember chrome:
an artifact is a standalone document the user may open on its own or share.

Non-negotiables for the generated artifact:

- **One self-contained `.html` file.** Inline `<style>`. No external anything:
  no CDN, no webfont, no remote image, no analytics, no `<script src>`. Small
  inline JS only if it genuinely earns its place (a collapsible section);
  the page must be fully readable with JS off.
- **Theme-aware.** Full light palette as tokens on bare `:root`; redefine only
  the changed tokens under `@media (prefers-color-scheme: dark)`. `body` gets an
  explicit token background. No color defined solely inside a media query.
- **Typography**: a serif display face for headings (Georgia / 'Iowan Old Style'
  stack), system sans for body, mono for eyebrows, labels, paths, and code.
  Uppercase letterspaced mono eyebrows above sections. Reading measure ~72ch.
- **Restraint**: one accent color used sparingly, hairline rules, generous
  whitespace, shadows no heavier than `0 1px 2px rgba(0,0,0,.06)`. No gradient
  soup, no neon, no emoji as UI chrome.
- **Responsive**: relative units, `img {max-width:100%}`, wide code and tables
  scroll inside their own `overflow-x:auto` container. The page body must never
  scroll horizontally.
- Honor `@media (prefers-reduced-motion: reduce)` and `@media print`.

The **authoring prompt** must demand a real document, and must be explicit that
accuracy outranks polish:

- Ground every claim in the brief or in files actually read. **If something is
  unknown, say so**: an honest "this isn't documented anywhere; here's what the
  code implies" is worth more than a confident invention. Never invent a command,
  a file path, a dependency, or an architectural claim.
- Build on the project's existing prose rather than restating it.
- Required substance, adapted to what the project actually is: what this is in
  one paragraph and who it's for; why it exists / the core idea; how to run it
  (only commands evidenced in the repo); how it's put together, with real file
  paths; the data or domain model where there is one; what state it's in right
  now, honestly, including what's unfinished; gotchas and landmines; and a
  concrete "if you're picking this up again, start here" section.
- An empty or near-empty project gets a short honest stub, not padding.
- Output **only** the HTML: no prose before or after, no markdown fence.

---

## 7b. The design document - `designPrompt` (Agent F)

```js
export function designPrompt({ brief, project, audience }) -> string
```

A sibling to `authoringPrompt`: same file, same art direction (everything in §7
above the authoring prompt applies unchanged), different document. It runs only
on the `authored` tier (§0) and consumes the brief's `design` block (§3b).

The design document answers **why**. The decisions this codebase embodies, the
forces that produced them, the alternatives that were rejected and what rejecting
them cost. Its reader wants to **learn** from this codebase, not operate it, so
how to install it, how to run it, and where the entry points are belong to the
onboarding artifact and are not repeated here.

**Evidence discipline (non-negotiable).** Every rationale in the document is one
of exactly three things, and the document must make clear to the reader which one
it is:

| Class | Rule |
|---|---|
| **Stated** | The repository says why. Quote it and cite it: `path:line`, the commit, the design doc. The quotation *is* the claim; do not smooth a source's words into a motive it did not state. |
| **Inferred** | The repository shows a decision but never explains it. Label the inference **as an inference, in the prose the reader sees** ("the code implies", "nobody wrote this down; the shape suggests") and show the evidence it rests on, so the reader can disagree. |
| **Unknown** | Neither. Say so plainly. *"The 800ms timeout is not explained anywhere in the repository"* is a finding, and a useful one. |

**Inventing a motive is the defining failure mode of this document.** It is worse
than inventing a command. A fabricated command fails the first time someone runs
it; a fabricated reason is **unfalsifiable**: it reads as authoritative, it
survives review, and the next reader repeats it as fact. An honest "undocumented"
beats a plausible story every time. A confident, well-written, invented rationale
is the worst artifact Forge can produce.

Further requirements:

- The `design` block is the author's own words and **outranks anything the model
  reasons out**. Start there; use `Read`/`Glob`/`Grep` to check claims against the
  actual code, which is the entire reason this kind requires the `authored` tier.
- Use `coverage` honestly: "the repository does not say" and "this was not
  scanned" are different statements and must not be conflated.
- Undocumented constants are material, not filler. A magic number with no
  explanation is a decision whose reason was lost; reporting it is the document
  doing its job.
- A project with no recorded reasoning gets a short honest document saying so:
  never a reconstructed narrative.
- Output **only** the HTML: no prose before or after, no markdown fence.

---

## 7c. The code breakdown - `codePrompt` (Agent F)

```js
export function codePrompt({ brief, project, audience }) -> string
```

Sibling to `authoringPrompt` and `designPrompt`; authored tier only. Consumes
the `code` block from §3c.

Onboarding answers "how do I work in this?", the rationale document answers
"why is it built this way?", and this answers "what am I actually looking at?"

**Its defining failure mode is the invented code sample**: not an invented
command, which fails loudly when run, and not an invented motive, which §7b
guards against, but a snippet that *looks* like this codebase and does not
exist in it. It teaches a false fact and survives review. So:

- Every snippet is copied from a file actually opened, labelled with its path.
  Never composed "in the style of" the code, never a cleaned-up version passed
  off as what is there, never an example from a library's own documentation.
- A simplified form is allowed only when declared as such AND shown alongside
  the real one. Elisions are marked.
- Libraries are described by what they do **here** (which functions, which
  options, what is deliberately unused), never by what the package does in
  general. Ordinary usage gets a line; surprising usage gets the space.
- Environment variables appear by **name only**. No value is read or guessed.

A project with few dependencies and no unusual syntax gets a short, accurate
page; "this code is plain and uses no unusual constructs" is a finding.

---

## 8. Deterministic artifact - `lib/artifact-template.js` (Agent F)

```js
export function renderArtifact(brief, opts) -> string   // complete HTML document
```

Same house style, built from facts alone, no model. It is both the `template`
tier and the **onboarding** kind's safety net; there is no design-kind
equivalent, and none is to be built (§0). Include: title and one-line identity; a stat band
(files, size, commits, languages, last activity); a language composition bar; a
90-day commit heatmap; the document index; entry points and run commands; the
directory map; recent commits; TODO samples; and an honest "what we could not
determine automatically" note. Escape every interpolated value: repository
content is untrusted.

`lib/artifact-parts.js` holds the shared HTML/SVG builders (stat band,
composition bar, heatmap, tree, escaping helpers) so both the template and any
future consumer use one implementation. Pure functions, no I/O.

---

## 9. UI (Agent E)

On the project detail view, a **Forge** panel:

- Primary action, labelled for the selected kind: **Create onboarding artifact**
  / **Create design document**. Disabled with an explanation when `claude` is
  unavailable: for onboarding, offer the `template` tier instead, which always
  works for that kind.
- Controls before launching: kind (Onboarding / Design), tier (Authored /
  Data-only), model, and an optional one-line audience hint.
- **Choosing Design restricts the tier control to Authored** and says why, rather
  than letting the user submit a request the server will reject with `400` (§0,
  §6). When `claude` is unavailable, Design is disabled outright with its reason:
  there is no data-only design artifact to offer.
- While running: a live progress log fed by the SSE stream, elapsed time, and a
  **Cancel** control. Reconnect with backoff if the stream drops. Navigating away
  and back must re-attach to the running job, not orphan it.
- On completion: the artifact in a sandboxed iframe (`sandbox="allow-same-origin"`)
  from the preview route, plus **Open in new tab**, **Save to project…**, and
  **Discard**.
- Save flow: filename field (default `ONBOARDING.html`, or `DESIGN.html` for the
  design kind), explicit confirm, and a clear second confirmation if the server
  returns `409 exists`. On success, show where it was written and refresh the
  project so the new doc appears.
- Failures render the reason plainly and offer Retry and Use data-only artifact.
  For a failed **design** job, offer Retry only: data-only is not an option for
  that kind, and must not be presented as one. Never show a spinner with no
  terminal state.

Follow `CONTRACT.md` §3 tokens and §5 conventions; the Forge panel must look
native to the dashboard, not bolted on.
