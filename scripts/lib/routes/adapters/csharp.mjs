// C# / .NET route adapters.
import { declarative, registration } from '../strategies.mjs';
import { fromValue, lit, fact, aspnetTokens } from '../model.mjs';
import { args } from '../structure.mjs';
import { lineOf } from '../detect.mjs';

const VERB_ATTR = /^Http(Get|Post|Put|Patch|Delete|Head|Options)$/;
const PRIMITIVE = /^(int|long|short|byte|sbyte|uint|ulong|ushort|bool|string|char|decimal|double|float|Guid|DateTime|DateTimeOffset|DateOnly|TimeOnly|TimeSpan|Int32|Int64|String|Boolean)(\?|\[\])?$/;
const INFRA_TYPE = /^(CancellationToken|HttpContext|HttpRequest|HttpResponse|ClaimsPrincipal|ILogger(<.*>)?|IFormFile|IFormFileCollection|Stream|PipeReader)\??$/;
const SERVICE_TYPE = /^I[A-Z]\w*(<.*>)?$|(Service|Repository|Context|DbContext|Client|Factory|Options|Mediator|Sender|Handler|Store|Manager)(<.*>)?\??$/;

const ann = (owner, re) => (owner.anns || []).filter((a) => (typeof re === 'string' ? a.name === re : re.test(a.name)));
const has = (owner, re) => ann(owner, re).length > 0;
const firstArg = (a, ...names) => (a.args.find((x) => names.includes(x.name)) || a.args.find((x) => !x.name));
const strList = (v) => (v?.list ? v.list.flatMap(strList) : v?.parts?.length === 1 && v.parts[0].lit !== undefined ? v.parts[0].lit.split(/[\s,]+/).filter(Boolean) : []);
const typeofArg = (v) => /typeof\s*\(\s*([\w.<>,\s\[\]?]+?)\s*\)/.exec(v?.text || '')?.[1];

// [controller], [action], [area] token replacement. Lower-cased: ASP.NET route matching is case-insensitive,
// and the original template is kept in originalTemplate.
function tokens(expr, cls, m) {
  return aspnetTokens(expr, cls.name, m.name, ann(cls, 'Area')[0]?.args[0]?.value.parts?.[0]?.lit);
}

