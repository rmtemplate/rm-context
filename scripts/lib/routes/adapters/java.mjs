// JVM route adapters (Java and Kotlin).
import { declarative, registration } from '../strategies.mjs';
import { fromValue, lit, fact, join } from '../model.mjs';
import { lineOf } from '../detect.mjs';

const ann = (owner, re) => (owner.anns || []).filter((a) => (typeof re === 'string' ? a.name === re : re.test(a.name)));
const has = (owner, re) => ann(owner, re).length > 0;
const argNamed = (a, ...names) => a.args.find((x) => names.includes(x.name));
const positional = (a) => a.args.find((x) => !x.name);
// Every path value of an annotation (value / path / uri / uris / urlPatterns), arrays expanded.
function paths(a, ...names) {
  const x = names.length ? (a.args.find((y) => names.includes(y.name)) || positional(a)) : positional(a);
  if (!x) return [[]];
  const v = x.value;
  const list = v.list ? v.list : [v];
  return list.length ? list.map((e) => springPlaceholders(fromValue(e))) : [[]];
}
// "${api.prefix}/users" → config reference resolved from application.properties/yml by the resolver.
export function springPlaceholders(expr) {
  return expr.flatMap((p) => {
    if (p.lit === undefined || !p.lit.includes('${')) return [p];
    const out = [];
    let rest = p.lit;
    for (let m; (m = /\$\{([^}:]+)(?::([^}]*))?\}/.exec(rest));) {
      if (m.index) out.push({ lit: rest.slice(0, m.index) });
      out.push({ ref: `config:${m[1]}`, ...(m[2] !== undefined ? { fallback: m[2] } : {}) });
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push({ lit: rest });
    return out;
  });
}
const strs = (v) => (v?.list ? v.list.flatMap(strs) : v?.parts?.map((p) => p.lit ?? p.ref).filter(Boolean) || []);
const authOf = (m, cls, re) => [...ann(m, re), ...ann(cls, re)].map((a) => `${a.name}${a.args.length ? '(' + a.args.map((x) => x.value.text).join(', ') + ')' : ''}`)[0];
const INFRA = /^(HttpServletRequest|HttpServletResponse|ServerHttpRequest|ServerHttpResponse|ServerWebExchange|Principal|Authentication|Model|ModelMap|BindingResult|Errors|Pageable|Sort|Locale|HttpSession|WebRequest|UriComponentsBuilder|RedirectAttributes|SecurityContext|UriInfo|HttpHeaders|Request|AsyncResponse|SseEventSink|Sse|ContainerRequestContext|RoutingContext|HttpRequest|Continuation)\b/;
const SIMPLE = /^(String|Integer|int|Long|long|Boolean|boolean|Double|double|Float|float|Short|short|UUID|LocalDate|LocalDateTime|Instant|BigDecimal|Optional<.*>|List<(String|Long|Integer|UUID)>)\??$/;

