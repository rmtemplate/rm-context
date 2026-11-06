// Structural parser over the token stream: annotations/attributes/decorators, classes, members, parameters,
// fields, typed member calls, constants. Shared by every language adapter; no type inference beyond declared types.
import { tokenize, brackets } from './tokenize.mjs';

const KEYWORDS = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'new', 'typeof', 'sizeof', 'nameof',
  'base', 'this', 'super', 'fixed', 'when', 'function', 'await', 'throw', 'else', 'case', 'in', 'is', 'as', 'yield', 'do', 'try', 'finally',
  'checked', 'unchecked', 'default', 'select', 'match', 'elif', 'not', 'and', 'or', 'with', 'go', 'defer', 'func', 'fn', 'fun', 'def', 'var', 'val',
  'let', 'const', 'echo', 'print', 'array', 'list', 'isset', 'unset', 'empty', 'require', 'include', 'import', 'export', 'from', 'class', 'interface', 'enum']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'async', 'override', 'virtual', 'abstract', 'final', 'sealed', 'open',
  'suspend', 'synchronized', 'extern', 'unsafe', 'partial', 'readonly', 'native', 'strictfp', 'default', 'inline', 'operator', 'infix', 'tailrec',
  'external', 'actual', 'expect', 'get', 'set', 'pub', 'required', 'lateinit', 'data', 'transient', 'volatile', 'const']);
const SOFT_KW = new Set(['echo', 'print', 'array', 'list', 'isset', 'unset', 'empty', 'require', 'include', 'import', 'export', 'from', 'select', 'match', 'default', 'go', 'when', 'with', 'not', 'and', 'or', 'init', 'constructor']);
const CLASS_KW = new Set(['class', 'interface', 'record', 'struct', 'enum', 'object', 'trait']);
// 'object' declares a type only in Kotlin; in C# and Java it is a type name (object Foo(), Task<object>).
const isClassKw = (v, fam) => CLASS_KW.has(v) && (v !== 'object' || fam === 'kt');
const HEAD_FOLLOW = new Set(['{', '=>', ';', ':', 'throws', 'where', '=', '->']);

export function famOf(lang, rel = '') {
  if (lang === 'java') return /\.kts?$/.test(rel) ? 'kt' : 'java';
  return lang;
}

export function parseFile(text, fam) {
  const toks = tokenize(text, fam);
  const match = brackets(toks);
  const P = { text, fam, toks, match };
  P.src = (a, b) => (a > b || a < 0 ? '' : text.slice(toks[a].s, b + 1 < toks.length ? toks[b + 1].s : text.length).replace(/\s+/g, ' ').trim());
  P.anns = annotations(P);
  P.annAt = new Map(P.anns.map((a) => [a.s, a]));
  P.classes = classes(P);
  P.fns = functions(P);
  P.consts = constants(P);
  return P;
}

// ---------- values ----------
// A value is { list: [value…] } or { parts: [{lit}|{ref}|{dyn,reason}], text }.
export function valueOf(P, a, b) {
  const { toks, match } = P;
  while (a <= b && toks[a].k === 'p' && toks[a].v === '(' && match[a] === b) { a++; b--; }
  if (a > b) return { parts: [], text: '' };
  const t = toks[a];
  // Arrays: Java { … }, Kotlin/PHP/Python/JS [ … ], arrayOf(…), listOf(…), new[] { … }, new string[] { … }, array(…)
  if (t.k === 'p' && (t.v === '{' || t.v === '[') && match[a] === b) return { list: splitTop(P, a + 1, b - 1).map(([x, y]) => valueOf(P, x, y)) };
  if (t.k === 'id' && /^(arrayOf|listOf|setOf|array|List\.of|Arrays\.asList)$/.test(t.v) && toks[a + 1]?.v === '(' && match[a + 1] === b)
    return { list: splitTop(P, a + 2, b - 1).map(([x, y]) => valueOf(P, x, y)) };
  if (t.k === 'id' && t.v === 'new') { const o = findTok(P, a, b, '{'); if (o >= 0 && match[o] === b) return { list: splitTop(P, o + 1, b - 1).map(([x, y]) => valueOf(P, x, y)) }; }
  // Concatenation of literals and references.
  const concat = P.fam === 'php' ? '.' : '+';
  const parts = [];
  let s = a;
  const operand = (x, y) => {
    if (x > y) return;
    const tx = toks[x];
    if (x === y && tx.k === 'str') {
      if (!tx.parts) return parts.push({ lit: tx.v });
      for (const p of tx.parts) parts.push(p.lit !== undefined ? { lit: p.lit } : /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(p.expr) ? { ref: p.expr.replace(/^\$/, '') } : { dyn: p.expr, reason: 'interpolated expression' });
      return;
    }
    if (tx.k === 'id' && tx.v === 'nameof' && toks[x + 1]?.v === '(') { parts.push({ lit: toks[match[x + 1] - 1]?.v || '' }); return; }
    const ref = refName(P, x, y);
    if (ref) return parts.push({ ref });
    parts.push({ dyn: P.src(x, y).slice(0, 80), reason: 'non-constant expression' });
  };
  for (let i = a; i <= b; i++) {
    const ti = toks[i];
    if (ti.k === 'p' && (ti.v === '(' || ti.v === '[' || ti.v === '{') && match[i] > i) { i = match[i]; continue; }
    if (ti.k === 'p' && ti.v === concat) { operand(s, i - 1); s = i + 1; }
  }
  operand(s, b);
  return { parts, text: P.src(a, b) };
}

