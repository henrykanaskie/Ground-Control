/**
 * Ground Control Forge: the deterministic artifact.
 *
 * `renderArtifact(brief, opts)` turns a repo brief into one complete,
 * self-contained HTML document built from repository facts alone. No model is
 * involved. It is both the `template` tier and the safety net when authored
 * generation fails, so it has to stand on its own as something useful.
 *
 * Two disciplines govern this file:
 *
 *   1. EVERY interpolated value is escaped by the builders in
 *      `artifact-parts.js`. Repository content (commit subjects, file names,
 *      doc titles, TODO text) is untrusted and must never inject markup.
 *   2. EVERY brief field may be missing, empty, or a different shape than
 *      expected. Nothing here throws on a malformed brief; a section with no
 *      data is omitted and recorded in the closing "what this could not
 *      determine" list, because a visible gap read honestly beats a broken one.
 *
 * Node stdlib only, ES modules, zero dependencies.
 */

import {
  esc, toText, clamp, arr, num, pick, normalizeBrief,
  fmtInt, fmtBytes, fmtDate, relative, parseDate,
  page, masthead, section, statBand, calloutHtml, hollow,
  table, pills, fold, facts, compositionBar, heatmap, directoryMap, commitLog,
  para, list, listHtml,
} from './artifact-parts.js';

/* ================================================================== *
 * renderArtifact
 * ================================================================== */

/**
 * @param {object} brief   the repo brief (see CONTRACT-FORGE §3)
 * @param {object} [opts]
 * @param {string} [opts.generatedAtISO]  timestamp shown in the masthead
 * @param {string} [opts.tier]            "template" | "authored-fallback" | "local"
 * @param {string} [opts.reason]          why the deterministic tier was used
 * @param {string} [opts.tool]            producer name for the colophon
 * @param {object} [opts.prose]           verified prose slots (CONTRACT-LOCAL §2)
 * @param {object} [opts.verification]    the verification record (CONTRACT-LOCAL §3)
 * @param {string} [opts.model]           the model that drafted the prose
 * @param {string} [opts.provenance]      the provenance sentence (CONTRACT-LOCAL §4)
 * @returns {string} a complete HTML document
 */
export function renderArtifact(brief, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const d = normalizeBrief(brief);
  const nowISO = toText(o.generatedAtISO) || d.generatedAtISO || new Date().toISOString();
  const now = parseDate(nowISO)?.getTime() ?? Date.now();
  /** Honest record of everything this document could not work out. */
  const gaps = [];
  /**
   * Optional authored prose (CONTRACT-LOCAL.md). It is *only* prose: every
   * command, path, statistic, tree and heatmap below still comes from the
   * deterministic brief, exactly as it does without it.
   */
  const prose = normalizeProse(o.prose);

  const isEmpty = (d.fileCount === 0)
    || (!d.fileCount && !d.docs.length && !d.langs.length && !d.recentCommits.length
        && !d.structure.length && !d.sizeBytes);

  const body = isEmpty
    ? renderEmpty(d, { nowISO, now, o, prose })
    : renderFull(d, { nowISO, now, o, gaps, prose });

  return page({
    title: `${d.name}: repository brief`,
    description: d.blurb || `A factual brief for ${d.name}, assembled from the repository itself.`,
    bodyHtml: body,
  });
}

export default renderArtifact;

/* ------------------------------------------------------------------ *
 * The empty / near-empty case: short, deliberate, honest.
 * ------------------------------------------------------------------ */

function renderEmpty(d, { nowISO, now, o, prose }) {
  const head = masthead({
    eyebrow: `Repository brief · ${fmtDate(nowISO)}`,
    title: d.name,
    standfirst: 'There is nothing in this directory yet. This page records that plainly rather than padding it out.',
    extraHtml: [
      statBand([
        { label: 'Status', value: d.status ? titleCase(d.status) : 'Empty' },
        { label: 'Files', value: '0' },
        d.path ? { label: 'Location', value: shortenPath(d.path) } : null,
      ].filter(Boolean)),
      prose ? provenanceCallout(o) : (toText(o.tier) === 'local' ? provenanceCallout(o, false) : ''),
    ].filter(Boolean).join('\n'),
  });

  const bits = [];
  // An empty project gets a stub, not padding: at most the single opening
  // paragraph, and only if verification left one standing.
  if (prose && prose.one_paragraph) bits.push(para(prose.one_paragraph));
  bits.push(hollow(
    'No files to describe',
    d.path
      ? 'The directory exists but contains no tracked content: no source, no documents, no git history.'
      : 'No content was found for this project.'
  ));
  bits.push(calloutHtml({
    heading: 'What this means',
    paragraphsHtml: [
      'A brief is only as good as what it can read. There is nothing here to read, so there is nothing to say: '
      + 'no language composition, no entry point, no history. That is the finding.',
      `When the first files land, regenerate this page and it will fill itself in.`,
    ],
    tone: 'plain',
  }));

  return `${head}
<main class="wrap">
${section({ id: 'state', title: 'An empty directory', label: 'Nothing measured', bodyHtml: bits.join('\n') })}
</main>
${renderFooter(d, { nowISO, now, o, prose, gaps: ['Everything. The directory is empty.'] })}`;
}

