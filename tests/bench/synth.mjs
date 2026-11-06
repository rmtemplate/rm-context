// Synthetic project graphs for benchmarks: realistic shape (modules → files → functions, APIs, tables, tests).
import fs from 'node:fs';
import path from 'node:path';

function rng(seed) { let s = seed >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296); }

export function synthGraph(target, seed = 7) {
  const r = rng(seed), nodes = [], edges = [], files = {};
  const pick = (a) => a[Math.floor(r() * a.length)];
  const ev = (file, a = 1, b = 20) => [{ file, lines: [a, b], type: 'declaration', confidence: 'verified' }];
  const add = (n) => { nodes.push({ origin: 'scan', confidence: 'verified', ...n }); return n.id; };
  const edge = (source, target, type, confidence = 'verified') => edges.push({ id: `${source}|${type}|${target}`, source, target, type, origin: 'scan', confidence });
  add({ id: 'project:synth', type: 'project', name: 'synth' });
  const M = Math.max(4, Math.round(target / 120)), mods = [], fileIds = [], fnIds = [], tables = [];
  for (let m = 0; m < M; m++) { const id = add({ id: `module:src/m${m}`, type: 'module', name: `src/m${m}` }); mods.push(id); edge(id, 'project:synth', 'belongs_to', 'inferred'); }
  for (let t = 0; t < Math.max(3, Math.round(target * 0.02)); t++) tables.push(add({ id: `table:t${t}`, type: 'table', name: `t${t}`, evidence: ev('db/schema.sql', t * 5 + 1, t * 5 + 4), attrs: { columns: [{ name: 'id', type: 'INT' }] } }));
  while (nodes.length < target) {
    const m = mods.length ? mods[Math.floor(r() * mods.length)] : null, dir = m.slice(7);
    const rel = `${dir}/${['controllers', 'services', 'models', 'utils'][Math.floor(r() * 4)]}/f${fileIds.length}.js`;
    const fid = add({ id: `file:${rel}`, type: 'file', name: rel, evidence: ev(rel, 1, 1) });
    files[rel] = { size: 1000, x: { lang: 'js', loc: 120 } };
    fileIds.push(fid); edge(fid, m, 'belongs_to', 'inferred');
    const k = 1 + Math.floor(r() * 4);
    for (let i = 0; i < k; i++) { const id = add({ id: `function:${rel}#fn${i}`, type: 'function', name: `fn${fileIds.length}_${i}`, evidence: ev(rel, i * 20 + 1, i * 20 + 15) }); fnIds.push(id); edge(id, fid, 'belongs_to'); }
    for (let i = 0; i < 2 && fileIds.length > 3; i++) { const o = pick(fileIds); if (o !== fid) edge(fid, o, 'depends_on'); }
    if (fnIds.length > 5) edge(fnIds[fnIds.length - 1], pick(fnIds), 'calls', 'inferred');
    if (r() < 0.12) { const a = add({ id: `api:GET /r${fileIds.length}`, type: 'api', name: `GET /r${fileIds.length}`, evidence: ev(rel, 3, 3) }); edge(fid, a, 'implements'); }
    if (r() < 0.2) edge(fid, pick(tables), r() < 0.5 ? 'reads_from' : 'writes_to', 'inferred');
    if (r() < 0.1) { const trel = `tests/t${fileIds.length}.test.js`; const t = add({ id: `test:${trel}`, type: 'test', name: trel, evidence: ev(trel) }); files[trel] = { size: 500, x: { lang: 'js', loc: 40, test: true } }; edge(fid, t, 'tested_by', 'inferred'); }
  }
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set();
  return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target && !seen.has(e.id) && seen.add(e.id)), files };
}

// Write a ready-to-view .rmcontext for `target` nodes into dir.
export function writeSynthProject(dir, target) {
  const g = synthGraph(target);
  const base = path.join(dir, '.rmcontext');
  for (const d of ['graph', 'state', 'documents', 'viewer', 'context']) fs.mkdirSync(path.join(base, d), { recursive: true });
  fs.writeFileSync(path.join(base, 'graph', 'nodes.json'), JSON.stringify({ schemaVersion: 2, nodes: g.nodes }));
  fs.writeFileSync(path.join(base, 'graph', 'edges.json'), JSON.stringify({ schemaVersion: 2, edges: g.edges }));
  fs.writeFileSync(path.join(base, 'state', 'files.json'), JSON.stringify({ extractorVersion: 3, files: g.files }));
  fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({ schemaVersion: 2, project: { id: 'synth', name: `synth-${target}` }, stack: { languages: { js: 1 } }, scan: { timestamp: new Date().toISOString(), mode: 'full' } }));
  fs.writeFileSync(path.join(base, 'documents', 'registry.json'), JSON.stringify({ documents: [] }));
  fs.writeFileSync(path.join(base, 'config.json'), '{}');
  return { nodes: g.nodes.length, edges: g.edges.length };
}