// Dotted/static reference: A, A.B.C, A::B, self::B, static::B, $this->x is not constant.
function refName(P, a, b) {
  const { toks } = P;
  const out = [];
  for (let i = a; i <= b; i++) {
    const t = toks[i];
    if ((i - a) % 2 === 0) { if (t.k !== 'id') return null; out.push(t.v); }
    else if (!(t.k === 'p' && (t.v === '.' || t.v === '::'))) return null;
  }
  if ((b - a) % 2 !== 0) return null;
  return out.join('.').replace(/^(self|static)\./, '');
}

function findTok(P, a, b, v) { for (let i = a; i <= b; i++) if (P.toks[i].v === v && P.toks[i].k === 'p') return i; return -1; }

// Split a token range by top-level commas.
export function splitTop(P, a, b, { angles = false } = {}) {
  const { toks, match } = P;
  const out = [];
  let s = a, ang = 0;
  for (let i = a; i <= b; i++) {
    const t = toks[i];
    if (t.k !== 'p') continue;
    if ((t.v === '(' || t.v === '[' || t.v === '{' || t.v === '#[') && match[i] > i) { i = match[i]; continue; }
    if (angles && t.v === '<') ang++;
    else if (angles && t.v === '>' && ang > 0) ang--;
    else if (t.v === ',' && ang === 0) { if (i > s) out.push([s, i - 1]); s = i + 1; }
  }
  if (b >= s) out.push([s, b]);
  return out;
}

// Arguments of a call/annotation between the brackets at `open`: [{ name?, a, b, value }]
export function args(P, open) {
  const { toks, match } = P;
  const close = match[open];
  if (close < 0) return [];
  return splitTop(P, open + 1, close - 1).map(([a, b]) => {
    let name;
    const t0 = toks[a], t1 = toks[a + 1];
    if (t0?.k === 'id' && t1?.k === 'p' && (t1.v === '=' || (t1.v === ':' && P.fam !== 'py' && P.fam !== 'kt' && P.fam !== 'js')) && a + 1 < b) { name = t0.v; a += 2; }
    return { name, a, b, value: valueOf(P, a, b) };
  });
}

// ---------- annotations ----------
function annotations(P) {
  const { toks, match, fam } = P;
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'p') continue;
    if (t.v === '@' && ['java', 'kt', 'js', 'py'].includes(fam) && toks[i + 1]?.k === 'id') {
      let j = i + 1;
      if (fam === 'kt' && toks[j + 1]?.v === ':' && /^(field|get|set|param|property|file|receiver|setparam|delegate)$/.test(toks[j].v)) j += 2;
      const names = [toks[j].v];
      while (toks[j + 1]?.v === '.' && toks[j + 2]?.k === 'id') { j += 2; names.push(toks[j].v); }
      if (names[0] === 'interface') continue;
      const open = toks[j + 1]?.v === '(' ? j + 1 : -1;
      const e = open >= 0 && match[open] > 0 ? match[open] : j;
      out.push({ name: names[names.length - 1], full: names.join('.'), args: open >= 0 ? args(P, open) : [], line: t.line, s: i, e });
      i = e;
    } else if ((t.v === '#[' && (fam === 'php' || fam === 'rs')) || (t.v === '[' && fam === 'cs' && csAttrPos(P, i))) {
      const close = match[i];
      if (close < 0) continue;
      const items = csAttrItems(P, i + 1, close - 1, fam);
      if (!items) continue;
      for (const it of items) out.push({ ...it, line: toks[it.at].line, s: i, e: close });
      i = close;
    }
  }
  return out;
}

function csAttrPos(P, i) {
  const prev = P.toks[i - 1];
  if (!prev) return true;
  if (prev.k === 'p' && [';', '{', '}', ']', '(', ','].includes(prev.v)) return true;
  return false;
}

