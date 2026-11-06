import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, routeGraph, routeList } from './routes-helpers.mjs';
import { validateGraph } from '../scripts/lib/graph.mjs';
import { capabilityMatrix } from '../scripts/lib/routes/registry.mjs';

const dotnet = routeGraph(loadFixture('dotnet-shop'));
const spring = routeGraph(loadFixture('spring-shop'));
const jvm = routeGraph(loadFixture('jvm-misc'));
const ev = (n) => `${n.evidence[0].file}:${n.evidence[0].lines.join('-')}`;
const has = (G, ids) => { for (const id of ids) assert.ok(G.edges.has(id), `missing edge ${id}`); };

test('route fixtures build valid graphs', () => {
  for (const G of [dotnet, spring, jvm]) assert.deepEqual(validateGraph(G.g).errors, []);
});

test('ASP.NET Core controllers: class prefix, tokens, inheritance, ~/ override, constants, AcceptVerbs', () => {
  const r = routeList(dotnet.apis.filter((n) => n.attrs.framework === 'aspnet-core' && n.attrs.kind !== 'minimal'));
  for (const x of ['GET /api/users', 'GET /api/users/{id}', 'POST /api/users', 'GET /api/v2/customers/{id:int}', 'DELETE /api/v2/customers/{id:int}',
    'GET /api/v2/customers/search', 'HEAD /api/v2/customers/search', 'POST /api/v2/customers/import', 'GET /api/customers-legacy',
    'GET /api/v1/products', 'GET /api/v1/products/{id:int}']) assert.ok(r.includes(x), `missing ${x}`);
  const u = dotnet.api('api:GET /api/users/{id}');
  assert.equal(u.confidence, 'verified');
  assert.equal(u.attrs.resolutionStatus, 'complete');
  assert.equal(u.attrs.handler, 'GetById');
  assert.equal(ev(u), 'src/Shop.Api/Controllers/UsersController.cs:22-23');
  assert.ok(u.attrs.originalTemplate, 'original template kept beside the resolved path');
  assert.ok(u.attrs.parameters.some((p) => p.name === 'id' && p.in === 'path'));
});

test('ASP.NET Core Minimal API: nested MapGroup, extension call sites, MapMethods, fallback, dynamic prefix', () => {
  for (const id of ['api:GET /api/v1/orders', 'api:GET /api/v1/orders/{id:guid}', 'api:POST /api/v1/orders', 'api:PUT /api/v1/orders/{id:guid}/status',
    'api:PATCH /api/v1/orders/{id:guid}/status', 'api:GET /api/v1/admin/users', 'api:DELETE /api/v1/admin/users/{id:int}', 'api:GET /health', 'api:ANY /{*path:nonfile}'])
    assert.ok(dotnet.ids.has(id), `missing ${id}`);
  const d = dotnet.apis.find((n) => n.name.endsWith('/settings'));
  assert.equal(d.confidence, 'inferred');
  assert.equal(d.attrs.resolutionStatus, 'partial');
  assert.deepEqual(d.attrs.unresolved.map((u) => [u.knownPrefix, u.expression]), [['/', 'GetTenantPrefix()']]);
  assert.ok(d.attrs.unresolved[0].reason);
});

test('legacy ASP.NET Web API: RoutePrefix, verb by name (inferred), conventional routes', () => {
  for (const id of ['api:GET /api/orders', 'api:POST /api/orders', 'api:DELETE /api/v1/orders/{id:int}', 'api:GET /api/values', 'api:GET /api/values/{id}', 'api:POST /api/values'])
    assert.ok(dotnet.ids.has(id), `missing ${id}`);
  assert.equal(dotnet.api('api:GET /api/orders/{id:int}').confidence, 'inferred');
  assert.equal(dotnet.api('api:GET /api/values').confidence, 'inferred');
  assert.ok(!dotnet.apis.some((n) => n.evidence[0].file.includes('Shop.Worker')), 'a worker service exposes no routes');
});

test('.NET relationships: route → handler → service → table, DbSet entities', () => {
  has(dotnet, ['api:GET /api/v1/orders/{id:guid}|calls|function:src/Shop.Api/Program.cs#GetOrder',
    'class:src/Shop.Api/Data/ShopDbContext.cs#ShopDbContext|depends_on|entity:User']);
  const e = dotnet.g.edges;
  assert.ok(e.some((x) => x.type === 'reads_from' && x.target === 'table:users' && x.source.includes('UserService')));
  assert.ok(e.some((x) => x.type === 'writes_to' && x.target === 'table:users' && x.source.includes('UserService')));
  // never by name similarity: no handler link to the legacy controller's GetOrder
  assert.ok(!e.some((x) => x.source === 'api:GET /api/v1/orders/{id:guid}' && x.target.includes('Legacy.Api')));
});

