/**
 * Forge: the shape of what it produces.
 *
 * The prompts have asked for diagrams for a long time, in the words "expected,
 * not optional". A real generated artifact then measured 3810 words across 73
 * paragraphs with zero diagrams, zero decision cards and zero folds. Asking
 * harder was not the fix; counting was. These tests hold the counting honest,
 * and hold the two prompt blocks that produce the material in place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { measureShape, validateShape } from '../lib/generate.js';
import { stylesheet } from '../lib/artifact-parts.js';
import {
  HOUSE_STYLE, DECISIONS, PREFLIGHT, VOCABULARY,
  authoringPrompt, designPrompt, codePrompt,
} from '../lib/house-style.js';

const PROSE = (n, words = 60) =>
  Array.from({ length: n }, () => `<p class="body">${'word '.repeat(words).trim()}</p>`).join('');

/* ---- measurement --------------------------------------------------- */

test('measureShape counts the things whose absence makes a wall of text', () => {
  const html = PROSE(4)
    + '<figure class="dia"><div class="diawrap"><svg></svg></div></figure>'
    + '<div class="decide"><h3 class="dq">Why X?</h3></div>'
    + '<details class="guess"><summary>Q</summary><div class="gbody"><p>a</p></div></details>'
    + '<details class="fold"><summary>more</summary></details>'
    + '<table><tr><td>1</td></tr></table>'
    + '<figure class="snip"><pre><code>x</code></pre></figure>';
  const s = measureShape(html);

  assert.equal(s.diagrams, 1);
  assert.equal(s.decisions, 1);
  assert.equal(s.reveals, 1);
  assert.equal(s.folds, 1);
  assert.equal(s.tables, 1);
  assert.equal(s.snippets, 1);
  // Four: the one-word <p> inside the reveal is below the three-word floor,
  // which keeps labels and captions out of the prose count.
  assert.equal(s.paragraphs, 4);
  assert.ok(s.minutes >= 1);
});

test('the longest prose run stops at anything that interrupts reading', () => {
  assert.equal(measureShape(PROSE(7)).longestProseRun, 7);
  assert.equal(measureShape(PROSE(3) + '<h3>break</h3>' + PROSE(2)).longestProseRun, 3);
  assert.equal(
    measureShape(PROSE(2) + '<figure class="dia"><svg></svg></figure>' + PROSE(9)).longestProseRun, 9);
});

/* ---- the gate ------------------------------------------------------ */

test('a long document with no diagram and no decision is refused', () => {
  const s = measureShape(PROSE(40));
  assert.ok(s.words >= 1500);
  const v = validateShape(s);
  assert.equal(v.ok, false);
  assert.match(v.reason, /without a single diagram/);
});

test('one diagram is enough to pass, and so is one decision card', () => {
  const wall = PROSE(40);
  assert.equal(validateShape(measureShape(wall + '<figure class="dia"><svg></svg></figure>')).ok, true);
  assert.equal(validateShape(measureShape(wall + '<div class="decide"></div>')).ok, true);
});

test('a thin repository still gets its short honest stub', () => {
  // The prompts ask for a few hundred words when there is little to say, and a
  // stub needs no diagram. Gating it would push the model into padding, which
  // is the failure this whole area is trying to avoid.
  const stub = measureShape(PROSE(4));
  assert.ok(stub.words < 1500);
  assert.equal(validateShape(stub).ok, true);
});

test('headings alone do not rescue a wall of text', () => {
  // The first version of this gate also required a long unbroken run of
  // paragraphs, and the very document that prompted the work slipped through
  // it: its runs are only five long because headings break them up.
  const withHeadings = Array.from({ length: 14 },
    () => '<h3>a heading</h3>' + PROSE(5)).join('');
  const s = measureShape(withHeadings);
  assert.ok(s.longestProseRun <= 5, 'headings do break the run');
  assert.equal(validateShape(s).ok, false, 'A WALL OF TEXT WITH HEADINGS IS STILL A WALL OF TEXT');
});

/* ---- the prompts carry the material -------------------------------- */

