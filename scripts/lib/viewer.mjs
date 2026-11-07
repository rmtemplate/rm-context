// Builds the single-file offline viewer: compiled Tailwind CSS, graph core, app script and project data in one HTML file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, writeFile, now, sha1, PLUGIN_ROOT } from './util.mjs';
import * as G from './graph.mjs';
import { renderGanttSvg, progress, criticalPath, validatePlan } from './pm.mjs';
import { readHandoffs } from './project.mjs';
import { contextStatus } from './context.mjs';
import { findSecrets } from './ignore.mjs';

const VIEWER_DIR = path.join(PLUGIN_ROOT, 'scripts', 'viewer');
const NOTE_DIRS = ['context', 'business', 'system', 'engineering', 'infrastructure', 'flows'];
const FILE_KEYS = ['lang', 'loc', 'test', 'imports', 'decls', 'routes', 'dbUses', 'http', 'tables'];

// Drop any line that looks like a credential before it is embedded.
const clean = (s) => String(s ?? '').replace(/^﻿/, '').split('\n').filter((l) => !findSecrets(l).length).join('\n');

function notes(c) {
  const out = [];
  for (const dir of NOTE_DIRS) {
    const d = c.p(dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md')).sort()) {
      const raw = clean(fs.readFileSync(path.join(d, f), 'utf8'));
      const title = (/^#\s+(.+)$/m.exec(raw)?.[1] || f.replace(/\.md$/, '')).trim();
      out.push({ path: `${dir}/${f}`, title, text: raw.slice(0, 8000), truncated: raw.length > 8000 || undefined });
    }
  }
  return out;
}

function files(c) {
  const cache = readJson(c.p('state', 'files.json'), { files: {} }).files || {};
  return Object.entries(cache).map(([p, v]) => {
    const f = { p };
    for (const k of FILE_KEYS) if (v.x?.[k] != null && !(Array.isArray(v.x[k]) && !v.x[k].length)) f[k] = v.x[k];
    return f;
  });
}

// viewer.css is committed with a hash of its sources. When the sources change (a developer edited app.js classes),
// rebuild it with Tailwind automatically; users with an unmodified plugin never trigger this.
const CSS_SOURCES = ['app.js', 'template.html', 'input.css', 'tailwind.config.cjs'];
function compiledCss() {
  const read = (f) => fs.readFileSync(path.join(VIEWER_DIR, f), 'utf8');
  const tag = `/* rmc-src:${sha1(CSS_SOURCES.map(read).join('\0'))} */\n`;
  const out = path.join(VIEWER_DIR, 'viewer.css');
  const current = fs.existsSync(out) ? read('viewer.css') : '';
  if (current.startsWith(tag)) return current;
  const win = process.platform === 'win32';
  const args = ['--yes', 'tailwindcss@3.4.17', '-c', path.join(VIEWER_DIR, 'tailwind.config.cjs'), '-i', path.join(VIEWER_DIR, 'input.css'), '-o', out, '--minify'];
  const r = spawnSync(win ? `npx ${args.map((a) => `"${a}"`).join(' ')}` : 'npx', win ? [] : args, { shell: win, stdio: 'ignore', timeout: 120000 });
  if (r.status === 0 && fs.existsSync(out)) { const css = tag + read('viewer.css').replace(/^\/\* rmc-src:\w+ \*\/\n/, ''); fs.writeFileSync(out, css); return css; }
  if (current) { console.error('Warning: viewer CSS sources changed but Tailwind could not be run (needs npx). Using the last compiled CSS.'); return current; }
  throw new Error('scripts/viewer/viewer.css is missing and Tailwind could not be run (needs npx).');
}

// A stored definition (never one flagged for a secret: those were not stored). Capped so the viewer stays small.
const DEF_MAX = 20000;
function defOf(base, o) {
  if (!o.definitionFile) return undefined;
  try { const t = fs.readFileSync(path.join(base, o.definitionFile), 'utf8'); return t.length > DEF_MAX ? t.slice(0, DEF_MAX) + '\n-- … truncated in the viewer; full text: rmc database show ' + o.kind + ' ' + o.name + ' --definition' : t; } catch { return undefined; }
}

// Database + mobile knowledge for the viewer: structure and metadata only (no definitions, no credentials).
function dbIntel(c) {
  const out = { targets: [], mobile: null, changes: [] };
  try {
    const dir = c.p('database'); const man = readJson(path.join(dir, 'manifest.json'), null);
    for (const [key, t] of Object.entries(man?.targets || {})) {
      const base = path.join(dir, t.scope, key); const idx = readJson(path.join(base, 'index.json'), { items: [] });
      const objs = [];
      for (const sub of ['schemas/tables', 'routines/procedures', 'routines/functions', 'routines/views', 'routines/triggers']) {
        const d = path.join(base, sub); if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) { const o = readJson(path.join(d, f), null); if (!o) continue;
          objs.push({ kind: o.kind, schema: o.schema, name: o.name, status: o.status, confidence: o.confidence, source: o.provenance?.source, file: o.provenance?.file, at: o.provenance?.updatedAt,
            columns: o.columns?.map((x) => ({ name: x.name, type: x.type, pk: x.pk || undefined, nullable: x.nullable, identity: x.identity || undefined })), primaryKey: o.primaryKey, foreignKeys: o.foreignKeys?.map((x) => ({ columns: x.columns, ref: x.ref?.name, refColumns: x.refColumns })),
            indexes: o.indexes?.map((x) => ({ name: x.name, columns: x.columns, unique: x.unique })), uniques: o.uniques?.map((x) => ({ name: x.name, columns: x.columns })), checks: o.checks?.map((x) => ({ name: x.name, definition: x.definition })), ddl: o.ddl, definition: defOf(base, o), params: o.params, encrypted: o.encrypted, review: o.reviewRequired, dynamic: o.dynamicSql, refs: o.references?.map((r) => ({ name: r.name, kind: r.kind, mode: r.mode, status: r.status, confidence: r.confidence })) }); }
      }
      const map = readJson(path.join(base, 'application-mapping', 'index.json'), { items: [], chain: [] });
      out.targets.push({ key, scope: t.scope, engine: t.engine, database: t.database, host: t.host, profile: t.profile, environment: t.environment, source: t.source, lastDiscoveredAt: t.lastDiscoveredAt, counts: t.counts, limitations: t.limitations, objects: objs, relationships: readJson(path.join(base, 'relationships.json'), { items: [] }).items, mapping: map.items.slice(0, 400), chain: map.chain.slice(0, 200), stats: idx.counts });
    }
  } catch { /* optional */ }
  try {
    const d = c.p('mobile'); const m = readJson(path.join(d, 'manifest.json'), null);
    if (m) out.mobile = { manifest: m, architecture: readJson(path.join(d, 'architecture.json'), {}), state: readJson(path.join(d, 'state-management.json'), {}).items || [], data: readJson(path.join(d, 'data-layer.json'), {}), deps: readJson(path.join(d, 'dependencies.json'), {}), navigation: (readJson(path.join(d, 'navigation.json'), {}).items || []).slice(0, 100) };
  } catch { /* optional */ }
  try {
    const d = c.p('state', 'database-changes');
    if (fs.existsSync(d)) out.changes = fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f), null)).filter(Boolean).map((p) => ({ id: p.id, stage: p.stage, environment: p.environment, target: p.target?.database || p.target?.id, risk: p.risk, backup: p.backup?.status, migration: p.migration?.file, framework: p.migration?.framework, destructive: p.destructive, createdAt: p.createdAt }));
  } catch { /* optional */ }
  return out;
}