/* ------------------------------------------------------------------ *
 * The full case
 * ------------------------------------------------------------------ */

function renderFull(d, ctx) {
  const { nowISO, now, o, gaps, prose } = ctx;

  const head = masthead({
    eyebrow: prose ? `Onboarding brief · ${fmtDate(nowISO)}` : `Repository brief · ${fmtDate(nowISO)}`,
    title: d.name,
    standfirst: d.blurb || fallbackStandfirst(d),
    extraHtml: [
      statBand(bandItems(d, now)),
      prose ? provenanceCallout(o) : (toText(o.tier) === 'local' ? provenanceCallout(o, false) : openingCallout(d, o)),
    ].filter(Boolean).join('\n'),
  });

  const sections = [
    // Authored prose slots sit between the deterministic sections; they carry
    // no facts of their own, and every one of them has already been through
    // verification (CONTRACT-LOCAL.md §3).
    sectionWhatThisIs(prose),
    sectionOrientation(d, ctx),
    sectionComposition(d, ctx),
    sectionActivity(d, ctx),
    sectionDocuments(d, ctx),
    sectionRunning(d, ctx),
    sectionLayout(d, ctx),
    sectionHowItWorks(prose),
    sectionCommits(d, ctx),
    sectionSignals(d, ctx),
    sectionStateOfPlay(prose),
    sectionStartHere(prose),
  ].filter(Boolean);

  return `${head}
<main class="wrap">
${sections.join('\n\n')}
</main>
${renderFooter(d, { nowISO, now, o, gaps, prose })}`;
}

function fallbackStandfirst(d) {
  const lang = d.primaryLanguage ? `${d.primaryLanguage} ` : '';
  const from = d.isGit ? 'its files and its git history' : 'its files';
  return `No description was found here: there is no README paragraph or featured document to quote `
    + `from. Everything on this page about this ${lang}project was measured directly from ${from}.`;
}

/** Docs that will actually render: the band must not count rows the table drops. */
function realDocs(d) {
  return arr(d.docs).filter((doc) => toText(doc && (doc.path ?? doc.file)) || toText(doc && doc.title));
}

function bandItems(d, now) {
  const items = [];
  if (d.status) items.push({ label: 'Status', value: titleCase(d.status) });
  if (Number.isFinite(d.fileCount)) items.push({ label: 'Files', value: fmtInt(d.fileCount) });
  if (Number.isFinite(d.sizeBytes) && d.sizeBytes > 0) items.push({ label: 'Size', value: fmtBytes(d.sizeBytes) });
  if (Number.isFinite(d.commitCount) && d.commitCount > 0) items.push({ label: 'Commits', value: fmtInt(d.commitCount) });
  if (d.primaryLanguage) items.push({ label: 'Language', value: clamp(d.primaryLanguage, 22) });
  const last = d.lastActivityRelative || relative(d.lastActivityISO || d.lastCommitISO, now);
  if (last) items.push({ label: 'Last activity', value: last });
  // Six cells is the most that stays on one row at the reading width; the
  // document count is already the label of its own section.
  const docs = realDocs(d).length;
  if (items.length < 6 && docs) items.push({ label: 'Documents', value: fmtInt(docs) });
  // One lone cell stretched across the page reads as a mistake, not a band.
  return items.length < 2 ? [] : items.slice(0, 6);
}

function openingCallout(d, o) {
  const tier = toText(o.tier);
  const reason = toText(o.reason);
  const ps = [];
  ps.push('Every figure and file path on this page was read from the repository. '
    + '<strong>Nothing here was written by a language model</strong>, so nothing here is invented, '
    + 'but nothing here is interpreted either. It tells you what is in the directory, not what it means.');
  if (tier === 'authored-fallback' || reason) {
    ps.push(`The written version could not be produced${reason ? `: ${esc(clamp(reason, 200))}` : ''}. `
      + 'This factual brief was staged instead.');
  }
  return calloutHtml({ heading: 'How to read this', paragraphsHtml: ps });
}