// Parses `[A, B(x), return: C]` contents; returns null when it is not an attribute list (e.g. an array literal).
function csAttrItems(P, a, b, fam) {
  const { toks, match } = P;
  if (a > b) return null;
  const items = [];
  for (const [x, y] of splitTop(P, a, b)) {
    let i = x;
    if (toks[i]?.k === 'id' && toks[i + 1]?.v === ':' && /^(assembly|module|return|param|field|method|type|property|event|typevar)$/.test(toks[i].v)) i += 2;
    if (toks[i]?.k !== 'id') return null;
    const names = [toks[i].v];
    while (toks[i + 1]?.v === '.' && toks[i + 2]?.k === 'id') { i += 2; names.push(toks[i].v); }
    if (fam === 'rs' && toks[i + 1]?.v === '=') { items.push({ name: names.pop(), full: names.join('.'), args: [], at: x }); continue; }
    let rest = i + 1;
    let argv = [];
    if (toks[rest]?.v === '(') { argv = args(P, rest); rest = match[rest] + 1; }
    if (rest <= y) return null;
    const name = names[names.length - 1].replace(/Attribute$/, '') || names[names.length - 1];
    items.push({ name, full: names.join('.'), args: argv, at: x });
  }
  return items.length ? items : null;
}

// ---------- classes ----------
function classes(P) {
  const { toks, match, fam } = P;
  if (fam === 'py' || fam === 'rb' || fam === 'go') return [];
  const out = [];
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    if (t.k !== 'id' || !isClassKw(t.v, fam)) continue;
    if (toks[i - 1]?.v === '.' || toks[i - 1]?.v === '::') continue;
    if (t.v === 'enum' && toks[i + 1]?.v === 'class') continue;
    const nameTok = toks[i + 1];
    if (nameTok?.k !== 'id' || KEYWORDS.has(nameTok.v)) continue;
    // Header: up to the body brace (same nesting level) or a terminator.
    let j = i + 2, body = -1, ctorOpen = -1;
    const bases = [];
    let mode = null, baseStart = -1;
    const flushBase = (end) => { if (baseStart >= 0 && end >= baseStart) bases.push(baseOf(P, baseStart, end)); baseStart = -1; };
    let ang = 0;
    for (; j < toks.length; j++) {
      const x = toks[j];
      if (x.k === 'p' && x.v === '<') { ang++; continue; }
      if (x.k === 'p' && x.v === '>' && ang) { ang--; continue; }
      if (ang) continue;
      if (x.k === 'p' && x.v === '(') { if (ctorOpen < 0 && mode === null) ctorOpen = j; j = match[j] > 0 ? match[j] : j; continue; }
      if (x.k === 'p' && x.v === '{') { body = j; break; }
      if (x.k === 'p' && (x.v === ';' || x.v === '}')) break;
      if ((x.k === 'p' && x.v === ':' && mode === null) || (x.k === 'id' && (x.v === 'extends' || x.v === 'implements'))) { flushBase(j - 1); mode = 'base'; baseStart = j + 1; continue; }
      if (x.k === 'id' && x.v === 'where') { flushBase(j - 1); mode = 'where'; continue; }
      if (mode === 'base' && x.k === 'p' && x.v === ',') { flushBase(j - 1); baseStart = j + 1; }
      if (x.k === 'p' && x.v === '=' && fam !== 'cs') break;
    }
    if (mode === 'base') flushBase((body >= 0 ? body : j) - 1);
    const anns = annsBefore(P, i);
    const mods = [];
    for (let k = i - 1; k >= 0 && toks[k].k === 'id' && MODIFIERS.has(toks[k].v); k--) mods.push(toks[k].v);
    out.push({ kind: t.v, name: nameTok.v, mods, line: anns[0]?.line ?? t.line, nameLine: nameTok.line, kwTok: i, body, bodyEnd: body >= 0 ? match[body] : j,
      end: toks[body >= 0 && match[body] > 0 ? match[body] : Math.min(j, toks.length - 1)].line, anns, bases: bases.filter((b) => b.name),
      ctorParams: ctorOpen >= 0 ? params(P, ctorOpen) : [], fields: new Map() });
    if (body < 0) i = j;
  }
  // Nesting and qualified names.
  for (const c of out) {
    const outer = out.filter((o) => o !== c && o.body >= 0 && o.body < c.kwTok && o.bodyEnd > c.kwTok).sort((a, b) => b.body - a.body)[0];
    c.outer = outer || null;
  }
  for (const c of out) { const chain = []; for (let o = c; o; o = o.outer) chain.unshift(o.name); c.qual = chain.join('.'); }
  for (const c of out) if (c.body >= 0) members(P, c);
  for (const c of out) for (const p of c.ctorParams) if (p.type) c.fields.set(p.name, p.type);
  return out;
}

