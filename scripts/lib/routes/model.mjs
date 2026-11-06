// Normalized route model shared by every adapter.
// A PathExpr is an array of parts: { lit } | { ref: 'Const.Name' } | { param: 'fn#index' } | { base: 'ClassName' } |
// { var: 'name' } (file-local, expanded before caching) | { dyn: 'expr', reason }.
// ponytail: paths are joined with "/" for every framework; framework-specific joins (e.g. none needed so far) can be added here.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

export const lit = (s) => ({ lit: String(s ?? '') });
export const fromValue = (v) => (v?.parts ? v.parts : v?.list ? (v.list[0]?.parts || []) : []);

// Join PathExprs as URL segments.
export function join(...exprs) {
  const out = [];
  for (const e of exprs) {
    if (!e || !e.length) continue;
    if (out.length) out.push({ lit: '/' });
    out.push(...e);
  }
  return out;
}

export function normalizePath(p, keepTrailing = false) {
  let s = String(p).replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && !keepTrailing) s = s.replace(/\/+$/, '');
  return s;
}

// Render a PathExpr to a path string. Unresolved parts become {?expr}; reasons are collected.
// Soft parts (a mount/caller prefix that may or may not exist) are reported but do not change the path text.
export function render(expr, keepTrailing = false) {
  let s = '';
  const unresolved = [];
  let known = '';
  for (const p of expr) {
    if (p.lit !== undefined) { s += p.lit; continue; }
    if (p.soft) { unresolved.push({ knownPrefix: normalizePath(s || '/'), expression: p.dyn ?? (p.param ? `caller of ${p.param.replace(/#\w+$/, '')}` : p.ref), reason: p.reason || reasonOf(p), soft: true }); continue; }
    const label = p.ref ?? p.dyn ?? (p.param ? `caller of ${p.param.replace(/#\w+$/, '')}` : p.base ? `${p.base} prefix` : p.var);
    if (!unresolved.length) known = s;
    unresolved.push({ knownPrefix: normalizePath(known || '/'), expression: label, reason: p.reason || reasonOf(p) });
    s += `{?${String(label).replace(/[{}]/g, '')}}`;
  }
  return { path: normalizePath(s, keepTrailing), unresolved };
}
function reasonOf(p) {
  if (p.ref && /^[a-z_]\w*$/.test(p.ref)) return `${p.ref} is not a constant in the indexed files (a local variable or parameter); its runtime value is unknown`;
  if (p.ref) return 'constant not found in the repository';
  if (p.param) return 'registration function has no resolvable call site';
  if (p.base) return 'base class prefix not found';
  if (p.var) return 'variable not traced to a route group';
  return 'dynamic expression';
}
export const isResolved = (expr) => expr.every((p) => p.lit !== undefined);
// complete: every part known · partial: some literal segment known · unresolved: nothing static is known.
export const statusOf = (expr) => (isResolved(expr) ? 'complete' : expr.some((p) => p.soft) && expr.every((p) => p.lit !== undefined || p.soft) ? 'partial'
  : expr.some((p) => p.lit && p.lit.replace(/\//g, '')) ? 'partial' : 'unresolved');

// Route parameters from a template: {id}, {id:int}, {id?}, {*slug}, {**slug}, {id=1}, :id, :id?, *path, <int:id>, <id>, {name...}
export function pathParams(path) {
  const out = [];
  const seen = new Set();
  const add = (name, extra = {}) => { if (!name || seen.has(name)) return; seen.add(name); out.push({ name, in: 'path', ...extra }); };
  const s = String(path);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let d = 0, j = i;
    for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) break; }
    if (j >= s.length) break;
    const inner = s.slice(i + 1, j);
    i = j;
    const m = /^(\*{0,2})([A-Za-z_][\w-]*)(\.\.\.)?/.exec(inner);
    if (!m) continue; // {?query} expansions and literals
    let rest = inner.slice(m[0].length), optional = false;
    if (rest.endsWith('?')) { optional = true; rest = rest.slice(0, -1); }
    if (rest.startsWith('=')) { optional = true; rest = ''; }
    if (rest && !rest.startsWith(':')) continue;
    const constraint = rest ? rest.slice(1).trim() : undefined;
    add(m[2], { ...(constraint ? { constraint } : {}), ...(optional ? { optional: true } : {}), ...(m[1] || m[3] ? { catchAll: true } : {}) });
  }
  for (const m of String(path).matchAll(/(?:^|\/)[:*]([A-Za-z_]\w*)(\?)?/g)) add(m[1], { ...(m[2] ? { optional: true } : {}), ...(m[0].includes('*') ? { catchAll: true } : {}) });
  for (const m of String(path).matchAll(/<(?:(\w+):)?([A-Za-z_]\w*)(\.\.)?>/g)) add(m[2], { ...(m[1] ? { constraint: m[1] } : {}), ...(m[3] ? { catchAll: true } : {}) });
  return out;
}