/* --- 1. Orientation ------------------------------------------------ */

function sectionOrientation(d, { now, gaps }) {
  const rows = [];
  if (d.path) rows.push({ label: 'Location', value: d.path, mono: true });
  if (d.status) rows.push({ label: 'Status', value: d.statusReason ? `${titleCase(d.status)}: ${d.statusReason}` : titleCase(d.status) });
  const touched = dateWithAge(d.lastActivityISO, now);
  if (touched) rows.push({ label: 'Last touched', value: touched });
  if (d.isGit) {
    if (d.branch) rows.push({ label: 'Branch', value: d.branch, mono: true });
    if (d.remote) rows.push({ label: 'Remote', value: d.remote, mono: true });
    else rows.push({ label: 'Remote', value: 'none configured: this repository exists only on this machine' });
    const tracking = (d.ahead || d.behind)
      ? `${d.ahead ? `${fmtInt(d.ahead)} ahead` : ''}${d.ahead && d.behind ? ', ' : ''}${d.behind ? `${fmtInt(d.behind)} behind` : ''} upstream`
      : '';
    if (tracking) rows.push({ label: 'Upstream', value: tracking });
    const dc = Number.isFinite(d.dirtyCount) ? d.dirtyCount : (d.dirtyFiles.length || null);
    if (d.dirty) {
      rows.push({ label: 'Working tree', value: dc ? `dirty: ${fmtInt(dc)} changed file${dc === 1 ? '' : 's'}` : 'dirty: uncommitted changes present' });
    } else if (d.isGit) {
      rows.push({ label: 'Working tree', value: 'clean' });
    }
  } else {
    rows.push({ label: 'Version control', value: 'not a git repository: there is no history to read' });
    gaps.push('Anything that would come from git: when the work happened, in what order, and what was changed together.');
  }

  const factsHtml = facts(rows);
  const stackHtml = d.stack.length
    ? `<h3>Detected stack</h3>${pills(d.stack.map((s) => toText(s)))}` +
      `<p class="note">Detected from file extensions and manifests, in order of confidence. It reflects what is present, not what is central.</p>`
    : '';

  if (!factsHtml && !stackHtml) return '';
  return section({
    id: 'orientation',
    title: 'Where this lives',
    label: d.isGit ? 'Identity · git state' : 'Identity · no version control',
    bodyHtml: [factsHtml, stackHtml].filter(Boolean).join('\n'),
  });
}

/* --- 2. Composition ------------------------------------------------ */

function sectionComposition(d, { gaps }) {
  const bar = compositionBar(d.langs);
  if (!bar) {
    if (Number.isFinite(d.fileCount) && d.fileCount > 0) {
      gaps.push('The language composition: no recognised source files were measured, so the bar could not be drawn.');
    }
    return '';
  }
  const counts = [];
  if (Number.isFinite(d.fileCount)) counts.push(`${fmtInt(d.fileCount)} file${d.fileCount === 1 ? '' : 's'}`);
  if (Number.isFinite(d.dirCount)) counts.push(`${fmtInt(d.dirCount)} director${d.dirCount === 1 ? 'y' : 'ies'}`);
  if (Number.isFinite(d.sizeBytes) && d.sizeBytes > 0) counts.push(fmtBytes(d.sizeBytes));

  return section({
    id: 'composition',
    title: 'What it is made of',
    label: counts.join(' · ') || 'Language composition',
    bodyHtml: [
      bar,
      para('Measured in bytes of source, not in files or lines, so a handful of large generated '
        + 'files can dominate a language that nobody actually writes here.', 'note'),
    ].filter(Boolean).join('\n'),
  });
}

/* --- 3. Activity --------------------------------------------------- */

