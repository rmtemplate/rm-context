// Load a fixture directory into an extraction cache and build the scan graph, without touching .rmcontext.
import fs from 'node:fs';
import path from 'node:path';
import { extract } from '../scripts/lib/extract.mjs';
import { buildScanGraph } from '../scripts/lib/scan.mjs';
import { ROOT } from './helpers.mjs';

export function loadFixture(name) {
  const dir = path.join(ROOT, 'tests', 'fixtures', 'routes', name);
  const cache = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else { const rel = path.relative(dir, abs).split(path.sep).join('/'); cache[rel] = { x: extract(rel, fs.readFileSync(abs, 'utf8')) }; }
    }
  };
  walk(dir);
  return cache;
}

export function routeGraph(cache) {
  const g = buildScanGraph(cache, { id: 'fx', name: 'fx' });
  const apis = g.nodes.filter((n) => n.type === 'api');
  return { g, apis, ids: new Set(apis.map((n) => n.id)), edges: new Set(g.edges.map((e) => e.id)), api: (id) => apis.find((n) => n.id === id) };
}

// "GET /a" strings for every api node, sorted.
export const routeList = (apis) => apis.map((n) => n.name).sort();
