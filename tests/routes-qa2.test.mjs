// Independent QA re-run (round 2) of the route intelligence engine. Fixtures in tests/fixtures/routes/qa2/ were written
// from framework semantics, separately from the implementer's and the first QA round's fixtures, and the expectations
// below were fixed before the engine was run. A failure here is a QA finding (see TC-002), not a test to be adjusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadFixture, routeGraph } from './routes-helpers.mjs';
import { validateGraph } from '../scripts/lib/graph.mjs';
import { fixture, ok } from './helpers.mjs';

const dn = routeGraph(loadFixture('qa2/dotnet'));
const jv = routeGraph(loadFixture('qa2/jvm'));
const byName = (G, name) => G.apis.find((n) => n.name.toLowerCase() === name.toLowerCase());
const has = (G, name) => assert.ok(byName(G, name), `missing route ${name}; have:\n${G.apis.map((n) => n.name).join('\n')}`);
const verified = (G, name) => { has(G, name); assert.equal(byName(G, name).confidence, 'verified', name); };
const none = (G, re) => assert.deepEqual(G.apis.map((n) => n.name).filter((n) => re.test(n)), []);
const out = (G, src) => G.g.edges.filter((e) => e.source === src);
const reach = (G, src, depth = 4) => { const seen = new Set([src]); let fr = [src]; for (let d = 0; d < depth; d++) fr = fr.flatMap((s) => out(G, s).map((e) => e.target)).filter((t) => !seen.has(t) && seen.add(t)); return seen; };
// Table node ids keep the schema casing (table:Invoices), so the target is compared case-insensitively.
const edge = (G, s, t) => G.g.edges.find((e) => e.source === s && e.target.toLowerCase() === t.toLowerCase());

test('QA2 graphs validate', () => {
  assert.deepEqual(validateGraph(dn.g).errors, []);
  assert.deepEqual(validateGraph(jv.g).errors, []);
});