function sectionActivity(d, { now, gaps }) {
  const map = heatmap(d.activity, { label: 'commits' });
  const rows = [];
  if (Number.isFinite(d.commitCount) && d.commitCount > 0) rows.push({ label: 'Commits', value: fmtInt(d.commitCount) });
  const first = dateWithAge(d.firstCommitISO, now);
  if (first) rows.push({ label: 'First commit', value: first });
  const latest = dateWithAge(d.lastCommitISO, now);
  if (latest) rows.push({ label: 'Latest commit', value: latest });

  const top = d.topFiles.length
    ? table(['Most-changed file', 'Revisions'], d.topFiles.slice(0, 5).map((f) => {
      const p = toText(f && (f.path ?? f.file ?? f.name ?? f));
      const n = num(f && (f.changes ?? f.count ?? f.commits), NaN);
      return [{ text: p, cls: 'm' }, { text: Number.isFinite(n) ? fmtInt(n) : '-', cls: 'n' }];
    }).filter((r) => r[0].text))
    : '';

  if (!map && !rows.length && !top) {
    if (d.isGit) gaps.push('The commit timeline: git history was expected but none was available.');
    return '';
  }

  const parts = [];
  if (map) parts.push(map);
  else if (d.isGit) parts.push(para('No per-day commit counts were available, so the 90-day heatmap could not be drawn.', 'note'));
  if (rows.length) parts.push(facts(rows));
  if (top) parts.push(`<h3>What changes most</h3>${top}<p class="note">Counted over the recent history the brief sampled, not the whole life of the repository. Files that churn are usually either the hot path or the configuration nobody has settled.</p>`);

  return section({
    id: 'activity',
    title: 'When the work happened',
    label: 'Last 90 days · commits per day',
    bodyHtml: parts.join('\n'),
  });
}

/* --- 4. Documents -------------------------------------------------- */

const KIND_ORDER = ['onboarding', 'claude', 'readme', 'design', 'doc', 'html', 'notebook'];

function sectionDocuments(d, { now, gaps }) {
  const docs = d.docs.map((doc) => ({
    path: toText(doc && (doc.path ?? doc.file)),
    title: toText(doc && doc.title),
    kind: toText(doc && doc.kind).toLowerCase(),
    words: num(doc && doc.wordCount, NaN),
    size: num(doc && doc.sizeBytes, NaN),
    mtime: toText(doc && doc.mtimeISO),
  })).filter((doc) => doc.path || doc.title);

  if (!docs.length) {
    gaps.push('What the project is for, in the author’s own words: there is no README, no CLAUDE.md and no onboarding document in the tree.');
    return section({
      id: 'documents',
      title: 'What has already been written',
      label: 'No documents found',
      bodyHtml: hollow('Nothing is documented',
        'No README, design note, or onboarding document was found at the top two levels of this project. '
        + 'Whatever this is, the explanation lives only in the code and in someone’s memory.'),
    });
  }

  docs.sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind); const kb = KIND_ORDER.indexOf(b.kind);
    return (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb) || (num(b.words, 0) - num(a.words, 0));
  });

  const featuredPath = toText(pick(d.featuredDoc, 'path') || pick(d.featuredProse, 'path'));

  const rows = docs.slice(0, 40).map((doc) => {
    const isFeatured = featuredPath && doc.path === featuredPath;
    const label = doc.title || doc.path;
    return [
      { text: label, strong: true, sub: doc.path && doc.path !== label ? doc.path : '' },
      { text: (doc.kind || 'doc') + (isFeatured ? ' · featured' : ''), cls: 'm' },
      { text: Number.isFinite(doc.words) ? `${fmtInt(doc.words)} words` : (Number.isFinite(doc.size) ? fmtBytes(doc.size) : '-'), cls: 'n' },
      { text: doc.mtime ? relative(doc.mtime, now) : '-', cls: 'n' },
    ];
  });

  const extra = docs.length - rows.length;
  const featuredNote = featuredPath
    ? `<p class="note">Start with <span class="path">${esc(featuredPath)}</span>: it is the richest document in the tree and the one Ground Control treats as this project’s front door.</p>`
    : '<p class="note">No single document stands out as the front door; read them in the order above.</p>';

  return section({
    id: 'documents',
    title: 'What has already been written',
    label: `${fmtInt(docs.length)} document${docs.length === 1 ? '' : 's'} in the tree`,
    bodyHtml: [
      table(['Document', 'Kind', 'Length', 'Updated'], rows),
      extra > 0 ? para(`${fmtInt(extra)} further documents are not listed.`, 'note') : '',
      featuredNote,
    ].filter(Boolean).join('\n'),
  });
}

/* --- 5. Running it ------------------------------------------------- */