// ---------- Spring MVC / WebFlux annotations ----------
const SPRING_VERB = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE' };
function spring(P, language) {
  return declarative(P, {
    framework: 'spring', language, inheritPrefix: true, frameworkBases: new Set(), abstractBases: true,
    isController: (c) => !has(c, /^(FeignClient|HttpExchange|RepositoryRestResource)$/) && (has(c, /^(RestController|Controller)$/) || (has(c, 'RequestMapping') && c.kind === 'interface') || ((c.methods || []).some((m) => has(m, /^(Get|Post|Put|Patch|Delete|Request)Mapping$/)) && c.kind === 'interface')),
    classPrefixes: (c) => ann(c, 'RequestMapping').flatMap((a) => paths(a, 'value', 'path')),
    methodRoutes(m, cls) {
      const out = [];
      for (const a of ann(m, /^(Get|Post|Put|Patch|Delete|Request)Mapping$/)) {
        let methods = SPRING_VERB[a.name] ? [SPRING_VERB[a.name]] : strs(argNamed(a, 'method')?.value).map((s) => s.split('.').pop().toUpperCase());
        if (!methods.length) methods = ['ANY'];
        const produces = strs(argNamed(a, 'produces')?.value), consumes = strs(argNamed(a, 'consumes')?.value);
        for (const e of paths(a, 'value', 'path')) out.push({ methods, expr: e, line: a.line, produces, consumes, ...(cls.kind === 'interface' ? { exact: false, note: 'declared on an interface; exposed by the implementing controller' } : {}) });
      }
      return out;
    },
    paramIn(p) {
      const a = (p.anns || [])[0];
      const bind = a && (argNamed(a, 'value', 'name')?.value.parts?.[0]?.lit || positional(a)?.value.parts?.[0]?.lit);
      const optional = a && (argNamed(a, 'required')?.value.text === 'false' || !!argNamed(a, 'defaultValue'));
      const map = { PathVariable: 'path', RequestParam: 'query', RequestBody: 'body', RequestHeader: 'header', CookieValue: 'cookie', RequestPart: 'form', ModelAttribute: 'query', MatrixVariable: 'path' };
      if (a && map[a.name]) return { in: map[a.name], ...(bind ? { bind } : {}), ...(optional ? { optional: true } : {}) };
      const t = String(p.type || '');
      if (!t || INFRA.test(t) || (p.anns || []).some((x) => /^(AuthenticationPrincipal|CurrentUser|Valid|Validated)$/.test(x.name)) && !SIMPLE.test(t)) return { skip: true };
      if (SIMPLE.test(t)) return { in: 'query' };
      return { skip: true };
    },
    meta: (m, cls) => ({ auth: authOf(m, cls, /^(PreAuthorize|Secured|RolesAllowed|PostAuthorize)$/), responseType: m.returnType }),
  });
}

// ---------- Spring WebFlux functional routing ----------
const FN_VERBS = { GET: ['GET'], POST: ['POST'], PUT: ['PUT'], PATCH: ['PATCH'], DELETE: ['DELETE'], HEAD: ['HEAD'], OPTIONS: ['OPTIONS'] };
function webfluxFunctional(P, language) {
  return registration(P, {
    framework: 'spring-webflux-fn', language, implicit: true, implicitTop: true, rootInScope: true, facade: /^(RequestPredicates|RouterFunctions|GraphQlRequestPredicates)$/,
    unwrap: /^path$/,
    roots: (c, P, as) => (c.name === 'route' && !as.length) || c.name === 'coRouter' || c.name === 'router',
    scopes: { nest: { pathArg: 0 }, path: { pathArg: 0 }, andNest: { pathArg: 0 } },
    verbs: (name, as) => (FN_VERBS[name] && as.length >= 1 && as[0].value.parts?.some((x) => x.lit !== undefined || x.ref) ? FN_VERBS[name] : null),
    handlerArg: (name, as) => (as.length > 1 ? as.length - 1 : null),
    literalPathsOnly: true,
  });
}