export function versionOf(path) {
  const m = /(?:^|\/)v(\d+(?:\.\d+)?)(?=\/|$)/i.exec(String(path));
  return m ? `v${m[1]}` : undefined;
}

// Merge declared handler parameters (with locations) into template parameters.
export function mergeParams(template, declared = []) {
  const out = template.map((p) => ({ ...p }));
  for (const d of declared) {
    if (!d || !d.name || d.in === 'service') continue;
    const t = out.find((p) => p.name.toLowerCase() === (d.bind || d.name).toLowerCase());
    if (t) { if (d.type && !t.type) t.type = d.type; continue; }
    if (d.in === 'path') continue; // declared as path but not in the template: do not invent a segment
    out.push({ name: d.bind || d.name, in: d.in || 'query', ...(d.type ? { type: d.type } : {}), ...(d.optional ? { optional: true } : {}) });
  }
  return out;
}

// Build a cached route fact. `expr` is the full PathExpr (prefixes + local template).
export function fact(o) {
  const { expr, method, line } = o;
  const r = render(expr, o.trailing);
  const declared = o.params || [];
  const f = {
    method: String(method || 'ANY').toUpperCase(), path: r.path, line, end: o.end && o.end >= line ? o.end : undefined,
    framework: o.framework, language: o.language, kind: o.kind && o.kind !== 'http' ? o.kind : undefined,
    template: o.template ?? undefined, controller: o.controller || undefined, handler: o.handler || undefined, handlerLine: o.handlerLine || undefined,
    params: undefined, requestBody: o.requestBody || undefined, responseType: o.responseType || undefined,
    consumes: o.consumes?.length ? o.consumes : undefined, produces: o.produces?.length ? o.produces : undefined,
    auth: o.auth || undefined, apiVersion: o.apiVersion || versionOf(r.path), group: o.group || undefined,
    calls: o.calls?.length ? o.calls : undefined, extraction: o.extraction || 'structural',
    status: statusOf(expr),
    exact: o.exact === false ? false : undefined, note: o.note || undefined, action: o.action || undefined, trailing: o.trailing || undefined,
  };
  if (!isResolved(expr)) f.expr = expr;
  const params = mergeParams(pathParams(r.path), declared);
  if (params.length) f.params = params;
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

// Re-render a fact after its PathExpr was (partly) resolved globally.
export function refact(f, expr, extra = {}) {
  const g = { ...f, ...extra };
  delete g.expr;
  const r = render(expr, f.trailing);
  g.path = r.path;
  g.status = statusOf(expr);
  if (!isResolved(expr)) g.expr = expr;
  const tparams = pathParams(r.path);
  const declared = (f.params || []).filter((p) => p.in !== 'path' || tparams.some((t) => t.name === p.name));
  g.params = mergeParams(tparams, declared.map((p) => ({ ...p })));
  if (!g.params.length) delete g.params;
  if (!g.apiVersion || g.apiVersion === f.apiVersion && versionOf(f.path) === f.apiVersion) { const v = versionOf(r.path); if (v) g.apiVersion = v; }
  return g;
}

export const unresolvedOf = (expr) => render(expr).unresolved;

// ASP.NET [controller] / [action] / [area] tokens. Lower-cased: ASP.NET route matching is case-insensitive and the
// original template is kept in originalTemplate. Applied again after base-class prefixes are resolved.
export function aspnetTokens(expr, controller, action, area) {
  const c = String(controller || '').replace(/Controller$/, '').toLowerCase();
  const a = String(action || '').replace(/Async$/, '').toLowerCase();
  return expr.map((p) => (p.lit === undefined || !p.lit.includes('[') ? p : { lit: p.lit.replace(/\[controller\]/gi, c).replace(/\[action\]/gi, a).replace(/\[area\]/gi, area ? area.toLowerCase() : '[area]') }));
}