function sectionRunning(d, { gaps }) {
  const entries = d.entryPoints.map((e) => ({
    path: toText(e && (e.path ?? e.file ?? e)),
    why: toText(e && (e.why ?? e.reason ?? e.note)),
  })).filter((e) => e.path).slice(0, 8);

  const cmds = d.run.map((c) => {
    const command = toText(c && (c.command ?? c.cmd ?? c.run ?? c));
    return {
      command,
      name: toText(c && c.name),
      source: toText(c && (c.source ?? c.from ?? c.file)),
      desc: toText(c && (c.description ?? c.desc ?? c.note ?? c.what)),
    };
  }).filter((c) => c.command || c.name).slice(0, 24);

  const manifests = d.manifests.map((m) => ({
    file: toText(m && (m.file ?? m.path ?? m.name)),
    kind: toText(m && m.kind),
    desc: toText(m && (m.description ?? m.summary ?? pick(m, 'parsed.description'))),
    deps: arr(m && (m.deps ?? m.dependencies ?? pick(m, 'parsed.dependencies')))
      .map(toText).filter(Boolean),
  })).filter((m) => m.file);

  const parts = [];

  if (cmds.length) {
    parts.push(table(['Command', 'Where it is declared', 'What it says it does'],
      cmds.map((c) => [
        { text: c.command || c.name, cls: 'm' },
        { text: c.source || '-', cls: 'sub' },
        { text: c.desc || (c.name && c.command !== c.name ? c.name : '-') },
      ])));
    parts.push(para('These are the commands the repository actually declares, in its manifests, its Makefile, '
      + 'or as a runnable entry file. None of them has been executed, and none is guaranteed to work on a '
      + 'fresh machine; missing prerequisites will not show up here.', 'note'));
  } else {
    gaps.push('How to run it. No npm script, Makefile target, or obvious runnable entry file was found, so any command would have been a guess.');
    parts.push(hollow('No run commands found',
      'Nothing in this repository declares how to start it: no package scripts, no Makefile targets, '
      + 'no module with a main entry. Read the entry points below and work it out from there.'));
  }

  if (entries.length) {
    parts.push(`<h3>Start reading here</h3>`);
    parts.push(listHtml(entries.map((e) => `<span class="path">${esc(e.path)}</span>${e.why ? `: ${esc(clamp(e.why, 160))}` : ''}`)));
    parts.push(para('Ranked by how likely each file is to be the way in: a declared entry point, a name '
      + 'like index, main or server, or simply the largest source file nearest the root.', 'note'));
  } else {
    gaps.push('Which file to read first: no entry point could be identified from names or manifests.');
  }

  if (manifests.length) {
    const rows = manifests.slice(0, 10).map((m) => [
      { text: m.file, cls: 'm' },
      { text: m.kind || '-', cls: 'sub' },
      { text: m.deps.length ? `${fmtInt(m.deps.length)} declared` : (m.desc ? clamp(m.desc, 90) : '-') },
    ]);
    parts.push(`<h3>Declared dependencies</h3>`);
    parts.push(table(['Manifest', 'Kind', 'Dependencies'], rows));
    const allDeps = [...new Set(manifests.flatMap((m) => m.deps))].slice(0, 40);
    if (allDeps.length) parts.push(pills(allDeps));
  }

  return section({
    id: 'running',
    title: 'Getting it running',
    label: cmds.length ? `${fmtInt(cmds.length)} declared command${cmds.length === 1 ? '' : 's'}` : 'No declared commands',
    bodyHtml: parts.filter(Boolean).join('\n'),
  });
}

/* --- 6. Layout ----------------------------------------------------- */

function sectionLayout(d, { gaps }) {
  const map = directoryMap(d.structure);
  if (!map) {
    gaps.push('The directory layout: no structure was captured for this project.');
    return '';
  }
  const big = d.structure.length > 26;
  return section({
    id: 'layout',
    title: 'How it is laid out',
    label: `Directory map · depth 3`,
    bodyHtml: big
      ? fold({ summary: 'Directory map', count: d.structure.length, countLabel: 'entries', bodyHtml: map, open: false })
      : map,
  });
}

/* --- 7. Recent commits --------------------------------------------- */

function sectionCommits(d, { now }) {
  const log = commitLog(d.recentCommits, { limit: 40, now });
  if (!log) return '';
  const n = d.recentCommits.length;
  const body = n > 12
    ? [commitLog(d.recentCommits.slice(0, 12), { limit: 12, now }),
      fold({ summary: 'Earlier in the sampled history', count: Math.min(n - 12, 28), countLabel: 'commits', bodyHtml: commitLog(d.recentCommits.slice(12), { limit: 40, now }) })].join('\n')
    : log;
  return section({
    id: 'commits',
    title: 'What was being worked on',
    label: `${fmtInt(Math.min(n, 40))} most recent commit message${n === 1 ? '' : 's'}`,
    bodyHtml: [
      body,
      para('Commit subjects are the cheapest honest record of intent in any repository. Read from the '
        + 'bottom up and you get the order the work actually happened in.', 'note'),
    ].join('\n'),
  });
}

