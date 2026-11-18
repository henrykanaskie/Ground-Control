/**
 * Math in the chat: LaTeX the agent writes becomes MathML the browser
 * typesets. These pin what would be embarrassing to regress: prices read as
 * equations, code blocks mangled, or a `\text{}` that injects HTML.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toMathML, extractMath, renderWithMath } from '../public/js/math.js';

const fakeMd = (s) => s.split(/\n{2,}/).map((p) => `<p>${p.trim()}</p>`).join('\n');

test('fractions, scripts, roots and big operators become MathML', () => {
  const m = toMathML('\\frac{a}{b} + x_i^2 + \\sqrt[3]{8}');
  assert.match(m, /<mfrac><mi>a<\/mi><mi>b<\/mi><\/mfrac>/);
  assert.match(m, /<msubsup><mi>x<\/mi><mi>i<\/mi><mn>2<\/mn><\/msubsup>/);
  assert.match(m, /<mroot><mn>8<\/mn><mn>3<\/mn><\/mroot>/);
  assert.match(toMathML('\\sum_{i=1}^n i', true), /<munderover><mo largeop/);
  assert.match(toMathML('\\sum_{i=1}^n i', false), /<msubsup><mo largeop/, 'inline sums keep their limits to the side');
  assert.match(toMathML('\\lim_{x \\to 0} f'), /<msub><mi>lim<\/mi>.*<\/msub><mo>⁡<\/mo>/);
});

test('symbols, styled letters and environments', () => {
  assert.match(toMathML('\\alpha \\le \\infty'), /α.*≤.*∞/);
  assert.match(toMathML('\\mathbb{R} \\mathbf{v}'), /ℝ.*𝐯/);
  const al = toMathML('\\begin{aligned} a &= b \\\\ c &\\le d \\end{aligned}', true);
  assert.equal((al.match(/<mtr>/g) || []).length, 2);
  assert.match(al, /columnalign="right"/);
  assert.match(toMathML('\\begin{pmatrix} 1 & 2 \\end{pmatrix}'), /<mo stretchy="true" fence="true">\(<\/mo><mtable/);
  assert.match(toMathML('\\begin{cases} x & y \\end{cases}'), /fence="true">\{<\/mo><mtable class="math-cases"/);
});

test('nothing in the source can become HTML', () => {
  const m = toMathML('\\text{<img src=x onerror=alert(1)>} < b');
  assert.ok(!/<img/.test(m));
  assert.match(m, /&lt;img/);
  assert.match(toMathML('\\notacommand x'), /math-unknown">\\notacommand/);
});

test('prices stay prices, code stays code, and math is found in prose', () => {
  const { items: a } = extractMath('It costs $5 to $10.');
  assert.equal(a.length, 0);
  const { items: b } = extractMath('Use `$x$` literally.\n\n```\n$$not math$$\n```');
  assert.equal(b.length, 0);
  const { items: c } = extractMath('Inline $x^2$, display $$y$$ and \\(z\\), \\[w\\].');
  assert.deepEqual(c.map((i) => [i.tex, i.display]), [['x^2', false], ['y', true], ['z', false], ['w', true]]);
  const html = renderWithMath('Loss is $L = \\sum_i e_i$.\n\n$$E = mc^2$$', fakeMd);
  assert.match(html, /<p>Loss is <math class="gc-math">/);
  assert.match(html, /<div class="math-block"><math display="block"/);
});
