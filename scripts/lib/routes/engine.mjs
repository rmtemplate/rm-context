// Route intelligence, per file: language → framework detection → parse once → adapters → cached facts.
// Parser failures never abort a scan: they are reported as route issues for the file.
import { famOf, parseFile, typedCalls, simpleType } from './structure.mjs';
import { REGISTRY } from './registry.mjs';
import { springPlaceholders } from './adapters/java.mjs';
import { findSecrets } from '../ignore.mjs';

const STRUCTURAL = new Set(['cs', 'java', 'kt']);
const PATHISH = /^[\w\-./{}:~[\]*?=$<>]{0,200}$/;
const SECRETISH = /key|secret|token|passw|pwd|credential|conn(ection)?str|salt|signature/i;

export function languageOf(fam, rel) {
  return { cs: 'csharp', java: 'java', kt: 'kotlin', php: 'php', py: 'python', go: 'go', rb: 'ruby', rs: 'rust' }[fam] || (/\.(ts|tsx|mts|cts)$/.test(rel) ? 'typescript' : 'javascript');
}

export function analyze(rel, text, lang) {
  const fam = famOf(lang, rel);
  const language = languageOf(fam, rel);
  const F = { rel, text, fam, language };
  let P = null;
  Object.defineProperty(F, 'P', { get: () => (P ||= parseFile(text, fam)) });
  const out = {};
  const detected = [];
  for (const a of REGISTRY) {
    if (!a.langs?.includes(lang) || (a.kotlinOnly && fam !== 'kt') || (a.javaOnly && fam === 'kt') || !a.detect) continue;
    let line = null;
    try { line = a.detect(F); } catch { line = null; }
    if (line) detected.push({ a, line });
  }
  if (!detected.some((d) => d.a.extract) && !STRUCTURAL.has(fam)) {
    if (detected.length) out.frameworks = detected.map(({ a, line }) => ({ id: a.id, line })); // recognised only; no parse needed
    return out;
  }
  try { F.P; } catch (e) { out.routeIssues = [{ line: 1, pattern: 'parser', reason: `parse failed: ${e.message}` }]; return out; }
  if (STRUCTURAL.has(fam)) { out.decls = declsOf(P, fam); out.consts = constsOf(P); }
  for (const { a, line } of detected) {
    (out.frameworks ||= []).push({ id: a.id, line });
    if (!a.extract) continue;
    out.claimed = true;
    let r;
    try { r = a.extract(F); } catch (e) { (out.routeIssues ||= []).push({ framework: a.id, line: 1, pattern: 'adapter', reason: `extraction failed: ${e.message}` }); continue; }
    if (r.routes?.length) (out.routes ||= []).push(...r.routes);
    if (r.callSites?.length) (out.routeCalls ||= []).push(...r.callSites.map((s) => ({ ...s, framework: a.id })));
    if (r.conventions?.length) (out.routeConv ||= []).push(...r.conventions);
    if (r.appPaths?.length) (out.routeApp ||= []).push(...r.appPaths);
    if (r.locators?.length) (out.routeLocators ||= []).push(...r.locators.map((l) => ({ ...l, framework: a.id })));
    if (r.controllerClasses?.length) (out.routeCtrls ||= []).push(...r.controllerClasses.map((c) => ({ ...c, framework: a.id })));
    if (r.issues?.length) (out.routeIssues ||= []).push(...r.issues.map((i) => ({ framework: a.id, ...i })));
    if (r.decls?.length) (out.extraDecls ||= []).push(...r.decls);
    if (r.stats) for (const [k, v] of Object.entries(r.stats)) if (v) ((out.routeStats ||= {})[a.id] ||= {})[k] = v;
  }
  // Class-level prefixes, for base-class inheritance resolved across files.
  if (out.frameworks && P.classes.length) {
    const cls = P.classes.filter((c) => c.kind === 'class' || c.kind === 'interface').map((c) => ({ name: c.name, line: c.nameLine, bases: c.bases.map((b) => b.name), prefixes: classPrefixFacts(c) })).filter((c) => c.prefixes || c.bases.length);
    if (cls.length) out.routeClasses = cls;
  }
  return out;
}

// Prefix annotations a subclass can inherit: [Route] (ASP.NET Core), @RequestMapping (Spring).
function classPrefixFacts(c) {
  const out = [];
  for (const a of c.anns) {
    if (a.name !== 'Route' && a.name !== 'RequestMapping') continue;
    const x = a.args.find((y) => !y.name || /^(value|path|template)$/i.test(y.name));
    if (!x) { out.push([]); continue; }
    // Spring ${prop} placeholders become config references here too, so inherited actions resolve them like the class's own.
    for (const v of x.value.list || [x.value]) if (v.parts) out.push(a.name === 'RequestMapping' ? springPlaceholders(v.parts) : v.parts);
  }
  return out.length ? out : undefined;
}

