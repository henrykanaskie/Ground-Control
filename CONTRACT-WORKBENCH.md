# Ground Control Workbench: Open, Hop, and Watch

Two capabilities, one purpose: make the dashboard a place you *work from*, not
just look at. Jump straight into any project in a real editor, and see at a
glance which projects have coding agents running in them right now.

Read `CONTRACT.md` first (its hard rules all still apply: Node stdlib only,
vanilla browser JS, no npm, no CDN, no build step). `CONTRACT-FORGE.md` covers a
separate feature; do not modify Forge code.

---

## 0. Verified environment facts

These were checked on this machine: build against them, but degrade gracefully
if any are missing:

- `code` (VS Code CLI) is at `/usr/local/bin/code`.
- `/Applications/Cursor.app`, `/Applications/Visual Studio Code.app`, and
  `/Applications/Xcode.app` all exist. `open -a <App> <path>` works regardless
  of whether a CLI shim is installed.
- Claude Code writes per-project session transcripts to
  `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`, where the encoding
  replaces `/`, `_`, and `.` with `-`. Confirmed:
  `~/coding_projects/ML_quantitative_research` →
  `-Users-henrykanaskie-coding-projects-ML-quantitative-research`.
- Running agents are attributable to a project: `ps` finds `claude` processes,
  and `lsof -a -p <pid> -d cwd -Fn` yields each one's working directory.
  Confirmed live: 4 agents in `groupStat`, 1 in `rLog`, 1 in `ideas/team_dispatch`.
- Transcripts get large (8.6 MB seen). `tail -c` on them is ~9 ms. **Never read a
  transcript whole**: always read a bounded tail.

---

## 1. File ownership

Everything below is yours:

- `lib/agents.js`  (new): agent activity detection
- `lib/editors.js` (new): editor detection and launching
- `server.js`      (existing): add Workbench routes only; **append, never restructure**
- `public/js/app.js`, `public/css/app.css`, `public/index.html` (existing): add
  the Workbench UI only; append, never restructure

Do not touch: `lib/scan.js`, `lib/git.js`, `lib/docs.js`, `lib/util.js`,
`lib/brief.js`, `lib/generate.js`, `lib/jobs.js`, `lib/house-style.js`,
`lib/artifact-template.js`, `lib/artifact-parts.js`, `public/js/markdown.js`,
`public/css/doc.css`, `README.md`, or any CONTRACT file.

Both Forge and Workbench live in `server.js` and `app.js`. Keep your code in its
own clearly-marked section and leave Forge's alone.

---

## 2. Editors: `lib/editors.js`

```js
export function detectEditors() -> [ Editor ]   // cached ~60s
export function openIn(editorId, absPath, opts) -> {ok, error}
```

`Editor`: `{ id, name, kind: "cli"|"app", available: bool, command, args }`.

Detect and support, in this order: **VS Code** (`code <path>`, falling back to
`open -a "Visual Studio Code" <path>`), **Cursor** (`open -a Cursor`), **Xcode**
(only offered when the project contains an `.xcodeproj`/`.xcworkspace`/`Package.swift`
: open that file, not the folder), **Finder** (`open <path>`), and **Terminal**
(`open -a Terminal <path>`).

`opts` may carry `{ file, line }` to open a specific file: VS Code supports
`code -g <file>:<line>`. The doc reader uses this to jump from a rendered
document straight to that file in the editor.

**Rules.**
- `child_process.execFile` with an argv array. Never a shell string, never string
  interpolation into a command. This takes a user-supplied path: treat it as hostile.
- Validate the target with the same three gates as `/api/doc` (syntactic,
  post-`path.resolve`, post-`fs.realpath`) and require it to resolve inside the
  scanned root. Reject anything else with 403.
- Detection is a capability probe only, cached ~60s so the UI stays fast.
- Launch is fire-and-forget with a 5s timeout; a failed launch reports a readable
  error, never a hang.
- Unavailable editors are reported as `available: false`: the UI hides or
  disables them rather than failing at click time.

---

## 3. Agent activity: `lib/agents.js`

```js
export async function agentActivity(projects, opts) -> Map<projectId, Activity>
export async function projectAgentDetail(project) -> ActivityDetail
export async function verifyAgentPid(pid, projectPath) -> { ok, reason? }
```