test('Spring: config placeholders, context-path, arrays, inheritance, constants; clients and comments ignored', () => {
  assert.deepEqual(routeList(spring.apis.filter((n) => n.attrs.framework === 'spring')), [
    'DELETE /shop/api/orders/{id}/items', 'GET /shop/api/orders/by-id/{id}', 'GET /shop/api/orders/{id}', 'GET /shop/api/users', 'GET /shop/api/users/{id}',
    'GET /shop/api/v2/reports', 'GET /shop/api/v2/reports/summary', 'HEAD /shop/api/orders/by-id/{id}', 'HEAD /shop/api/orders/{id}', 'POST /shop/api/users', 'PUT /shop/api/orders/{id}']);
  assert.ok(!spring.apis.some((n) => /stock|commented-out/.test(n.name)), 'FeignClient and commented-out mappings produce no routes');
  const u = spring.api('api:GET /shop/api/users/{id}');
  assert.equal(u.confidence, 'verified');
  assert.equal(ev(u), 'src/main/java/com/acme/shop/web/UserController.java:23-26');
  for (const id of ['api:GET /fn/hello', 'api:POST /fn/echo', 'api:GET /fn/api/status', 'api:GET /legacy/*', 'api:POST /legacy/*']) assert.ok(spring.ids.has(id), `missing ${id}`);
});

test('Spring relationships: controller → service → repository → entity → table', () => {
  const S = 'function:src/main/java/com/acme/shop/service/UserService.java#';
  has(spring, [`function:src/main/java/com/acme/shop/web/UserController.java#UserController.findById|calls|${S}UserService.findById`, `${S}UserService.create|writes_to|table:app_users`,
    `${S}UserService.findAll|reads_from|table:app_users`, 'class:src/main/java/com/acme/shop/repository/UserRepository.java#UserRepository|depends_on|entity:User', 'entity:User|depends_on|table:app_users']);
});

test('application config never leaks secrets into the cache', () => {
  const c = loadFixture('spring-shop');
  assert.ok(!JSON.stringify(c).includes('change-me'));
});

test('JAX-RS, Micronaut, Vert.x and Ktor', () => {
  assert.deepEqual(routeList(jvm.apis), ['ANY /vx/static/*', 'GET /greet/{name}', 'GET /kt/health', 'GET /kt/users', 'GET /rest/items', 'GET /rest/items/{id}', 'GET /vx/ping',
    'POST /greet', 'POST /kt/users/{id}', 'POST /rest/items', 'POST /vx/items']);
  const jr = jvm.g.routeReport.find((r) => r.id === 'jax-rs');
  assert.ok(jr.issues.some((i) => /sub-resource/.test(i.reason)), 'sub-resource locators are reported, not guessed');
});

test('coverage report and capability matrix are honest', () => {
  const rep = dotnet.g.routeReport.find((r) => r.id === 'aspnet-core');
  assert.equal(rep.status, 'supported');
  assert.equal(rep.routes, rep.verified + rep.inferred);
  const m = capabilityMatrix();
  assert.ok(m.some((x) => x.id === 'spring' && x.status === 'supported'));
  for (const x of m) assert.ok(['supported', 'partial', 'detected', 'planned'].includes(x.status), `${x.id}: ${x.status}`);
});

test('incremental refresh: a shared prefix change re-resolves dependents, remaps agent edges, and deleted controllers lose their routes', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const { fixture, ok, graph, readJson } = await import('./helpers.mjs');
  const dir = fixture('routes/dotnet-shop');
  ok(dir, 'init');
  let ids = new Set(graph(dir).nodes.map((n) => n.id));
  assert.ok(ids.has('api:GET /api/v1/products') && ids.has('api:GET /api/v1/orders'));
  const payload = path.join(dir, '.rmcontext', '.local', 'p.json');
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, JSON.stringify({ nodes: [{ id: 'SR-001', type: 'requirement', name: 'List products', confidence: 'manual', evidence: [{ type: 'user', confidence: 'manual' }] }],
    edges: [{ source: 'api:GET /api/v1/products', target: 'SR-001', type: 'implements', confidence: 'manual', evidence: [{ type: 'user', confidence: 'manual' }] }] }));
  ok(dir, 'graph', 'upsert', payload);
  const routes = path.join(dir, 'src/Shop.Api/ApiRoutes.cs');
  fs.writeFileSync(routes, fs.readFileSync(routes, 'utf8').replace('"/api/v1"', '"/api/v9"'));
  fs.rmSync(path.join(dir, 'src/Shop.Api/Controllers/UsersController.cs'));
  ok(dir, 'refresh');
  const g = graph(dir);
  ids = new Set(g.nodes.map((n) => n.id));
  for (const id of ['api:GET /api/v9/products', 'api:GET /api/v9/orders', 'api:GET /api/v1/admin/users']) assert.ok(ids.has(id), `missing ${id}`);
  for (const id of ['api:GET /api/v1/products', 'api:GET /api/v1/orders', 'api:GET /api/users', 'api:POST /api/users']) assert.ok(!ids.has(id), `stale ${id}`);
  assert.ok(g.edges.some((e) => e.id === 'api:GET /api/v9/products|implements|SR-001'), 'agent edge follows the remapped route');
  const scan = readJson(path.join(dir, '.rmcontext/state/scan.json'));
  assert.ok(scan.routeIdChanges.some((c) => c.from === 'api:GET /api/v1/products' && c.to === 'api:GET /api/v9/products'));
  assert.ok(scan.routes.some((r) => r.id === 'aspnet-core'));
});