// ---------- JAX-RS / Jakarta REST (incl. Quarkus REST, RESTEasy) ----------
const JAXRS_VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
function jaxrs(P, language) {
  return declarative(P, {
    framework: 'jax-rs', language, inheritPrefix: false,
    isController: (c) => has(c, 'Path') || (c.methods || []).some((m) => has(m, JAXRS_VERB)),
    classPrefixes: (c) => ann(c, 'Path').flatMap((a) => paths(a, 'value')),
    subResource: (c) => !has(c, 'Path'),
    methodRoutes(m, cls) {
      const verbs = ann(m, JAXRS_VERB).map((a) => a.name);
      const mp = ann(m, 'Path');
      if (!verbs.length) return [];
      const expr = mp.length ? paths(mp[0], 'value')[0] : [];
      return [{ methods: verbs, expr, line: (mp[0] || ann(m, JAXRS_VERB)[0]).line, consumes: [...ann(m, 'Consumes'), ...ann(cls, 'Consumes')].flatMap((a) => strs(positional(a)?.value)), produces: [...ann(m, 'Produces'), ...ann(cls, 'Produces')].flatMap((a) => strs(positional(a)?.value)) }];
    },
    paramIn(p) {
      const a = (p.anns || []).find((x) => !/^(Valid|NotNull|DefaultValue|Encoded)$/.test(x.name));
      const map = { PathParam: 'path', QueryParam: 'query', HeaderParam: 'header', FormParam: 'form', CookieParam: 'cookie', MatrixParam: 'path', RestPath: 'path', RestQuery: 'query', RestHeader: 'header', RestForm: 'form', RestCookie: 'cookie' };
      const bind = a && positional(a)?.value.parts?.[0]?.lit;
      if (a && map[a.name]) return { in: map[a.name], ...(bind ? { bind } : {}), ...((p.anns || []).some((x) => x.name === 'DefaultValue') ? { optional: true } : {}) };
      if (a && /^(Context|BeanParam|Suspended)$/.test(a.name)) return { skip: true };
      if (INFRA.test(String(p.type || ''))) return { skip: true };
      return { in: 'body' }; // JAX-RS entity parameter
    },
    meta: (m, cls) => ({ auth: authOf(m, cls, /^(RolesAllowed|Authenticated|PermitAll|DenyAll)$/), responseType: m.returnType }),
  });
}
// Sub-resource locators: @Path without an HTTP method annotation.
function jaxrsIssues(P) {
  const out = [];
  for (const c of P.classes) for (const m of c.methods || []) if (has(m, 'Path') && !has(m, JAXRS_VERB) && !simpleReturn(m)) out.push({ line: m.line, pattern: 'JAX-RS sub-resource locator', reason: `${c.name}.${m.name} returns a sub-resource of undeclared type; its nested routes are not composed` });
  return out;
}

// Sub-resource locators: @Path without an HTTP verb. The declared return type names the sub-resource class.
const simpleReturn = (m) => { const t = String(m.returnType || '').replace(/<.*$/, '').trim().split('.').pop(); return /^[A-Z]\w*$/.test(t) && !/^(Object|Response|Class)$/.test(t) ? t : null; };
function jaxrsLocators(P) {
  const out = [];
  for (const c of P.classes) for (const m of c.methods || []) {
    if (!has(m, 'Path') || has(m, JAXRS_VERB) || !simpleReturn(m)) continue;
    const own = paths(ann(m, 'Path')[0], 'value')[0] || [];
    const pre = has(c, 'Path') ? ann(c, 'Path').flatMap((a) => paths(a, 'value')) : [[{ locator: c.name }]];
    for (const p of pre) out.push({ type: simpleReturn(m), expr: join(p, own), owner: c.name, method: m.name, line: m.line });
  }
  return out;
}

// ---------- Micronaut ----------
const MN_VERB = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', Trace: 'TRACE' };
// Micronaut URI templates may carry RFC 6570 query expansions: /books{?max,offset}
const stripQuery = (expr) => { const q = []; const e = expr.map((p) => (p.lit === undefined ? p : { lit: p.lit.replace(/\{\?([^}]*)\}/g, (_, x) => { q.push(...x.split(',')); return ''; }) })); return { e, q }; };
function micronaut(P, language) {
  const extraQuery = new Map();
  const r = declarative(P, {
    framework: 'micronaut', language,
    isController: (c) => has(c, 'Controller'),
    classPrefixes: (c) => ann(c, 'Controller').flatMap((a) => paths(a, 'value')).map((e) => stripQuery(e).e),
    methodRoutes(m) {
      const out = [];
      for (const a of ann(m, new RegExp(`^(${Object.keys(MN_VERB).join('|')})$`))) for (const e of paths(a, 'value', 'uri', 'uris')) {
        const { e: ex, q } = stripQuery(e);
        if (q.length) extraQuery.set(m, q);
        out.push({ methods: [MN_VERB[a.name]], expr: ex, line: a.line, produces: strs(argNamed(a, 'produces')?.value), consumes: strs(argNamed(a, 'consumes')?.value) });
      }
      return out;
    },
    paramIn(p) {
      const a = (p.anns || [])[0];
      const map = { PathVariable: 'path', QueryValue: 'query', Body: 'body', Header: 'header', CookieValue: 'cookie', Part: 'form' };
      const bind = a && positional(a)?.value.parts?.[0]?.lit;
      if (a && map[a.name]) return { in: map[a.name], ...(bind ? { bind } : {}) };
      if (INFRA.test(String(p.type || ''))) return { skip: true };
      return SIMPLE.test(String(p.type || '')) ? { in: 'query' } : { skip: true };
    },
    meta: (m, cls) => ({ auth: authOf(m, cls, /^(Secured|RolesAllowed|PermitAll)$/), responseType: m.returnType }),
  });
  return r;
}

