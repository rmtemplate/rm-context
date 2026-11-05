// Lexer for route intelligence. Zero dependencies, deterministic.
// Produces tokens with exact line numbers and excludes comments, so commented-out routes are never extracted.
//   k: 'id' | 'str' | 'num' | 'p' (punctuation)   v: text (for strings: the decoded content)   line: 1-based
//   Strings carry `parts` when they interpolate: [{ lit }, { expr }] (C# $"…", JS `…${}`, Kotlin "$x", Python f"…", PHP/Ruby "…").
// ponytail: one hand-written lexer for all families instead of tree-sitter grammars; heredocs, Ruby %-literals and
// nested interpolation are approximated (they rarely hold route templates). Swap in a real grammar if that changes.

const PUNCT3 = new Set(['...', '?.[', '<=>', '**=', '===', '!==']);
const PUNCT2 = new Set(['=>', '->', '::', '?.', ':=', '==', '!=', '<=', '>=', '&&', '||', '??', '#[', '..', '+=', '-=', '++', '--', '<-']);
const ID_START = /[A-Za-z_$À-￿]/;
const ID_PART = /[\w$À-￿]/;

const FAMILY = {
  cs: { line: ['//'], block: true, verbatim: true },
  java: { line: ['//'], block: true, textBlock: true },
  kt: { line: ['//'], block: true, textBlock: true, dollar: true },
  js: { line: ['//'], block: true, template: true, regex: true },
  go: { line: ['//'], block: true, raw: '`' },
  rs: { line: ['//'], block: true, rust: true },
  php: { line: ['//', '#'], block: true, dollar: true, phpAttr: true },
  py: { line: ['#'], python: true },
  rb: { line: ['#'], ruby: true },
};

const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '&&', '||', '=>', 'return', 'typeof', 'case']);