/* --- 8. Signals ---------------------------------------------------- */

function sectionSignals(d, { gaps }) {
  const parts = [];

  const todos = d.todos.map((t) => {
    if (typeof t === 'string') {
      const m = /^(.*?):(\d+)\s*[—:-]?\s*(.*)$/.exec(t);
      return m ? { file: m[1], line: m[2], text: m[3] } : { file: '', line: '', text: t };
    }
    return {
      file: toText(t && (t.file ?? t.path)),
      line: toText(t && t.line),
      text: toText(t && (t.text ?? t.message ?? t.todo)),
    };
  }).filter((t) => t.text || t.file);

  if (todos.length) {
    parts.push(table(['Location', 'Note left in the code'],
      todos.slice(0, 15).map((t) => [
        { text: t.file ? `${t.file}${t.line ? `:${t.line}` : ''}` : '-', cls: 'm' },
        { text: clamp(t.text, 200) || '-' },
      ])));
    const total = Number.isFinite(d.todoCount) ? d.todoCount : todos.length;
    if (total > todos.length) {
      parts.push(para(`${fmtInt(total)} TODO/FIXME markers in total; the ${fmtInt(Math.min(todos.length, 15))} above are a sample.`, 'note'));
    }
  } else if (Number.isFinite(d.todoCount) && d.todoCount > 0) {
    parts.push(para(`${fmtInt(d.todoCount)} TODO/FIXME markers are present in the source, but no samples were captured.`, 'body'));
  }

  const tests = [];
  if (d.hasTests === true) tests.push(`Tests are present${d.testLayout ? `: ${d.testLayout}` : ''}.`);
  else if (d.hasTests === false) tests.push('No test files were found anywhere in this project.');
  else if (d.testLayout) tests.push(d.testLayout);
  if (d.hasTests === false) gaps.push('Whether anything works. There are no tests, so nothing in this repository is verified by anything except its author’s memory.');

  if (tests.length) parts.push(`<h3>Tests</h3>${tests.length === 1 ? para(tests[0]) : list(tests)}`);

  if (d.dirtyFiles.length) {
    const rows = d.dirtyFiles.slice(0, 20).map((f) => {
      const p = toText(f && (f.path ?? f.file ?? f));
      const st = toText(f && (f.state ?? f.status));
      return [{ text: p, cls: 'm' }, { text: st || '-', cls: 'sub' }];
    }).filter((r) => r[0].text);
    if (rows.length) {
      parts.push(`<h3>Uncommitted work</h3>`);
      parts.push(table(['File', 'State'], rows));
      parts.push(para('These changes exist only in the working tree. If you clone this repository elsewhere, '
        + 'you will not get them.', 'note'));
    }
  }

  const cfg = d.configFiles.map((c) => toText(c && (c.name ?? c.path ?? c))).filter(Boolean);
  if (cfg.length) {
    parts.push(`<h3>Configuration and environment</h3>`);
    parts.push(pills(cfg.slice(0, 24)));
    parts.push(para('Filenames only. Ground Control never reads the contents of environment, credential, or key '
      + 'files, so what these configure, and whether they are required, is not known here.', 'note'));
    gaps.push('What the configuration and environment files contain, and which values are required: these are listed by name and deliberately never read.');
  }

  if (!parts.length) return '';
  return section({
    id: 'signals',
    title: 'Loose ends the code admits to',
    label: 'TODOs · tests · uncommitted work',
    bodyHtml: parts.join('\n'),
  });
}

/* --- footer -------------------------------------------------------- */