function baseOf(P, a, b) {
  const { toks } = P;
  let i = a;
  while (i <= b && toks[i].k === 'id' && MODIFIERS.has(toks[i].v)) i++;
  const names = [];
  for (; i <= b && toks[i].k === 'id'; i += 2) { names.push(toks[i].v); if (toks[i + 1]?.v !== '.' && toks[i + 1]?.v !== '::' && toks[i + 1]?.v !== '\\') { i++; break; } }
  const lt = findTok(P, a, b, '<');
  const typeArgs = lt >= 0 ? P.src(lt + 1, b).replace(/>[^>]*$/, '').split(',').map((s) => s.trim().replace(/<.*$/, '').split('.').pop()).filter(Boolean) : [];
  return { name: names[names.length - 1] || '', typeArgs };
}

// Annotations that end right before token i (skipping modifiers and other annotations).
function annsBefore(P, i) {
  const { toks } = P;
  const out = [];
  let j = i - 1;
  for (; j >= 0;) {
    const t = toks[j];
    if (t.k === 'id' && (MODIFIERS.has(t.v) || t.v === 'export' || t.v === 'fun' || t.v === 'function' || t.v === 'def')) { j--; continue; }
    const owner = P.anns.filter((a) => a.e === j);
    if (owner.length) { out.unshift(...owner); j = owner[0].s - 1; continue; }
    break;
  }
  return out;
}

// Annotations of a member declaration: everything between the previous member boundary and the name token.
function annsBeforeDecl(P, n) {
  const { toks } = P;
  const out = [];
  let angle = 0; // commas inside generic arguments (Map<String, List<X>>) belong to the return type
  for (let j = n - 1, guard = 0; j >= 0 && guard < 80; guard++) {
    const owner = P.anns.filter((a) => a.e === j);
    if (owner.length) { out.unshift(...owner); j = owner[0].s - 1; continue; }
    const t = toks[j];
    if (t.k === 'p' && /^>+$/.test(t.v)) angle += t.v.length;
    else if (t.k === 'p' && t.v === '<') angle = Math.max(0, angle - 1);
    else if (t.k === 'p' && [';', '{', '}', ')', '=', ','].includes(t.v) && !(t.v === ',' && angle > 0)) break;
    j--;
  }
  return out;
}

// ---------- members ----------
function members(P, cls) {
  const { toks, match, fam } = P;
  cls.methods = [];
  for (let i = cls.body + 1; i < cls.bodyEnd; i++) {
    const t = toks[i];
    const ann = P.annAt.get(i);
    if (ann) { i = ann.e; continue; }
    if (t.k === 'id' && isClassKw(t.v, fam) && toks[i - 1]?.v !== '.') {
      // Nested type: skip its header and body (it is parsed as its own class).
      let j = i + 1;
      while (j < cls.bodyEnd && !(toks[j].k === 'p' && (toks[j].v === '{' || toks[j].v === ';'))) { if (toks[j].v === '(' && match[j] > 0) j = match[j]; j++; }
      i = toks[j]?.v === '{' && match[j] > 0 ? match[j] : j;
      continue;
    }
    if (t.k === 'p' && (t.v === ';' || t.v === '=' || t.v === '{' || t.v === '=>')) fieldBefore(P, cls, i);
    if (t.k === 'p' && t.v === ':' && toks[i - 1]?.k === 'id' && /^(val|var|readonly|private|public|protected|internal|lateinit)$/.test(toks[i - 2]?.v || '')) {
      cls.fields.set(toks[i - 1].v, typeForward(P, i + 1));
    }
    if (t.k === 'p' && t.v === '(') {
      const m = methodAt(P, i, cls);
      if (m) { cls.methods.push(m); i = m.lastTok; continue; }
      if (match[i] > i) i = match[i];
      continue;
    }
    if (t.k === 'p' && (t.v === '{' || t.v === '[') && match[i] > i) i = match[i];
  }
}

function fieldBefore(P, cls, i) {
  const { toks } = P;
  const name = toks[i - 1];
  if (name?.k !== 'id' || KEYWORDS.has(name.v) || MODIFIERS.has(name.v)) return;
  const prev = toks[i - 2];
  if (!prev || !(prev.k === 'id' || prev.v === '>' || prev.v === '?' || prev.v === ']')) return;
  if (prev.k === 'id' && (KEYWORDS.has(prev.v) || MODIFIERS.has(prev.v) || prev.v === 'return')) return;
  const type = typeBackward(P, i - 2);
  if (type) cls.fields.set(name.v.replace(/^\$/, ''), type);
}