function templateOf(a) {
  const x = firstArg(a, 'template', 'Template');
  if (!x) return { expr: [] };
  let parts = fromValue(x.value);
  let absolute = false;
  if (parts[0]?.lit !== undefined && /^~?\//.test(parts[0].lit)) { absolute = true; parts = [{ lit: parts[0].lit.replace(/^~/, '') }, ...parts.slice(1)]; }
  return { expr: parts, absolute, template: x.value.text?.replace(/^@?"|"$/g, '') };
}

function paramIn(p, m) {
  const a = (p.anns || [])[0];
  const name = a && (a.args.find((x) => x.name === 'Name')?.value.parts?.[0]?.lit);
  const map = { FromRoute: 'path', FromQuery: 'query', FromBody: 'body', FromHeader: 'header', FromForm: 'form', FromUri: 'query' };
  if (a && (a.name === 'FromServices' || a.name === 'FromKeyedServices')) return { skip: true };
  if (a && map[a.name]) return { in: map[a.name], ...(name ? { bind: name } : {}) };
  const t = String(p.type || '');
  if (INFRA_TYPE.test(t)) return t.startsWith('IForm') ? { in: 'form' } : { skip: true };
  if (SERVICE_TYPE.test(t)) return { skip: true };
  if (PRIMITIVE.test(t) || /^(int|long|string|Guid)\??$/.test(t)) return { in: 'query' };
  // Complex types bind from the body on API controllers / Minimal API (POST, PUT, PATCH).
  return { in: 'body' };
}

function meta(m, cls) {
  const auth = has(m, 'AllowAnonymous') ? undefined : [...ann(m, 'Authorize'), ...ann(cls, 'Authorize')].map((a) => `Authorize${a.args.length ? '(' + a.args.map((x) => (x.name ? x.name + '=' : '') + x.value.text).join(', ') + ')' : ''}`)[0];
  const versions = [...ann(m, /^(MapToApiVersion|ApiVersion)$/), ...(has(m, /^(MapToApiVersion|ApiVersion)$/) ? [] : ann(cls, 'ApiVersion'))].map((a) => a.args[0]?.value.parts?.[0]?.lit).filter(Boolean);
  const produces = [...ann(m, 'Produces'), ...ann(cls, 'Produces')].flatMap((a) => a.args.filter((x) => !x.name).flatMap((x) => strList(x.value)));
  const consumes = [...ann(m, 'Consumes'), ...ann(cls, 'Consumes')].flatMap((a) => a.args.filter((x) => !x.name).flatMap((x) => strList(x.value)));
  const prt = ann(m, 'ProducesResponseType').map((a) => typeofArg(a.args[0]?.value)).find(Boolean);
  return { auth, apiVersion: versions.length ? versions.join(', ') : undefined, produces, consumes, responseType: prt || m.returnType };
}

// ---------- ASP.NET Core controllers ----------
const CORE_BASES = new Set(['ControllerBase', 'Controller', 'AbpController', 'AbpControllerBase', 'ODataController']);
function coreControllers(P) {
  return declarative(P, {
    framework: 'aspnet-core', language: 'csharp', inheritPrefix: true, frameworkBases: CORE_BASES, tokens, paramIn, meta, abstractBases: true,
    isController: (c) => c.kind === 'class' && !has(c, 'NonController') && !(c.mods || []).includes('abstract') &&
      (has(c, /^(ApiController|Controller|Route)$/) || c.bases.some((b) => CORE_BASES.has(b.name)) || (/Controller$/.test(c.name) && (c.methods || []).some((m) => has(m, VERB_ATTR)))),
    classPrefixes: (c) => ann(c, 'Route').map((a) => tokensSafe(templateOf(a).expr)),
    skipMethod: (m) => has(m, 'NonAction') || m.isCtor || !(m.mods.includes('public')) || m.isStatic,
    methodRoutes(m, cls) {
      const out = [];
      const routeTpls = ann(m, 'Route').map(templateOf);
      const verbs = ann(m, VERB_ATTR);
      for (const a of verbs) {
        const method = a.name.replace(/^Http/, '').toUpperCase();
        const t = templateOf(a);
        if (a.args.some((x) => !x.name || x.name === 'template')) out.push({ methods: [method], ...t, line: a.line });
        else if (routeTpls.length) for (const rt of routeTpls) out.push({ methods: [method], ...rt, line: a.line });
        else out.push({ methods: [method], expr: [], line: a.line });
      }
      for (const a of ann(m, 'AcceptVerbs')) {
        const ms = a.args.filter((x) => !x.name).flatMap((x) => strList(x.value)).map((s) => s.toUpperCase());
        const r = a.args.find((x) => x.name === 'Route');
        const t = r ? templateOf({ args: [{ value: r.value }] }) : routeTpls[0] || { expr: [] };
        out.push({ methods: ms.length ? ms : ['ANY'], ...t, line: a.line });
      }
      if (!verbs.length && !ann(m, 'AcceptVerbs').length) {
        if (routeTpls.length) for (const rt of routeTpls) out.push({ methods: ['ANY'], ...rt, line: ann(m, 'Route')[0].line });
        else if (has(cls, 'Route') || has(cls, 'ApiController')) out.push({ methods: ['ANY'], expr: [], line: m.startLine, exact: false, note: 'action has no HTTP method attribute; it matches any method at the controller route' });
        else out.push({ methods: ['ANY'], expr: [], line: m.startLine, conventional: true, extraction: 'convention', exact: false });
      }
      return out;
    },
  });
}
const tokensSafe = (e) => e;

// ---------- ASP.NET Core Minimal API ----------
const MAP_VERBS = { MapGet: ['GET'], MapPost: ['POST'], MapPut: ['PUT'], MapPatch: ['PATCH'], MapDelete: ['DELETE'], Map: ['ANY'], MapFallback: ['ANY'], MapHealthChecks: ['GET'], MapHub: ['ANY'] };
function minimalApi(P) {
  return registration(P, {
    framework: 'aspnet-core', language: 'csharp', groups: { MapGroup: 0 }, authRe: /^RequireAuthorization$/,
    roots: (c, P) => c.name === 'Build' || (c.name === 'Create' && P.toks[c.recvEnd]?.v === 'WebApplication'),
    paramReceiver: (p) => !p.type || /IEndpointRouteBuilder|RouteGroupBuilder|WebApplication|IApplicationBuilder|IEndpointConventionBuilder/.test(p.type),
    receiverOk: (v) => v === 'app' || v === 'endpoints',
    verbs(name, as) {
      if (name === 'MapMethods') return strList(as[1]?.value).map((s) => s.toUpperCase());
      if (name === 'Map' && !(as[0]?.value.parts?.some((x) => x.lit !== undefined || x.ref))) return null;
      return MAP_VERBS[name] || null;
    },
    pathArg: (name, as) => (name === 'MapFallback' && !(as[0]?.value.parts?.some((x) => x.lit !== undefined || x.ref) && as.length > 1) ? null : 0),
    defaultPath: (name) => (name === 'MapFallback' ? [lit('/{*path:nonfile}')] : []),
    handlerArg: (name, as) => (name === 'MapHealthChecks' || name === 'MapHub' ? null : as.length - 1),
    kindOf: (name) => (name === 'MapFallback' ? 'fallback' : name === 'MapHub' ? 'websocket' : name === 'MapHealthChecks' ? 'health' : undefined),
    paramIn: (p, method) => { const r = paramIn(p); return r.in === 'body' && /^(GET|DELETE|HEAD)$/.test(method) ? { skip: true } : r; },
    ignoreCall: /^(With\w+|Require\w+|Produces\w*|Accepts|AddEndpointFilter\w*|AllowAnonymous|CacheOutput|DisableAntiforgery|ExcludeFromDescription|HasApiVersion|MapToApiVersion|Run|RunAsync|Use\w*|Add\w+)$/,
  });
}

// Conventional routes: MapControllerRoute / MapDefaultControllerRoute / MapRoute / MapHttpRoute
function conventions(P, framework) {
  const out = [];
  const { toks } = P;
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    if (t.k !== 'id' || toks[i + 1]?.v !== '(') continue;
    if (t.v === 'MapDefaultControllerRoute') out.push({ framework: 'aspnet-core', template: '{controller=Home}/{action=Index}/{id?}', line: t.line, kind: 'mvc' });
    else if (/^(MapControllerRoute|MapAreaControllerRoute|MapRoute|MapHttpRoute)$/.test(t.v)) {
      const as = args(P, i + 1);
      const tpl = as.find((x) => /^(pattern|url|routeTemplate)$/.test(x.name || '')) || as[t.v === 'MapAreaControllerRoute' ? 2 : 1];
      const s = tpl?.value.parts?.length === 1 ? tpl.value.parts[0].lit : null;
      const optional = as.map((x) => P.src(x.a, x.b)).flatMap((s) => [...s.matchAll(/(\w+)\s*=\s*(?:RouteParameter|UrlParameter)\.Optional/g)].map((m) => m[1]));
      if (s != null) out.push({ framework: t.v === 'MapHttpRoute' || t.v === 'MapRoute' ? 'aspnet-webapi' : framework, template: s, line: t.line, kind: t.v === 'MapHttpRoute' ? 'webapi' : 'mvc', ...(optional.length ? { optional } : {}) });
    }
  }
  return out;
}

