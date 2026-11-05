// Graph-build-time route resolution over the extraction cache (no file I/O).
// Resolves what one file cannot: cross-file constants, base-class prefixes, registration-function call sites,
// application prefixes from configuration, conventional routes. Every resolution step is recorded; anything that
// cannot be resolved stays visible as {?expression} with a reason instead of being guessed.
import path from 'node:path';
import { refact, render, normalizePath, isResolved, join, aspnetTokens } from './model.mjs';
import { REGISTRY, LANGUAGE_NAMES } from './registry.mjs';

const MAX_ALTS = 24;

export function resolveRoutes(cache) {
  const files = Object.keys(cache).sort();
  const consts = new Map(), shortConsts = new Map();
  const classPrefix = new Map();
  const callSites = new Map();
  const conventions = [], appPaths = [], configs = [];
  const deps = [];
  for (const rel of files) {
    const x = cache[rel].x;
    if (!x) continue;
    for (const k of x.consts || []) {
      (consts.get(k.qual) || consts.set(k.qual, []).get(k.qual)).push({ ...k, file: rel });
      (shortConsts.get(k.name) || shortConsts.set(k.name, []).get(k.name)).push({ ...k, file: rel });
    }
    for (const c of x.routeClasses || []) (classPrefix.get(c.name) || classPrefix.set(c.name, []).get(c.name)).push({ ...c, file: rel });
    for (const s of x.routeCalls || []) (callSites.get(s.fn) || callSites.set(s.fn, []).get(s.fn)).push({ ...s, file: rel });
    for (const c of x.routeConv || []) conventions.push({ ...c, file: rel });
    for (const a of x.routeApp || []) appPaths.push({ ...a, file: rel });
    if (x.routeConfig) configs.push({ file: rel, root: configRoot(rel), map: x.routeConfig });
    for (const d of x.deps || []) deps.push(d.name);
  }
  const quarkus = deps.some((d) => /quarkus/i.test(d));

  const nearestConfig = (rel, key) => {
    const hits = configs.filter((c) => c.map[key] && (c.root === '' || rel.startsWith(c.root + '/'))).sort((a, b) => b.root.length - a.root.length);
    return hits[0] ? { value: hits[0].map[key].value, file: hits[0].file, line: hits[0].map[key].line } : null;
  };
  const near = (list, rel) => list.slice().sort((a, b) => common(b.file, rel) - common(a.file, rel));

  // Resolve one part into alternatives: [{ parts, steps, exact }]
  function resolvePart(p, ctx, depth) {
    if (p.lit !== undefined || depth > 12) return [{ parts: [p], steps: [], exact: true }];
    if (p.ref?.startsWith('config:')) {
      const key = p.ref.slice(7);
      const hit = nearestConfig(ctx.rel, key);
      if (hit) return [{ parts: [{ lit: hit.value }], steps: [`config ${key} = "${hit.value}" (${hit.file}:${hit.line})`], exact: true }];
      if (p.fallback !== undefined) return [{ parts: [{ lit: p.fallback }], steps: [`config ${key} not found; placeholder default "${p.fallback}" used`], exact: false }];
      return [{ parts: [{ ...p, reason: `configuration key ${key} not found in application.properties/yml` }], steps: [], exact: false }];
    }
    if (p.ref) {
      let hits = [];
      let exact = true;
      // Lexical scope first: a reference inside class A.B tries A.B.ref, A.ref, ref in the same file.
      if (ctx.scope) { const chain = ctx.scope.split('.'); for (let i = chain.length; i >= 0 && !hits.length; i--) hits = (consts.get([...chain.slice(0, i), p.ref].join('.')) || []).filter((h) => h.file === ctx.rel); }
      if (!hits.length) hits = consts.get(p.ref) || [];
      if (!hits.length) {
        // Qualified suffix (Namespace.Class.Name), Java static import, or unique short name (C# using static).
        const tail = p.ref.split('.').slice(-2).join('.');
        hits = consts.get(tail) || [];
        if (!hits.length && !p.ref.includes('.')) {
          const imp = (cache[ctx.rel]?.x?.imports || []).map((i) => i.spec).find((s) => s.endsWith('.' + p.ref));
          if (imp) hits = consts.get(imp.split('.').slice(-2).join('.')) || [];
          if (!hits.length) { hits = shortConsts.get(p.ref) || []; exact = false; }
        }
      }
      if (!hits.length) return [{ parts: [p], steps: [], exact: false }];
      const best = near(hits, ctx.rel)[0];
      if (hits.length > 1 && new Set(hits.map((h) => JSON.stringify(h.parts))).size > 1) exact = false;
      const inner = resolveExpr(best.parts, { ...ctx, rel: best.file, scope: best.qual.split('.').slice(0, -1).join('.') }, depth + 1);
      return inner.map((alt) => ({ parts: alt.parts, steps: [`constant ${best.qual} (${best.file}:${best.line})`, ...alt.steps], exact: exact && alt.exact }));
    }
    if (p.param) {
      const [fn, key] = p.param.split('#');
      const sites = (callSites.get(fn) || []).filter((s) => s.args[key] !== undefined);
      if (!sites.length) return [{ parts: [p], steps: [], exact: false }];
      const multiDecl = (ctx.fnDecls?.get(fn) || 0) > 1;
      const out = [];
      for (const s of sites) for (const alt of resolveExpr(s.args[key], { ...ctx, rel: s.file }, depth + 1))
        out.push({ parts: alt.parts, steps: [`called from ${s.file}:${s.line} (${fn})`, ...alt.steps], exact: alt.exact && !multiDecl });
      return out;
    }
    if (p.base) {
      const hits = near(classPrefix.get(p.base) || [], ctx.rel);
      if (!hits.length) return [{ parts: [], steps: [`base class ${p.base} not in the repository; assumed to add no prefix`], exact: false }];
      const b = hits[0];
      if (!b.prefixes) {
        const parent = b.bases.find((n) => classPrefix.has(n));
        if (parent) return resolvePart({ base: parent }, ctx, depth + 1).map((a) => ({ ...a, steps: [`inherits through ${p.base}`, ...a.steps] }));
        return [{ parts: [], steps: [`base class ${p.base} (${b.file}:${b.line}) declares no prefix`], exact: true }];
      }
      const out = [];
      for (const pre of b.prefixes) for (const alt of resolveExpr(pre, { ...ctx, rel: b.file }, depth + 1)) out.push({ parts: alt.parts, steps: [`prefix inherited from ${p.base} (${b.file}:${b.line})`, ...alt.steps], exact: alt.exact });
      return out;
    }
    return [{ parts: [p], steps: [], exact: !p.dyn && !p.soft }];
  }
  function resolveExpr(expr, ctx, depth = 0) {
    let alts = [{ parts: [], steps: [], exact: true }];
    for (const p of expr) {
      const options = resolvePart(p, ctx, depth);
      const next = [];
      for (const a of alts) for (const o of options) if (next.length < MAX_ALTS) next.push({ parts: [...a.parts, ...o.parts], steps: [...a.steps, ...o.steps], exact: a.exact && o.exact });
      alts = next;
    }
    return alts;
  }

  // Application-level prefix per framework (configuration or @ApplicationPath).
  function appPrefix(f, rel) {
    const steps = [];
    let parts = [], exact = true;
    const cfgKeys = { spring: ['server.servlet.context-path', 'server.context-path', 'spring.mvc.servlet.path', 'spring.webflux.base-path'], 'jax-rs': ['quarkus.http.root-path', 'quarkus.rest.path', 'quarkus.resteasy.path'], micronaut: ['micronaut.server.context-path'] }[f.framework] || [];
    for (const k of cfgKeys) { const hit = nearestConfig(rel, k); if (hit && hit.value && hit.value !== '/') { parts = join(parts, [{ lit: hit.value }]); steps.push(`application prefix ${k} = "${hit.value}" (${hit.file}:${hit.line})`); } }
    if (f.framework === 'jax-rs') {
      const ap = near(appPaths.filter((a) => a.framework === 'jax-rs'), rel)[0];
      if (ap) { parts = join(parts, [{ lit: ap.path }]); steps.push(`@ApplicationPath("${ap.path}") (${ap.file}:${ap.line})`); }
      else if (!quarkus) { exact = false; steps.push('no @ApplicationPath found; application root assumed (a web.xml servlet mapping may add a prefix)'); }
    }
    return { parts, steps, exact };
  }

  const fnDecls = new Map();
  for (const rel of files) for (const d of cache[rel].x?.decls || []) if (d.type === 'function') fnDecls.set(d.name, (fnDecls.get(d.name) || 0) + 1);

  const out = [];
  const report = new Map();
  const rep = (fw, language) => {
    const k = `${language}|${fw}`;
    if (!report.has(k)) report.set(k, { language, framework: fw, files: new Set(), controllers: 0, registrations: 0, routes: 0, verified: 0, inferred: 0, unresolved: 0, unsupported: 0, issues: [] });
    return report.get(k);
  };
  for (const rel of files) {
    const x = cache[rel].x;
    if (!x) continue;
    const lang = langName(x, rel);
    for (const fw of x.frameworks || []) rep(fw.id, lang).files.add(rel);
    for (const [fw, s] of Object.entries(x.routeStats || {})) { const r = rep(fw, lang); r.controllers += s.controllers || 0; r.registrations += s.registrations || 0; }
    for (const i of x.routeIssues || []) { const r = rep(i.framework || 'unknown', lang); r.unsupported++; if (r.issues.length < 25) r.issues.push({ file: rel, line: i.line, pattern: i.pattern, reason: i.reason }); }
    for (const f of x.routes || []) {
      const finals = [];
      if (f.conventional) {
        const tpl = conventions.find((c) => c.framework === f.framework && /\{controller/.test(c.template) && (c.kind === 'webapi' || /\{action/.test(c.template)));
        if (!tpl) { const r = rep(f.framework, f.language || lang); r.unsupported++; if (r.issues.length < 25) r.issues.push({ file: rel, line: f.line, pattern: 'conventional routing', reason: `${f.controller}.${f.handler} has no attribute route and no conventional route template was found` }); continue; }
        const ctrl = String(f.controller || '').replace(/Controller$/, '').toLowerCase(), action = String(f.action || f.handler || '').replace(/Async$/, '').toLowerCase();
        let p = tpl.template.replace(/\{controller(=[^}]*)?\}/, ctrl).replace(/\{action(=[^}]*)?\}/, action).replace(/\{area(=[^}]*)?\}\/?/, '');
        // Optional trailing parameters ({id?} or id = RouteParameter.Optional) are dropped when the action does not take them.
        const names = new Set((f.params || []).map((x) => x.name.toLowerCase()));
        p = p.replace(/\/\{(\w+)(\?)?\}$/, (m, n, q) => ((q || (tpl.optional || []).includes(n)) && !names.has(n.toLowerCase()) ? '' : m));
        finals.push({ ...refact(f, [{ lit: p }]), steps: [`conventional route "${tpl.template}" (${tpl.file}:${tpl.line})`], exact: false });
      } else {
        const app = appPrefix(f, rel);
        if (!f.expr && !app.parts.length && app.exact) finals.push({ ...f, steps: [], exact: f.exact !== false });
        else {
          const expr = f.expr || [{ lit: f.path }];
          for (const alt of resolveExpr(expr, { rel, fnDecls })) {
            let full = app.parts.length ? join(app.parts, alt.parts) : alt.parts;
            if (/^aspnet/.test(f.framework || '')) full = aspnetTokens(full, f.controller, f.handler);
            finals.push({ ...refact(f, full), steps: [...app.steps, ...alt.steps], exact: alt.exact && app.exact && f.exact !== false });
          }
        }
      }
      for (const g of finals) {
        const expr = g.expr || [{ lit: g.path }];
        const unresolved = render(expr, g.trailing).unresolved;
        if (g.status === 'partial' && !unresolved.length && f.note) unresolved.push({ knownPrefix: '/', expression: 'mount prefix', reason: f.note, soft: true });
        const confidence = g.status === 'complete' && g.exact && f.exact !== false ? 'verified' : 'inferred';
        const r = rep(g.framework || 'generic', g.language || lang);
        r.routes++; r[confidence]++; if (g.status !== 'complete') r.unresolved++;
        out.push({ ...g, file: rel, confidence, unresolved: unresolved.length ? unresolved : undefined });
      }
    }
  }
  const byId = new Map(REGISTRY.map((a) => [a.id, a]));
  const summary = [...report.values()].map((r) => {
    const a = byId.get(r.framework);
    return { language: LANGUAGE_NAMES[r.language] || r.language, framework: a?.name || r.framework, id: r.framework, status: a?.status || (r.framework === 'generic' ? 'partial' : 'unknown'), files: r.files.size, controllers: r.controllers, registrations: r.registrations,
      routes: r.routes, verified: r.verified, inferred: r.inferred, unresolved: r.unresolved, unsupported: r.unsupported,
      note: r.framework === 'generic' ? 'Routes matched by the generic pattern extractor in files where no framework was recognised' : a && !a.extract ? (a.status === 'partial' ? 'Routes come from the generic pattern extractor (literal paths only; prefixes not composed)' : 'Framework recognised; route extraction is not implemented for it') : r.files.size && !r.routes ? 'Framework detected but no routes were found in its files' : undefined,
      limitations: a?.limitations || [], issues: r.issues };
  }).sort((a, b) => a.language.localeCompare(b.language) || a.framework.localeCompare(b.framework));
  return { routes: out, report: summary };
}

function langName(x, rel) {
  return { cs: 'csharp', java: /\.kts?$/.test(rel) ? 'kotlin' : 'java', php: 'php', py: 'python', go: 'go', rb: 'ruby', rs: 'rust', js: /\.(ts|tsx|mts|cts)$/.test(rel) ? 'typescript' : 'javascript' }[x.lang] || x.lang;
}
// Spring/Quarkus resource roots apply to the module that contains them: a/b/src/main/resources/x → a/b
function configRoot(rel) {
  const i = rel.indexOf('src/main/resources/');
  if (i >= 0) return rel.slice(0, Math.max(0, i - 1));
  const d = path.posix.dirname(rel);
  return d === '.' ? '' : d;
}
function common(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
export { normalizePath, isResolved };