// Type tokens ending at j (walk back over identifiers, dots, generics, nullable and array markers).
function typeBackward(P, j) {
  const { toks } = P;
  let k = j, ang = 0;
  for (; k >= 0; k--) {
    const t = toks[k];
    if (t.k === 'p' && t.v === '>') { ang++; continue; }
    if (t.k === 'p' && t.v === '<') { if (!ang) break; ang--; continue; }
    if (ang) continue;
    if (t.k === 'p' && (t.v === '.' || t.v === '?' || t.v === ']' || t.v === '[' || t.v === '::' || t.v === '\\')) continue;
    // Two adjacent identifiers end the type ("@Autowired UserService" stops before "Autowired").
    if (t.k === 'id' && !MODIFIERS.has(t.v) && !KEYWORDS.has(t.v) && !(k < j && toks[k + 1].k === 'id')) continue;
    break;
  }
  return P.src(k + 1, j);
}

function typeForward(P, a) {
  const { toks, match } = P;
  let b = a, ang = 0;
  const line = toks[a]?.line;
  for (; b < toks.length; b++) {
    const t = toks[b];
    if (t.line !== line) break;
    if (t.k === 'p' && t.v === '<') { ang++; continue; }
    if (t.k === 'p' && t.v === '>') { if (ang) ang--; continue; }
    if (ang) continue;
    if (t.k === 'p' && t.v === '(' && match[b] > b) { b = match[b]; continue; }
    if (t.k === 'p' && (t.v === '=' || t.v === ';' || t.v === ',' || t.v === ')' || t.v === '{' || t.v === '}' || t.v === '=>')) break;
    if (t.k === 'id' && (t.v === 'by' || t.v === 'where')) break;
  }
  return P.src(a, b - 1);
}

// Is the "(" at index i the parameter list of a method declaration?
function methodAt(P, i, cls) {
  const { toks, match, fam } = P;
  let n = i - 1;
  if (toks[n]?.v === '>') { let d = 0; for (; n >= 0; n--) { if (toks[n].v === '>') d++; else if (toks[n].v === '<' && --d === 0) break; } n--; }
  const nameTok = toks[n];
  if (nameTok?.k !== 'id') return null;
  let p = n - 1;
  while (p >= 0 && P.anns.some((a) => a.e === p)) p = P.anns.find((a) => a.e === p).s - 1;
  const prev = toks[p];
  // Contextual words (list, print, select, match, …) are ordinary method names after a modifier, type or fun/def.
  const declared = (fam !== 'js' && ['>', ']', '?'].includes(prev?.v)) || prev?.k === 'id' && (MODIFIERS.has(prev.v) || /^(fun|function|def|fn|void)$/.test(prev.v) || !KEYWORDS.has(prev.v)) && prev.v !== 'return' && prev.v !== 'new';
  if (KEYWORDS.has(nameTok.v) && !(SOFT_KW.has(nameTok.v) && declared) && nameTok.v !== 'constructor' && nameTok.v !== 'init') return null;
  let ok = false;
  if (prev && prev.k === 'id' && (prev.v === 'fun' || prev.v === 'function' || prev.v === 'def' || prev.v === 'fn')) ok = true;
  else if (prev && prev.k === 'id' && MODIFIERS.has(prev.v)) ok = true;
  else if (prev && (prev.k === 'id' || prev.v === '>' || prev.v === ']' || prev.v === '?') && !(prev.k === 'id' && KEYWORDS.has(prev.v))) ok = fam !== 'js' || prev.k === 'id' && MODIFIERS.has(prev.v);
  else if (!prev || (prev.k === 'p' && [';', '{', '}', '*'].includes(prev.v)) || P.anns.some((a) => a.e === n - 1)) ok = fam === 'js' || fam === 'kt' || P.anns.some((a) => a.e === n - 1);
  if (fam === 'kt' && prev?.v === '.' ) ok = true; // extension function: fun Route.users()
  if (!ok) return null;
  const close = match[i];
  if (close < 0) return null;
  const after = toks[close + 1];
  if (!after || !(HEAD_FOLLOW.has(after.v) || (after.k === 'id' && (after.v === 'throws' || after.v === 'where')))) {
    if (!(prev?.v === 'fun' || prev?.v === 'function' || prev?.v === 'def')) return null;
  }
  return fnRecord(P, n, i, cls);
}

