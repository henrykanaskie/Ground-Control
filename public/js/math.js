/**
 * Math in the chat: LaTeX in, MathML out, typeset by the browser itself.
 *
 * CONTRACT.md allows no npm, no CDN and no external fonts, so this does not
 * ship KaTeX. It doesn't need to: Chrome, Safari and the app's WebKit view all
 * render MathML natively, in the system's math font. This file only
 * translates the LaTeX an agent writes (`$\frac{a}{b}$`, `$$\sum_{i=1}^n i$$`,
 * `\begin{aligned}…`) into MathML elements. Every piece of text it emits is
 * escaped, so the output is safe to set as innerHTML.
 *
 * Two entry points:
 *   toMathML(tex, display)   one expression → a <math> element as a string
 *   renderWithMath(md, render)  markdown with math in it → HTML, by lifting the
 *                            math out before markdown sees it (markdown would
 *                            eat its underscores and backslashes) and putting
 *                            it back, typeset, afterwards.
 */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── symbol tables ────────────────────────────────────────────────────── */

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** Identifiers that are symbols rather than operators: set as <mi>. */
const IDENT = {
  infty: '∞', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ', emptyset: '∅', varnothing: '∅',
  Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘', top: '⊤', bot: '⊥', angle: '∠', triangle: '△',
  square: '□', checkmark: '✓', dagger: '†', ddagger: '‡', degree: '°', prime: '′', imath: 'ı', jmath: 'ȷ',
};

/** Operators and relations: set as <mo>. */
const OPS = {
  cdot: '⋅', times: '×', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', odot: '⊙', wedge: '∧', land: '∧', vee: '∨', lor: '∨', neg: '¬', lnot: '¬',
  cap: '∩', cup: '∪', setminus: '∖', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  ll: '≪', gg: '≫', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  forall: '∀', exists: '∃', nexists: '∄', mid: '∣', parallel: '∥', perp: '⊥',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒',
  Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', impliedby: '⟸', iff: '⟺', mapsto: '↦',
  longrightarrow: '⟶', longleftarrow: '⟵', longmapsto: '⟼', uparrow: '↑', downarrow: '↓',
  Uparrow: '⇑', Downarrow: '⇓', nearrow: '↗', searrow: '↘', hookrightarrow: '↪',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', colon: ':',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', vert: '|', Vert: '‖',
  lbrace: '{', rbrace: '}', backslash: '∖',
};

const OP_CHARS = new Set(Object.values(OPS).concat(['−', '·']));

/** Big operators: limits go under and over in display math. */
const BIG = { sum: '∑', prod: '∏', coprod: '∐', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigvee: '⋁', bigwedge: '⋀' };
const INTEGRALS = { int: '∫', iint: '∬', iiint: '∭', oint: '∮' };

/** Upright function names. The ones in LIMITS take under-limits like ∑. */
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'log', 'ln', 'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'arg', 'deg', 'gcd', 'lcm',
  'Pr', 'dim', 'ker', 'hom', 'argmax', 'argmin', 'mod', 'tr', 'rank', 'sgn', 'var', 'cov']);