function renderFooter(d, { nowISO, now, o, gaps, prose }) {
  // The brief keeps its own honest record of what the scan could not establish;
  // fold it in rather than pretending this page discovered everything.
  const fromBrief = arr(d.unknowns)
    .map((u) => toText(u && (u.text ?? u.message ?? u)))
    .filter(Boolean)
    .map((u) => titleCase(clamp(u, 220)));
  // The author's own "I could not determine this" list belongs here too, and
  // ahead of the mechanical gaps: it is the part a reader most needs.
  const fromProse = (prose ? arr(prose.unknowns) : [])
    .map((u) => titleCase(clamp(toText(u), 220)))
    .filter(Boolean);
  const unknowns = dedupe([...fromProse, ...gaps, ...fromBrief]).slice(0, 14);
  unknowns.push('Why any of this was built. Intent is not recoverable from file listings: '
    + 'only the person who wrote it, or a document they wrote, can supply it.');

  const tool = toText(o.tool) || 'Ground Control Forge';
  const local = toText(o.tier) === 'local';
  const colophon = [
    local
      ? `${tool} · local-model tier${o.model ? ` · prose by ${toText(o.model)}` : ''} · assembled ${fmtDate(nowISO)}`
      : `${tool} · data-only tier · assembled ${fmtDate(nowISO)}`,
    d.path ? `Source: ${d.path}` : '',
    'Self-contained: no scripts, no network requests, no external assets.',
  ].filter(Boolean).join('\n');

  const lede = prose
    ? `<p>The measurements on this page were read from the repository. The written passages were drafted from `
      + `those same measurements${o.model ? ` by <strong>${esc(toText(o.model))}</strong>, running on this machine` : ''}, `
      + `and each sentence was checked before it was rendered. The following are still simply absent:</p>`
    : `<p>This is a measurement, not an explanation. It was assembled without a language model and without
running anything, which is why it can be trusted literally, and also why the following are simply absent:</p>`;

  const closing = prose
    ? verificationNote(o)
    : `<p>If you want the explanation as well as the measurements (what the project is for, how the pieces fit
together, and what will bite you), generate the written version, which reads the code as well as counting it.</p>`;

  return `<footer><div class="wrap">
<h2>What this page could not work out</h2>
${lede}
${listHtml(unknowns.map((u) => esc(u)))}
${closing}
<p class="colophon">${esc(colophon).replace(/\n/g, '<br>')}</p>
</div></footer>`;
}

/* ================================================================== *
 * Authored prose (CONTRACT-LOCAL.md §2–§4)
 *
 * The model fills bounded prose slots and nothing else. It never sees the
 * HTML, never supplies a path, a command or a number, and everything it did
 * write has already been through the verification step in lib/local.js; any
 * sentence naming a path or command that could not be traced to this
 * repository was dropped before it reached this file.
 * ================================================================== */

/** Accept the prose object only if something survived verification. */
function normalizeProse(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {
    one_paragraph: toText(p.one_paragraph).trim(),
    core_idea: toText(p.core_idea).trim(),
    how_it_works: toText(p.how_it_works).trim(),
    current_state: toText(p.current_state).trim(),
    gotchas: arr(p.gotchas).map((g) => toText(g).trim()).filter(Boolean),
    unknowns: arr(p.unknowns).map((g) => toText(g).trim()).filter(Boolean),
    start_here: toText(p.start_here).trim(),
  };
  const any = out.one_paragraph || out.core_idea || out.how_it_works
    || out.current_state || out.start_here || out.gotchas.length || out.unknowns.length;
  return any ? out : null;
}