function fnRecord(P, n, open, cls) {
  const { toks, match, fam } = P;
  const close = match[open];
  let bodyStart = -1, bodyEnd = -1, k = close + 1, retType = '';
  if ((toks[k]?.v === ':' || toks[k]?.v === '->') && fam !== 'cs') { const s = k + 1; while (k < toks.length && !['{', '=', ';', '=>'].includes(toks[k + 1]?.v) && toks[k + 1]?.line === toks[s].line) k++; retType = P.src(s, k); k++; }
  for (; k < toks.length; k++) {
    const t = toks[k];
    if (t.k === 'p' && t.v === '(' && match[k] > k) { k = match[k]; continue; }
    if (t.k === 'p' && t.v === '{') { bodyStart = k; bodyEnd = match[k] > 0 ? match[k] : k; break; }
    if (t.k === 'p' && t.v === ';') { bodyEnd = k; break; }
    if (t.k === 'p' && (t.v === '=>' || (t.v === '=' && fam !== 'cs'))) {
      bodyStart = k;
      let e = k + 1;
      for (; e < toks.length; e++) { const x = toks[e]; if (x.k === 'p' && (x.v === '(' || x.v === '{' || x.v === '[') && match[e] > e) { e = match[e]; continue; } if (x.v === ';' || (fam === 'kt' && toks[e + 1] && toks[e + 1].line > x.line && !/[+.,(=]$/.test(x.v))) break; }
      bodyEnd = Math.min(e, toks.length - 1); break;
    }
    if (t.k === 'p' && t.v === '}') { bodyEnd = k - 1; break; }
  }
  if (bodyEnd < 0) bodyEnd = close;
  const anns = annsBeforeDecl(P, n);
  const mods = [];
  const from = anns.length ? Math.max(...anns.map((x) => x.e)) + 1 : n - 1;
  for (let j = anns.length ? from : n - 1; anns.length ? j < n : j >= 0; anns.length ? j++ : j--) {
    const t = toks[j];
    if (t.k === 'p' && [';', '{', '}', ')', '='].includes(t.v)) { if (anns.length) continue; break; }
    if (t.k === 'id' && MODIFIERS.has(t.v)) mods.push(t.v);
  }
  if (!retType && fam !== 'kt' && fam !== 'js' && fam !== 'py' && fam !== 'php') {
    let j = n - 1;
    if (toks[j]?.k === 'id' && !MODIFIERS.has(toks[j].v) || ['>', ']', '?'].includes(toks[j]?.v)) retType = typeBackward(P, j);
  }
  return { name: nameTok(toks, n), cls: cls || null, nameTok: n, line: toks[n].line, startLine: anns[0]?.line ?? toks[n].line, end: toks[bodyEnd].line,
    open, close, bodyStart, bodyEnd, lastTok: bodyEnd, params: params(P, open), anns, mods, returnType: retType || undefined,
    isStatic: mods.includes('static'), isCtor: !!cls && (toks[n].v === cls.name || toks[n].v === 'constructor' || toks[n].v === '__construct') };
}
const nameTok = (toks, n) => toks[n].v;

export function params(P, open) {
  const { toks, match, fam } = P;
  const close = match[open];
  if (close < 0) return [];
  const out = [];
  for (const [a0, b0] of splitTop(P, open + 1, close - 1, { angles: fam !== 'py' && fam !== 'rb' && fam !== 'php' })) {
    let a = a0, b = b0;
    const anns = P.anns.filter((x) => x.s >= a && x.e <= b);
    if (anns.length) a = Math.max(...anns.map((x) => x.e)) + 1;
    const eq = findTok(P, a, b, '=');
    let hasDefault = false;
    if (eq > a) { b = eq - 1; hasDefault = true; }
    const flags = [];
    while (a <= b && toks[a].k === 'id' && /^(this|ref|out|in|params|final|readonly|private|public|protected|internal|val|var|override|vararg|mut|scoped)$/.test(toks[a].v) && a < b) { flags.push(toks[a].v); a++; }
    if (a > b) continue;
    let name, type;
    const colon = splitColon(P, a, b);
    if (colon >= 0) {
      name = P.src(a, colon - 1); type = P.src(colon + 1, b);
      if (fam === 'rs') { const m = /\(\s*([A-Za-z_]\w*)\s*\)/.exec(name); name = m ? m[1] : name.replace(/^mut\s+/, ''); }
    } else if (fam === 'go') { name = toks[a].v; type = P.src(a + 1, b); }
    else if (fam === 'py' || fam === 'rb' || fam === 'js') { name = toks[a].v; type = ''; }
    else { name = toks[b].k === 'id' ? toks[b].v : P.src(a, b); type = P.src(a, b - 1); }
    name = String(name).replace(/^[$*&]+/, '').replace(/[?]$/, '');
    if (!name || name === 'self' || name === 'cls') { if (name === 'self' || name === 'cls') continue; }
    out.push({ name, type: type || undefined, anns, flags, optional: hasDefault || /\?$/.test(type || ''), line: toks[a0].line });
  }
  return out;
}

function splitColon(P, a, b) {
  for (let i = a; i <= b; i++) { const t = P.toks[i]; if (t.k === 'p' && t.v === ':' ) return i; if (t.k === 'p' && (t.v === '(' || t.v === '<' || t.v === '[') && P.match[i] > i) i = P.match[i]; }
  return -1;
}

// ---------- functions outside classes ----------
function functions(P) {
  const { toks, match, fam } = P;
  const out = [];
  for (const c of P.classes) for (const m of c.methods || []) out.push(m);
  const inMember = (i) => out.some((f) => f.bodyStart >= 0 && i > f.open && i <= f.bodyEnd);
  const extOf = new Map();
  if (fam === 'cs') {
    const inClass = (i) => P.classes.some((c) => c.body >= 0 && i > c.body && i < c.bodyEnd);
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].v === '{' && toks[i].k === 'p' && match[i] > i && (inClass(i) || inMember(i))) { i = match[i]; continue; }
      if (!(toks[i].k === 'p' && toks[i].v === '(') || inClass(i)) continue;
      const m = methodAt(P, i, null);
      // record Pay(decimal Amount); and class C(IDep d) are positional type declarations, not local functions
      if (m && isClassKw(toks[m.nameTok - 1]?.v, fam)) continue;
      if (m && !out.some((f) => f.nameTok === m.nameTok)) { out.push(m); i = m.lastTok; }
    }
  }
  for (let i = 0; i < toks.length - 2; i++) {
    const t = toks[i];
    if (t.k !== 'id') continue;
    let open = -1, n = -1;
    if ((t.v === 'func' && fam === 'go') || (t.v === 'fn' && fam === 'rs') || (t.v === 'fun' && fam === 'kt') || (t.v === 'function' && (fam === 'js' || fam === 'php'))) {
      let j = i + 1;
      if (fam === 'go' && toks[j]?.v === '(') j = match[j] + 1; // method receiver
      if (toks[j]?.v === '<') { let d = 0; for (; j < toks.length; j++) { if (toks[j].v === '<') d++; else if (toks[j].v === '>' && --d === 0) break; } j++; }
      let ext;
      while (fam === 'kt' && toks[j]?.k === 'id' && toks[j + 1]?.v === '.') { ext = toks[j].v; j += 2; } // extension receiver
      if (ext) extOf.set(j, ext);
      if (toks[j]?.k === 'id' && (toks[j + 1]?.v === '(' || toks[j + 1]?.v === '<')) { n = j; open = toks[j + 1].v === '(' ? j + 1 : -1; if (open < 0) { let k = j + 1, d = 0; for (; k < toks.length; k++) { if (toks[k].v === '<') d++; else if (toks[k].v === '>' && --d === 0) break; } open = toks[k + 1]?.v === '(' ? k + 1 : -1; } }
    } else if (fam === 'js' && (t.v === 'const' || t.v === 'let' || t.v === 'var') && toks[i + 1]?.k === 'id' && toks[i + 2]?.v === '=') {
      let j = i + 3;
      if (toks[j]?.v === 'async') j++;
      if (toks[j]?.v === '(' && match[j] > 0 && toks[match[j] + 1]?.v === '=>') { n = i + 1; open = j; }
      else if (toks[j]?.v === 'function' && toks[j + 1]?.v === '(') { n = i + 1; open = j + 1; }
    }
    if (open < 0 || n < 0 || inMember(i)) continue;
    if (out.some((f) => f.nameTok === n)) continue;
    const f = fnRecord(P, n, open, null);
    if (extOf.has(n)) f.ext = extOf.get(n);
    if (fam === 'js' && toks[match[open] + 1]?.v === '=>') { const b = match[open] + 2; if (toks[b]?.v === '{') { f.bodyStart = b; f.bodyEnd = match[b]; f.end = toks[match[b]].line; } }
    out.push(f);
  }
  return out;
}