const LIMITS = new Set(['lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'argmax', 'argmin', 'det', 'gcd', 'Pr']);

const ACCENTS = { hat: '^', widehat: '^', bar: '¯', overline: '¯', vec: '→', tilde: '~', widetilde: '~', dot: '˙', ddot: '¨', check: 'ˇ', breve: '˘', acute: '´', grave: '`', overrightarrow: '→' };

const SPACES = { ',': '0.1667em', ':': '0.2222em', '>': '0.2222em', ';': '0.2778em', ' ': '0.25em', quad: '1em', qquad: '2em', enspace: '0.5em', thinspace: '0.1667em', '!': '-0.1667em' };

const FENCES = { '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '.': '', '\\{': '{', '\\}': '}', '\\|': '‖',
  '\\langle': '⟨', '\\rangle': '⟩', '\\lfloor': '⌊', '\\rfloor': '⌋', '\\lceil': '⌈', '\\rceil': '⌉', '\\vert': '|', '\\Vert': '‖', '\\lbrace': '{', '\\rbrace': '}', '/': '/' };

/*
 * MathML Core renders only mathvariant="normal", so bold, blackboard and
 * script letters are written as the Unicode math alphabets instead.
 */
const ALPHA_BASE = { bf: [0x1D400, 0x1D41A, 0x1D7CE], it: [0x1D434, 0x1D44E, null], bb: [0x1D538, 0x1D552, 0x1D7D8],
  cal: [0x1D49C, 0x1D4B6, null], frak: [0x1D504, 0x1D51E, null], sf: [0x1D5A0, 0x1D5BA, 0x1D7E2], tt: [0x1D670, 0x1D68A, 0x1D7F6] };
const ALPHA_HOLES = {
  bb: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
  cal: { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' },
  frak: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
  it: { h: 'ℎ' },
};
function styled(ch, style) {
  const holes = ALPHA_HOLES[style] || {};
  if (holes[ch]) return holes[ch];
  const [up, low, dig] = ALPHA_BASE[style] || [];
  const c = ch.charCodeAt(0);
  if (up && c >= 65 && c <= 90) return String.fromCodePoint(up + c - 65);
  if (low && c >= 97 && c <= 122) return String.fromCodePoint(low + c - 97);
  if (dig && c >= 48 && c <= 57) return String.fromCodePoint(dig + c - 48);
  return ch;
}
const STYLE_CMDS = { mathbf: 'bf', boldsymbol: 'bf', bm: 'bf', mathbb: 'bb', mathcal: 'cal', mathscr: 'cal', mathfrak: 'frak', mathsf: 'sf', mathtt: 'tt', mathit: 'it' };

/* ── tokens ───────────────────────────────────────────────────────────── */

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+)\*?|^\\(.)/s.exec(src.slice(i));
      if (!m) { i += 1; continue; }
      out.push({ t: 'cmd', v: m[1] || m[2] });
      i += m[0].length;
      continue;
    }
    if (/\s/.test(c)) { i += 1; out.push({ t: 'sp' }); while (i < src.length && /\s/.test(src[i])) i += 1; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+|^[0-9]+/.exec(src.slice(i));
      if (m) { out.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
    }
    out.push({ t: 'ch', v: c });
    i += 1;
  }
  return out;
}

/* ── parser ───────────────────────────────────────────────────────────── */

class P {
  constructor(src, display) { this.toks = tokenize(src); this.i = 0; this.display = display; }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  skipSp() { while (this.peek() && this.peek().t === 'sp') this.i += 1; }
  isCh(v) { const t = this.peek(); return t && t.t === 'ch' && t.v === v; }
  isCmd(v) { const t = this.peek(); return t && t.t === 'cmd' && t.v === v; }

  /** A whole expression until `stop(token)` says it has ended. */
  expr(stop) {
    const items = [];
    for (;;) {
      const t = this.peek();
      if (!t || (stop && stop(t))) break;
      if (t.t === 'sp') { this.i += 1; continue; }
      const a = this.scripted();
      if (a != null) items.push(a);
    }
    return items;
  }

  /** `{…}` or a single atom: what a ^, _ or \frac takes as an argument. */
  arg() {
    this.skipSp();
    if (this.isCh('{')) {
      this.next();
      const items = this.expr((t) => t.t === 'ch' && t.v === '}');
      this.next();
      return row(items);
    }
    const a = this.atom();
    return a == null ? '<mrow></mrow>' : a;
  }

  /** `{…}` read as raw text, for \text and \begin's name. */
  rawGroup() {
    this.skipSp();
    if (!this.isCh('{')) { const t = this.next(); return t ? (t.v || ' ') : ''; }
    this.next();
    let depth = 1;
    let s = '';
    while (this.peek()) {
      const t = this.next();
      if (t.t === 'ch' && t.v === '{') depth += 1;
      if (t.t === 'ch' && t.v === '}' && --depth === 0) break;
      s += t.t === 'sp' ? ' ' : t.t === 'cmd' ? (/^[A-Za-z]/.test(t.v) ? '\\' + t.v + ' ' : t.v) : t.v;
    }
    return s;
  }

  optArg() {
    this.skipSp();
    if (!this.isCh('[')) return null;
    this.next();
    const items = this.expr((t) => t.t === 'ch' && t.v === ']');
    this.next();
    return row(items);
  }

