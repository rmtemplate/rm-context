// The two shared extraction strategies. Adapters are tables that parameterise these; no adapter re-implements them.
//   declarative  — class-level prefix + method-level verb annotations/attributes/decorators
//   registration — fluent calls (MapGet, r.GET, router.get) with group variables, mounts, block scopes and
//                  registration functions whose router parameter is supplied by a caller (resolved globally)
import { args, params as parseParams, fnAt, typedCalls, simpleType } from './structure.mjs';
import { fact, refact, join, fromValue, lit } from './model.mjs';

export const callsOf = (P, f) => (f ? typedCalls(P, f).map((c) => ({ type: simpleType(c.type), typeArgs: /<(.+)>/.exec(c.type)?.[1], method: c.method, prop: c.prop, line: c.line })) : []);
const N = (v) => String(v ?? '').replace(/^\$/, '');

// ---------- declarative ----------
export function declarative(P, cfg) {
  const routes = [], issues = [], controllerClasses = [];
  let controllers = 0;
  for (const cls of P.classes) {
    const isCtrl = cfg.isController(cls);
    // An abstract base class is never mapped itself; its actions are emitted as templates that the resolver instantiates
    // for every derived controller (inherited actions, possibly declared in another file).
    const abstract = !isCtrl && cls.kind === 'class' && (cls.mods || []).includes('abstract') && !!cfg.abstractBases;
    if (!isCtrl && !abstract) continue;
    if (isCtrl) { controllers++; controllerClasses.push({ name: cls.name, line: cls.nameLine, methods: (cls.methods || []).map((m) => m.name) }); }
    let prefixes = abstract ? [[]] : cfg.classPrefixes(cls);
    if (!abstract && !prefixes.length && cfg.subResource?.(cls)) prefixes = [[{ locator: cls.name }]];
    else if (!abstract && !prefixes.length && (cls.mods || []).includes('partial')) prefixes = [[{ partialOf: cls.name }]];
    else if (!abstract && !prefixes.length) {
      const base = cls.bases.find((b) => !cfg.frameworkBases?.has(b.name) && !/^I[A-Z]/.test(b.name));
      prefixes = cfg.inheritPrefix && base && cls.kind !== 'interface' ? [[{ base: base.name }]] : [[]];
    }
    for (const m of cls.methods || []) {
      if (cfg.skipMethod?.(m, cls)) continue;
      const rs = cfg.methodRoutes(m, cls);
      if (!rs.length) continue;
      const declared = m.params.map((p) => ({ name: p.name, type: p.type, optional: p.optional, ...cfg.paramIn(p, m) })).filter((p) => !p.skip);
      const body = declared.find((p) => p.in === 'body');
      const meta = cfg.meta?.(m, cls) || {};
      for (const r of rs) for (const pre of r.absolute ? [[]] : prefixes) {
        const local = r.expr || [];
        let expr = r.absolute ? local : join(pre, local);
        if (cfg.tokens) expr = cfg.tokens(expr, cls, m);
        for (const method of r.methods) {
          routes.push(fact({
            expr, method, line: r.line || m.startLine, end: m.end, framework: cfg.framework, language: cfg.language, kind: r.kind,
            template: r.template ?? (local.length ? local.map((p) => p.lit ?? `{${p.ref || p.dyn}}`).join('') : ''),
            controller: cls.name, handler: m.name, handlerLine: m.line, params: declared, requestBody: body?.type ? String(body.type).trim() : meta.requestBody,
            responseType: meta.responseType ?? m.returnType, consumes: r.consumes || meta.consumes, produces: r.produces || meta.produces,
            auth: meta.auth, apiVersion: meta.apiVersion, calls: callsOf(P, m), extraction: r.extraction || 'structural', exact: r.exact ?? meta.exact,
            note: r.note || meta.note, conventional: r.conventional,
          }));
          if (r.conventional) Object.assign(routes[routes.length - 1], { conventional: true, action: m.name });
          if (abstract) Object.assign(routes[routes.length - 1], { abstractBase: true, absolute: !!r.absolute });
        }
      }
    }
  }
  return { routes, issues, controllers, controllerClasses };
}

// ---------- registration ----------
const SEP = new Set(['.', '?.', '::', '->']);

