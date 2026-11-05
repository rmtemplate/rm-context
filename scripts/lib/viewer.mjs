// Builds the single-file offline viewer from graph, documents and plan.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeFile, now, PLUGIN_ROOT } from './util.mjs';
import * as G from './graph.mjs';
import { renderGanttSvg, progress, criticalPath, validatePlan } from './pm.mjs';

export function buildViewer(c) {
  const g = G.loadGraph(c);
  const manifest = readJson(c.manifest);
  const reg = readJson(c.registry, { documents: [] });
  let plan = fs.existsSync(c.plan) ? readJson(c.plan) : null;
  if (plan && validatePlan(c, plan).errors.length) plan = { ...plan, invalid: true };
  const slim = (ev) => (ev || []).slice(0, 5).map(({ file, lines, type, confidence, ref }) => ({ file, lines, type, confidence, ref }));
  const nodes = g.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, description: n.description, confidence: n.confidence, origin: n.origin, stale: n.stale || undefined, attrs: n.attrs, evidence: slim(n.evidence) }));
  const edges = g.edges.map((e) => ({ source: e.source, target: e.target, type: e.type, confidence: e.confidence, stale: e.stale || undefined }));
  const mods = g.nodes.filter((n) => n.type === 'module').map((m) => ({ id: m.id, name: m.name, n: g.edges.filter((e) => e.target === m.id && e.type === 'belongs_to').length })).sort((a, b) => b.n - a.n).slice(0, 12);
  const data = {
    generatedAt: now(), manifest, layers: G.LAYERS, propagation: G.PROPAGATION, stats: G.stats(g), graph: { nodes, edges }, modules: mods,
    documents: reg.documents.map(({ id, title, type, status, version, author, updatedAt, path: p, nodes: ns, needsReview }) => ({ id, title, type, status, version, author, updatedAt, path: p, nodes: ns, needsReview })),
    rtm: G.rtm(g).map((r) => ({ id: r.requirement.id, status: r.status })),
    plan, progress: plan ? progress(c, plan) : null, critical: plan && !plan.invalid ? criticalPath(plan).path : [],
  };
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'viewer', 'template.html'), 'utf8');
  // Escape "</" so embedded data can never close the script element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = tpl.replace('/*__RMC_DATA__*/null', () => json).replace('/*__GANTT__*/null', () => renderGanttSvg.toString());
  writeFile(c.viewer, html);
  writeFile(path.join(path.dirname(c.viewer), 'graph.html'), '<!doctype html><meta charset="utf-8"><title>RM Context graph</title><meta http-equiv="refresh" content="0;url=index.html#graph"><a href="index.html#graph">Open graph</a>\n');
  return c.viewer;
}
