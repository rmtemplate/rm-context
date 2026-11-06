import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, upsert, impact, rtm, edgeId } from '../scripts/lib/graph.mjs';

const N = (id, type, extra = {}) => ({ id, type, name: id, origin: 'agent', confidence: 'inferred', evidence: [], ...extra });
const E = (source, type, target, extra = {}) => { const e = { source, type, target, origin: 'agent', confidence: 'inferred', evidence: [], ...extra }; e.id = edgeId(e); return e; };

test('validation rejects bad types, dangling edges, unevidenced verified claims and illegal endpoints', () => {
  const g = {
    nodes: [N('a', 'file'), N('b', 'bogus'), N('c', 'file', { confidence: 'verified' }), N('d', 'file', { evidence: [{ file: '/etc/passwd', type: 'declaration' }] }), N('t', 'task')],
    edges: [E('a', 'calls', 'zzz'), E('a', 'tested_by', 'c'), E('a', 'depends_on', 'c', { confidence: 'verified' }), E('t', 'blocks', 'a')],
  };
  const { errors } = validateGraph(g);
  const has = (re) => assert.ok(errors.some((e) => re.test(e)), `expected ${re}\n${errors.join('\n')}`);
  has(/node b: unknown type/);
  has(/node c: verified nodes need evidence/);
  has(/repository-relative/);
  has(/target node does not exist/);
  has(/target type "file" not allowed for tested_by/);
  has(/verified relationships need source evidence/);
  has(/target type "file" not allowed for blocks/);
});

test('secret-like content in graph names is rejected', () => {
  const { errors } = validateGraph({ nodes: [N('x', 'server', { name: 'db password=SuperSecret123' })], edges: [] });
  assert.ok(errors.some((e) => /secret/.test(e)));
});

test('upsert protects scan-owned facts and clears stale flags', () => {
  const g = { nodes: [N('file:a.js', 'file', { origin: 'scan', confidence: 'verified', evidence: [{ file: 'a.js', type: 'declaration' }] }), N('BR-1', 'business_requirement', { stale: true })], edges: [] };
  upsert(g, { nodes: [{ id: 'file:a.js', description: 'Entry point', confidence: 'inferred' }, { id: 'BR-1', type: 'business_requirement', name: 'R' }] });
  const f = g.nodes.find((n) => n.id === 'file:a.js');
  assert.equal(f.origin, 'scan');
  assert.equal(f.confidence, 'verified');
  assert.equal(f.description, 'Entry point');
  assert.equal(g.nodes.find((n) => n.id === 'BR-1').stale, undefined);
  assert.throws(() => upsert(g, { remove: { nodes: ['file:a.js'] } }), /scan-owned/);
});

test('impact follows dependents, implementers, tests and plan links but not the project root', () => {
  const g = {
    nodes: ['project:p', 'module:m', 'file:db.js', 'file:svc.js', 'file:api.js', 'test:svc.test.js', 'api:GET /x', 'BR-1', 'T-1', 'service:web', 'server:s1', 'dependency:npm/x']
      .map((id) => N(id, id.startsWith('BR') ? 'business_requirement' : id.startsWith('T-') ? 'task' : id.split(':')[0])),
    edges: [E('module:m', 'belongs_to', 'project:p'), E('file:db.js', 'belongs_to', 'module:m'), E('file:svc.js', 'depends_on', 'file:db.js'), E('file:api.js', 'depends_on', 'file:svc.js'),
      E('file:svc.js', 'tested_by', 'test:svc.test.js'), E('file:api.js', 'implements', 'api:GET /x'), E('api:GET /x', 'implements', 'BR-1'), E('T-1', 'implements', 'BR-1'),
      E('service:web', 'deployed_on', 'server:s1'), E('file:db.js', 'depends_on', 'dependency:npm/x')],
  };
  const ids = (r) => new Set(r.affected.map((a) => a.node.id));
  const r = impact(g, ['file:db.js']);
  for (const id of ['file:svc.js', 'file:api.js', 'test:svc.test.js', 'api:GET /x', 'BR-1', 'module:m']) assert.ok(ids(r).has(id), id);
  assert.ok(!ids(r).has('T-1'), 'T-1 is 5 hops away, beyond the default depth');
  assert.ok(ids(impact(g, ['file:db.js'], 5)).has('T-1'));
  assert.ok(!ids(r).has('project:p'));
  assert.ok(!ids(r).has('dependency:npm/x'), 'a file change does not affect its third-party dependency');
  assert.ok(!ids(r).has('service:web'));
  assert.ok(ids(impact(g, ['server:s1'])).has('service:web'));
  assert.equal(r.affected.find((a) => a.node.id === 'BR-1').depth, 4);
});

test('RTM coverage: covered, partial, not traced', () => {
  const g = {
    nodes: [N('BR-1', 'business_requirement'), N('BR-2', 'business_requirement'), N('BR-3', 'business_requirement'), N('UC-1', 'use_case'), N('api:POST /u', 'api'), N('file:u.js', 'file'), N('test:u.test.js', 'test'), N('file:b.js', 'file'), N('T-1', 'task')],
    edges: [E('UC-1', 'satisfies', 'BR-1'), E('api:POST /u', 'implements', 'UC-1'), E('file:u.js', 'implements', 'api:POST /u'), E('file:u.js', 'tested_by', 'test:u.test.js'), E('file:b.js', 'implements', 'BR-2'), E('T-1', 'implements', 'BR-1')],
  };
  const rows = Object.fromEntries(rtm(g).map((r) => [r.requirement.id, r]));
  assert.equal(rows['BR-1'].status, 'Covered (inferred tests)');
  g.edges.find((e) => e.type === 'tested_by').confidence = 'verified';
  assert.equal(rtm(g).find((r) => r.requirement.id === 'BR-1').status, 'Covered');
  assert.deepEqual(rows['BR-1'].tests, ['test:u.test.js']);
  assert.deepEqual(rows['BR-1'].tasks, ['T-1']);
  assert.equal(rows['BR-2'].status, 'Partial');
  assert.equal(rows['BR-3'].status, 'Not traced');
});
