// Unified Project Intelligence Graph: schema, validation, persistence, query, impact, traceability.
import fs from 'node:fs';
import { readJson, writeJson, now, fail } from './util.mjs';
import { findSecrets } from './ignore.mjs';

export const LAYERS = {
  business: ['stakeholder', 'business_requirement', 'business_process', 'business_rule', 'use_case', 'user_story'],
  system: ['system', 'module', 'feature', 'requirement', 'api', 'database', 'table', 'entity', 'integration'],
  engineering: ['file', 'class', 'function', 'component', 'dependency', 'test'],
  infrastructure: ['server', 'container', 'service', 'network', 'environment', 'deployment', 'pipeline'],
  project: ['project', 'milestone', 'sprint', 'task', 'risk', 'issue', 'assumption', 'question', 'decision', 'document'],
};
export const NODE_TYPES = Object.fromEntries(Object.entries(LAYERS).flatMap(([l, ts]) => ts.map((t) => [t, l])));
export const EDGE_TYPES = ['belongs_to', 'implements', 'depends_on', 'calls', 'reads_from', 'writes_to',
  'integrates_with', 'deployed_on', 'tested_by', 'satisfies', 'blocks', 'related_to'];
export const CONFIDENCE = ['verified', 'inferred', 'manual'];
export const ORIGINS = ['scan', 'agent', 'manual'];
export const EVIDENCE_TYPES = ['declaration', 'import', 'route', 'schema', 'config', 'call', 'test', 'doc', 'commit', 'user'];

// Semantic constraints on edge endpoints (by layer or type). Unlisted edges are unconstrained.
const EDGE_RULES = {
  tested_by: { target: (t) => t === 'test' },
  deployed_on: { target: (t) => NODE_TYPES[t] === 'infrastructure' },
  satisfies: { target: (t) => ['business', 'system'].includes(NODE_TYPES[t]) },
  blocks: { source: (t) => NODE_TYPES[t] === 'project' || t === 'dependency', target: (t) => NODE_TYPES[t] === 'project' },
};

// Legacy (0.2.0) edge vocabulary → current.
const LEGACY_EDGES = { reads: 'reads_from', writes: 'writes_to', uses: 'depends_on', imports: 'depends_on', routes_to: 'implements' };
const LEGACY_NODES = { route: 'api', endpoint: 'api', external_service: 'integration' };

export const layerOf = (type) => NODE_TYPES[type] || 'unknown';
export const edgeId = (e) => `${e.source}|${e.type}|${e.target}`;

export function loadGraph(c) {
  const nodes = readJson(c.nodes, []);
  const edges = readJson(c.edges, []);
  return { nodes: Array.isArray(nodes) ? nodes : nodes.nodes || [], edges: Array.isArray(edges) ? edges : edges.edges || [] };
}

export function saveGraph(c, g) {
  const { errors } = validateGraph(g);
  if (errors.length) fail(`Refusing to write invalid graph:\n  ${errors.slice(0, 20).join('\n  ')}`);
  g.nodes.sort((a, b) => a.id.localeCompare(b.id));
  g.edges.sort((a, b) => a.id.localeCompare(b.id));
  writeJson(c.nodes, g.nodes);
  writeJson(c.edges, g.edges);
}

// Upgrade 0.2.0 graphs in place. Unknown items are kept but reported.
export function migrateGraph(g) {
  const notes = [];
  for (const n of g.nodes) {
    if (LEGACY_NODES[n.type]) { notes.push(`node ${n.id}: type ${n.type} → ${LEGACY_NODES[n.type]}`); n.type = LEGACY_NODES[n.type]; }
    n.origin ??= 'manual';
    n.confidence ??= n.evidenceStatus && CONFIDENCE.includes(n.evidenceStatus) ? n.evidenceStatus : 'inferred';
    if (!n.evidence && n.file) n.evidence = [{ file: n.file, lines: n.line ? [n.line, n.line] : undefined, type: 'declaration', confidence: n.confidence }];
    delete n.evidenceStatus; delete n.file; delete n.line;
    n.evidence ??= [];
  }
  for (const e of g.edges) {
    if (e.type === 'contains') { [e.source, e.target] = [e.target, e.source]; e.type = 'belongs_to'; notes.push(`edge contains → belongs_to (reversed)`); }
    if (LEGACY_EDGES[e.type]) { notes.push(`edge ${e.source}→${e.target}: ${e.type} → ${LEGACY_EDGES[e.type]}`); e.type = LEGACY_EDGES[e.type]; }
    e.origin ??= 'manual';
    e.confidence ??= 'inferred';
    if (e.evidence && !Array.isArray(e.evidence)) e.evidence = [{ ...e.evidence, lines: e.evidence.line ? [e.evidence.line, e.evidence.line] : undefined, type: 'declaration', confidence: e.confidence }];
    e.evidence ??= [];
    e.id = edgeId(e);
  }
  return notes;
}