// ---------- Legacy ASP.NET Web API 2 / MVC 5 ----------
const LEGACY_BASES = new Set(['ApiController', 'Controller']);
const verbFromName = (name) => /^(Get|Post|Put|Delete|Patch|Head|Options)/.exec(name)?.[1]?.toUpperCase();
function legacy(P) {
  return declarative(P, {
    framework: 'aspnet-webapi', language: 'csharp', inheritPrefix: false, frameworkBases: LEGACY_BASES, paramIn: (p) => {
      const r = paramIn(p);
      return r;
    }, meta,
    isController: (c) => c.kind === 'class' && !(c.mods || []).includes('abstract') && (c.bases.some((b) => LEGACY_BASES.has(b.name)) || has(c, /^(RoutePrefix|Route)$/)),
    classPrefixes: (c) => ann(c, 'RoutePrefix').map((a) => fromValue(firstArg(a, 'prefix')?.value)),
    skipMethod: (m) => has(m, 'NonAction') || m.isCtor || !m.mods.includes('public') || m.isStatic,
    methodRoutes(m, cls) {
      const verbs = ann(m, VERB_ATTR).map((a) => a.name.replace(/^Http/, '').toUpperCase());
      for (const a of ann(m, 'AcceptVerbs')) verbs.push(...a.args.filter((x) => !x.name).flatMap((x) => strList(x.value)).map((s) => s.toUpperCase().replace(/^HTTPVERBS\./, '')));
      const byName = verbs.length ? null : verbFromName(m.name);
      const methods = verbs.length ? verbs : [byName || 'POST'];
      const routes = ann(m, 'Route').length ? ann(m, 'Route') : ann(cls, 'Route');
      if (!routes.length) return [{ methods, expr: [], conventional: true, extraction: 'convention', exact: false, line: m.startLine }];
      return routes.map((a) => ({ methods, ...templateOf(a), line: a.line, ...(verbs.length ? {} : { exact: false, note: byName ? `HTTP method inferred from the action name prefix "${byName}"` : 'no HTTP method attribute or verb prefix: Web API defaults to POST' }) }));
    },
  });
}