// ---------- Vert.x Web ----------
const VX_VERB = { get: ['GET'], post: ['POST'], put: ['PUT'], patch: ['PATCH'], delete: ['DELETE'], head: ['HEAD'], options: ['OPTIONS'], route: ['ANY'] };
function vertx(P, language) {
  return registration(P, {
    framework: 'vertx', language,
    roots: (c, P) => c.name === 'router' && P.toks[c.recvEnd]?.v === 'Router',
    paramReceiver: (p) => /\bRouter\b/.test(p.type || ''),
    mounts: { mountSubRouter: { pathArg: 0, targetArg: 1 }, subRouter: { recvPath: true, targetArg: 0 } },
    verbs(name, as) {
      if (name === 'route' && as.length === 2 && /HttpMethod\.(\w+)/.test(as[0].value.text)) return [/HttpMethod\.(\w+)/.exec(as[0].value.text)[1]];
      return VX_VERB[name] && (as.length === 0 || as[as.length - 1].value.parts?.some((x) => x.lit !== undefined || x.ref)) ? VX_VERB[name] : null;
    },
    pathArg: (name, as) => (as.length ? as.length - 1 : null),
    handlerOf(P, h, as, tail) {
      const t = tail.find((x) => /^(handler|blockingHandler|respond)$/.test(x.name));
      const v = t?.args[0]?.value;
      return v?.parts?.length === 1 && v.parts[0].ref ? { name: v.parts[0].ref } : {};
    },
    handlerArg: () => null,
  });
}

// ---------- Servlets ----------
function servlets(P, language) {
  const routes = [], issues = [];
  for (const c of P.classes) {
    const ws = ann(c, 'WebServlet')[0];
    const isServlet = c.bases.some((b) => /HttpServlet$/.test(b.name));
    if (!ws) { if (isServlet) issues.push({ line: c.line, pattern: 'servlet without @WebServlet', reason: `${c.name}: servlet mappings declared in web.xml are not parsed` }); continue; }
    const pats = paths(ws, 'value', 'urlPatterns');
    const methods = (c.methods || []).map((m) => /^do(Get|Post|Put|Delete|Head|Options|Trace|Patch)$/.exec(m.name)?.[1]?.toUpperCase()).filter(Boolean);
    for (const e of pats) for (const method of methods.length ? methods : ['ANY'])
      routes.push(fact({ expr: e, method, line: ws.line, end: c.end, framework: 'servlet', language, kind: 'servlet', controller: c.name, handler: methods.length ? `do${method[0]}${method.slice(1).toLowerCase()}` : undefined, template: e.map((p) => p.lit ?? '').join(''), extraction: 'structural' }));
  }
  return { routes, issues };
}

