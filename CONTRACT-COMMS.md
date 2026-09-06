# Ground Control Comms: Talk to an Agent About One Project

Everything else in Ground Control looks at projects. Comms is the one place you
can *say something* to one. You pick a project, type a message, and a `claude`
process runs in that project's folder and answers.

Read `CONTRACT.md` first: its hard rules all still apply (Node stdlib only,
vanilla browser JS, no npm, no CDN, no build step). Comms sits beside Forge and
the Workbench; it does not modify either.

---

## 0. Verified environment facts

Checked on this machine against `claude` 2.1.243. Build against these, and
degrade gracefully if any are missing:

- `claude -p` runs headless and reads its prompt from stdin. `--output-format
  stream-json --verbose` emits one JSON object per line; `--include-partial-
  messages` adds `stream_event` deltas, which is what makes a reply appear
  a sentence at a time rather than all at once when the process exits.
- `--session-id <uuid>` pins a new conversation's id up front, so the turn that
  starts it and every turn after it address the same session.
- `--resume <id>` continues a conversation. `--fork-session` makes the resume
  write to a **new** session id instead of the original.
- Every event carries `session_id`, so a forked session's new id is known from
  the first line of output.
- The `result` event carries `total_cost_usd`, `duration_ms`, and `is_error`.

**There is no way to type into a running agent.** A live `claude` process has
no inbox. Anything that claims to "message a running session" is either forking
its transcript or writing to a file two processes both own. Comms forks.

---

## 1. The two ways in

Both land in the same panel and behave identically once open.

**A new chat.** A session Ground Control owns. `--session-id` pins the id, and
every later turn is `--resume <that id>`.

**Continuing a session you already have.** The Agents panel already lists every
session for a project. Each row gets a *continue* button, which opens a chat
with `--resume <id> --fork-session`.

The fork is not optional and is not a preference:

> Resuming a session in place while it is also open in a terminal means two
> processes appending to one transcript, and the loser of that race loses work.

Forking gives Comms its own session id seeded with the whole history. The
conversation you see carries the context and cannot corrupt the original. The
UI says this in the panel, not in a tooltip, because a user who thinks they are
typing into their terminal session will be confused when it does not update.

---

## 2. File ownership

- `lib/comms.js` (new): the chat registry, the spawn, the stream.
- `server.js` (existing): the `/api/comms/*` section only. **Append, never
  restructure.** One dispatch line in `route()`, one `agentExcludePids()`
  helper, one shutdown hook.
- `public/js/app.js`, `public/css/app.css`, `public/index.html` (existing): the
  Comms UI only, in its own marked section, plus three hookups: the detail view
  mounts the panel, the Agents panel's session rows gain a continue button, and
  `onLocationChange` tears the stream down on leaving.
- `test/comms.test.js` (new).

Do not touch: `lib/scan.js`, `lib/git.js`, `lib/docs.js`, `lib/util.js`,
`lib/brief.js`, `lib/jobs.js`, `lib/agents.js`, `lib/reclaim.js`,
`lib/sources.js`, `public/js/markdown.js`, or any other CONTRACT file.
`lib/generate.js` gains nothing; Comms imports `claudeAvailable` and `childEnv`
from it and reuses them unchanged, so the billing guard has exactly one
definition.

---

## 3. What a chat agent may do

**A chat agent is a full agent.** It runs with `--permission-mode
bypassPermissions`: it reads, edits and creates files, and runs commands, in
the project it was opened on. This is deliberate and was chosen explicitly. The
alternative in headless mode is not "a safer agent", it is a broken one: there
is no terminal to answer a permission prompt in, so anything not pre-approved
fails mid-turn and the agent spends the reply explaining that it cannot work.

That choice is the reason for every rule in this section.

**3a. Loopback only, without exception.** `server.listen(port)` binds every
interface, so the dashboard is reachable from the rest of the network. Every
`/api/comms/*` route, **including the read-only ones**, refuses a non-loopback
caller with a sentence saying why. Sources draws this line for read access;
Comms draws it for everything.

**3b. The agent's directory comes from the scan, never from the request.** A
caller sends a `projectId`. The server resolves it through `findProject` and
uses that project's own path as the child's cwd. A caller cannot nominate a
directory, and `--add-dir` is never passed: a chat agent gets one folder.

**3c. Removing a folder revokes it.** Every send re-checks that the project is
still watched, and a chat against a detached folder is refused. The scan prunes
chats whose project is gone, skipping any that is mid-turn: `send` refuses on
its next message regardless, and yanking a chat out from under a running agent
would only hide it.

**3d. Bounded and killable.** One turn at a time per chat, three concurrent
turns across the whole app, and a 20-minute ceiling on a turn. Every child is
spawned `detached` into its own process group and stopped by signalling the
group, because an agent's `Bash` calls leave grandchildren that would otherwise
survive. SIGTERM first so the CLI flushes its transcript, SIGKILL after a grace
period. The server's shutdown hook stops every one of them.

**3e. Said in plain words.** The line "a chat agent works in this folder with
permissions bypassed: it can read, edit and create files, and run commands" sits
under the composer in every state of the panel, and the Stop control is present
whenever a turn is running. A control that can change your files must not
require reading this document to understand.

**3f. On the subscription.** The child's environment is `childEnv()` from
`lib/generate.js`, with `ANTHROPIC_API_KEY` and every related override deleted,
so a chat can never quietly run on metered API billing.

---

## 4. Transcripts stay the user's

`lib/agents.js` is read-only under `~/.claude` and Comms does not weaken that.
Comms never writes there itself: the `claude` CLI owns those files, and Comms
only ever hands it a session id.