test('framework recognition for languages without a structural adapter yet', async () => {
  const { REGISTRY } = await import('../scripts/lib/routes/registry.mjs');
  const samples = { fastapi: 'from fastapi import FastAPI', django: 'from django.urls import path', rails: 'Rails.application.routes.draw do', axum: 'use axum::Router;',
    symfony: String.raw`use Symfony\Component\Routing\Attribute\Route;`, slim: String.raw`use Slim\Factory\AppFactory;`, gin: 'import "github.com/gin-gonic/gin"',
    echo: '"github.com/labstack/echo/v4"', nestjs: "import { Controller } from '@nestjs/common';", sinatra: "require 'sinatra'" };
  for (const [id, text] of Object.entries(samples)) assert.ok(REGISTRY.find((a) => a.id === id).detect({ text }), `${id} not recognised`);
  assert.equal(REGISTRY.find((a) => a.id === 'gin').detect({ text: 'import "github.com/gin-gonic/ginx"' }), null);
});

// ---------- Regression tests for the QA findings (TC-001, B1–B11); fixture tests/fixtures/routes/regress ----------
const rg = routeGraph(loadFixture('regress'));
const rgNames = new Set(rg.apis.map((n) => n.name));

test('B2/B3: generic, nested, qualified, array, nullable and object return types keep their actions', () => {
  for (const r of ['GET /api/rt/a', 'GET /api/rt/b', 'GET /api/rt/c', 'GET /api/rt/d', 'GET /api/rt/e', 'GET /api/rt/list', 'GET /api/rt/select', 'GET /api/rt/nullable',
    'GET /app/v1/products', 'GET /app/v1/products/export', 'GET /app/v1/products/match', 'GET /app/v1/products/from']) assert.ok(rgNames.has(r), `missing ${r}`);
  assert.ok(!rg.apis.some((n) => n.name === 'ANY /api/rt'), 'no phantom action from a mis-parsed member');
  assert.ok(!rg.g.nodes.some((n) => n.type === 'class' && /#(A|B|C|D|E)$/.test(n.id)), 'object-returning members are not classes');
  assert.ok(!rg.g.nodes.some((n) => n.type === 'function' && /#PayRequest$/.test(n.id)), 'positional records are not functions');
});

test('B1: profile-specific config is conditional, never applied, and only-in-profile keys stay partial', () => {
  const p = rg.api('api:GET /app/v1/products');
  assert.equal(p.confidence, 'verified');
  assert.ok(p.attrs.conditional.some((c) => c.profile === 'prod' && c.key === 'server.servlet.context-path' && c.value === '/prod-app'));
  assert.ok(!rg.apis.some((n) => /prod-app|prod-only/.test(n.name)), 'no route built from a profile file');
  const y = rg.apis.find((n) => n.name.endsWith('/x/y'));
  assert.equal(y.confidence, 'inferred');
  assert.equal(y.attrs.resolutionStatus, 'partial');
  assert.match(y.attrs.unresolved[0].reason, /profile-specific.*prod/);
});

test('B4: sub-resources compose through the locator return type (inferred); unknown sub-resources are reported', () => {
  assert.equal(jvm.api('api:GET /rest/items/{id}').confidence, 'verified');
  const q = routeGraph(loadFixture('qa-jvm'));
  for (const id of ['GET /rest/orders/{id}/lines', 'DELETE /rest/orders/{id}/lines/{lineId}']) assert.equal(q.api(`api:${id}`)?.confidence, 'inferred', id);
  assert.ok(jvm.g.routeReport.find((r) => r.id === 'jax-rs').issues.some((i) => /PartResource/.test(i.reason)));
});

test('B6: partial controller without [Route] in any part is partial/inferred; with a [Route] part it is composed', () => {
  for (const n of rg.apis.filter((x) => /ping/.test(x.name))) { assert.equal(n.confidence, 'inferred', n.name); assert.equal(n.attrs.resolutionStatus, 'partial', n.name); }
  assert.ok(!rgNames.has('GET /ping'), 'no root route guessed');
});

test('B7: inherited actions per derived controller, overrides not duplicated, orphan abstract bases reported', () => {
  assert.ok(rgNames.has('GET /api/invoices') && rgNames.has('GET /api/invoices/{id}'));
  const one = rg.api('api:GET /api/invoices/{id}');
  assert.equal(one.evidence.length, 1, 'the override replaces the inherited action');
  assert.ok(one.evidence[0].file.endsWith('Bases.cs'));
  assert.ok(!rg.apis.some((n) => /orphan-base/.test(n.name)));
  assert.ok(rg.g.routeReport.find((r) => r.id === 'aspnet-core').issues.some((i) => i.pattern === 'abstract base controller'));
  assert.match(rg.api('api:GET /api/invoices').attrs.resolution.join(' '), /inherited by InvoicesController/);
});

test('B8/B11: placeholder keys resolve by reference; local variables get an honest reason', () => {
  const q = routeGraph(loadFixture('qa-jvm'));
  assert.equal(q.api('api:GET /shop/admin/stats')?.confidence, 'verified');
  assert.match(q.apis.find((n) => n.name.endsWith('/z/w')).attrs.unresolved[0].reason, /not found among the path-valued keys/);
});

test('B9: entity → table only from [Table], ToTable or the DbSet name; never a similar name', () => {
  const e = new Map(rg.g.edges.filter((x) => x.source.startsWith('entity:') && x.type === 'depends_on').map((x) => [x.source, x]));
  assert.equal(e.get('entity:Invoice').target, 'table:tbl_invoice');
  assert.equal(e.get('entity:Invoice').confidence, 'verified');
  assert.equal(e.get('entity:Entry').target, 'table:ledger');
  assert.equal(e.get('entity:Customer').target, 'table:people');
  assert.equal(e.get('entity:Customer').confidence, 'inferred');
  const q = routeGraph(loadFixture('qa-dotnet'));
  assert.ok(!q.g.edges.some((x) => x.source === 'entity:Customer' && x.target === 'table:customer'), 'Customer is not linked to the unrelated customer table');
});

test('B5: agent edges follow multi-prefix and path-array routes through a shared prefix change; unrelated edges stay', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const { fixture, ok, graph, readJson } = await import('./helpers.mjs');
  const dir = fixture('routes/qa-dotnet');
  ok(dir, 'init');
  const payload = path.join(dir, '.rmcontext', '.local', 'p.json');
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  const man = { confidence: 'manual', evidence: [{ type: 'user', confidence: 'manual' }] };
  fs.writeFileSync(payload, JSON.stringify({ nodes: [{ id: 'SR-901', type: 'requirement', name: 'Get order', ...man }, { id: 'SR-902', type: 'requirement', name: 'Legacy get', ...man }],
    edges: [{ source: 'api:GET /api/v1/orders/{id:int:min(1)}', target: 'SR-901', type: 'implements', ...man },
      { source: 'api:GET /api/legacy-orders/{id:int:min(1)}', target: 'SR-902', type: 'implements', ...man },
      { source: 'api:GET /health/live', target: 'SR-902', type: 'related_to', ...man }] }));
  ok(dir, 'graph', 'upsert', payload);
  const routes = path.join(dir, 'src/Qa.Api/Routes.cs');
  const src = fs.readFileSync(routes, 'utf8');
  assert.match(src, /V1 = Root \+ "\/v1"/);
  fs.writeFileSync(routes, src.replace('V1 = Root + "/v1"', 'V1 = Root + "/v2"'));
  ok(dir, 'refresh');
  const ids = new Set(graph(dir).edges.map((e) => e.id));
  for (const id of ['api:GET /api/v2/orders/{id:int:min(1)}|implements|SR-901', 'api:GET /api/legacy-orders/{id:int:min(1)}|implements|SR-902', 'api:GET /health/live|related_to|SR-902'])
    assert.ok(ids.has(id), `missing ${id}`);
  const scan = readJson(path.join(dir, '.rmcontext/state/scan.json'));
  assert.deepEqual(scan.orphanedAgentEdges, []);
  assert.ok(scan.routeIdChanges.some((c) => c.to === 'api:GET /api/v2/orders/{id:int:min(1)}'));
  // a deleted controller: its routes and the agent edge on them go, reported as orphaned (no dangling edge)
  fs.rmSync(path.join(dir, 'src/Qa.Api/Controllers/OrdersController.cs'));
  ok(dir, 'refresh');
  const g = graph(dir), nodeIds = new Set(g.nodes.map((n) => n.id));
  assert.ok(![...nodeIds].some((id) => /orders\/\{id:int:min/.test(id)));
  for (const e of g.edges) assert.ok(nodeIds.has(e.source) && nodeIds.has(e.target), `dangling ${e.id}`);
  assert.ok(readJson(path.join(dir, '.rmcontext/state/scan.json')).orphanedAgentEdges.some((id) => /SR-901/.test(id)));
});