export function registration(P, cfg) {
  const { toks, match } = P;
  const vars = new Map(), varAuth = new Map();
  const scopes = [];
  const routes = [], callSites = [], issues = [];
  let declarations = 0;
  const isCall = (i) => toks[i]?.k === 'id' && toks[i + 1]?.k === 'p' && toks[i + 1].v === '(' && match[i + 1] > 0;
  const callInfo = (i) => ({ name: toks[i].v, nameTok: i, open: i + 1, close: match[i + 1], recvEnd: SEP.has(toks[i - 1]?.v) ? i - 2 : -1, sep: SEP.has(toks[i - 1]?.v) ? toks[i - 1].v : null });
  const scopeAt = (at, pred) => { let best = null; for (const s of scopes) if (at > s.start && at < s.end && (!pred || pred(s)) && (!best || s.start > best.start)) best = s; return best; };
  const implicitPrefix = (at) => {
    const sc = scopeAt(at);
    if (sc) return sc.prefix;
    const f = fnAt(P, at);
    if (f?.ext && cfg.extRoot?.test(f.ext)) return []; // e.g. Ktor's fun Application.module() is the entry point
    if (f?.ext && cfg.extReceiver?.test(f.ext)) return [{ param: `${f.name}#0` }];
    return cfg.implicitTop ? [] : null;
  };
  const argExpr = (call, k) => {
    if (k == null) return [];
    const as = args(P, call.open);
    const a = typeof k === 'string' ? as.find((x) => x.name === k) : as[k];
    if (!a) return [];
    // path("/api") / RequestPredicates.path("/api") wrappers
    if (cfg.unwrap && toks[a.b]?.v === ')' && isCall(match[a.b] - 1) && cfg.unwrap.test(toks[match[a.b] - 1].v)) { const inner = args(P, match[a.b])[0]; return inner ? fromValue(inner.value) : []; }
    return fromValue(a.value);
  };

  function prefixOf(end, at, depth = 0) {
    if (end < 0 || depth > 30) return null;
    const t = toks[end];
    if (t.k === 'p' && t.v === ')') {
      const nameTok = match[end] - 1;
      if (!isCall(nameTok)) return null;
      const c = callInfo(nameTok);
      const root = cfg.roots?.(c, P, args(P, c.open));
      if (root) {
        const own = Array.isArray(root) ? root : [];
        const sc = scopeAt(at, (s) => !s.params.size);
        return sc && cfg.rootInScope ? join(sc.prefix, own) : own;
      }
      const gk = cfg.groups?.[c.name];
      const base = c.recvEnd >= 0 ? prefixOf(c.recvEnd, at, depth + 1) : (cfg.implicit && gk !== undefined ? implicitPrefix(at) : null);
      if (base == null) return null;
      return gk !== undefined ? join(base, argExpr(c, gk)) : base;
    }
    if (t.k === 'id') {
      const v = N(t.v);
      if (cfg.facade?.test(v) && !SEP.has(toks[end - 1]?.v)) return implicitPrefix(at) ?? [];
      if (SEP.has(toks[end - 1]?.v)) {
        // this.app / self.router are fields of the current object; other owners (s.router) are untraced
        if (!/^(this|self|\$this)$/.test(toks[end - 2]?.v || '')) return cfg.receiverOk?.(v) ? [] : null;
      }
      if (vars.has(v)) return [{ var: v }];
      const sc = scopeAt(at, (s) => s.params.has(v));
      if (sc) return sc.prefix;
      const f = fnAt(P, at);
      const idx = f ? f.params.findIndex((p) => N(p.name) === v) : -1;
      if (idx >= 0 && (!cfg.paramReceiver || cfg.paramReceiver(f.params[idx]))) return [{ param: `${f.name}#${idx}`, ...(cfg.softParams ? { soft: true } : {}) }];
      if (cfg.receiverOk?.(v)) return [];
      return null;
    }
    return null;
  }
  function chainHasRouter(end, depth = 0) {
    if (depth > 30) return false;
    const t = toks[end];
    if (t.k === 'p' && t.v === ')') { const n = match[end] - 1; if (!isCall(n)) return false; const c = callInfo(n); if (cfg.roots?.(c, P, args(P, c.open)) || cfg.groups?.[c.name] !== undefined) return true; return c.recvEnd >= 0 && chainHasRouter(c.recvEnd, depth + 1); }
    return t.k === 'id' && vars.has(N(t.v));
  }
  function chainAuth(end, depth = 0) {
    if (end < 0 || depth > 30 || !cfg.authRe) return false;
    const t = toks[end];
    if (t.k === 'p' && t.v === ')') { const n = match[end] - 1; if (!isCall(n)) return false; const c = callInfo(n); return cfg.authRe.test(c.name) || chainAuth(c.recvEnd, depth + 1); }
    if (t.k === 'id') return !!varAuth.get(N(t.v));
    return false;
  }
  // Calls chained after a registration: .RequireAuthorization().WithName("x").WithTags("users")
  function trailing(close) {
    const out = [];
    let k = close + 1;
    while (SEP.has(toks[k]?.v) && isCall(k + 1)) { const c = callInfo(k + 1); out.push({ name: c.name, args: args(P, c.open), open: c.open }); k = c.close + 1; }
    return out;
  }
  function lambdaParams(a, b) {
    const ps = new Set();
    for (let i = a; i <= b; i++) {
      const t = toks[i];
      if (t.k === 'p' && (t.v === '=>' || t.v === '->')) {
        const p = toks[i - 1];
        if (p?.k === 'id') ps.add(N(p.v));
        else if (p?.v === ')') for (const q of parseParams(P, match[i - 1])) ps.add(N(q.name));
        break;
      }
      if (t.k === 'id' && (t.v === 'func' || t.v === 'function' || t.v === 'fn') && toks[i + 1]?.v === '(') { const q = parseParams(P, i + 1)[0]; if (q) ps.add(N(q.name)); break; }
      if (t.k === 'p' && t.v === '|' && P.fam === 'rb') { if (toks[i + 1]?.k === 'id') ps.add(toks[i + 1].v); break; }
    }
    return ps;
  }
  function stmtEnd(i) {
    for (let e = i; e < toks.length; e++) {
      const x = toks[e];
      if (x.k === 'p' && (x.v === '(' || x.v === '[' || x.v === '{') && match[e] > e) { e = match[e]; if (toks[e + 1] && toks[e + 1].line > toks[e].line && !SEP.has(toks[e + 1].v)) return e; continue; }
      if (x.k === 'p' && (x.v === ';' || x.v === '}' || x.v === ')' || x.v === ',')) return e - 1;
      const nx = toks[e + 1];
      if (nx && nx.line > x.line && !SEP.has(nx.v) && !SEP.has(x.v) && !/^[+=(,]$/.test(x.v)) return e;
    }
    return toks.length - 1;
  }

  // Pass 1: variables, mounts and scopes, in source order.
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'p' && (t.v === '=' || t.v === ':=') && toks[i - 1]?.k === 'id' && !(toks[i - 2] && SEP.has(toks[i - 2].v) && !/^(this|self|\$this)$/.test(toks[i - 3]?.v || ''))) {
      const last = stmtEnd(i + 1);
      const p = prefixOf(last, i + 1);
      if (p && (toks[last].v === ')' ? chainHasRouter(last) : vars.has(N(toks[last].v)))) {
        vars.set(N(toks[i - 1].v), p);
        varAuth.set(N(toks[i - 1].v), chainAuth(last));
      }
      continue;
    }
    if (!isCall(i)) continue;
    const c = callInfo(i);
    if (cfg.mounts?.[c.name]) {
      const m = cfg.mounts[c.name];
      const as = args(P, c.open);
      const target = as[m.targetArg < 0 ? as.length + m.targetArg : m.targetArg];
      let pexpr, base;
      if (m.recvPath) {
        // router.route("/api/*").subRouter(api): the prefix is the receiver route's path
        const rc = toks[c.recvEnd]?.v === ')' ? callInfo(match[c.recvEnd] - 1) : null;
        pexpr = rc ? argExpr(rc, 0).map((x) => (x.lit !== undefined ? { lit: x.lit.replace(/\/?\*$/, '') } : x)) : null;
        base = rc && rc.recvEnd >= 0 ? prefixOf(rc.recvEnd, i) : null;
      } else {
        const pathA = as[m.pathArg];
        pexpr = pathA && as.length > 1 && pathA.value.parts?.some((x) => x.lit !== undefined || x.ref) ? fromValue(pathA.value) : null;
        base = c.recvEnd >= 0 ? prefixOf(c.recvEnd, i) : implicitPrefix(i);
      }
      if (!target || !pexpr || base == null) continue;
      // target: a variable, or child.routes() / child.middleware()
      let tv = target.a === target.b && toks[target.a].k === 'id' ? toks[target.a] : null;
      if (!tv && toks[target.a].k === 'id' && SEP.has(toks[target.a + 1]?.v) && isCall(target.a + 2) && match[target.a + 3] === target.b) tv = toks[target.a];
      if (!tv) {
        // nest("/api", api_router()) → the router returned by that function gets the prefix
        if (toks[target.b]?.v === ')' && isCall(match[target.b] - 1)) callSites.push({ fn: toks[match[target.b] - 1].v, args: { ret: join(base, pexpr) }, line: toks[i].line });
        continue;
      }
      vars.set(N(tv.v), join(base, pexpr));
      declarations++;
      continue;
    }
    if (cfg.plugins?.[c.name]) {
      const as = args(P, c.open);
      const fnName = as[0]?.value.parts?.length === 1 ? as[0].value.parts[0].ref : null;
      const base = c.recvEnd >= 0 ? prefixOf(c.recvEnd, i) : null;
      if (fnName && base != null) callSites.push({ fn: fnName.split('.').pop(), args: { 0: join(base, cfg.plugins[c.name](P, as) || []) }, line: toks[i].line });
      continue;
    }
    const sk = cfg.scopes?.[c.name];
    if (sk) {
      const base = c.recvEnd >= 0 ? prefixOf(c.recvEnd, i) : (cfg.implicit ? implicitPrefix(i) ?? [] : null);
      if (base == null) continue;
      const start = c.open;
      let end = c.close;
      if (toks[c.close + 1]?.v === '{' && match[c.close + 1] > 0) end = match[c.close + 1];
      else if (toks[c.close + 1]?.v === 'do') { let d = 0; for (let k = c.close + 1; k < toks.length; k++) { if (toks[k].v === 'do') d++; else if (toks[k].v === 'end' && --d === 0) { end = k; break; } } }
      const pexpr = sk.pathArg == null ? [] : argExpr(c, sk.pathArg);
      if (sk.pathArg != null && !pexpr.length) continue;
      scopes.push({ start, end, prefix: join(base, pexpr), params: lambdaParams(start, end), auth: chainAuth(c.recvEnd) });
      declarations++;
    }
  }

  // Pass 2: route registrations and registration-function call sites.
  for (let i = 0; i < toks.length; i++) {
    if (cfg.implicit && cfg.blockVerbs?.[toks[i].v] && toks[i].k === 'id' && toks[i + 1]?.v === '{' && !SEP.has(toks[i - 1]?.v)) {
      const pre = implicitPrefix(i);
      if (pre != null) { declarations++; routes.push(fact({ expr: pre, method: cfg.blockVerbs[toks[i].v], line: toks[i].line, end: toks[match[i + 1]]?.line, framework: cfg.framework, language: cfg.language, template: '', handler: 'lambda' })); }
      continue;
    }
    if (!isCall(i)) continue;
    const c = callInfo(i);
    const as = args(P, c.open);
    const methods = cfg.verbs(c.name, as, c, P);
    if (methods) {
      const recvPrefix = c.recvEnd >= 0 ? prefixOf(c.recvEnd, i) : (cfg.implicit ? implicitPrefix(i) : null);
      if (recvPrefix == null) continue;
      const pk = cfg.pathArg ? cfg.pathArg(c.name, as) : 0;
      const pa = pk == null ? null : as[pk];
      const recvVar = toks[c.recvEnd]?.k === 'id' ? N(toks[c.recvEnd].v) : null;
      let local;
      if (pa) {
        const v = pa.value;
        if (!v.parts) continue;
        const allDyn = v.parts.every((x) => x.dyn !== undefined);
        if (allDyn && (cfg.literalPathsOnly || (recvVar && cfg.receiverOk?.(recvVar) && !vars.has(recvVar)))) continue;
        local = v.parts;
      } else local = cfg.defaultPath ? cfg.defaultPath(c.name) : [];
      if (local === null) continue;
      declarations++;
      const tail = trailing(c.close);
      const hk = cfg.handlerArg ? cfg.handlerArg(c.name, as) : as.length - 1;
      const h = hk != null && hk !== pk ? as[hk] : null;
      const handler = cfg.handlerOf ? cfg.handlerOf(P, h, as, tail) : handlerOf(P, h);
      const scope = scopeAt(i);
      const auth = tail.some((x) => cfg.authRe?.test(x.name)) || chainAuth(c.recvEnd) || (recvVar && varAuth.get(recvVar)) || scope?.auth;
      const group = tail.find((x) => x.name === 'WithTags' || x.name === 'WithGroupName')?.args[0]?.value.parts?.[0]?.lit;
      const untraced = !!recvVar && !vars.has(recvVar) && !!cfg.receiverOk?.(recvVar) && !scopeAt(i, (s) => s.params.has(recvVar)) && !(fnAt(P, i)?.params.some((p) => N(p.name) === recvVar));
      const ms = cfg.tailMethods ? cfg.tailMethods(tail) || methods : methods;
      for (const method of ms) {
        const f = fact({
          expr: join(recvPrefix, local), method, line: toks[i].line, end: toks[c.close].line, framework: cfg.framework, language: cfg.language,
          kind: cfg.kindOf?.(c.name), template: pa ? pa.value.text.replace(/^['"`@$]+|['"`]+$/g, '') : '',
          handler: handler.name, handlerLine: handler.line, action: handler.action,
          params: handler.params ? handler.params.map((p) => ({ name: N(p.name), type: p.type, optional: p.optional, ...(cfg.paramIn ? cfg.paramIn(p, method) : {}) })).filter((p) => !p.skip) : undefined,
          auth: auth ? 'required' : undefined, group, calls: handler.fn ? callsOf(P, handler.fn) : [], extraction: untraced ? 'regex' : 'structural',
          note: untraced ? `receiver "${recvVar}" is not traced to an application or router instance; a mount prefix may apply` : undefined,
          exact: untraced ? false : undefined, trailing: cfg.trailing,
        });
        if (untraced && f.status === 'complete') f.status = 'partial';
        routes.push(f);
      }
      continue;
    }
    if (cfg.groups?.[c.name] !== undefined || cfg.scopes?.[c.name] || cfg.mounts?.[c.name] || cfg.ignoreCall?.test(c.name)) continue;
    // Registration-function call site: Register(app) / group.MapUsers() / registerRoutes(v1)
    const recv = c.recvEnd >= 0 ? prefixOf(c.recvEnd, i) : null;
    const argPrefixes = {};
    let any = false;
    const offset = recv ? 1 : 0;
    if (recv) { argPrefixes[0] = recv; any = true; }
    as.forEach((a, k) => {
      const tk = toks[a.b];
      if (!(tk.k === 'id' || tk.v === ')')) return;
      if (tk.k === 'id' && a.a !== a.b) return;
      const p = prefixOf(a.b, i);
      const tv = N(tk.v);
      if (p && (tk.k !== 'p' || chainHasRouter(a.b)) && !(tk.k === 'id' && !vars.has(tv) && !p.some((x) => x.param) && !scopeAt(i, (s) => s.params.has(tv)) && !cfg.receiverOk?.(tv))) { argPrefixes[k + offset] = p; any = true; }
    });
    if (!any && cfg.implicitCalls && c.recvEnd < 0 && !as.length) { const pre = scopeAt(i)?.prefix; if (pre) { argPrefixes[0] = pre; any = true; } }
    if (any) callSites.push({ fn: c.name, args: argPrefixes, line: toks[i].line, ext: !!recv });
  }

  // Expand file-local variables and constants before caching.
  const local = new Map();
  for (const k of P.consts) { local.set(k.qual, k.parts); if (!local.has(k.name)) local.set(k.name, k.parts); }
  const expand = (expr, depth = 0) => expr.flatMap((p) => {
    if (depth > 20) return [p];
    if (p.var) { const v = vars.get(p.var); return v ? expand(v, depth + 1) : [p]; }
    if (p.ref && local.has(p.ref)) return expand(local.get(p.ref), depth + 1);
    return [p];
  });
  const done = routes.map((f) => (f.expr ? refact(f, expand(f.expr)) : f));
  return { routes: done, callSites: callSites.map((s) => ({ ...s, args: Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, expand(v)])) })), issues, declarations, expand };
}