### 3a. Observation, and the one exception

This module observes. It does not manage: nothing here kills, signals, or
writes to a process, nothing writes anywhere under `~/.claude`, and no
transcript content leaves it beyond short bounded snippets.

**The single exception is `POST /api/agents/stop` (§4).** It was added
deliberately, replacing an earlier absolute "Ground Control never signals a process"
rule. Stopping a session you started on your own machine is legitimate, and the
dashboard is the place you notice one needs stopping. The absolute rule is
replaced by four guards, all of which are required:

1. **Attribution.** The pid must be one Ground Control already attributes to the named
   project. A caller cannot nominate an arbitrary pid.
2. **Re-verification.** `verifyAgentPid` re-checks the pid immediately before
   the signal: still alive, still a `claude` binary, cwd still inside that
   project: bypassing every cache. A pid recycled between a sweep and a click
   is the only way this could reach an unrelated process, and this closes it.
3. **Self-preservation.** The session Ground Control is running from is never
   signalled. It is identified by process ancestry (`isSelf`) and refused.
4. **SIGTERM only.** Claude Code flushes its transcript on term. Nothing here
   escalates to SIGKILL, and no UI offers it.

`lib/agents.js` still performs no signalling itself: `verifyAgentPid` only
reads. The `process.kill` call lives in the HTTP handler, so the module's own
"observe only" property is intact and testable.

### 3b. What counts as a live agent

A running `claude` process is **not** sufficient. Measured on a real machine,
seven processes sat in one project with nothing written to their transcripts
for two to three days, and one for six: editor tabs left open, not work.
Reporting those as agents is the module's largest source of false positives.

- A process whose project has no transcript write within `OPEN_WINDOW_MS`
  (90 minutes) is **parked**: counted in `parked`, excluded from `live`, and it
  produces no agent presence.
- Zombie processes are skipped: a dead process `ps` still lists is not an agent.
- Processes Forge itself spawned are excluded via `opts.excludePids`. Forge runs
  `claude` with its cwd inside the project it is documenting, so without this
  Ground Control detects itself and reports it as the user's work.
- `active` (the orbit count) is `min(live, sessions genuinely mid-turn)`, so it
  can never exceed the processes actually running. Turn state, not recency, is
  the signal (§3b above), and the sessions are counted **per session file, not
  per store**: several agents started in the same folder share one transcript
  directory, so reading only its newest session would report one agent when
  three are working. Each agent that is mid-turn gets its own orbit.

### `Activity` (cheap: computed for every project on each scan)
```jsonc
{
  "live": 2,                       // NON-parked agent processes whose cwd is in this project
  "parked": 7,                     // alive but silent past OPEN_WINDOW_MS, not agents (§3b)
  "active": 2,                     // orbits drawn; min(live, sessions genuinely mid-turn)
  "processes": [                   // the evidence for the claim, and what /stop acts on
    { "pid": 16312, "origin": "vscode|desktop|cli|other", "uptimeMs": 0,
      "isSelf": false, "parked": true }
  ],
  "state": "working|open|idle|none",  // working = live>0 AND active>0; open = live>0, nothing written just now
  "lastSessionISO": "2026-08-16T22:13:04Z",   // newest transcript mtime, or null
  "lastSessionRelative": "3 days ago",
  "sessionCount": 4,
  "currentAction": "editing lib/scan.js",     // short, from the live session tail; null when idle
  "pids": [16312, 16773]
}
```

### `ActivityDetail` (detail view only)
Adds `recentEvents`: up to 25 entries from the newest transcript's tail,
`{ atISO, kind: "user"|"assistant"|"tool", label }` where `label` is a tool name
plus its key argument (`Edit lib/scan.js`) or a **≤120 char** snippet of message
text. Also `sessions: [{ id, startedISO, endedISO, sizeBytes, messageCount }]`.

**How to compute it.**
- **Live processes**: one `ps -o pid=,command= -ax` for the whole sweep, filter
  for a `claude` binary, then `lsof -a -p <pid> -d cwd -Fn` per candidate PID to
  get its cwd. Batch and cache aggressively: this is the expensive part.
  Attribute a PID to the project whose path is a prefix of that cwd, choosing the
  **longest** matching project path so `ideas/team_dispatch` doesn't get
  misattributed to `ideas`.