  /** An atom with any ^ and _ after it, and primes. */
  scripted() {
    let base = this.atom();
    if (base == null) return null;
    // A function name is followed by the invisible "apply function" operator,
    // after its scripts: lim_{x→0} then the ⁡, so the spacing is right.
    const fn = /^<mi data-fn/.test(base);
    const tail = fn ? '<mo>⁡</mo>' : '';
    if (fn) base = base.replace(' data-fn', '');
    const limits = base.startsWith('<mo largeop') || base.startsWith('<mo movablelimits') || base.includes('data-limits');
    let sub = null;
    let sup = null;
    for (;;) {
      this.skipSpIfScript();
      if (this.isCh('^')) { this.next(); sup = this.arg(); continue; }
      if (this.isCh('_')) { this.next(); sub = this.arg(); continue; }
      if (this.isCh("'")) {
        let p = '';
        while (this.isCh("'")) { this.next(); p += '′'; }
        sup = sup ? row([`<mo>${p}</mo>`, sup]) : `<mo>${p}</mo>`;
        continue;
      }
      if (this.isCmd('limits') || this.isCmd('nolimits')) { this.next(); continue; }
      break;
    }
    base = base.replace(' data-limits', '');
    if (!sub && !sup) return base + tail;
    if (limits && this.display) {
      if (sub && sup) return `<munderover>${base}${sub}${sup}</munderover>${tail}`;
      return (sub ? `<munder>${base}${sub}</munder>` : `<mover>${base}${sup}</mover>`) + tail;
    }
    if (sub && sup) return `<msubsup>${base}${sub}${sup}</msubsup>${tail}`;
    return (sub ? `<msub>${base}${sub}</msub>` : `<msup>${base}${sup}</msup>`) + tail;
  }

  skipSpIfScript() {
    let j = this.i;
    while (this.toks[j] && this.toks[j].t === 'sp') j += 1;
    const t = this.toks[j];
    if (t && t.t === 'ch' && (t.v === '^' || t.v === '_')) this.i = j;
  }

  atom() {
    const t = this.next();
    if (!t) return null;
    if (t.t === 'num') return `<mn>${esc(t.v)}</mn>`;
    if (t.t === 'ch') {
      const v = t.v;
      if (v === '{') {
        const items = this.expr((x) => x.t === 'ch' && x.v === '}');
        this.next();
        return row(items);
      }
      if (v === '}') return null;
      if (/[A-Za-z]/.test(v)) return `<mi>${esc(v)}</mi>`;
      if (v === '-') return '<mo>−</mo>';
      if (v === '*') return '<mo>∗</mo>';
      if (v === '~') return '<mspace width="0.25em"></mspace>';
      if (v === '&' || v === '^' || v === '_') return null;
      if (/[()[\]|]/.test(v)) return `<mo stretchy="false">${esc(v)}</mo>`;
      if (/[+=<>/,;:!?.]/.test(v) || OP_CHARS.has(v)) return `<mo>${esc(v)}</mo>`;
      return `<mi>${esc(v)}</mi>`;
    }
    if (t.t === 'sp') return null;
    return this.command(t.v);
  }