/** Split a prose blob into paragraphs and escape each one. */
function proseHtml(text) {
  return toText(text)
    .split(/\n{2,}/)
    .map((chunk) => chunk.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((chunk) => para(chunk))
    .join('\n');
}

/**
 * CONTRACT-LOCAL.md §4: say who wrote it, plainly, near the top. Locally
 * drafted prose is never presented as if a person or a frontier model wrote it.
 */
function provenanceCallout(o, hasProse = true) {
  const model = toText(o.model);
  const line = toText(o.provenance)
    || `Prose drafted locally by ${model || 'a local model'}; every path, command and figure on this page is read directly from the repository.`;
  if (!hasProse) {
    // The local tier ran, but nothing it wrote survived verification. Say that
    // rather than letting the page imply no model was ever involved.
    return calloutHtml({
      heading: 'Who wrote this page',
      paragraphsHtml: [
        `A local model${model ? ` (${esc(model)})` : ''} was asked to draft the written sections of this page, and `
        + 'nothing it produced could be traced back to this repository, so none of it was rendered. '
        + 'What remains was measured directly from the files and the git history: no sentence below was written by a model.',
      ],
    });
  }
  const ps = [esc(line)];
  ps.push('The written passages below are the model\'s, working only from a brief assembled by reading this '
    + 'repository. Everything else (the counts, the composition bar, the commit heatmap, the document index, '
    + 'the run commands, the directory map) is rendered straight from that brief and was never routed through '
    + 'the model. Before rendering, every file path and command in the prose was checked against the repository, '
    + 'and any sentence naming something that could not be traced was removed.');
  return calloutHtml({ heading: 'Who wrote this page', paragraphsHtml: ps });
}

/** The closing note about what verification removed (contract §4). */
function verificationNote(o) {
  const v = (o.verification && typeof o.verification === 'object') ? o.verification : null;
  const dropped = arr(v && v.strippedSentences).length;
  const checked = arr(v && v.mentioned).length;
  const bits = [];
  if (dropped > 0) {
    bits.push(`${fmtInt(dropped)} sentence${dropped === 1 ? '' : 's'} written for this page ${dropped === 1 ? 'was' : 'were'} `
      + `removed before you saw ${dropped === 1 ? 'it' : 'them'}: ${dropped === 1 ? 'it named' : 'they named'} a file path or command `
      + 'that could not be traced to this repository. A shorter paragraph is worth more than a confident wrong path.');
  } else if (checked === 1) {
    bits.push('The one file path named in the prose above was traced back to this repository before the page '
      + 'was rendered. Nothing had to be removed.');
  } else if (checked > 1) {
    bits.push(`All ${fmtInt(checked)} of the file paths and commands named in the prose above were traced back `
      + 'to this repository before the page was rendered. Nothing had to be removed.');
  } else {
    bits.push('The prose above names no file paths or commands, so there was nothing for the verification step to remove.');
  }
  const emptied = arr(v && v.emptiedFields).length;
  if (emptied > 0) {
    bits.push(`${fmtInt(emptied)} section${emptied === 1 ? '' : 's'} ${emptied === 1 ? 'is' : 'are'} missing entirely for the same reason: `
      + 'nothing survived, and an empty section is more honest than a padded one.');
  }
  return `<p>${bits.map((b) => esc(b)).join(' ')}</p>`;
}

/** 1. What this is, and why it exists. */
function sectionWhatThisIs(prose) {
  if (!prose) return '';
  const body = [proseHtml(prose.one_paragraph), proseHtml(prose.core_idea)].filter(Boolean).join('\n');
  if (!body) return '';
  return section({
    id: 'what-this-is',
    title: 'What this is',
    label: 'In one paragraph · why it exists',
    bodyHtml: body,
  });
}

/** 2. Architecture in prose, sitting directly under the directory map. */
function sectionHowItWorks(prose) {
  if (!prose) return '';
  const body = proseHtml(prose.how_it_works);
  if (!body) return '';
  return section({
    id: 'how-it-works',
    title: 'How it fits together',
    label: 'Architecture, in prose',
    bodyHtml: [
      body,
      para('Written from the brief above, not from running anything. Any path named here appears in the '
        + 'repository; sentences naming one that did not were removed.', 'note'),
    ].join('\n'),
  });
}

/** 3. Honest current state plus the landmines. */
function sectionStateOfPlay(prose) {
  if (!prose) return '';
  const parts = [];
  const state = proseHtml(prose.current_state);
  if (state) parts.push(state);
  if (prose.gotchas.length) {
    parts.push('<h3>What will bite you</h3>');
    parts.push(list(prose.gotchas));
  }
  if (!parts.length) return '';
  return section({
    id: 'state-of-play',
    title: 'What state it is in',
    label: prose.gotchas.length ? `Honestly · ${fmtInt(prose.gotchas.length)} gotcha${prose.gotchas.length === 1 ? '' : 's'}` : 'Honestly, including what is unfinished',
    bodyHtml: parts.join('\n'),
  });
}

/** 4. Picking it up again. */
function sectionStartHere(prose) {
  if (!prose) return '';
  const body = proseHtml(prose.start_here);
  if (!body) return '';
  return section({
    id: 'start-here',
    title: 'If you are picking this up again',
    label: 'Start here',
    bodyHtml: body,
  });
}

/* --- helpers ------------------------------------------------------- */

/** Unique strings, comparing on a loose normalisation so near-dupes collapse. */
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = toText(item).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** "17 August 2026 (2 days ago)", or '' when the value will not parse. */
function dateWithAge(iso, now) {
  const date = fmtDate(iso);
  if (!date) return '';
  const age = relative(iso, now);
  return age ? `${date} (${age})` : date;
}

function titleCase(s) {
  const t = toText(s).trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

function shortenPath(p) {
  const s = toText(p);
  if (s.length <= 34) return s;
  const parts = s.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : clamp(s, 34);
}