// ---------- constants ----------
function constants(P) {
  const { toks, match, fam, text } = P;
  const out = [];
  const depthAt = braceDepth(toks);
  for (let i = 1; i < toks.length - 1; i++) {
    const t = toks[i];
    if (!(t.k === 'p' && t.v === '=')) continue;
    const name = toks[i - 1];
    if (name.k !== 'id') continue;
    let s = i - 2;
    while (s >= 0 && !(toks[s].k === 'p' && [';', '{', '}', '('].includes(toks[s].v)) && toks[s].line === name.line) s--;
    const kws = new Set(toks.slice(s + 1, i - 1).filter((x) => x.k === 'id').map((x) => x.v));
    const inConstBlock = fam === 'go' && toks[s]?.v === '(' && toks[s - 1]?.v === 'const';
    let ok = false;
    if (fam === 'cs') ok = kws.has('const') || (kws.has('static') && kws.has('readonly'));
    else if (fam === 'java') ok = kws.has('final') && kws.has('static');
    else if (fam === 'kt') ok = kws.has('const') || (kws.has('val') && depthAt[i] === 0);
    else if (fam === 'js') ok = kws.has('const') && depthAt[i] === 0;
    else if (fam === 'go') ok = kws.has('const') || inConstBlock;
    else if (fam === 'rs') ok = kws.has('const') || kws.has('static');
    else if (fam === 'php') ok = kws.has('const');
    else if (fam === 'py' || fam === 'rb') ok = s < 0 || toks[s].line < name.line ? (name.s === 0 || text[name.s - 1] === '\n') : false;
    if (!ok) continue;
    let e = i + 1;
    for (; e < toks.length; e++) {
      const x = toks[e];
      if (x.k === 'p' && (x.v === '(' || x.v === '[' || x.v === '{') && match[e] > e) { e = match[e]; continue; }
      if (x.k === 'p' && (x.v === ';' || x.v === ',' || x.v === ')' || x.v === '}')) break;
      const nx = toks[e + 1];
      if (nx && nx.line > x.line && !(x.k === 'p' && /^[+.]$/.test(x.v)) && !(nx.k === 'p' && /^[+.]$/.test(nx.v))) { e++; break; }
    }
    const v = valueOf(P, i + 1, e - 1);
    if (!v.parts || !v.parts.length || v.parts.some((p) => p.dyn !== undefined)) continue;
    const cls = P.classes.filter((c) => c.body >= 0 && c.body < i && c.bodyEnd > i).sort((a, b) => b.body - a.body)[0];
    out.push({ name: name.v.replace(/^\$/, ''), qual: cls ? `${cls.qual}.${name.v}` : name.v, parts: v.parts, line: name.line });
  }
  return out;
}