  command(name) {
    if (GREEK[name]) return `<mi>${GREEK[name]}</mi>`;
    if (IDENT[name]) return `<mi>${IDENT[name]}</mi>`;
    if (OPS[name]) return `<mo>${OPS[name]}</mo>`;
    if (BIG[name]) return `<mo largeop="true" movablelimits="true">${BIG[name]}</mo>`;
    if (INTEGRALS[name]) return `<mo largeop="true">${INTEGRALS[name]}</mo>`;
    if (FUNCS.has(name)) return `<mi data-fn${LIMITS.has(name) ? ' data-limits' : ''}>${name}</mi>`;
    if (SPACES[name]) return `<mspace width="${SPACES[name]}"></mspace>`;
    if (STYLE_CMDS[name]) {
      const style = STYLE_CMDS[name];
      const raw = this.rawGroup();
      if (/\\/.test(raw)) return new P(raw, this.display).run();
      return `<mi>${esc([...raw.replace(/\s+/g, '')].map((c) => styled(c, style)).join(''))}</mi>`;
    }
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': {
        const a = this.arg(); const b = this.arg();
        return `<mfrac>${a}${b}</mfrac>`;
      }
      case 'binom': case 'dbinom': case 'tbinom': {
        const a = this.arg(); const b = this.arg();
        return `<mrow><mo>(</mo><mfrac linethickness="0">${a}${b}</mfrac><mo>)</mo></mrow>`;
      }
      case 'sqrt': {
        const n = this.optArg();
        const x = this.arg();
        return n ? `<mroot>${x}${n}</mroot>` : `<msqrt>${x}</msqrt>`;
      }
      case 'text': case 'textrm': case 'textit': case 'textbf': case 'textsf': case 'texttt': case 'mbox': case 'hbox': {
        const s = this.rawGroup();
        return `<mtext>${esc(s.replace(/\\([$%&#_{}])/g, '$1'))}</mtext>`;
      }
      case 'mathrm': case 'operatorname': case 'mathop': {
        const s = this.rawGroup().replace(/\s+/g, '');
        return `<mi${name === 'operatorname' ? ' data-fn' : ''}${s.length === 1 ? ' mathvariant="normal"' : ''}>${esc(s)}</mi>`;
      }
      case 'underline': return `<munder accentunder="true">${this.arg()}<mo stretchy="true">_</mo></munder>`;
      case 'overbrace': return `<mover>${this.arg()}<mo stretchy="true">⏞</mo></mover>`;
      case 'underbrace': return `<munder data-limits>${this.arg()}<mo stretchy="true">⏟</mo></munder>`;
      case 'right': return this.fence('right').right || null;
      case 'left': case 'big': case 'Big': case 'bigg': case 'Bigg': case 'bigl': case 'bigr': case 'Bigl': case 'Bigr': case 'middle':
        return this.fence(name);
      case 'begin': return this.env(this.rawGroup().trim());
      case 'end': this.rawGroup(); return null;
      case '\\': case 'newline': case 'cr': return null;
      case '{': return '<mo>{</mo>';
      case '}': return '<mo>}</mo>';
      case '|': return '<mo>‖</mo>';
      case '%': case '$': case '&': case '#': case '_': return `<mi>${esc(name)}</mi>`;
      case 'displaystyle': case 'textstyle': case 'scriptstyle': case 'nonumber': case 'notag': return null;
      case 'label': case 'tag': this.rawGroup(); return null;
      case 'color': case 'textcolor': this.rawGroup(); return this.arg();
      case 'boxed': return `<menclose notation="box">${this.arg()}</menclose>`;
      case 'not': { const a = this.atom(); return a ? a.replace(/<mo>(.)<\/mo>/, '<mo>$1̸</mo>') : '<mo>/</mo>'; }
      case 'stackrel': case 'overset': { const top = this.arg(); const base = this.arg(); return `<mover>${base}${top}</mover>`; }
      case 'underset': { const bot = this.arg(); const base = this.arg(); return `<munder>${base}${bot}</munder>`; }
      default:
        if (ACCENTS[name]) {
          const a = this.arg();
          const stretch = /^(widehat|widetilde|overline|overrightarrow)$/.test(name) ? 'true' : 'false';
          return `<mover accent="true">${a}<mo stretchy="${stretch}">${ACCENTS[name]}</mo></mover>`;
        }
        // Unknown: shown as written, never dropped, so nothing silently vanishes.
        return `<mtext class="math-unknown">\\${esc(name)}</mtext>`;
    }
  }

  /** \left( … \right) as one stretchy pair; \big( as a single fence. */
  fence(kind) {
    this.skipSp();
    const t = this.next();
    const key = !t ? '.' : t.t === 'cmd' ? '\\' + t.v : t.v;
    const glyph = FENCES[key] != null ? FENCES[key] : (OPS[key.slice(1)] || key);
    const mo = glyph ? `<mo stretchy="true" fence="true">${esc(glyph)}</mo>` : '';
    if (kind !== 'left') return kind === 'right' ? { right: mo } : (glyph ? `<mo fence="true" stretchy="false" class="math-big">${esc(glyph)}</mo>` : null);
    const inner = [];
    for (;;) {
      const p = this.peek();
      if (!p) break;
      if (p.t === 'cmd' && p.v === 'right') { this.next(); const r = this.fence('right'); return row([mo, row(inner), r.right]); }
      if (p.t === 'sp') { this.i += 1; continue; }
      const a = this.scripted();
      if (a != null) inner.push(a);
    }
    return row([mo, row(inner)]);
  }

  /** Matrices, cases and aligned equations, as an <mtable>. */
  env(name) {
    const base = name.replace(/\*$/, '');
    let colspec = null;
    if (base === 'array') colspec = this.rawGroup().replace(/[^lcr]/g, '');
    const rows = [[[]]];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.t === 'cmd' && t.v === 'end') { this.next(); this.rawGroup(); break; }
      if (t.t === 'cmd' && (t.v === '\\' || t.v === 'cr')) { this.next(); this.optArg(); rows.push([[]]); continue; }
      if (t.t === 'ch' && t.v === '&') { this.next(); rows[rows.length - 1].push([]); continue; }
      if (t.t === 'sp') { this.i += 1; continue; }
      const a = this.scripted();
      const cells = rows[rows.length - 1];
      if (a != null) cells[cells.length - 1].push(a);
    }
    while (rows.length > 1 && rows[rows.length - 1].every((c) => !c.length)) rows.pop();

    const aligned = /^(aligned|align|split|alignat|alignedat|eqnarray|flalign)$/.test(base);
    const ncols = Math.max(...rows.map((r) => r.length));
    const colAlign = (j) => {
      if (aligned) return j % 2 === 0 ? 'right' : 'left';
      if (base === 'cases') return 'left';
      if (colspec) return { l: 'left', c: 'center', r: 'right' }[colspec[j]] || 'center';
      return 'center';
    };
    const cell = (items, j) => {
      // In aligned columns, the right-hand cell starts with its relation (=):
      // an empty mi keeps it spaced as a binary relation, the way LaTeX does.
      // Children go straight into the cell (it is an implied row): an <mrow>
      // wrapper is laid out as one box and ignores the cell's alignment.
      const body = (aligned && j % 2 === 1 ? ['<mi></mi>'].concat(items) : items).filter(Boolean).join('');
      // Chrome lays a cell's math out ignoring plain `text-align: right`; the
      // -webkit- keywords work there and in WebKit, which also reads columnalign.
      const al = colAlign(j);
      return `<mtd columnalign="${al}" style="text-align:-webkit-${al}${aligned && j % 2 === 1 ? ';padding-left:0' : ''}${aligned && j % 2 === 0 ? ';padding-right:0' : ''}">${body}</mtd>`;
    };
    const trs = rows.map((r) => `<mtr>${Array.from({ length: ncols }, (_, j) => cell(r[j] || [], j)).join('')}</mtr>`).join('');
    const table = `<mtable class="math-${aligned ? 'aligned' : base === 'cases' ? 'cases' : 'matrix'}"${aligned ? ' displaystyle="true"' : ''}>${trs}</mtable>`;
    const wrap = { pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', ''] }[base];
    if (!wrap) return table;
    return row([`<mo stretchy="true" fence="true">${wrap[0]}</mo>`, table, wrap[1] ? `<mo stretchy="true" fence="true">${wrap[1]}</mo>` : '']);
  }

  run() { return row(this.expr(null)); }
}