function checkEvidence(where, ev, errors) {
  if (!Array.isArray(ev)) return errors.push(`${where}: evidence must be an array`);
  ev.forEach((x, i) => {
    const w = `${where}.evidence[${i}]`;
    if (x.type !== 'user' && x.type !== 'commit' && (!x.file || typeof x.file !== 'string')) errors.push(`${w}: file is required`);
    if (x.file && (/^([a-z]:|\/|\\)/i.test(x.file) || x.file.split('/').includes('..'))) errors.push(`${w}: file must be repository-relative (${x.file})`);
    if (x.lines !== undefined && !(Array.isArray(x.lines) && x.lines.length === 2 && x.lines.every(Number.isInteger) && x.lines[0] >= 1 && x.lines[1] >= x.lines[0])) errors.push(`${w}: lines must be [start, end] with 1 ≤ start ≤ end`);
    if (!EVIDENCE_TYPES.includes(x.type)) errors.push(`${w}: type must be one of ${EVIDENCE_TYPES.join(', ')}`);
    if (x.confidence && !CONFIDENCE.includes(x.confidence)) errors.push(`${w}: invalid confidence ${x.confidence}`);
  });
}

export function validateGraph(g) {
  const errors = [], warnings = [];
  const ids = new Map();
  for (const n of g.nodes) {
    const w = `node ${n.id ?? '(no id)'}`;
    if (!n.id || typeof n.id !== 'string' || /[\r\n]/.test(n.id)) { errors.push(`${w}: id must be a single-line string`); continue; }
    if (ids.has(n.id)) errors.push(`${w}: duplicate id`);
    ids.set(n.id, n);
    if (!NODE_TYPES[n.type]) errors.push(`${w}: unknown type "${n.type}"`);
    if (!n.name) errors.push(`${w}: name is required`);
    if (!ORIGINS.includes(n.origin)) errors.push(`${w}: origin must be one of ${ORIGINS.join(', ')}`);
    if (!CONFIDENCE.includes(n.confidence)) errors.push(`${w}: confidence must be one of ${CONFIDENCE.join(', ')}`);
    checkEvidence(w, n.evidence ?? [], errors);
    if (n.confidence === 'verified' && n.origin !== 'manual' && !(n.evidence || []).length) errors.push(`${w}: verified nodes need evidence`);
  }
  const eids = new Set();
  for (const e of g.edges) {
    const w = `edge ${e.source}→${e.target} (${e.type})`;
    if (!EDGE_TYPES.includes(e.type)) errors.push(`${w}: unknown type`);
    const s = ids.get(e.source), t = ids.get(e.target);
    if (!s) errors.push(`${w}: source node does not exist`);
    if (!t) errors.push(`${w}: target node does not exist`);
    if (e.source === e.target) errors.push(`${w}: self-loop`);
    if (e.id !== edgeId(e)) errors.push(`${w}: id must be "${edgeId(e)}"`);
    if (eids.has(e.id)) errors.push(`${w}: duplicate edge`);
    eids.add(e.id);
    if (!ORIGINS.includes(e.origin)) errors.push(`${w}: invalid origin`);
    if (!CONFIDENCE.includes(e.confidence)) errors.push(`${w}: invalid confidence`);
    checkEvidence(w, e.evidence ?? [], errors);
    if (e.confidence === 'verified' && e.origin !== 'manual' && !(e.evidence || []).length) errors.push(`${w}: verified relationships need source evidence`);
    const rule = EDGE_RULES[e.type];
    if (rule && s && t) {
      if (rule.source && !rule.source(s.type)) errors.push(`${w}: source type "${s.type}" not allowed for ${e.type}`);
      if (rule.target && !rule.target(t.type)) errors.push(`${w}: target type "${t.type}" not allowed for ${e.type}`);
    }
  }
  const text = JSON.stringify(g.nodes.map((n) => [n.name, n.description, n.attrs]));
  for (const h of findSecrets(text)) errors.push(`graph contains secret-like content (${h.kind}); remove it`);
  const stale = g.nodes.filter((n) => n.stale).length + g.edges.filter((e) => e.stale).length;
  if (stale) warnings.push(`${stale} agent/manual item(s) are stale: their evidence file changed since they were recorded`);
  return { errors, warnings };
}