// Handler argument → { name, line, params, fn }
export function handlerOf(P, a) {
  if (!a) return {};
  const { toks, match } = P;
  const t = toks[a.a];
  // Lambda: (int id, IUserService svc) => …, async (…) => …, func(c *gin.Context) {…}, (req, res) => {…}
  let i = a.a;
  if (toks[i]?.v === 'async') i++;
  if (toks[i]?.k === 'p' && toks[i].v === '(' && match[i] > 0 && (toks[match[i] + 1]?.v === '=>' || toks[match[i] + 1]?.v === '->')) {
    const ps = parseParams(P, i);
    return { name: 'lambda', line: t.line, params: ps, fn: { params: ps, bodyStart: match[i] + 1, bodyEnd: a.b, cls: null } };
  }
  if (toks[i]?.k === 'id' && (toks[i].v === 'func' || toks[i].v === 'function') && toks[i + 1]?.v === '(') {
    const ps = parseParams(P, i + 1);
    return { name: 'lambda', line: t.line, params: ps, fn: { params: ps, bodyStart: match[i + 1], bodyEnd: a.b, cls: null } };
  }
  // Method group / function reference: GetAll, Handlers.GetAll, handler::list, h.List
  const v = a.value;
  if (v.parts?.length === 1 && v.parts[0].ref) {
    const name = v.parts[0].ref.split('.').pop();
    const fn = P.fns.find((f) => f.name === name);
    return { name: v.parts[0].ref, line: fn?.line, params: fn?.params, fn };
  }
  return {};
}

export const litExpr = (s) => (s == null ? [] : [lit(s)]);