- **Transcripts**: map the project path to `~/.claude/projects/<encoded>` by
  replacing `/`, `_`, and `.` with `-`. Because that encoding is lossy, also scan
  the directory listing and match on the normalized form, so an unexpected
  character can't silently produce "no agent history".
- **Current action / recent events**: `tail` a bounded number of bytes (≤256 KB)
  off the newest transcript, parse the trailing complete JSON lines, and read the
  last tool use or assistant text. Skip malformed lines silently. **Never load a
  whole transcript.**

**Rules.**
- **Read-only. Never write to, move, or delete anything under `~/.claude/`.**
- **Never kill or signal an agent process.** Ground Control observes; it does not manage.
  No endpoint may terminate a PID.
- **Privacy**: transcripts are the user's own conversations. Surface only short
  status labels and the bounded `recentEvents` snippets described above. Never
  expose a full transcript, never add an endpoint that returns raw transcript
  content, and truncate every snippet at 120 chars.
- Everything is best-effort: if `ps`, `lsof`, or `~/.claude/projects` is missing
  or unreadable, return `state: "none"` and keep the dashboard working. This must
  never fail a scan or crash the server.
- Give the whole sweep a hard budget (~1.5s). If it overruns, return what you have
  and mark the rest unknown: the dashboard's sub-second scan must not regress.

---

## 4. HTTP API

| Route | Behavior |
|---|---|
| `GET /api/editors` | `{ editors: [Editor] }` |
| `POST /api/open` | Body `{ id, editor, file?, line? }`. Opens the project (or a file inside it) in that editor. `403` on a path that escapes the project, `404` unknown project/editor, `409` if the editor is unavailable. Returns `{ ok: true, opened: "<abs path>", editor }`. |
| `GET /api/agents` | `{ activity: { <projectId>: Activity }, scannedAt, budgetExceeded: bool }` |
| `GET /api/agents/:id` | `ActivityDetail`; `404` unknown project. |
| `POST /api/agents/stop` | Body `{ id, pid }`. Sends **SIGTERM** to that session under the four guards in §3a. `400` bad id/pid, `404` unknown project, `409` if the pid is not one Ground Control attributes to that project, if re-verification fails (already exited, pid reused, moved out of the project), or if it is the session Ground Control runs from (`isSelf`), `403` if signalling is not permitted. Returns `{ stopped: true, pid, projectId, signal: "SIGTERM", note }`. Never escalates to SIGKILL. |

`Activity` is also folded into each `ProjectSummary` as an `agent` field on
`/api/projects`, so the grid can render it without a second round trip. Keep it
cheap enough not to slow the existing scan; if the budget is blown, omit it
rather than delaying the response.

The existing `/api/stream` SSE should re-emit projects when agent state changes
(a project gaining or losing a live agent), debounced with the existing 800ms.

---

## 5. UI

**On each card**: when `state === "working"`, a small live indicator: a soft
pulsing dot in the ember accent with a count when > 1: plus `currentAction`
truncated to one line. `idle` gets a quieter "agent ran 3 days ago". `none`
renders nothing at all (most cards must stay calm: this is an accent, not
chrome). Respect `prefers-reduced-motion` by dropping the pulse.

**Filter and sort**: add an "Agent active" filter chip and an "Agent activity"
sort option, so "what am I in the middle of?" is one click. Persist in the URL
query like the existing filters.

**On the card and the detail header**: an **Open** control: primary action opens
VS Code, with a small menu for the other available editors. Show which editor
will be used. Disabled with a reason when none are available.

**Detail view**: an Agents panel showing live processes (count, uptime, current
action), last session time, session count, and the `recentEvents` timeline. When
nothing has ever run, say so plainly rather than rendering an empty box.

**Doc reader**: an "Open in editor" control on the document being read, using
`{file, line}` so it lands on that file.

**Quick switcher**: `Cmd+K` (and `/` to focus filter) opens a fuzzy project
switcher: type a few characters, Enter navigates to that project, `Cmd+Enter`
opens it in VS Code. This is the "hop from project to project" affordance; make
it fast and keyboard-complete, with visible focus states and Escape to dismiss.

Follow `CONTRACT.md` §3 tokens and §5 conventions throughout: build DOM with
`createElement`/`textContent`, never `innerHTML` with server data.