function declsOf(P, fam) {
  const out = [];
  for (const f of P.fns) {
    if (f.cls) continue;
    const calls = typedCalls(P, f).map((x) => ({ type: simpleType(x.type), method: x.method, prop: x.prop, line: x.line }));
    out.push({ type: 'function', name: f.name, line: f.line, end: f.end, ...(calls.length ? { calls } : {}) });
  }
  for (const c of P.classes) {
    if (c.kind === 'enum' && fam === 'cs') continue;
    const d = { type: 'class', name: c.name, line: c.nameLine, end: c.end, kind: c.kind !== 'class' ? c.kind : undefined };
    if (c.bases.length) d.bases = c.bases.map((b) => (b.typeArgs.length ? `${b.name}<${b.typeArgs.join(',')}>` : b.name));
    const sets = {};
    for (const [k, v] of c.fields) { const m = /^(?:Db|I?Queryable|IDb)Set<\s*([\w.]+)\s*>/.exec(v); if (m) sets[k] = simpleType(m[1]); }
    if (Object.keys(sets).length) d.dbsets = sets;
    // Explicit table mappings: [Table("x")] on the class, and EF fluent Entity<T>().ToTable("x") inside a DbContext.
    const ta = c.anns.find((a) => a.name === 'Table' || a.name === 'TableAttribute');
    const tn = ta && (ta.args.find((x) => !x.name || x.name === 'name')?.value.parts || []).map((p) => p.lit).join('');
    if (tn) d.table = tn;
    if (d.dbsets && c.body >= 0) for (const m of P.src(c.body, c.bodyEnd).matchAll(/Entity<\s*([\w.]+)\s*>\s*\(\s*\)[\s\S]{0,160}?\.ToTable\(\s*"([\w.]+)"/g)) (d.toTables ||= {})[simpleType(m[1])] = m[2];
    out.push(d);
    for (const m of c.methods || []) {
      if (m.isCtor) continue;
      const calls = typedCalls(P, m).map((x) => ({ type: simpleType(x.type), method: x.method, prop: x.prop, line: x.line }));
      out.push({ type: 'function', name: m.name, line: m.line, end: m.end, cls: c.name, ...(calls.length ? { calls } : {}) });
    }
  }
  return out;
}

function constsOf(P) {
  const out = [];
  for (const k of P.consts) {
    if (SECRETISH.test(k.name)) continue;
    if (!k.parts.every((p) => p.ref || (p.lit !== undefined && PATHISH.test(p.lit) && !findSecrets(p.lit).length))) continue;
    out.push({ name: k.name, qual: k.qual, parts: k.parts, line: k.line });
  }
  return out.length ? out : undefined;
}

// Spring Boot / Quarkus / Micronaut configuration keys that hold path prefixes (values never stored otherwise).
const CONFIG_KEYS = /^(server\.servlet\.context-path|spring\.mvc\.servlet\.path|spring\.webflux\.base-path|quarkus\.http\.root-path|quarkus\.resteasy\.path|quarkus\.rest\.path|micronaut\.server\.context-path|server\.context-path)$/;
export function routeConfig(rel, text) {
  const map = {};
  const keep = (k, v, line) => {
    v = String(v).trim().replace(/^['"]|['"]$/g, '');
    if (!/^\/[\w\-./{}]*$/.test(v) && v !== '') return;
    // Any non-secret key with a path-shaped value: placeholders such as ${app.paths.admin} reference arbitrary keys.
    if (CONFIG_KEYS.test(k) || (v.startsWith('/') && !SECRETISH.test(k))) map[k] = { value: v, line };
  };
  if (/\.properties$/.test(rel)) {
    text.split(/\r?\n/).forEach((l, i) => { const m = /^\s*([\w.\-[\]]+)\s*[=:]\s*(.*)$/.exec(l); if (m && !l.trim().startsWith('#')) keep(m[1], m[2], i + 1); });
  } else {
    // ponytail: indentation-based YAML flattening for application.yml; anchors, lists and multi-documents are ignored.
    const stack = [];
    text.split(/\r?\n/).forEach((l, i) => {
      if (/^\s*(#|$)/.test(l) || /^---/.test(l)) return;
      const m = /^(\s*)([\w.\-]+):\s*(.*)$/.exec(l);
      if (!m) return;
      const ind = m[1].length;
      while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
      const key = [...stack.map((s) => s.k), m[2]].join('.');
      if (m[3] && !m[3].startsWith('#')) keep(key, m[3].replace(/\s+#.*$/, ''), i + 1);
      else stack.push({ ind, k: m[2] });
    });
  }
  return Object.keys(map).length ? map : undefined;
}