export function buildViewer(c) {
  const g = G.loadGraph(c);
  const manifest = readJson(c.manifest);
  const reg = readJson(c.registry, { documents: [] });
  let plan = fs.existsSync(c.plan) ? readJson(c.plan) : null;
  if (plan && validatePlan(c, plan).errors.length) plan = { ...plan, invalid: true };
  const slim = (ev) => (ev || []).slice(0, 5).map(({ file, lines, type, confidence, ref }) => ({ file, lines, type, confidence, ref }));
  const nodes = g.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, description: n.description, confidence: n.confidence, origin: n.origin, stale: n.stale || undefined, attrs: n.attrs, evidence: slim(n.evidence) }));
  const edges = g.edges.map((e) => ({ source: e.source, target: e.target, type: e.type, confidence: e.confidence, origin: e.origin, stale: e.stale || undefined }));
  const handoffs = readHandoffs(c).filter((h) => !h.invalid).map((h) => ({
    id: h.id, at: h.at, from: h.from, to: h.to, workflow: h.workflow, summary: clean(h.summary), nodes: h.nodes,
    ...Object.fromEntries(['artifacts', 'decisions', 'assumptions', 'openQuestions'].map((k) => [k, (h[k] || []).map((x) => clean(typeof x === 'string' ? x : JSON.stringify(x))).filter(Boolean)])),
  }));
  const data = {
    generatedAt: now(), manifest, layers: G.LAYERS, propagation: G.PROPAGATION, stats: G.stats(g), graph: { nodes, edges },
    documents: reg.documents.map(({ id, title, type, status, version, author, updatedAt, path: p, nodes: ns, sources, needsReview }) => {
      const f = c.p(p);
      const text = fs.existsSync(f) ? clean(fs.readFileSync(f, 'utf8')) : '';
      return { id, title, type, status, version, author, updatedAt, path: p, nodes: ns, sources, needsReview, text: text.slice(0, 120000), truncated: text.length > 120000 || undefined };
    }),
    rtm: G.rtm(g).map((r) => ({ id: r.requirement.id, status: r.status })),
    plan, progress: plan ? progress(c, plan) : null, critical: plan && !plan.invalid ? criticalPath(plan).path : [],
    files: files(c), handoffs, notes: notes(c), autoContext: contextStatus(c), dbIntel: dbIntel(c),
  };
  const read = (f) => fs.readFileSync(path.join(VIEWER_DIR, f), 'utf8');
  const core = read('graph-core.mjs').replace(/^export /gm, '');
  // Escape "<" so embedded data and code can never close the script element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  // Mermaid (vendored, MIT) is embedded only when a document or note has a diagram, and evaluated only when one is shown.
  const hasMermaid = [...data.documents, ...data.notes].some((x) => /```mermaid/.test(x.text));
  const mermaid = hasMermaid ? JSON.stringify(read('vendor/mermaid.min.js')).replace(/</g, '\\u003c') : 'null';
  // One pass over the template: inserted content is never re-scanned for placeholders.
  const parts = { CSS: compiledCss, RMC_DATA: () => json, GANTT: () => renderGanttSvg.toString(), CORE: () => core, APP: () => read('app.js'), MERMAID: () => mermaid };
  const html = read('template.html').replace(/\/\*__(CSS|RMC_DATA|GANTT|CORE|APP|MERMAID)__\*\/(?:null)?/g, (_, k) => parts[k]());
  writeFile(c.viewer, html);
  writeFile(path.join(path.dirname(c.viewer), 'graph.html'), '<!doctype html><meta charset="utf-8"><title>RM Context graph</title><meta http-equiv="refresh" content="0;url=index.html#/graph"><a href="index.html#/graph">Open graph</a>\n');
  return c.viewer;
}