Closing a chat removes Ground Control's record of it and **nothing else**. The
conversation stays on disk, and the panel says so where the button is. This is
the same promise Sources makes about removing a folder.

Ground Control's own index lives at `~/.ground-control/comms.json`: chat ids,
titles, session ids, the pid of any turn in flight (§4a), and the turns as
displayed. Written atomically (temp file + rename) at mode `0600`, on chat
creation, removal and turn completion, never per delta. A chat that was
mid-turn when the process died comes back **idle**, with that turn marked as
interrupted and its half-written tail discarded: nothing in the new process
will ever finish it.

### 4a. Orphans

A turn's child is spawned into its own process group, so that stopping it
reaches the grandchildren an agent's `Bash` calls leave behind. The price is
that it does not die with the server for free. The chain above it is:

```
macOS app  --keep-alive pipe-->  sh + watchdog  --killpg-->  node  --?-->  claude turn
```

The app→server link is airtight: the watchdog blocks on a pipe whose write end
only the app holds, so an app force-quit still SIGTERMs node. The server→turn
link is the shutdown hook alone, and **`kill -9` on the server gets past it**.
Measured: the child survives and is reparented to PID 1.

So the pid of a running turn is written to the store the moment the child is
spawned, with `persistNow()` rather than the usual debounce, because a crash
inside the debounce window would lose the only handle on it. `hydrate()` then
looks for it on the next start.

The reap is deliberately narrow, because a pid recycled between the crash and
the restart is the one way this could signal an unrelated process:

1. `ps -o command=` the recorded pid.
2. The command must be a `claude` invocation **and** carry one of that chat's
   own session ids. Those are UUIDs, so a coincidental match is not a thing
   that happens. "Is it named claude" is not good enough on its own: the user
   may well have started their own agent since.
3. SIGTERM the group, never SIGKILL: the CLI flushes its transcript on term.
4. The pid is cleared from the store either way, so a later start cannot
   re-signal a number that now belongs to someone else.

The restored turn then tells the truth about which of the two things happened.
A turn whose agent kept working says so and says to check the project for
changes; a turn whose process really did die says only that it was
interrupted. Reporting the first as the second is the actual bug this closes:
the orphan is recoverable, a confident wrong label is not.

---

## 5. The panel

Full width in the project detail view, under Forge. A project with no chat
renders one sentence and one button; the panel earns its space only once there
is a conversation in it.

- A row of chats along the top: one per open conversation, a dot on any that is
  running, plus new and close.
- The log: your messages, the agent's prose rendered as markdown, and between
  them a compact strip of what it actually did (`Read agents.js`, `npm test`).
  Tool labels are one line each and never the whole tool input.
- The live tail of the sentence being written is shown as plain text with a
  caret. It is deliberately never run through markdown: half a fenced code
  block renders as garbage and would reflow every frame.
- One SSE stream per open chat (`hello` replays everything, `delta` carries the
  live tail, `turn` and `settled` carry structure), reconnecting on a backoff.
  A `delta` touches one text node; everything else repaints the panel.

**Comms' own children are excluded from agent detection.** Forge already has
this problem and solves it the same way: a `claude` process with its cwd inside
a project is, to `ps` and `lsof`, exactly what an agent you opened yourself
looks like. `agentExcludePids()` in `server.js` merges both sets. A chat you are
watching in the panel must not also make the card claim an agent appeared out of
nowhere; the orbit is for sessions you started somewhere else.

---

## 6. The API

Every route is loopback-only (§3a).

```
GET    /api/comms/status                 -> { available, version, models, defaultModel,
                                              maxConcurrent, promptMax, timeoutMinutes,
                                              running[], permissionNote, billingNote }
GET    /api/comms/project/:projectId     -> { projectId, chats: [ChatSummary] }
POST   /api/comms/start                  { projectId, sessionId?, model? } -> Chat  (201)
GET    /api/comms/chat/:id               -> Chat
DELETE /api/comms/chat/:id               -> { ok, closed }
POST   /api/comms/chat/:id/send          { text } -> { chat, turnId }              (202)
POST   /api/comms/chat/:id/stop          -> Chat
GET    /api/comms/chat/:id/stream        -> SSE: hello | delta | turn | settled | ping
```

`Chat` is `{ id, projectId, projectName, title, model, state, error, sessionId,
resumeFrom, createdISO, updatedISO, messageCount, costUsd, interrupted, turns }`.
A `turn` is either `{ role: 'user', text }` or `{ role: 'agent', state, steps,
partial, costUsd, durationMs, error }`, where a step is `{ kind: 'text', text }`
or `{ kind: 'tool', name, label, state }`.

Refusals are a status and a sentence, never a queue: 409 while a chat is still
working, 429 past three concurrent turns, 413 past 32 KB in one message, 503
when the CLI is not installed. A chat that banks your messages and replays them
minutes later is worse than one that says it is busy.

---

## 7. Tests

`test/comms.test.js`, and no test spawns a `claude` process: the CLI is not a
test dependency and the interesting failures are all decisions made before the
spawn. What is covered:

- a new chat pins its own session id and resumes nothing
- **continuing a session always forks it** (the one that would be expensive to
  regress silently)
- later turns resume the chat's own session, not the original
- the cwd is the project and `--add-dir` is never passed
- messages over the cap are refused rather than truncated
- the chat cap never evicts a running chat, and pruning never drops one
- a chat that was mid-turn when the server died comes back idle and says so
- an agent that outlived its server is found and stopped, and its turn says so
- **a pid the OS handed to someone else is never signalled** (`ps` output and
  the kill are injected, so this is exercised without spawning anything)
- the reaped pid is dropped from the store, so a later start cannot re-signal it
- the index is written `0600`
- tool labels stay one line