// ---------- WCF WebHttp ----------
function wcf(P) {
  return declarative(P, {
    framework: 'wcf', language: 'csharp', paramIn: () => ({ in: 'query' }),
    isController: (c) => has(c, 'ServiceContract'),
    classPrefixes: () => [[{ dyn: 'service base address', reason: 'the WCF base address comes from hosting configuration (.svc / web.config), which is not parsed' }]],
    methodRoutes(m) {
      const out = [];
      for (const a of ann(m, /^(WebGet|WebInvoke)$/)) {
        const uri = a.args.find((x) => x.name === 'UriTemplate');
        const method = a.name === 'WebGet' ? 'GET' : (a.args.find((x) => x.name === 'Method')?.value.parts?.[0]?.lit || 'POST').toUpperCase();
        out.push({ methods: [method], expr: uri ? fromValue(uri.value) : [lit(m.name)], line: a.line });
      }
      return out;
    },
  });
}

// ---------- ServiceStack: [Route] on request DTOs ----------
function serviceStack(P) {
  const routes = [];
  for (const c of P.classes) {
    for (const a of ann(c, 'Route')) {
      const path = a.args.find((x) => !x.name || x.name === 'Path');
      const verbsA = a.args.filter((x) => !x.name)[1] || a.args.find((x) => x.name === 'Verbs');
      const verbs = verbsA ? strList(verbsA.value).map((s) => s.toUpperCase()) : ['ANY'];
      if (!path) continue;
      for (const method of verbs) routes.push(fact({ expr: fromValue(path.value), method, line: a.line, end: c.end, framework: 'servicestack', language: 'csharp', template: path.value.text, requestBody: c.name, controller: c.name, note: 'ServiceStack request DTO route; the handling Service method is not linked', extraction: 'structural' }));
    }
  }
  return { routes, issues: [] };
}

const using = (re) => (F) => lineOf(F.text, new RegExp(`^\\s*(?:global\\s+)?using\\s+(?:static\\s+)?${re}`, 'm'));