export function tokenize(text, lang) {
  const f = FAMILY[lang] || FAMILY.js;
  const toks = [];
  const n = text.length;
  let i = 0, line = 1;
  const push = (k, v, start, extra) => toks.push({ k, v, line: lineAtStart, s: start, ...extra });
  let lineAtStart = 1;
  const adv = (to) => { for (; i < to && i < n; i++) if (text.charCodeAt(i) === 10) line++; };

  // Read a quoted string starting at i (opening quote at i + prefixLen). Returns decoded value and parts.
  function quoted(prefixLen, q, { escapes = true, interp = null, doubled = false } = {}) {
    const start = i;
    let j = i + prefixLen + q.length;
    let lit = '', parts = null;
    const flush = () => { if (lit) (parts ||= []).push({ lit }); lit = ''; };
    while (j < n) {
      if (text.startsWith(q, j)) {
        if (doubled && text.startsWith(q + q, j)) { lit += q; j += 2 * q.length; continue; }
        j += q.length; break;
      }
      const ch = text[j];
      if (escapes && ch === '\\' && j + 1 < n) {
        const nx = text[j + 1];
        lit += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx; j += 2; continue;
      }
      if (interp === 'brace' && ch === '{') {
        if (text[j + 1] === '{') { lit += '{'; j += 2; continue; }
        const end = closeBrace(j);
        flush(); (parts ||= []).push({ expr: text.slice(j + 1, end).split(/[:,]/)[0].trim() }); j = end + 1; continue;
      }
      if (interp === 'brace' && ch === '}' && text[j + 1] === '}') { lit += '}'; j += 2; continue; }
      if (interp === 'dollarBrace' && ch === '$' && text[j + 1] === '{') {
        const end = closeBrace(j + 1);
        flush(); (parts ||= []).push({ expr: text.slice(j + 2, end).trim() }); j = end + 1; continue;
      }
      if (interp === 'hashBrace' && ch === '#' && text[j + 1] === '{') {
        const end = closeBrace(j + 1);
        flush(); (parts ||= []).push({ expr: text.slice(j + 2, end).trim() }); j = end + 1; continue;
      }
      if (interp === 'dollar' && ch === '$') {
        if (text[j + 1] === '{') { const end = closeBrace(j + 1); flush(); (parts ||= []).push({ expr: text.slice(j + 2, end).trim() }); j = end + 1; continue; }
        const m = /^\$[A-Za-z_][\w]*(?:->[A-Za-z_]\w*)?/.exec(text.slice(j, j + 80));
        if (m) { flush(); (parts ||= []).push({ expr: m[0].slice(1) }); j += m[0].length; continue; }
      }
      lit += ch; j++;
    }
    if (parts) flush();
    const v = parts ? parts.map((p) => p.lit ?? `{${p.expr}}`).join('') : lit;
    lineAtStart = line;
    adv(j);
    toks.push({ k: 'str', v, line: lineAtStart, s: start, ...(parts && parts.some((p) => p.expr !== undefined) ? { parts } : {}) });
  }
  function closeBrace(j) {
    let d = 0;
    for (let k = j; k < n; k++) { if (text[k] === '{') d++; else if (text[k] === '}' && --d === 0) return k; }
    return n - 1;
  }

  while (i < n) {
    const c = text[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') { adv(i + 1); continue; }
    lineAtStart = line;
    // Comments
    if (f.phpAttr && c === '#' && text[i + 1] === '[') { push('p', '#[', i); adv(i + 2); continue; }
    if (f.line.some((p) => text.startsWith(p, i))) { const e = text.indexOf('\n', i); adv(e < 0 ? n : e); continue; }
    if (f.block && c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); adv(e < 0 ? n : e + 2); continue; }
    if (f.ruby && c === '=' && text.startsWith('=begin', i) && (i === 0 || text[i - 1] === '\n')) { const e = text.indexOf('\n=end', i); adv(e < 0 ? n : e + 5); continue; }
    // Strings
    if (f.verbatim) {
      const m = /^(\$+@?|@\$+|@)?("""+|")/.exec(text.slice(i, i + 8));
      if (m && (m[1] || m[2])) {
        const pre = m[1] || '', q = m[2];
        if (q.length >= 3) { quoted(pre.length, q, { escapes: false, interp: pre.includes('$') ? 'brace' : null }); continue; }
        if (pre.includes('@')) { quoted(pre.length, '"', { escapes: false, doubled: true, interp: pre.includes('$') ? 'brace' : null }); continue; }
        quoted(pre.length, '"', { interp: pre.includes('$') ? 'brace' : null }); continue;
      }
      if (c === "'") { quoted(0, "'"); continue; }
    }
    if (f.textBlock && text.startsWith('"""', i)) { quoted(0, '"""', { escapes: !f.dollar, interp: f.dollar ? 'dollar' : null }); continue; }
    if ((f.textBlock || f.dollar) && !f.phpAttr && c === '"') { quoted(0, '"', { interp: f.dollar ? 'dollar' : null }); continue; }
    if (f.textBlock && c === "'") { quoted(0, "'"); continue; }
    if (f.template) {
      if (c === '`') { quoted(0, '`', { interp: 'dollarBrace' }); continue; }
      if (c === '"' || c === "'") { quoted(0, c); continue; }
      if (c === '/' && f.regex) {
        const prev = toks[toks.length - 1];
        if (!prev || (prev.k === 'p' && REGEX_PREV.has(prev.v)) || (prev.k === 'id' && REGEX_PREV.has(prev.v))) {
          let j = i + 1, cls = false;
          for (; j < n && text[j] !== '\n'; j++) {
            if (text[j] === '\\') { j++; continue; }
            if (text[j] === '[') cls = true; else if (text[j] === ']') cls = false; else if (text[j] === '/' && !cls) break;
          }
          if (text[j] === '/') { j++; while (j < n && /[a-z]/i.test(text[j])) j++; push('p', 'regex', i); adv(j); continue; }
        }
      }
    }
    if (f.raw && c === f.raw) { quoted(0, f.raw, { escapes: false }); continue; }
    if (f.raw && (c === '"' || c === "'")) { quoted(0, c); continue; }
    if (f.rust) {
      const m = /^b?r(#*)"/.exec(text.slice(i, i + 12));
      if (m) { quoted(m[0].length - 1, '"' + m[1], { escapes: false }); continue; }
      if (c === '"' || (c === 'b' && text[i + 1] === '"')) { quoted(c === 'b' ? 1 : 0, '"'); continue; }
      if (c === "'") {
        const m2 = /^'(\\.[^']*|[^\\'])'/.exec(text.slice(i, i + 12));
        if (m2) { push('str', m2[1], i); adv(i + m2[0].length); continue; }
        push('p', "'", i); adv(i + 1); continue; // lifetime
      }
    }
    if (f.phpAttr) {
      if (c === "'") { quoted(0, "'"); continue; }
      if (c === '"') { quoted(0, '"', { interp: 'dollar' }); continue; }
      if (text.startsWith('<<<', i)) {
        const m = /^<<<\s*['"]?(\w+)['"]?/.exec(text.slice(i, i + 80));
        if (m) { const e = text.indexOf('\n' + m[1], i); const end = e < 0 ? n : e + m[1].length + 1; push('str', '', i); adv(end); continue; }
      }
    }
    if (f.python) {
      const m = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(text.slice(i, i + 6));
      if (m && (m[1] === '' || !ID_PART.test(text[i - 1] || ' '))) {
        const fstr = /f/i.test(m[1]);
        quoted(m[1].length, m[2], { escapes: !/r/i.test(m[1]), interp: fstr ? 'brace' : null }); continue;
      }
    }
    if (f.ruby) {
      if (c === "'") { quoted(0, "'"); continue; }
      if (c === '"') { quoted(0, '"', { interp: 'hashBrace' }); continue; }
    }
    // Identifiers (C# @verbatim identifiers drop the @)
    if (ID_START.test(c) || (f.verbatim && c === '@' && ID_START.test(text[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && ID_PART.test(text[j])) j++;
      push('id', text.slice(c === '@' ? i + 1 : i, j), i); adv(j); continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j]) && !(text[j] === '.' && text[j + 1] === '.')) j++;
      push('num', text.slice(i, j), i); adv(j); continue;
    }
    const three = text.slice(i, i + 3), two = text.slice(i, i + 2);
    if (PUNCT3.has(three)) { push('p', three, i); adv(i + 3); continue; }
    if (PUNCT2.has(two) && !(two === '#[' && !f.rust)) { push('p', two, i); adv(i + 2); continue; }
    push('p', c, i); adv(i + 1);
  }
  return toks;
}

// Matching bracket index for every (, [, { token (and the reverse).
export function brackets(toks) {
  const match = new Int32Array(toks.length).fill(-1);
  const stack = [];
  const open = { '(': ')', '[': ']', '{': '}', '#[': ']' };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'p') continue;
    if (open[t.v]) stack.push(i);
    else if (t.v === ')' || t.v === ']' || t.v === '}') {
      // Recover from unbalanced input: pop until a compatible opener.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (open[toks[stack[k]].v] === t.v) { const o = stack[k]; stack.length = k; match[o] = i; match[i] = o; break; }
      }
    }
  }
  return match;
}
