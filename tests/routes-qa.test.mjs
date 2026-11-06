// Independent QA of the route intelligence engine. Expectations were written from framework semantics before the
// engine was run against these fixtures; failures here are QA findings, not test bugs (see the QA report).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, routeGraph } from './routes-helpers.mjs';
import { validateGraph } from '../scripts/lib/graph.mjs';

const dn = routeGraph(loadFixture('qa-dotnet'));
const jv = routeGraph(loadFixture('qa-jvm'));
const names = (G) => new Set(G.apis.map((n) => n.name));
const expectAll = (G, list) => { const s = names(G); const miss = list.filter((x) => !s.has(x)); assert.deepEqual(miss, [], `missing routes: ${miss.join(', ')}`); };
const expectNone = (G, re) => { const bad = G.apis.map((n) => n.name).filter((n) => re.test(n)); assert.deepEqual(bad, [], `unexpected routes: ${bad.join(', ')}`); };
const conf = (G, id) => G.api(`api:${id}`)?.confidence;
const edgesFrom = (G, src) => G.g.edges.filter((e) => e.source === src);
const reach = (G, src, depth = 3) => { const seen = new Set([src]); let fr = [src]; for (let d = 0; d < depth; d++) { fr = fr.flatMap((s) => edgesFrom(G, s).map((e) => e.target)).filter((t) => !seen.has(t) && seen.add(t)); } return seen; };

test('QA graphs validate', () => {
  assert.deepEqual(validateGraph(dn.g).errors, []);
  assert.deepEqual(validateGraph(jv.g).errors, []);
});