// Agents and users add knowledge through this, never by hand-editing JSON.
export function upsert(g, payload, { origin = 'agent' } = {}) {
  if (!ORIGINS.includes(origin) || origin === 'scan') fail(`origin must be agent or manual`);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const stamp = now();
  let added = 0, updated = 0;
  for (const raw of payload.nodes || []) {
    const prev = byId.get(raw.id);
    if (prev && prev.origin === 'scan') {
      // Scan-owned facts stay scan-owned; agents may only annotate them.
      for (const k of ['description', 'tags']) if (raw[k] !== undefined) prev[k] = raw[k];
      prev.attrs = { ...prev.attrs, ...raw.attrs };
      updated++;
      continue;
    }
    const n = { confidence: 'inferred', evidence: [], ...prev, ...raw, origin: raw.origin || prev?.origin || origin, updated: stamp };
    delete n.stale;
    prev ? updated++ : added++;
    byId.set(n.id, n);
  }
  g.nodes = [...byId.values()];
  const edges = new Map(g.edges.map((e) => [e.id, e]));
  for (const raw of payload.edges || []) {
    const e = { confidence: 'inferred', evidence: [], origin, ...raw, updated: stamp };
    e.id = edgeId(e);
    delete e.stale;
    edges.has(e.id) ? updated++ : added++;
    edges.set(e.id, e);
  }
  const rmNodes = new Set(payload.remove?.nodes || []);
  for (const id of rmNodes) if (byId.get(id)?.origin === 'scan') fail(`Cannot remove scan-owned node ${id}; it is derived from source`);
  g.nodes = g.nodes.filter((n) => !rmNodes.has(n.id));
  const rmEdges = new Set(payload.remove?.edges || []);
  g.edges = [...edges.values()].filter((e) => !rmEdges.has(e.id) && !rmNodes.has(e.source) && !rmNodes.has(e.target));
  return { added, updated, removed: rmNodes.size + rmEdges.size };
}

export function index(g) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map(), inc = new Map();
  for (const e of g.edges) {
    (out.get(e.source) || out.set(e.source, []).get(e.source)).push(e);
    (inc.get(e.target) || inc.set(e.target, []).get(e.target)).push(e);
  }
  return { byId, out: (id) => out.get(id) || [], inc: (id) => inc.get(id) || [] };
}

export function search(g, query, limit = 15) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = [];
  for (const n of g.nodes) {
    const name = n.name.toLowerCase(), id = n.id.toLowerCase(), desc = (n.description || '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name === t) score += 10; else if (name.includes(t)) score += 5;
      if (id.includes(t)) score += 2;
      if (desc.includes(t)) score += 1;
    }
    if (score && terms.every((t) => name.includes(t) || id.includes(t) || desc.includes(t))) score += 5;
    if (score) scored.push({ score, node: n });
  }
  return scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, limit).map((s) => s.node);
}

// How a change propagates along each relationship type.
//   fwd: from source to target when the source changes.  back: from target to source when the target changes.
export const PROPAGATION = {
  belongs_to: { fwd: true, back: 'start' }, implements: { fwd: true, back: true }, satisfies: { fwd: true, back: true },
  depends_on: { back: true }, calls: { back: true }, reads_from: { back: true }, writes_to: { fwd: true, back: true },
  integrates_with: { fwd: true, back: true }, deployed_on: { fwd: true, back: true }, tested_by: { fwd: true },
  blocks: { fwd: true }, related_to: { fwd: 'start', back: 'start' },
};

