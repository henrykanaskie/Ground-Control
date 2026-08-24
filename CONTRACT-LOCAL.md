# Ground Control: the local-model tier

A third Forge tier that writes the onboarding artifact using a **local model via
ollama**, so generation works offline and without touching the user's Claude
subscription. Read `CONTRACT-FORGE.md` first, this extends it and reuses its
brief, staging, and save machinery unchanged.

---

## 0. The architecture, and why it is not "ask the model for the page"

This was measured on this machine before the design was settled. `gemma4:8b` was
given a real project two ways:

| Asked for | Result |
|---|---|
| JSON prose fields, schema-constrained | Accurate. Caught that `pandas`/`matplotlib` were declared but unused, flagged a hardcoded key, put three real gaps in `unknowns`. |
| The whole HTML artifact, free-form | Structurally valid but **invented behaviour**: claimed a 7-line script that does `urlopen` + `pprint` was "cleaning it and preparing it for statistical regression modeling". Emoji headings, no reading measure. |

Same model, same input. Constrained mode told the truth; free-form embellished.

So: **the local model never produces the document.** It fills bounded prose
slots; `lib/artifact-template.js` renders the page exactly as it does for the
`template` tier. Design consequences that are not negotiable:

- Every command, file path, statistic, tree and heatmap comes from the
  deterministic brief. The model cannot invent them because it is never asked for
  them.
- Output is JSON validated against a schema, not HTML.
- There is no agentic tool loop. Small models fail worst there, and the brief
  already carries the repository's own prose.

A second measured finding shaped this: both models did well on `groupStat`
(12.8 KB brief) and poorly on `pitwall` (3 KB brief). **Brief quality dominates
model size**, so spend effort on grounding, not on a bigger model.

---

## 1. File ownership

- `lib/local.js` (new): ollama client, slot filling, verification
- `lib/generate.js`: add the `local` tier alongside `template` / `authored`
- `lib/artifact-template.js`: accept authored prose and render it
- `server.js`: extend `/api/forge/status` and accept `tier: "local"`
- `public/js/app.js`, `public/css/app.css`: the tier option and its status

Do not touch `lib/scan.js`, `lib/git.js`, `lib/docs.js`, `lib/util.js`,
`lib/brief.js`, `lib/jobs.js`, `lib/agents.js`, `lib/editors.js`,
`lib/reclaim.js`, `public/js/markdown.js`, `public/css/doc.css`, `README.md`, or
any other CONTRACT file. A `test/` directory is being written in parallel: do
not create or edit anything under `test/`.

---

## 2. `lib/local.js`

```js
export async function ollamaStatus() -> {available, version, models:[{name, sizeBytes, parameterSize}], defaultModel}
export async function generateLocal({brief, model, audience, signal, onProgress}) -> {prose, verification, model, durationMs}
```

- Talk to `http://127.0.0.1:11434` with `fetch`. No new dependency.
- `ollamaStatus()` calls `/api/tags`, is cached ~30 s, and returns
  `available:false` rather than throwing when nothing is listening.
- **Default model**: prefer `gemma4:latest` if present, it beat
  `qwen2.5-coder:14b` on this exact task (better prose, 2.5× faster; the coder
  model leaked raw brief metadata such as ISO timestamps and byte counts into
  sentences). Otherwise the first non-embedding model.
- `generateLocal` posts to `/api/chat` with `stream:false`, `format:<schema>`,
  `options:{temperature:0.2, num_ctx:32768}`, a system message stating that
  accuracy outranks fluency and that anything not evidenced goes in `unknowns`,
  and the rendered brief markdown as the user message.
- Emit `onProgress` lines so the existing SSE job stream stays informative.
- Honour `signal` for cancel; enforce a **5 minute** timeout.

### The schema (exact field set)
```jsonc
{ "one_paragraph": string,   // what this is and who it's for
  "core_idea":     string,   // why it exists
  "how_it_works":  string,   // architecture in prose, no invented paths
  "current_state": string,   // honest, including what is unfinished
  "gotchas":       string[],
  "unknowns":      string[], // what could not be determined
  "start_here":    string }  // picking it up again
```

## 3. Verification: the part that makes it trustworthy

Before any prose is rendered, run it through a deterministic check:

- Extract every file-path-looking and command-looking token from the prose.
- Any path that does not appear in the brief **and** does not exist on disk in
  the project is **unverifiable**. Same for any command not present in the
  brief's evidenced-commands list.
- Do not silently delete them. Return a `verification` record
  (`{mentioned, unverifiable:[...], strippedSentences:[...]}`) and **drop the
  sentence containing an unverifiable path**, because a confident wrong path is
  worse than a shorter paragraph.
- Empty or near-empty model output for a field is fine; render the section as
  absent rather than padding it.

## 4. Provenance: say who wrote it

The artifact must state plainly, near the top, that its prose was written by a
local model and name it, e.g. *"Prose drafted locally by gemma4:8b; every path,
command and figure on this page is read directly from the repository."* If the
verification step dropped anything, say how many, in the page's existing
"what this page could not work out" section. Never present locally-drafted prose
as if a person or a frontier model wrote it.

## 5. Tier behaviour

- `/api/forge/status` gains `ollama: {available, models, defaultModel}` and
  `local` in `tiers` **only when ollama is reachable**.
- `POST /api/forge/generate` accepts `tier:"local"` plus an optional `model`.
  Reject with a clear message when ollama is unreachable, never hang.
- The local tier must **never** invoke the `claude` CLI, and must not require
  network access.
- The UI shows the tier with its model picker (populated from `ollamaStatus`),
  disabled with a reason when ollama is not running, and states plainly that it
  runs on this machine and costs nothing. Do not show a money figure for it.

## 6. Verification you must actually perform

Ollama is installed and running on this machine with `gemma4:latest` and
`qwen2.5-coder:14b` available.

1. `node --check` everything you touch.
2. `ollamaStatus()` lists both models and picks `gemma4:latest`.
3. Generate for real on **three shapes**: `groupStat` (rich brief, ~12.8 KB),
   `pitwall` (thin brief, ~3 KB), and `n8n` (empty). Report duration, and paste
   the actual prose produced for each. The empty project must produce an honest
   stub, not padding.
4. Prove the verification step works: craft prose containing a path that does not
   exist and confirm the sentence is dropped and recorded.
5. Confirm the rendered artifact is valid self-contained HTML, states its
   provenance, and that every command and path in it traces to the brief.
6. Confirm graceful failure with ollama stopped: a clear message, no hang.
   (Stop it with `pkill ollama` only if you restart it afterwards; prefer
   pointing the client at a dead port instead, which is safer.)
7. Leave no stray processes.