// ---------- C# ----------
test('QA2-CS-01 controller: version route parameter, [controller], [HttpGet, Route("x")] on one line, object return types', () => {
  verified(dn, 'GET /api/v{version:apiVersion}/warehouse/{sku}');
  verified(dn, 'GET /api/v{version:apiVersion}/warehouse/summary');
  verified(dn, 'POST /api/v{version:apiVersion}/warehouse/bulk');
  none(dn, /ghost/i);
});
test('QA2-CS-02 original template casing is kept in metadata while the id stays lower-cased for tokens', () => {
  const r = byName(dn, 'GET /api/v{version:apiVersion}/warehouse/{sku}');
  assert.match(JSON.stringify(r.attrs), /\[controller\]|apiVersion/);
});
test('QA2-CS-03 MapGroup prefix from runtime configuration is never verified', () => {
  none(dn, /^GET \/ping$/);
  const ping = dn.apis.filter((n) => /\/ping$/.test(n.name));
  assert.ok(ping.length >= 1, 'the /ping declaration is still recorded (partial)');
  for (const p of ping) { assert.notEqual(p.confidence, 'verified', p.id); assert.ok(p.attrs.unresolved?.length, `${p.id} explains what is unresolved`); }
});
test('QA2-CS-04 chained group builder (.RequireAuthorization().WithTags()) keeps the constant prefix', () => {
  verified(dn, 'DELETE /admin/cache/{key}');
});
test('QA2-CS-05 group passed to a local static helper method', () => {
  has(dn, 'GET /reports/daily');
  assert.ok(!dn.apis.some((n) => n.name === 'GET /daily' && n.confidence === 'verified'), 'no verified root /daily');
});
test('QA2-CS-06 handler → interface → single implementation; never the uninjected WarehouseService', () => {
  const r = [...reach(dn, byName(dn, 'GET /api/v{version:apiVersion}/warehouse/{sku}').id)];
  assert.ok(r.some((id) => /#StockReader\.Read$/.test(id)), `StockReader.Read reached: ${r.join(', ')}`);
  assert.deepEqual(dn.g.edges.filter((e) => /WarehouseService/.test(e.target) && e.type !== 'belongs_to').map((e) => e.id), []);
});
test('QA2-CS-07 EF Core: ToTable and [Table] are verified and override the DbSet name; DbSet default is inferred with a reason', () => {
  assert.equal(edge(dn, 'entity:Customer', 'table:crm_customers')?.confidence, 'verified');
  assert.equal(edge(dn, 'entity:LedgerLine', 'table:ledger_lines')?.confidence, 'verified');
  assert.equal(edge(dn, 'entity:Customer', 'table:customer'), undefined, 'no link to the similarly named decoy');
  assert.equal(edge(dn, 'entity:LedgerLine', 'table:lines'), undefined, '[Table] overrides the DbSet property name');
  const inv = edge(dn, 'entity:Invoice', 'table:invoices');
  assert.equal(inv?.confidence, 'inferred');
  assert.ok(inv.evidence?.[0]?.ref, 'inferred mapping states why (provenance)');
});

// ---------- JVM ----------
test('QA2-J-01 Spring: ${prop} from default yml + context-path; profile value never applied', () => {
  for (const r of ['GET /svc/catalog/items', 'GET /svc/catalog/items/search', 'POST /svc/catalog/items/search', 'GET /svc/catalog/items/find', 'POST /svc/catalog/items/find']) verified(jv, r);
  none(jv, /prod-catalog|ghost/);
});
test('QA2-J-02 generic and fully qualified array return types do not hide the action', () => {
  verified(jv, 'GET /svc/catalog/items');
  verified(jv, 'GET /svc/catalog/items/find');
});
test('QA2-J-03 actions inherited from a generic abstract base take the derived controller prefix', () => {
  verified(jv, 'GET /svc/catalog/items/{id}');
  verified(jv, 'DELETE /svc/catalog/items/{id}');
  none(jv, /^(GET|DELETE) \/\{id\}$/);
});
test('QA2-J-04 key defined only in a profile file: partial, never verified, profile recorded', () => {
  const ops = jv.apis.filter((n) => /\/health$/.test(n.name));
  assert.ok(ops.length >= 1, 'health declaration recorded');
  for (const o of ops) { assert.notEqual(o.confidence, 'verified', o.id); assert.match(JSON.stringify(o.attrs), /prod/); }
  none(jv, /^GET \/svc\/ops\/health$/);
});
test('QA2-J-05 JAX-RS path declared on the interface, @ApplicationPath applied', () => {
  const r = jv.apis.find((n) => /^GET (\/svc)?\/rest\/stock\/\{sku\}$/.test(n.name));
  assert.ok(r, jv.apis.map((n) => n.name).join('\n'));
  assert.notEqual(r.attrs.resolutionStatus, 'partial');
});
test('QA2-J-06 handler → injected service; never the uninjected CatalogService', () => {
  const r = [...reach(jv, byName(jv, 'GET /svc/catalog/items').id)];
  assert.ok(r.some((id) => /#ItemService\.all$/.test(id)), r.join(', '));
  assert.deepEqual(jv.g.edges.filter((e) => /CatalogService/.test(e.target) && e.type !== 'belongs_to').map((e) => e.id), []);
});
test('QA2-J-07 JPA: @Table verified; default naming (no pluralisation) inferred with a reason; decoys untouched', () => {
  assert.equal(edge(jv, 'entity:PurchaseOrder', 'table:cat_orders')?.confidence, 'verified');
  assert.equal(edge(jv, 'entity:PurchaseOrder', 'table:purchase_orders'), undefined);
  // Spring Boot's default physical naming maps Item → item (snake_case, singular). A plural "items" is Rails/Laravel convention.
  const it = edge(jv, 'entity:Item', 'table:item');
  assert.equal(it?.confidence, 'inferred');
  assert.ok(it.evidence?.[0]?.ref, 'inferred mapping states why (provenance)');
  assert.equal(edge(jv, 'entity:Item', 'table:items'), undefined);
});

// ---------- incremental: function ids written by the previous extractor ----------
test('QA2-INC-01 agent edges on C# methods survive the change to class-qualified function ids (graph from an older extractor)', () => {
  const dir = fixture('routes/qa2/dotnet');
  ok(dir, 'init');
  const rc = (...p) => path.join(dir, '.rmcontext', ...p);
  const ctl = 'Inventory.Api/Controllers/WarehouseController.cs';
  const qualified = `function:${ctl}#WarehouseController.GetBySku`;
  const legacy = `function:${ctl}#GetBySku`;
  // Rewrite the graph and cache the way the previous extractor (EXTRACTOR_VERSION 4, unqualified method ids) left them.
  const nodes = JSON.parse(fs.readFileSync(rc('graph', 'nodes.json'), 'utf8'));
  const edges = JSON.parse(fs.readFileSync(rc('graph', 'edges.json'), 'utf8'));
  assert.ok(nodes.some((n) => n.id === qualified), 'current extractor writes class-qualified ids');
  const fix = (s) => s.replace(/#(\w+)\.(\w+)$/, (m, c, n) => (/\.(cs|java|kt)#/.test(s) ? `#${n}` : m));
  for (const n of nodes) if (n.type === 'function') { n.id = fix(n.id); n.name = n.name.split('.').pop(); }
  for (const e of edges) { e.source = fix(e.source); e.target = fix(e.target); e.id = `${e.source}|${e.type}|${e.target}`; }
  nodes.push({ id: 'REQ-77', type: 'requirement', name: 'Stock lookup', origin: 'agent', confidence: 'manual', evidence: [{ file: ctl, type: 'user' }] });
  edges.push({ id: `${legacy}|implements|REQ-77`, source: legacy, target: 'REQ-77', type: 'implements', origin: 'agent', confidence: 'manual', evidence: [{ file: ctl, type: 'user' }] });
  fs.writeFileSync(rc('graph', 'nodes.json'), JSON.stringify(nodes));
  fs.writeFileSync(rc('graph', 'edges.json'), JSON.stringify(edges));
  const files = JSON.parse(fs.readFileSync(rc('state', 'files.json'), 'utf8'));
  files.extractorVersion = 4;
  for (const v of Object.values(files.files)) for (const d of v.x?.decls || []) delete d.cls;
  fs.writeFileSync(rc('state', 'files.json'), JSON.stringify(files));

  ok(dir, 'refresh');
  const scan = JSON.parse(fs.readFileSync(rc('state', 'scan.json'), 'utf8'));
  const after = JSON.parse(fs.readFileSync(rc('graph', 'edges.json'), 'utf8'));
  const afterNodes = JSON.parse(fs.readFileSync(rc('graph', 'nodes.json'), 'utf8'));
  assert.deepEqual(scan.orphanedAgentEdges, [], 'no agent edge orphaned');
  assert.ok(after.some((e) => e.source === qualified && e.target === 'REQ-77' && e.origin === 'agent'), 'agent edge follows the new id');
  // Top-level statements' local functions (Program.cs MapReports) have no containing class, so they stay unqualified.
  assert.deepEqual(afterNodes.filter((n) => n.type === 'function' && /\.cs#\w+$/.test(n.id) && !/Program\.cs#/.test(n.id)).map((n) => n.id), [], 'no unqualified C# method ids remain');
  assert.deepEqual(validateGraph({ nodes: afterNodes, edges: after }).errors, []);
});

// ---------- entity → table conventions of the declaration extractors (JPA, Laravel, Rails, Django, SQLAlchemy) ----------
import { extract } from '../scripts/lib/extract.mjs';
import { buildScanGraph } from '../scripts/lib/scan.mjs';
const mini = (files) => {
  const cache = Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, { x: extract(rel, text) }]));
  return buildScanGraph(cache, { id: 'p', name: 'p' }).edges.filter((e) => e.source.startsWith('entity:') && e.target.startsWith('table:'));
};
const sql = (...t) => t.map((n) => `CREATE TABLE ${n} (id INT);`).join('\n');
test('QA2-ENT-01 JPA default naming is singular snake_case: no link to a plural table', () => {
  const e = mini({ 'src/OrderLine.java': 'package a;\nimport jakarta.persistence.Entity;\n@Entity\npublic class OrderLine { }\n', 'db/V1.sql': sql('order_lines') });
  assert.deepEqual(e.map((x) => x.id), []);
  const e2 = mini({ 'src/OrderLine.java': 'package a;\nimport jakarta.persistence.Entity;\n@Entity\npublic class OrderLine { }\n', 'db/V1.sql': sql('order_line', 'order_lines') });
  assert.deepEqual(e2.map((x) => `${x.target} ${x.confidence}`), ['table:order_line inferred']);
  assert.match(e2[0].evidence[0].ref, /JPA/);
});
test('QA2-ENT-02 Laravel and Rails: plural snake_case, inferred with the convention named', () => {
  const l = mini({ 'app/Models/Category.php': '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Category extends Model {}\n', 'db/s.sql': sql('categories', 'category') });
  assert.deepEqual(l.map((x) => `${x.target} ${x.confidence}`), ['table:categories inferred']);
  assert.match(l[0].evidence[0].ref, /Laravel/);
  const r = mini({ 'app/models/order_line.rb': 'class OrderLine < ApplicationRecord\nend\n', 'db/s.sql': sql('order_lines') });
  assert.deepEqual(r.map((x) => `${x.target} ${x.confidence}`), ['table:order_lines inferred']);
  assert.match(r[0].evidence[0].ref, /Rails/);
});
test('QA2-ENT-03 explicit table names are verified and exact', () => {
  const l = mini({ 'app/Models/Line.php': "<?php\nclass Line extends Model {\n  protected $table = 'legacy_lines';\n}\n", 'db/s.sql': sql('legacy_lines', 'lines') });
  assert.deepEqual(l.map((x) => `${x.target} ${x.confidence}`), ['table:legacy_lines verified']);
});
test('QA2-ENT-04 Django uses <app>_<model>; SQLAlchemy without __tablename__ has no default and gets no edge', () => {
  const d = mini({ 'shop/models.py': 'from django.db import models\n\nclass Order(models.Model):\n    pass\n', 'db/s.sql': sql('shop_order', 'order', 'orders') });
  assert.deepEqual(d.map((x) => `${x.target} ${x.confidence}`), ['table:shop_order inferred']);
  assert.match(d[0].evidence[0].ref, /Django/);
  const s = mini({ 'app/db.py': 'class Order(Base):\n    id = Column(Integer)\n', 'db/s.sql': sql('order', 'orders') });
  assert.deepEqual(s.map((x) => x.id), []);
});