function row(items) {
  const list = items.filter((x) => x != null && x !== '');
  return list.length === 1 && /^<(mrow|mi|mn|mo|mfrac|msqrt|mroot|mtable|mtext)\b/.test(list[0]) ? list[0] : `<mrow>${list.join('')}</mrow>`;
}

/** One expression as a <math> element. Anything it cannot read stays as code. */
export function toMathML(tex, display = false) {
  const src = String(tex || '').trim();
  try {
    const body = new P(src, display).run();
    return `<math${display ? ' display="block"' : ''} class="gc-math"><semantics>${body}<annotation encoding="application/x-tex">${esc(src)}</annotation></semantics></math>`;
  } catch {
    return `<code class="math-raw">${esc(src)}</code>`;
  }
}

/* ── finding the math in markdown ─────────────────────────────────────── */

const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';

/**
 * Replace each piece of math with a placeholder markdown leaves alone,
 * skipping fenced code and `inline code`, where a $ is just a dollar sign.
 * Inline `$…$` follows Pandoc's rule so prices stay prices: the opening $ is
 * not followed by a space, the closing one not preceded by one nor followed
 * by a digit.
 */
export function extractMath(md) {
  const items = [];
  const put = (tex, display) => { items.push({ tex, display }); return PH_OPEN + (items.length - 1) + PH_CLOSE; };
  const lines = String(md).split('\n');
  let inFence = null;
  const outLines = [];
  let buf = [];
  const flush = () => { if (buf.length) { outLines.push(extractInline(buf.join('\n'), put)); buf = []; } };
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (inFence) {
      outLines.push(line);
      if (f && f[1][0] === inFence[0] && f[1].length >= inFence.length) inFence = null;
      continue;
    }
    if (f) { flush(); inFence = f[1]; outLines.push(line); continue; }
    buf.push(line);
  }
  flush();
  return { text: outLines.join('\n'), items };
}