export default [
  {
    id: 'aspnet-core', name: 'ASP.NET Core (MVC controllers + Minimal API)', language: 'csharp', langs: ['cs'], status: 'supported',
    detect: (F) => (/^\s*using\s+System\.Web\.(Http|Mvc)\b/m.test(F.text) ? null : using('Microsoft\\.AspNetCore')(F) || lineOf(F.text, /\b(WebApplication\.Create(Builder)?|IEndpointRouteBuilder|RouteGroupBuilder|\.Map(Get|Post|Put|Patch|Delete|Group|Methods|Controllers)\s*\(|:\s*ControllerBase\b|\[ApiController\])/)),
    extract(F) {
      const c = coreControllers(F.P), m = minimalApi(F.P);
      const conv = conventions(F.P, 'aspnet-core');
      return { routes: [...c.routes, ...m.routes], callSites: m.callSites, conventions: conv, controllerClasses: c.controllerClasses, stats: { controllers: c.controllers, registrations: m.declarations }, issues: [] };
    },
    patterns: ['[ApiController]/[Controller] classes and ControllerBase/Controller subclasses', '[Route] on controllers (multiple, cartesian with actions)', '[HttpGet|Post|Put|Patch|Delete|Head|Options(template)]', '[AcceptVerbs(…, Route = …)]', '[Route] on actions', 'leading "/" or "~/" overrides the controller prefix', '[controller] [action] [area] tokens', 'route constraints, optional and catch-all parameters', '[FromRoute|Query|Body|Header|Form|Services]', '[Authorize]/[AllowAnonymous]', '[ApiVersion]/[MapToApiVersion] (recorded)', '[Produces]/[Consumes]/[ProducesResponseType]', 'base-controller [Route] inheritance (cross-file)', 'MapGet/MapPost/MapPut/MapPatch/MapDelete/MapMethods/Map/MapFallback/MapHealthChecks/MapHub', 'MapGroup chains and nested groups through local variables', 'route constants (const / static readonly, cross-file)', 'extension methods (this IEndpointRouteBuilder / RouteGroupBuilder) resolved through their call sites', 'RequireAuthorization on routes and groups', 'conventional routing (MapControllerRoute / MapDefaultControllerRoute) for non-attribute-routed controllers (inferred)'],
    limitations: ['Prefixes computed at runtime (method calls, configuration values) are recorded as unresolved', 'Route tokens are lower-cased; ASP.NET matches case-insensitively', 'API version route parameters (v{version:apiVersion}) are kept as templates; declared versions are recorded in apiVersion', 'Custom IRouteTemplateProvider attributes and application model conventions are not evaluated', 'Partial classes are not merged'],
  },
  {
    id: 'aspnet-webapi', name: 'ASP.NET Web API 2 / MVC 5 (legacy)', language: 'csharp', langs: ['cs'], status: 'supported',
    detect: (F) => using('System\\.Web\\.(Http|Mvc)\\b')(F) || lineOf(F.text, /:\s*ApiController\b|\[RoutePrefix\(|\bHttpConfiguration\b|\bMapHttpRoute\s*\(/),
    extract(F) {
      const r = legacy(F.P);
      return { routes: r.routes, conventions: conventions(F.P, 'aspnet-webapi'), stats: { controllers: r.controllers, attributeRouting: /MapHttpAttributeRoutes\s*\(/.test(F.text) || undefined }, issues: [] };
    },
    patterns: ['ApiController/Controller subclasses', '[RoutePrefix] + [Route] composition', '"~/" override', '[HttpGet|Post|Put|Delete|Patch]', '[AcceptVerbs]', 'HTTP method from the action name prefix (Get…, Post…) when no attribute (inferred)', 'config.MapHttpAttributeRoutes() and MapHttpRoute conventional templates (inferred)', '[FromBody]/[FromUri]'],
    limitations: ['Convention-based routes are inferred from MapHttpRoute templates', 'Route constraints from config.Routes defaults are not evaluated'],
  },
  {
    id: 'wcf', name: 'WCF WebHttp ([WebGet]/[WebInvoke])', language: 'csharp', langs: ['cs'], status: 'partial',
    detect: (F) => using('System\\.ServiceModel')(F) && lineOf(F.text, /\[(WebGet|WebInvoke)\b/),
    extract(F) { const r = wcf(F.P); return { routes: r.routes, stats: { controllers: r.controllers }, issues: [] }; },
    patterns: ['[ServiceContract] with [WebGet(UriTemplate)] / [WebInvoke(Method, UriTemplate)]'],
    limitations: ['The service base address is hosting configuration; every route is partial with an unresolved base address', 'SOAP operations are not HTTP routes and are not listed'],
  },
  {
    id: 'servicestack', name: 'ServiceStack', language: 'csharp', langs: ['cs'], status: 'partial',
    detect: using('ServiceStack\\b'),
    extract(F) { return serviceStack(F.P); },
    patterns: ['[Route(path, verbs)] on request DTOs'],
    limitations: ['Routes are not linked to the Service method that handles the DTO', 'Fluent Routes.Add registration is not extracted'],
  },
  {
    id: 'nancy', name: 'Nancy', language: 'csharp', langs: ['cs'], status: 'detected',
    detect: (F) => using('Nancy\\b')(F) && lineOf(F.text, /:\s*NancyModule\b/),
    patterns: [], limitations: ['Detected only: NancyModule route registrations (Get("/x", …)) are not extracted'],
  },
];
