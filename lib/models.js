/**
 * The Claude models Ground Control offers.
 *
 * This is the one place the list lives. Forge (lib/generate.js, server.js) and
 * Comms (lib/comms.js) both read it, and the browser gets it from the two
 * `/status` endpoints, so a model added here shows up everywhere at once. It
 * used to be spelled out in four files and they had already drifted apart.
 *
 * TWO KINDS OF ENTRY, and the difference matters:
 *
 *   - a FAMILY ALIAS (`opus`, `sonnet`, `haiku`, `fable`). The CLI resolves
 *     these to the newest model in that family at the moment the process
 *     starts. Pick one of these and you are current forever without anybody
 *     editing this file. The cost is that the run record says `opus`, not
 *     which model `opus` actually was that day.
 *   - a PINNED ID (`claude-opus-5`). Exactly one model, reproducible, and the
 *     run record names it. The cost is that it goes stale, which is the whole
 *     reason this file exists.
 *
 * Ground Control offers both and defaults to a pinned id, because a generated
 * artifact carries the model name as a fact about how it was made.
 *
 * WHEN A NEW MODEL SHIPS you do not have to wait for this file. Set
 * GROUND_CONTROL_MODELS to a comma-separated list and it replaces the list
 * below; GROUND_CONTROL_DEFAULT_MODEL picks the default out of it. The CLI is
 * the only thing that validates a model name, so an unknown one fails at the
 * run, visibly, rather than being silently swapped.
 *
 * Node stdlib only.
 */

/** Family aliases: whatever the CLI currently calls the newest of each. */
export const ALIASES = ['opus', 'fable', 'sonnet', 'haiku'];

/**
 * The offer, newest-first within each tier. Pinned ids first because they are
 * what a run record should say; aliases after, for people who would rather
 * never think about this list again.
 */
const BUILTIN_MODELS = [
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  ...ALIASES,
];

const BUILTIN_DEFAULT = 'claude-opus-5';

/**
 * One short phrase per model, for the pickers. A model with no note here is
 * still offered: the picker just shows its bare id.
 */
export const NOTES = {
  'claude-opus-5': 'most thorough',
  'claude-opus-4-8': 'most thorough',
  'claude-fable-5': 'most capable, slowest',
  'claude-sonnet-5': 'faster',
  'claude-sonnet-4-5': 'faster',
  'claude-haiku-4-5': 'quickest',
  opus: 'always the newest Opus',
  fable: 'always the newest Fable',
  sonnet: 'always the newest Sonnet',
  haiku: 'always the newest Haiku',
};

/** A comma or whitespace separated override, or null when unset or empty. */
function fromEnv(raw) {
  if (typeof raw !== 'string') return null;
  const list = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return list.length ? Array.from(new Set(list)) : null;
}

/** The models on offer, in picker order. */
export const MODELS = fromEnv(process.env.GROUND_CONTROL_MODELS) || BUILTIN_MODELS;

/**
 * The model used when nobody picks one. An override that names something not
 * on the list would make the picker and the default disagree, so the list
 * wins and the first entry stands in.
 */
const asked = (process.env.GROUND_CONTROL_DEFAULT_MODEL || '').trim();
export const DEFAULT_MODEL =
  (asked && MODELS.includes(asked) && asked) ||
  (MODELS.includes(BUILTIN_DEFAULT) ? BUILTIN_DEFAULT : MODELS[0]);

/** Is this a model Ground Control will pass to the CLI? */
export function isKnownModel(id) {
  return typeof id === 'string' && MODELS.includes(id);
}

/** `[{ value, label }]` for a picker, notes folded into the label. */
export function modelOptions() {
  return MODELS.map((id) => ({ value: id, label: NOTES[id] ? id + ' - ' + NOTES[id] : id }));
}