function extractInline(text, put) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      const m = /^(`+)[\s\S]*?[^`]\1(?!`)|^(`+)\1/.exec(text.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (c === '\\' && text[i + 1] === '$') { out += '\\$'; i += 2; continue; }
    if (c === '\\' && (text[i + 1] === '[' || text[i + 1] === '(')) {
      const close = text[i + 1] === '[' ? '\\]' : '\\)';
      const j = text.indexOf(close, i + 2);
      if (j !== -1) {
        const display = text[i + 1] === '[';
        out += (display ? '\n\n' : '') + put(text.slice(i + 2, j), display) + (display ? '\n\n' : '');
        i = j + 2;
        continue;
      }
    }
    if (c === '$' && text[i + 1] === '$') {
      const j = text.indexOf('$$', i + 2);
      if (j !== -1 && text.slice(i + 2, j).trim()) {
        out += '\n\n' + put(text.slice(i + 2, j), true) + '\n\n';
        i = j + 2;
        continue;
      }
    }
    if (c === '\\' && /^\\begin\{(aligned|align\*?|equation\*?|gather\*?|cases|[pbvBV]?matrix)\}/.test(text.slice(i)) && /(^|\n)\s*$/.test(out)) {
      const env = /^\\begin\{([^}]+)\}/.exec(text.slice(i))[1];
      const endTag = `\\end{${env}}`;
      const j = text.indexOf(endTag, i);
      if (j !== -1) {
        let tex = text.slice(i, j + endTag.length);
        if (/^(equation|gather)/.test(env)) tex = tex.replace(/^\\begin\{[^}]+\}|\\end\{[^}]+\}$/g, '');
        if (env.startsWith('align')) tex = tex.replace(/\\(begin|end)\{align\*?\}/g, '\\$1{aligned}');
        out += '\n\n' + put(tex, true) + '\n\n';
        i = j + endTag.length;
        continue;
      }
    }
    if (c === '$' && text[i + 1] && !/\s/.test(text[i + 1]) && text[i - 1] !== '\\') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\n' && text[j + 1] === '\n') { j = -1; break; }
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '$') break;
        j += 1;
      }
      if (j > i + 1 && j < text.length && !/\s/.test(text[j - 1]) && !/[0-9]/.test(text[j + 1] || '')) {
        out += put(text.slice(i + 1, j), false);
        i = j + 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Put the typeset math back where its placeholders landed in the HTML. */
export function restoreMath(html, items) {
  const re = new RegExp(PH_OPEN + '(\\d+)' + PH_CLOSE, 'g');
  return String(html)
    .replace(new RegExp('<p>\\s*' + PH_OPEN + '(\\d+)' + PH_CLOSE + '\\s*</p>', 'g'), (m, n) => {
      const it = items[Number(n)];
      return it && it.display ? `<div class="math-block">${toMathML(it.tex, true)}</div>` : m;
    })
    .replace(re, (m, n) => {
      const it = items[Number(n)];
      if (!it) return '';
      return it.display ? `<span class="math-block">${toMathML(it.tex, true)}</span>` : toMathML(it.tex, false);
    });
}

/** Markdown with math in it, through `render` (markdown.js), typeset. */
export function renderWithMath(md, render) {
  const { text, items } = extractMath(md);
  const html = render(text);
  return items.length ? restoreMath(html, items) : html;
}

export const _internals = { tokenize, styled };