export function impact(g, startIds, maxDepth = 4) {
  const ix = index(g);
  const seen = new Map(startIds.map((id) => [id, { depth: 0, via: null, confidence: 'verified' }]));
  const queue = [...startIds];
  const weaker = (a, b) => (CONFIDENCE.indexOf(a) > CONFIDENCE.indexOf(b) ? a : b);
  while (queue.length) {
    const id = queue.shift();
    const cur = seen.get(id);
    if (cur.depth >= maxDepth) continue;
    const isStart = cur.depth === 0;
    const steps = [];
    for (const e of ix.out(id)) { const p = PROPAGATION[e.type] || {}; if (p.fwd === true || (p.fwd === 'start' && isStart)) steps.push([e.target, e]); }
    for (const e of ix.inc(id)) { const p = PROPAGATION[e.type] || {}; if (p.back === true || (p.back === 'start' && isStart)) steps.push([e.source, e]); }
    for (const [next, e] of steps) {
      // The project root contains everything; reaching it says nothing about impact.
      if (seen.has(next) || !ix.byId.has(next) || ix.byId.get(next).type === 'project') continue;
      seen.set(next, { depth: cur.depth + 1, via: { from: id, edge: e.type }, confidence: weaker(cur.confidence, e.confidence) });
      queue.push(next);
    }
  }
  const affected = [...seen].filter(([id]) => !startIds.includes(id)).map(([id, s]) => ({ node: ix.byId.get(id), ...s }));
  const byLayer = {};
  for (const a of affected) (byLayer[layerOf(a.node.type)] ||= []).push(a);
  return { start: startIds.map((id) => ix.byId.get(id)).filter(Boolean), affected, byLayer };
}

// Requirement Traceability Matrix derived from the graph.
export function rtm(g) {
  const ix = index(g);
  const reqTypes = ['business_requirement', 'requirement', 'user_story'];
  const near = (id, types, edgeTypes) => {
    const ids = new Set();
    for (const e of [...ix.inc(id), ...ix.out(id)]) {
      if (edgeTypes && !edgeTypes.includes(e.type)) continue;
      const other = e.source === id ? e.target : e.source;
      if (types.includes(ix.byId.get(other)?.type)) ids.add(other);
    }
    return [...ids];
  };
  const linkTypes = ['implements', 'satisfies', 'related_to', 'belongs_to'];
  return g.nodes.filter((n) => reqTypes.includes(n.type)).sort((a, b) => a.id.localeCompare(b.id)).map((req) => {
    const useCases = near(req.id, ['use_case', 'user_story', 'business_process'], linkTypes);
    const sysIds = near(req.id, ['feature', 'api', 'module', 'requirement', 'entity', 'table', 'integration'], linkTypes);
    for (const uc of useCases) sysIds.push(...near(uc, ['feature', 'api', 'module'], linkTypes));
    const system = [...new Set(sysIds)].filter((x) => x !== req.id);
    const codeIds = new Set(near(req.id, ['file', 'class', 'function', 'component'], linkTypes));
    for (const s of system) near(s, ['file', 'class', 'function', 'component'], ['implements', 'belongs_to']).forEach((x) => codeIds.add(x));
    const code = [...codeIds];
    const sources = new Set([req.id, ...system, ...code]);
    const testEdges = g.edges.filter((e) => ['tested_by', 'related_to'].includes(e.type) && ((sources.has(e.source) && ix.byId.get(e.target)?.type === 'test') || (sources.has(e.target) && ix.byId.get(e.source)?.type === 'test')));
    const tests = [...new Set(testEdges.map((e) => (sources.has(e.source) ? e.target : e.source)))];
    const tasks = near(req.id, ['task', 'milestone'], null);
    // Scanner test links are name/import heuristics; say so instead of claiming firm coverage.
    const testsInferredOnly = tests.length > 0 && testEdges.every((e) => e.confidence === 'inferred');
    const status = code.length && tests.length ? (testsInferredOnly ? 'Covered (inferred tests)' : 'Covered') : code.length || system.length ? 'Partial' : 'Not traced';
    return { requirement: req, useCases, system, code, tests, tasks, status };
  });
}

export function stats(g) {
  const byType = {}, byLayer = {}, byConfidence = {};
  for (const n of g.nodes) { byType[n.type] = (byType[n.type] || 0) + 1; byLayer[layerOf(n.type)] = (byLayer[layerOf(n.type)] || 0) + 1; }
  for (const e of g.edges) byConfidence[e.confidence] = (byConfidence[e.confidence] || 0) + 1;
  return { nodes: g.nodes.length, edges: g.edges.length, byLayer, byType, edgeConfidence: byConfidence, stale: g.nodes.filter((n) => n.stale).length + g.edges.filter((e) => e.stale).length };
}

export const graphExists = (c) => fs.existsSync(c.nodes);
