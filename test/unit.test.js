/** Pure-function behaviour, including several bugs found during the build. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as util from '../lib/util.js';
import * as docs from '../lib/docs.js';
import * as md from '../public/js/markdown.js';

test('slugify produces stable, url-safe ids', () => {
  assert.equal(util.slugify('ML_quantitative_research'), 'ml-quantitative-research');
  assert.equal(util.slugify('rLog'), 'r-log');
  assert.ok(!/[^a-z0-9-]/.test(util.slugify('Wild!! name?? 123')));
});

test('relativeTime reads as prose, not a timestamp', () => {
  const now = Date.now();
  assert.match(util.relativeTime(new Date(now - 30_000).toISOString()), /just now|second/i);
  assert.match(util.relativeTime(new Date(now - 3 * 86400_000).toISOString()), /3 days ago/);
  assert.match(util.relativeTime(new Date(now - 400 * 86400_000).toISOString()), /year/);
});

test('ignore list covers virtualenvs, which otherwise dominate file counts', () => {
  // Measured: water_potability looked like 11,557 files but is almost all pot-venv.
  for (const d of ['node_modules', '.git', '__pycache__', 'pot-venv', 'quant_venv', '.venv', 'venv']) {
    assert.equal(util.isIgnoredDir(d), true, `${d} should be ignored`);
  }
  for (const d of ['src', 'lib', 'docs']) assert.equal(util.isIgnoredDir(d), false);
});

test('doc classification maps real filenames to kinds', () => {
  assert.equal(docs.classify('ONBOARDING.md'), 'onboarding');
  assert.equal(docs.classify('docs/ONBOARDING.md'), 'onboarding');
  assert.equal(docs.classify('README.md'), 'readme');
  assert.equal(docs.classify('CLAUDE.md'), 'claude');
  assert.equal(docs.classify('index.html'), 'html');
});

test('featured doc: onboarding wins at any depth', () => {
  const d = (p, kind, wordCount = 100) => ({ path: p, kind, wordCount, sizeBytes: wordCount * 6 });
  const picked = docs.pickFeatured([d('README.md', 'readme', 900), d('docs/ONBOARDING.md', 'onboarding', 50)]);
  assert.equal(picked.path, 'docs/ONBOARDING.md');
});

test('featured doc: a root README beats a NESTED claude file', () => {
  // Regression: `ideas` featured team_dispatch/CLAUDE.md over its own README,
  // purely because `claude` outranks `readme` in the kind order.
  const d = (p, kind, wordCount = 100) => ({ path: p, kind, wordCount, sizeBytes: wordCount * 6 });
  const picked = docs.pickFeatured([d('README.md', 'readme'), d('team_dispatch/CLAUDE.md', 'claude', 5000)]);
  assert.equal(picked.path, 'README.md');
});

test('featured doc: nested docs are still used when the root has none', () => {
  const d = (p, kind) => ({ path: p, kind, wordCount: 100, sizeBytes: 600 });
  const picked = docs.pickFeatured([d('auxilium/SystemDesign.md', 'doc')]);
  assert.equal(picked.path, 'auxilium/SystemDesign.md');
});

test('blurb treats a malformed heading as a heading', () => {
  // Regression: StockPortfolio's entire README is "#StockPortfolio" with no
  // space. That is not a CommonMark heading, so it leaked in as the blurb.
  assert.equal(docs.blurbFromMarkdown('#StockPortfolio\n'), '');
  assert.equal(docs.blurbFromMarkdown('# Title\n'), '');
  assert.match(docs.blurbFromMarkdown('# Title\n\nReal prose here.\n'), /Real prose here/);
});

test('blurb skips badges, quotes and code fences', () => {
  const src = '# T\n\n![badge](https://img.example/b.svg)\n\n> a quote\n\n```\ncode\n```\n\nThe actual sentence.\n';
  assert.match(docs.blurbFromMarkdown(src), /The actual sentence/);
});

test('markdown escapes script tags rather than emitting them', () => {
  const out = md.render('<script>alert(1)</script>');
  assert.ok(!/<script/i.test(out), 'must not emit a script tag');
  assert.match(out, /&lt;script/i);
});

test('markdown rejects javascript: and data: urls', () => {
  const out = md.render('[x](javascript:alert(1)) and [y](data:text/html,<b>)');
  assert.ok(!/href="javascript:/i.test(out));
  assert.ok(!/href="data:text\/html/i.test(out));
});

test('markdown heading ids match the ids headings() reports', () => {
  const src = '# One\n\n## Two Words\n\n## Two Words\n';
  const html = md.render(src);
  for (const h of md.headings(src)) {
    assert.ok(html.includes(`id="${h.id}"`), `rendered html is missing id ${h.id}`);
  }
});

test('markdown survives hostile and malformed input without throwing', () => {
  for (const bad of ['', '```\nunclosed', '| a | b |\n|---|\n| 1 |', '- '.repeat(200), '#'.repeat(50)]) {
    assert.doesNotThrow(() => md.render(bad));
  }
});