// ---------- C# ----------
test('QA-CS-01 controller: multiple [Route], const concat, [controller], separate-line attrs, [Route("")], [action]+Async', () => {
  expectAll(dn, ['GET /api/v1/orders', 'GET /api/legacy-orders', 'GET /api/v1/orders/{id:int:min(1)}', 'GET /api/legacy-orders/{id:int:min(1)}',
    'POST /api/v1/orders', 'POST /api/legacy-orders', 'PUT /api/v1/orders/{id}', 'PUT /api/legacy-orders/{id}', 'GET /api/v1/orders/export', 'GET /api/legacy-orders/export']);
  for (const id of ['GET /api/v1/orders/{id:int:min(1)}', 'PUT /api/legacy-orders/{id}']) assert.equal(conf(dn, id), 'verified', id);
});
test('QA-CS-02 comments, strings and [NonAction] never produce routes', () => {
  expectNone(dn, /commented|ghost|fake|helper/i);
});
test('QA-CS-03 "~/" override with regex constraint containing [[ ]] and {{ }}', () => {
  const r = dn.apis.filter((n) => n.name.includes('by-code'));
  assert.deepEqual(r.map((n) => n.name), ['GET /orders/by-code/{code:regex(^[[A-Z]]{{3}}$)}']);
  assert.ok(r[0].attrs.parameters?.some((p) => p.name === 'code' && p.in === 'path'), 'code is a path parameter');
});
test('QA-CS-04 [controller] on a class without the Controller suffix', () => expectAll(dn, ['GET /api/inventory/{sku}']));
test('QA-CS-05 [area] token and actions without a verb attribute', () => {
  expectAll(dn, ['POST /admin/reports/rebuild', 'ANY /admin/reports/index']);
});
test('QA-CS-06 actions inherited from an abstract base controller', () => {
  expectAll(dn, ['POST /api/customers', 'GET /api/customers', 'GET /api/customers/{id}']);
});
test('QA-CS-07 partial controller across files: no verified route without the class prefix', () => {
  expectAll(dn, ['GET /api/accounts/{id}']);
  assert.notEqual(conf(dn, 'DELETE /{id}'), 'verified', 'DELETE /{id} must not be verified (prefix lives in the other partial)');
});
test('QA-CS-08 verbatim, raw and interpolated const strings, nested static class constant', () => {
  expectAll(dn, ['GET /api/verbatim/raw/{id}', 'GET /api/verbatim/api/interp', 'GET /api/verbatim/api/v1/admin/nested-const']);
});
test('QA-CS-09 Minimal API: chained MapGroup with RequireAuthorization/WithTags, MapMethods', () => {
  expectAll(dn, ['GET /api/v1/users', 'GET /api/v1/users/{id:int}', 'POST /api/v1/users', 'PATCH /api/v1/users/{id}/touch', 'OPTIONS /api/v1/users/{id}/touch']);
  assert.equal(dn.api('api:GET /api/v1/users/{id:int}').attrs.auth, 'required');
  assert.equal(dn.api('api:GET /health/live').attrs.auth, undefined);
  expectNone(dn, /\/commented/);
});
test('QA-CS-10 Minimal API: extension method, static helper with group arg, helper called twice, const group', () => {
  expectAll(dn, ['GET /api/v1/products/{id}', 'DELETE /api/v1/products/{id}', 'GET /api/v1/orders', 'POST /api/v1/orders/{id}/cancel',
    'GET /api/alpha/status', 'GET /api/beta/status', 'GET /api/v1/const-group/ping']);
});
test('QA-CS-11 dynamic group prefix and uncalled extension are partial, inferred, with reasons', () => {
  const s = dn.apis.find((n) => n.name.endsWith('/settings'));
  assert.ok(s, 'settings route present');
  assert.equal(s.attrs.resolutionStatus === 'complete', false);
  assert.equal(s.confidence, 'inferred');
  assert.ok(s.attrs.unresolved?.[0]?.reason, 'reason recorded');
  const o = dn.apis.find((n) => n.name.endsWith('/orphan'));
  assert.ok(o, 'orphan route present');
  assert.equal(o.confidence, 'inferred');
  assert.notEqual(o.attrs.resolutionStatus, 'complete');
});
test('QA-CS-12 MapFallback default pattern', () => expectAll(dn, ['ANY /{*path:nonfile}']));
test('QA-CS-13 Web API 2: RoutePrefix, ~/, verb-by-name inferred, POST default inferred, AcceptVerbs, conventional', () => {
  expectAll(dn, ['GET /api/books', 'GET /api/books/{id:int}', 'GET /api/authors/{authorId}/books', 'POST /api/books', 'POST /api/books/{id}/archive',
    'GET /api/books/count', 'HEAD /api/books/count', 'GET /api/values', 'GET /api/values/{id}', 'DELETE /api/values/{id}']);
  for (const id of ['GET /api/books', 'POST /api/books/{id}/archive', 'GET /api/values', 'DELETE /api/values/{id}']) assert.equal(conf(dn, id), 'inferred', id);
  for (const id of ['GET /api/books/{id:int}', 'HEAD /api/books/count']) assert.equal(conf(dn, id), 'verified', id);
});
test('QA-CS-14 route → handler → service through the single implementation', () => {
  const r = reach(dn, 'api:GET /api/v1/orders/{id:int:min(1)}');
  // Amended by the implementer (see the audit doc, QA amendments): method ids are class-qualified (file#Class.method); the
  // original /#Get$/ and /Services\.cs#Find$/ matched whichever class declared the name first (here IOrderService.Find).
  assert.ok([...r].some((id) => /OrdersController\.cs#OrdersController\.Get$/.test(id)), 'handler linked');
  assert.ok([...r].some((id) => /Services\.cs#OrderService\.Find$/.test(id)), 'OrderService.Find linked through IOrderService');
});
test('QA-CS-15 no link to an implementation when the interface has two; no link to a never-injected same-named service', () => {
  const r = reach(dn, 'api:GET /api/accounts/{id}', 4);
  const bad = [...r].filter((id) => /AccountService|CachedAccountService|UserService/.test(id) && !/IAccountService/.test(id));
  assert.deepEqual(bad, []);
  const anyUser = dn.g.edges.filter((e) => /UserService/.test(e.target) && e.type !== 'belongs_to');
  assert.deepEqual(anyUser.map((e) => e.id), []);
});
test('QA-CS-16 primary-constructor dependency is followed (C# 12)', () => {
  const r = reach(dn, 'api:POST /api/payments', 4);
  // Amended: with unqualified ids the original /#Charge$/ could only match UserService.Charge (first declaration in the file).
  assert.ok([...r].some((id) => /#PaymentService\.Charge$/.test(id)), 'Pay → PaymentService.Charge');
  assert.ok(![...r].some((id) => /UserService/.test(id)), 'never the uninjected UserService');
});

// ---------- JVM ----------
test('QA-J-01 Spring: value arrays, ${prop} from yml, context-path, path=, method arrays, constants, no-arg mapping', () => {
  const P = ['/shop/api/products', '/shop/legacy/products'];
  expectAll(jv, P.flatMap((p) => [`GET ${p}`, `GET ${p}/{id:[0-9]+}`, `GET ${p}/search`, `POST ${p}/search`, `POST ${p}/items`, `DELETE ${p}/{id}`, `DELETE ${p}/{id}/purge`, `ANY ${p}/any`]));
  assert.equal(conf(jv, 'GET /shop/api/products/{id:[0-9]+}'), 'verified');
  const p = jv.api('api:GET /shop/api/products/{id:[0-9]+}').attrs.parameters || [];
  assert.ok(p.some((x) => x.name === 'id' && x.in === 'path'));
});
test('QA-J-02 Spring: comments and strings never produce routes; Feign client excluded', () => expectNone(jv, /ghost|commented|fake|remote/));
test('QA-J-03 profile-specific yml does not override the default profile', () => {
  expectNone(jv, /dev-shop|dev-api/);
});
test('QA-J-04 placeholders: default value inferred, missing key partial, nested yml key, .properties key', () => {
  expectAll(jv, ['GET /shop/fallback/x/y', 'GET /shop/admin/stats', 'GET /shop/catalog/entries']);
  assert.equal(conf(jv, 'GET /shop/fallback/x/y'), 'inferred');
  const z = jv.apis.find((n) => n.name.endsWith('/z/w'));
  assert.ok(z, 'missing-key route present');
  assert.equal(z.confidence, 'inferred');
  assert.notEqual(z.attrs.resolutionStatus, 'complete');
});
test('QA-J-05 Spring: methods inherited from an abstract generic base controller', () => {
  expectAll(jv, ['POST /shop/customers', 'GET /shop/customers', 'GET /shop/customers/{id}']);
});
test('QA-J-06 Spring: interface-declared mapping is listed but not verified', () => {
  expectAll(jv, ['GET /shop/accounts/{id}']);
  assert.equal(conf(jv, 'GET /shop/accounts/{id}'), 'inferred');
});
test('QA-J-07 Kotlin Spring: [..] and arrayOf(..) arrays', () => {
  expectAll(jv, ['GET /shop/kt/a', 'GET /shop/kt/b', 'GET /shop/kt/c', 'GET /shop/kt/d', 'POST /shop/kt/e/{id}']);
});
test('QA-J-08 JAX-RS: @ApplicationPath, class+method @Path, regex with braces, @Consumes', () => {
  expectAll(jv, ['GET /rest/orders', 'GET /rest/orders/{id: [0-9]{1,6}}', 'POST /rest/orders']);
  const p = jv.api('api:GET /rest/orders/{id: [0-9]{1,6}}')?.attrs.parameters || [];
  assert.ok(p.some((x) => x.name === 'id' && x.in === 'path'), 'id path param despite {1,6}');
});
test('QA-J-09 JAX-RS: sub-resource class (no class @Path) yields no root-level verified routes', () => {
  for (const id of ['GET /rest', 'DELETE /rest/{lineId}']) assert.notEqual(conf(jv, id), 'verified', `${id} is a sub-resource route, not a root route`);
});
test('QA-J-10 JAX-RS: interface @Path implemented by a class', () => expectAll(jv, ['GET /rest/customers/{id}']));
test('QA-J-11 Micronaut: module context-path, uri=, {?query}, uris array, no-arg @Post', () => {
  expectAll(jv, ['GET /mn/books/{id}', 'GET /mn/books', 'POST /mn/books', 'DELETE /mn/books/{id}', 'DELETE /mn/books/remove/{id}']);
  const l = jv.api('api:GET /mn/books');
  assert.ok(['max', 'offset'].every((q) => l.attrs.parameters?.some((p) => p.name === q && p.in === 'query')));
  expectNone(jv, /^\w+ \/shop\/books|^\w+ \/mn\/(api|shop)/); // module configs do not leak
});
test('QA-J-12 Spring relationships: interface with two impls is not resolved to either; repository → entity from generic arg', () => {
  const r = reach(jv, 'api:GET /shop/api/products', 4);
  assert.deepEqual([...r].filter((id) => /DefaultProductService|CachingProductService|ProductHelper/.test(id)), []);
  assert.ok(jv.g.edges.some((e) => /ProductRepository/.test(e.source) && e.target === 'entity:Product' && e.type === 'depends_on'));
});