function braceDepth(toks) {
  const d = new Int32Array(toks.length);
  let depth = 0;
  for (let i = 0; i < toks.length; i++) { const t = toks[i]; if (t.k === 'p' && t.v === '}') depth = Math.max(0, depth - 1); d[i] = depth; if (t.k === 'p' && t.v === '{') depth++; }
  return d;
}

// Innermost function whose body contains token index i.
export function fnAt(P, i) {
  let best = null;
  for (const f of P.fns) if (f.bodyStart >= 0 && i > f.bodyStart && i <= f.bodyEnd && (!best || f.bodyStart > best.bodyStart)) best = f;
  return best;
}
export function classAt(P, i) {
  let best = null;
  for (const c of P.classes) if (c.body >= 0 && i > c.body && i < c.bodyEnd && (!best || c.body > best.body)) best = c;
  return best;
}

// Member calls on typed receivers inside a function body: svc.Get(…), this.repo.save(…), _db.Users.Add(…).
export function typedCalls(P, f) {
  const { toks } = P;
  if (f.bodyStart < 0) return [];
  const types = new Map();
  for (const [k, v] of f.cls?.fields || []) types.set(k, v);
  for (const p of f.params) if (p.type) types.set(p.name, p.type);
  const out = [];
  for (let i = f.bodyStart; i < f.bodyEnd - 2; i++) {
    let t = toks[i];
    if (t.k !== 'id') continue;
    let j = i;
    if ((t.v === 'this' || t.v === 'self' || t.v === '$this') && (toks[i + 1]?.v === '.' || toks[i + 1]?.v === '->') && toks[i + 2]?.k === 'id') { j = i + 2; t = toks[j]; }
    else if (toks[i - 1]?.v === '.' || toks[i - 1]?.v === '->' || toks[i - 1]?.v === '?.') continue;
    const type = types.get(t.v.replace(/^\$/, ''));
    if (!type) continue;
    const dot = (k) => toks[k]?.k === 'p' && (toks[k].v === '.' || toks[k].v === '?.' || toks[k].v === '->');
    if (dot(j + 1) && toks[j + 2]?.k === 'id') {
      if (toks[j + 3]?.v === '(') out.push({ recv: t.v, type, method: toks[j + 2].v, line: toks[j + 2].line });
      else if (dot(j + 3) && toks[j + 4]?.k === 'id' && toks[j + 5]?.v === '(') out.push({ recv: t.v, type, prop: toks[j + 2].v, method: toks[j + 4].v, line: toks[j + 4].line });
    }
    i = j;
  }
  return out;
}

export const simpleType = (t) => String(t || '').replace(/\?$/, '').replace(/^.*[.\\]/, '').replace(/<.*$/, '').replace(/\[\]$/, '').trim();
export const typeArgsOf = (t) => { const m = /<(.+)>/.exec(String(t || '')); return m ? m[1].split(',').map((s) => simpleType(s.trim())) : []; };