const KINDS = [['onboarding', authoringPrompt], ['design', designPrompt], ['code', codePrompt]];

test('all three documents share the decisions, vocabulary and preflight blocks', () => {
  // The vocabulary discipline used to live inline in the onboarding prompt and
  // nowhere else, which left the design and code documents free to assume the
  // reader already knew every term. The reader asking for a design document is
  // exactly the reader who does not.
  for (const [kind, build] of KINDS) {
    const p = build({ brief: { markdown: '# demo' }, project: { name: 'demo', path: '/tmp/demo' } });
    assert.ok(p.includes('DECISIONS AND TRADE-OFFS'), `${kind} lost the decisions block`);
    assert.ok(p.includes('DOES NOT ALREADY KNOW THE VOCABULARY'), `${kind} lost the vocabulary block`);
    assert.ok(p.includes('BEFORE YOU EMIT: COUNT'), `${kind} lost the preflight check`);
    assert.ok(!/\$\{[A-Z]/.test(p), `${kind} has an unresolved template placeholder`);
  }
});

test('the decisions block keeps motive and trade-off apart', () => {
  // This distinction is the whole mechanism. A motive needs evidence; a claim
  // about what two technologies are does not, and conflating them is what was
  // suppressing the comparisons the reader wanted.
  assert.match(DECISIONS, /A MOTIVE is a claim about what a person was thinking/);
  assert.match(DECISIONS, /A TRADE-OFF is a claim about what the technologies are/);
  assert.match(DECISIONS, /required/);
});

test('the design prompt permits analysis, not just evidence', () => {
  // Without this the "never invent a reason" rule reads as "never compare
  // anything", and the document goes back to being an inventory.
  const p = designPrompt({ brief: { markdown: '#x' }, project: { name: 'd', path: '/tmp/d' } });
  assert.ok(p.includes('4. **Analysis**'), 'THE ANALYSIS CATEGORY IS GONE: TRADE-OFFS WILL VANISH WITH IT');
  assert.match(p, /rule about MOTIVES/);
});

test('the vocabulary block still glosses terms and bans the dismissive words', () => {
  assert.match(VOCABULARY, /Assume intelligence; do not assume vocabulary/);
  assert.match(VOCABULARY, /Never write "simply"/);
});

test('the preflight check asks for counts, not for care', () => {
  assert.match(PREFLIGHT, /How many/);
  assert.match(PREFLIGHT, /at least two/);
});

/* ---- the classes the prompts name actually exist -------------------- */

test('every component the house style teaches is defined in the stylesheet', () => {
  const css = stylesheet();
  for (const cls of ['.decide', '.dalts', '.drow', 'table.vs', 'details.guess', '.gbody',
                     'figure.dia', 'figure.snip', 'details.fold', 'ul.terms']) {
    assert.ok(css.includes(cls), `the prompt names ${cls} but the stylesheet does not define it`);
    assert.ok(HOUSE_STYLE.includes(cls.replace(/^\./, '')), `${cls} is not taught in the house style`);
  }
});

test('the stylesheet stays a valid template literal', () => {
  // Both new components were first written with backticks in their CSS
  // comments, which silently ended the template literal they live inside.
  const css = stylesheet();
  assert.ok(!css.includes('`'), 'a backtick in the stylesheet ends the template literal it lives in');
  assert.ok(!css.includes('${'), 'an unescaped interpolation in the stylesheet');
  assert.ok(css.length > 15000);
});

test('the reveal and the decision card survive print and dark mode', () => {
  const css = stylesheet();
  // A <details> that stays shut on paper hides content from anyone printing it.
  assert.match(css, /details\.guess \.gbody\{display:block!important\}/);
  // No component rule may carry a literal colour: it would be invisible on one
  // of the two grounds. The :root blocks and @media print are the exceptions,
  // because those ARE the palettes, paper included.
  const components = css.slice(css.indexOf('*{box-sizing'), css.indexOf('@media print'));
  const literals = components.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(literals, [], 'a hard-coded colour in a component rule is invisible in one theme');
});