// ---------- Ktor (Kotlin) ----------
const KTOR_VERB = { get: ['GET'], post: ['POST'], put: ['PUT'], patch: ['PATCH'], delete: ['DELETE'], head: ['HEAD'], options: ['OPTIONS'] };
function ktor(P) {
  return registration(P, {
    framework: 'ktor', language: 'kotlin', implicit: true, implicitTop: false, implicitCalls: true, extReceiver: /^(Route|Routing)$/, extRoot: /^Application$/,
    scopes: { route: { pathArg: 0 }, routing: { pathArg: null }, authenticate: { pathArg: null } }, blockVerbs: KTOR_VERB,
    verbs: (name, as) => (KTOR_VERB[name] && (!as.length || as[0].value.parts?.some((x) => x.lit !== undefined || x.ref)) ? KTOR_VERB[name] : null),
    pathArg: (name, as) => (as.length ? 0 : null), handlerArg: () => null,
  });
}

const imp = (re) => (F) => lineOf(F.text, new RegExp(`^\\s*import\\s+(?:static\\s+)?${re}`, 'm'));

export default [
  {
    id: 'spring', name: 'Spring MVC / Spring WebFlux (annotations)', language: 'java', langs: ['java'], status: 'supported',
    detect: (F) => imp('org\\.springframework\\.(web\\.bind\\.annotation|stereotype\\.Controller)')(F) || lineOf(F.text, /@(RestController|(Get|Post|Put|Patch|Delete|Request)Mapping)\b/),
    extract(F) { const r = spring(F.P, F.language); return { routes: r.routes, controllerClasses: r.controllerClasses, stats: { controllers: r.controllers }, issues: [] }; },
    patterns: ['@RestController / @Controller', '@RequestMapping on classes and methods (value/path arrays, method = RequestMethod.X)', '@GetMapping/@PostMapping/@PutMapping/@PatchMapping/@DeleteMapping (no-arg, value, path, arrays)', 'class + method composition with every combination of multiple paths', '@PathVariable/@RequestParam/@RequestBody/@RequestHeader/@CookieValue', 'produces/consumes', '@PreAuthorize/@Secured/@RolesAllowed', '${property} placeholders resolved from application.properties/yml', 'server.servlet.context-path / spring.webflux.base-path application prefix', 'superclass @RequestMapping inheritance (cross-file)', 'route constants (static final, cross-file and static imports)', 'Kotlin controllers (arrays with [...])'],
    limitations: ['Profile-specific configuration (application-<profile>.yml) is not applied', '@FeignClient and @HttpExchange interfaces are clients and are excluded', 'Routes declared on interfaces are marked inferred (the implementing controller exposes them)'],
  },
  {
    id: 'spring-webflux-fn', name: 'Spring WebFlux functional routing', language: 'java', langs: ['java'], status: 'partial',
    detect: (F) => imp('org\\.springframework\\.web\\.(reactive|servlet)\\.function')(F),
    extract(F) { const r = webfluxFunctional(F.P, F.language); return { routes: r.routes, callSites: r.callSites, stats: { registrations: r.declarations }, issues: [] }; },
    patterns: ['route(GET("/x"), h).andRoute(POST("/y"), h)', 'route().GET("/x", h).build()', 'nest(path("/api"), …) and builder .path("/api", b -> …)'],
    limitations: ['Kotlin coRouter/router DSL string receivers ("/api".nest { }) are not composed', 'Handlers inside predicate-style route(…) calls are not linked', 'Composed predicates (and/or, accept, contentType) are ignored'],
  },
  {
    id: 'jax-rs', name: 'Jakarta REST / JAX-RS (incl. Quarkus REST, RESTEasy)', language: 'java', langs: ['java'], status: 'supported',
    detect: (F) => imp('(javax|jakarta)\\.ws\\.rs')(F) || imp('org\\.jboss\\.resteasy')(F),
    extract(F) { const r = jaxrs(F.P, F.language); return { routes: r.routes, stats: { controllers: r.controllers }, issues: jaxrsIssues(F.P), appPaths: appPaths(F.P), locators: jaxrsLocators(F.P) }; },
    patterns: ['@Path on resource classes and methods', '@GET/@POST/@PUT/@PATCH/@DELETE/@HEAD/@OPTIONS', '@PathParam/@QueryParam/@HeaderParam/@FormParam/@CookieParam (and Quarkus @RestPath/@RestQuery/…)', '@Consumes/@Produces on methods and classes', '@RolesAllowed/@Authenticated', '@ApplicationPath (cross-file) and quarkus.rest.path / quarkus.resteasy.path / quarkus.http.root-path'],
    limitations: ['Sub-resource locators are reported, their nested routes are not composed', 'Servlet mappings in web.xml are not parsed; without @ApplicationPath the application prefix is assumed to be the root (marked inferred unless the project is Quarkus)'],
  },
  {
    id: 'micronaut', name: 'Micronaut', language: 'java', langs: ['java'], status: 'supported',
    detect: imp('io\\.micronaut\\.http\\.annotation'),
    extract(F) { const r = micronaut(F.P, F.language); return { routes: r.routes, stats: { controllers: r.controllers }, issues: [] }; },
    patterns: ['@Controller prefix', '@Get/@Post/@Put/@Patch/@Delete/@Head/@Options (value, uri, uris)', '@PathVariable/@QueryValue/@Body/@Header', 'RFC 6570 query templates ({?max,offset}) are moved out of the path', '@Secured'],
    limitations: ['micronaut.server.context-path is applied; other URI customisations are not'],
  },
  {
    id: 'vertx', name: 'Vert.x Web', language: 'java', langs: ['java'], status: 'partial',
    detect: imp('io\\.vertx\\.(ext\\.web|rxjava3?\\.ext\\.web|reactivex\\.ext\\.web)'),
    extract(F) { const r = vertx(F.P, F.language); return { routes: r.routes, callSites: r.callSites, stats: { registrations: r.declarations }, issues: [] }; },
    patterns: ['Router.router(vertx)', 'router.get/post/put/patch/delete/head/options/route("/x").handler(h)', 'route(HttpMethod.X, "/x")', 'mountSubRouter("/api", sub) and route("/api/*").subRouter(sub)', 'functions taking a Router parameter (resolved through call sites)'],
    limitations: ['Regex routes (routeWithRegex, getWithRegex) are not extracted', 'OpenAPI RouterBuilder operations are not extracted'],
  },
  {
    id: 'servlet', name: 'Jakarta/Java Servlet', language: 'java', langs: ['java'], status: 'partial',
    detect: (F) => lineOf(F.text, /@WebServlet\b|extends\s+HttpServlet\b/),
    extract(F) { return servlets(F.P, F.language); },
    patterns: ['@WebServlet(value | urlPatterns) with doGet/doPost/… methods; endpoint kind "servlet"'],
    limitations: ['web.xml servlet mappings are not parsed (reported as unsupported patterns)', 'Servlet context paths come from the container and are not applied'],
  },
  {
    id: 'ktor', name: 'Ktor (Kotlin)', language: 'kotlin', langs: ['java'], kotlinOnly: true, status: 'partial',
    detect: imp('io\\.ktor\\.server\\.(routing|application)'),
    extract(F) { const r = ktor(F.P); return { routes: r.routes, callSites: r.callSites, stats: { registrations: r.declarations }, issues: [] }; },
    patterns: ['routing { route("/api") { get("/x") { } } }', 'verbs without a path (get { })', 'extension functions on Route (fun Route.users()) resolved through their call sites', 'authenticate { } blocks'],
    limitations: ['Type-safe Resources routing (get<Articles> { }) is not extracted', 'Routes registered in plugins installed elsewhere are composed only through extension-function call sites'],
  },
];

// @ApplicationPath("/api") on a JAX-RS Application subclass.
function appPaths(P) {
  const out = [];
  for (const c of P.classes) for (const a of ann(c, 'ApplicationPath')) out.push({ framework: 'jax-rs', path: a.args[0]?.value.parts?.[0]?.lit ?? '', line: a.line });
  return out;
}
export { lit };
