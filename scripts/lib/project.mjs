// Project-level operations: init, status, validation, search, impact, RTM, links, routing, hand-offs.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, writeFile, now, fail, git, PLUGIN_ROOT, SCHEMA_VERSION, sha1, readHandoffs } from './util.mjs';
import { listFiles } from './ignore.mjs';
import * as G from './graph.mjs';
import { validateAllDocs } from './docs.mjs';
import { validatePlan } from './pm.mjs';

const DIRS = ['context', 'business', 'system', 'engineering', 'infrastructure', 'project-management', 'documents', 'templates', 'graph', 'flows', 'references', 'viewer', 'state', '.local'];
export const AGENTS = ['business-analyst', 'system-analyst', 'project-manager', 'senior-engineer', 'devops-engineer', 'qa', 'documentation', 'quick-qa', 'architecture'];

export function initProject(c) {
  const created = [];
  for (const d of DIRS) if (!fs.existsSync(c.p(d))) { fs.mkdirSync(c.p(d), { recursive: true }); created.push(d + '/'); }
  const ensure = (file, content) => { if (!fs.existsSync(file)) { writeFile(file, content); created.push(path.relative(c.base, file)); } };
  ensure(c.p('.gitignore'), '# Machine-local state (absolute paths, file mtimes)\n.local/\nstate/files.json\n');
  ensure(c.config, JSON.stringify({ schemaVersion: SCHEMA_VERSION, models: {}, ignore: [], maxFileBytes: 1000000 }, null, 2) + '\n');
  ensure(c.registry, JSON.stringify({ schemaVersion: SCHEMA_VERSION, documents: [] }, null, 2) + '\n');
  ensure(c.nodes, '[]\n');
  ensure(c.edges, '[]\n');
  return created;
}

// ---------- model routing ----------
const ALIASES = ['opus', 'sonnet', 'haiku', 'inherit'];
export function resolveRouting(c) {
  const defaults = readJson(path.join(PLUGIN_ROOT, 'config', 'models.json'));
  const project = fs.existsSync(c.config) ? readJson(c.config).models || {} : {};
  const rows = [], warnings = [];
  for (const [agent, def] of Object.entries(defaults.agents)) {
    const override = project[agent];
    let model = override ?? def.model, source = override ? 'project' : 'default';
    if (!ALIASES.includes(model) && !/^claude-[a-z0-9.-]+$/.test(model)) {
      warnings.push(`${agent}: "${model}" is not a model alias or claude-* id; using default "${def.model}"`);
      model = def.model; source = 'default (invalid override)';
    } else if (!ALIASES.includes(model)) warnings.push(`${agent}: "${model}" is a full model id; it cannot be verified offline. If Claude Code rejects it, the fallback applies.`);
    rows.push({ agent, model, source, reason: def.reason });
  }
  for (const k of Object.keys(project)) if (!defaults.agents[k]) warnings.push(`Unknown agent in config.models: ${k}`);
  return { rows, fallback: defaults.fallback, warnings };
}
export function formatRouting(r) {
  return ['Agent default models (used when a delegation has no task category; with a category, rmc route picks the tier):', '',
    '| Agent | Model | Source | Reason |', '|---|---|---|---|',
    ...r.rows.map((x) => `| ${x.agent} | ${x.model} | ${x.source} | ${x.reason} |`), '',
    `Fallback: ${r.fallback.join(' → ')}`, 'Subagent models never change the main session model.',
    ...r.warnings.map((w) => `Warning: ${w}`)].join('\n');
}

// ---------- hand-offs ----------
export function addHandoff(c, h) {
  const errs = [];
  if (!AGENTS.includes(h.from) && h.from !== 'user' && h.from !== 'orchestrator') errs.push(`from must be an agent, "user" or "orchestrator"`);
  if (!AGENTS.includes(h.to) && h.to !== 'user' && h.to !== 'orchestrator') errs.push(`to must be an agent, "user" or "orchestrator"`);
  if (!h.summary) errs.push('summary is required');
  for (const k of ['artifacts', 'decisions', 'assumptions', 'openQuestions', 'nodes']) if (h[k] !== undefined && !Array.isArray(h[k])) errs.push(`${k} must be an array`);
  if (errs.length) fail(`Invalid hand-off: ${errs.join('; ')}`);
  const rec = { id: `H-${Date.now().toString(36)}`, at: now(), workflow: null, artifacts: [], decisions: [], assumptions: [], openQuestions: [], nodes: [], ...h };
  fs.mkdirSync(path.dirname(c.handoffs), { recursive: true });
  fs.appendFileSync(c.handoffs, JSON.stringify(rec) + '\n');
  return `Recorded hand-off ${rec.id}: ${rec.from} → ${rec.to}`;
}
export { readHandoffs }; // lives in util.mjs so the routing hook path does not load this module
export function listHandoffs(c, to) {
  const hs = readHandoffs(c).filter((h) => !to || h.to === to).slice(-20);
  if (!hs.length) return 'No hand-offs recorded.';
  return hs.map((h) => `${h.id} ${h.at.slice(0, 16)} ${h.from} → ${h.to}${h.workflow ? ` [${h.workflow}]` : ''}: ${h.summary}` +
    (h.openQuestions.length ? `\n    open questions: ${h.openQuestions.join(' | ')}` : '') + (h.artifacts.length ? `\n    artifacts: ${h.artifacts.join(', ')}` : '')).join('\n');
}

// ---------- search ----------
export function find(c, query, limit) {
  if (!query) fail('Usage: rmc find <terms…>');
  const g = G.loadGraph(c);
  const nodes = G.search(g, query, limit);
  const terms = query.toLowerCase().split(/\s+/);
  const reg = readJson(c.registry, { documents: [] });
  const docs = reg.documents.filter((d) => {
    const hay = `${d.id} ${d.type} ${d.title}`.toLowerCase();
    if (terms.every((t) => hay.includes(t))) return true;
    const f = c.p(d.path);
    return fs.existsSync(f) && terms.every((t) => fs.readFileSync(f, 'utf8').toLowerCase().includes(t));
  }).slice(0, limit);
  const notes = [];
  for (const dir of ['context', 'business', 'system', 'engineering', 'infrastructure', 'flows']) {
    const d = c.p(dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md'))) {
      const lines = fs.readFileSync(path.join(d, f), 'utf8').split('\n');
      lines.forEach((l, i) => { if (terms.every((t) => l.toLowerCase().includes(t))) notes.push(`.rmcontext/${dir}/${f}:${i + 1}  ${l.trim().slice(0, 120)}`); });
    }
  }
  const ev = (n) => (n.evidence || []).filter((e) => e.file).slice(0, 2).map((e) => `${e.file}${e.lines ? ':' + e.lines[0] : ''}`).join(', ');
  return [`## Graph (${nodes.length})`, ...nodes.map((n) => `- ${n.id} [${n.type}, ${n.confidence}${n.stale ? ', STALE' : ''}] ${ev(n)}`),
    `\n## Documents (${docs.length})`, ...docs.map((d) => `- ${d.id} ${d.title} [${d.status}] .rmcontext/${d.path}`),
    `\n## Notes (${Math.min(notes.length, limit)})`, ...notes.slice(0, limit).map((n) => `- ${n}`),
    nodes.length ? `\nInspect a node: rmc graph node "<id>" · Impact: rmc impact "<id>"` : ''].join('\n');
}

// ---------- change detection ----------
export function changedSinceScan(c) {
  const cache = readJson(c.files, { files: {} }).files;
  const config = readJson(c.config, {});
  const { files } = listFiles(c.root, { extraIgnore: config.ignore || [] });
  const changed = [];
  for (const rel of files) {
    const prev = cache[rel];
    if (!prev) { changed.push(rel); continue; }
    const st = fs.statSync(path.join(c.root, rel));
    if (st.size !== prev.size || (st.mtimeMs !== prev.mtimeMs && sha1(fs.readFileSync(path.join(c.root, rel))) !== prev.hash)) changed.push(rel);
  }
  const set = new Set(files);
  for (const rel of Object.keys(cache)) if (!set.has(rel)) changed.push(rel);
  return changed;
}

// ---------- impact ----------
function resolveStart(c, g, arg, changed) {
  const ix = G.index(g);
  const ids = new Set();
  const addFile = (rel) => {
    for (const p of [`file:${rel}`, `test:${rel}`]) if (ix.byId.has(p)) ids.add(p);
    for (const n of g.nodes) if (n.origin === 'scan' && n.type !== 'file' && (n.evidence || []).some((e) => e.file === rel) && n.type !== 'dependency') ids.add(n.id);
  };
  if (changed) changedSinceScan(c).forEach(addFile);
  if (arg) {
    if (ix.byId.has(arg)) ids.add(arg);
    else if (fs.existsSync(path.join(c.root, arg))) addFile(arg.replace(/\\/g, '/').replace(/^\.\//, ''));
    else { const hit = G.search(g, arg, 1)[0]; if (hit) ids.add(hit.id); }
  }
  return [...ids];
}

export function impactReport(c, arg, { changed, depth }) {
  const g = G.loadGraph(c);
  const start = resolveStart(c, g, arg, changed);
  if (!start.length) fail(changed ? 'No changes since the last scan.' : `Nothing matches "${arg}". Try: rmc find ${arg}`);
  const r = G.impact(g, start, depth);
  const ix = G.index(g);
  const ids = new Set([...start, ...r.affected.map((a) => a.node.id)]);
  const reg = readJson(c.registry, { documents: [] });
  const files = new Set([...ids].map((id) => ix.byId.get(id)).flatMap((n) => (n.evidence || []).map((e) => e.file)).filter(Boolean));
  const docs = reg.documents.filter((d) => (d.nodes || []).some((n) => ids.has(n)) || (d.sources || []).some((s) => files.has(s)));
  const plan = readJson(c.plan, { tasks: [] });
  const tasks = (plan.tasks || []).filter((t) => (t.nodes || []).some((n) => ids.has(n)) || (t.evidence || []).some((e) => files.has(e.file)) || ids.has(`task:${t.id}`) || ids.has(t.id));
  const ev = (n) => { const e = (n.evidence || []).find((x) => x.file); return e ? `\`${e.file}${e.lines ? `:${e.lines[0]}-${e.lines[1]}` : ''}\`` : '—'; };
  const sections = [
    ['Business requirements & processes', ['business']], ['System: modules, features, APIs, data', ['system']],
    ['Source code, components & tests', ['engineering']], ['Infrastructure & deployment', ['infrastructure']], ['Project management items', ['project']],
  ];
  const lines = [`# Change Impact Report`, '', `Generated: ${now()} · Depth: ${depth} · Graph: ${g.nodes.length} nodes / ${g.edges.length} edges`, '',
    '## Change origin', ...r.start.map((n) => `- \`${n.id}\` (${n.type}) — ${ev(n)}`), ''];
  for (const [title, layers] of sections) {
    const rows = r.affected.filter((a) => layers.includes(G.layerOf(a.node.type))).sort((a, b) => a.depth - b.depth);
    lines.push(`## ${title} (${rows.length})`);
    if (!rows.length) { lines.push('- None found in the graph. Absence here means "not traced", not "not affected".', ''); continue; }
    lines.push('| Node | Type | Hops | Via | Confidence | Evidence |', '|---|---|---|---|---|---|');
    for (const a of rows.slice(0, 60)) lines.push(`| \`${a.node.id}\` | ${a.node.type} | ${a.depth} | ${a.via.edge} ← \`${a.via.from}\` | ${a.confidence}${a.node.stale ? ' (stale)' : ''} | ${ev(a.node)} |`);
    if (rows.length > 60) lines.push(`| … ${rows.length - 60} more | | | | | |`);
    lines.push('');
  }
  lines.push(`## Plan tasks referencing affected items (${tasks.length})`, ...(tasks.length ? tasks.map((t) => `- ${t.id} ${t.name} [${t.status}]${t.milestone ? ' (milestone)' : ''}`) : ['- None linked.']), '');
  lines.push(`## Documents to review (${docs.length})`, ...(docs.length ? docs.map((d) => `- ${d.id} ${d.title} [${d.status}] \`.rmcontext/${d.path}\``) : ['- None linked.']), '');
  lines.push('## Reading this report', '- `verified`: every hop is backed by a literal source fact. `inferred`: at least one hop is heuristic and needs checking.',
    '- The graph only knows what was scanned or recorded by agents. Dynamic calls, configuration-driven wiring and undocumented business rules are not visible here.');
  return lines.join('\n') + '\n';
}

// ---------- RTM ----------
export function rtmMarkdown(c) {
  const g = G.loadGraph(c);
  const rows = G.rtm(g);
  const ix = G.index(g);
  const name = (id) => { const n = ix.byId.get(id); return n ? `${n.type === 'file' || n.type === 'test' ? n.name : id}` : id; };
  const cell = (xs) => (xs.length ? xs.slice(0, 6).map((x) => `\`${name(x)}\``).join('<br>') + (xs.length > 6 ? `<br>+${xs.length - 6}` : '') : '—');
  const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  return [`# Requirement Traceability Matrix`, '', `Generated from the project graph on ${now()}. ${rows.length} requirement(s): ` +
    (Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'), '',
    rows.length ? '| Requirement | Use cases / stories | System elements | Code | Tests | Tasks | Coverage |\n|---|---|---|---|---|---|---|' : '_No requirement nodes in the graph yet. The Business Analyst records them with `rmc graph upsert`._',
    ...rows.map((r) => `| **${r.requirement.id}** ${r.requirement.name} | ${cell(r.useCases)} | ${cell(r.system)} | ${cell(r.code)} | ${cell(r.tests)} | ${cell(r.tasks)} | ${r.status} |`),
    '', 'Coverage: **Covered** = traced to code and tests · **Covered (inferred tests)** = the only test links are scanner heuristics (import or file name); confirm the test exercises the requirement, then record a verified `tested_by` edge · **Partial** = traced to system or code without tests · **Not traced** = no downstream links recorded.'].join('\n') + '\n';
}

// ---------- links ----------
export function link(c, target) {
  const abs = path.resolve(c.root, target);
  const m = path.join(abs, '.rmcontext', 'manifest.json');
  if (!fs.existsSync(m)) fail(`${target} has no .rmcontext/manifest.json. Initialize it first.`);
  const other = readJson(m);
  const refs = readJson(c.refs, { projects: [] });
  const entry = { id: other.project.id, name: other.project.name, stack: [...(other.stack?.frameworks || [])].slice(0, 8), linkedAt: now(), role: 'reference-only' };
  refs.projects = [...refs.projects.filter((p) => p.id !== entry.id), entry];
  writeJson(c.refs, refs);
  const local = readJson(c.local, {});
  writeJson(c.local, { ...local, links: { ...(local.links || {}), [entry.id]: abs } });
  return `Linked ${entry.name} (${entry.id}). Query it with: rmc find <terms> --root "${abs}"`;
}

// ---------- status & validation ----------
export function status(c) {
  const manifest = readJson(c.manifest);
  const g = G.loadGraph(c);
  const reg = readJson(c.registry, { documents: [] });
  const plan = fs.existsSync(c.plan) ? readJson(c.plan) : null;
  const head = git(c.root, ['rev-parse', 'HEAD']);
  const changed = fs.existsSync(c.files) ? changedSinceScan(c) : null;
  const byStatus = {};
  for (const d of reg.documents) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  const hs = readHandoffs(c);
  const contextFiles = ['overview', 'architecture', 'tech-stack', 'business-rules', 'conventions'].map((f) => [f, fs.existsSync(c.p('context', f + '.md'))]);
  return {
    project: manifest.project, schemaVersion: manifest.schemaVersion, stack: manifest.stack, scan: manifest.scan,
    freshness: { headCommit: head, commitChanged: !!(head && manifest.scan.commit && head !== manifest.scan.commit), filesChangedSinceScan: changed?.length ?? null, sample: changed?.slice(0, 10) },
    graph: G.stats(g), context: Object.fromEntries(contextFiles),
    documents: { total: reg.documents.length, byStatus, needsReview: reg.documents.filter((d) => d.needsReview).map((d) => d.id) },
    plan: plan ? { tasks: (plan.tasks || []).length } : null,
    handoffs: { total: hs.length, openQuestions: hs.reduce((n, h) => n + (h.openQuestions?.length || 0), 0) },
  };
}
export function formatStatus(s) {
  const L = [`RM Context — ${s.project.name} (${s.project.id}), schema v${s.schemaVersion}`,
    `Last scan: ${s.scan.timestamp} (${s.scan.mode})${s.scan.commit ? ` at ${s.scan.commit.slice(0, 10)}` : ''}`];
  const f = s.freshness;
  L.push(f.filesChangedSinceScan ? `Freshness: STALE — ${f.filesChangedSinceScan} file(s) changed since scan (e.g. ${f.sample.slice(0, 3).join(', ')}). Run: rmc refresh` : f.commitChanged ? 'Freshness: commit changed since scan, files identical' : 'Freshness: up to date');
  L.push(`Graph: ${s.graph.nodes} nodes, ${s.graph.edges} edges — ${Object.entries(s.graph.byLayer).map(([k, v]) => `${k} ${v}`).join(', ')}${s.graph.stale ? ` — ${s.graph.stale} stale` : ''}`);
  L.push(`Context notes: ${Object.entries(s.context).map(([k, v]) => `${k} ${v ? '✓' : '·'}`).join('  ')}`);
  L.push(`Documents: ${s.documents.total}${s.documents.total ? ` (${Object.entries(s.documents.byStatus).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}${s.documents.needsReview.length ? ` — needs review: ${s.documents.needsReview.join(', ')}` : ''}`);
  L.push(`Plan: ${s.plan ? `${s.plan.tasks} task(s) — run rmc pm progress` : 'none (rmc pm init)'}`);
  L.push(`Hand-offs: ${s.handoffs.total}, open questions recorded: ${s.handoffs.openQuestions}`);
  return L.join('\n');
}

export function validateAll(c) {
  const r = {};
  const m = { errors: [], warnings: [] };
  try {
    const man = readJson(c.manifest);
    if (man.schemaVersion !== SCHEMA_VERSION) m.warnings.push(`schemaVersion ${man.schemaVersion} (current ${SCHEMA_VERSION}); run rmc refresh to migrate`);
    if (!man.project?.id) m.errors.push('project.id missing');
    if (/[a-z]:\\|^\/(home|users)\//i.test(JSON.stringify(man))) m.errors.push('manifest contains a machine-specific absolute path');
  } catch (e) { m.errors.push(e.message); }
  r.manifest = m;
  const cfg = { errors: [], warnings: [] };
  try {
    const conf = readJson(c.config, {});
    if (conf.ignore && !Array.isArray(conf.ignore)) cfg.errors.push('config.ignore must be an array of gitignore patterns');
    const routing = resolveRouting(c);
    cfg.warnings.push(...routing.warnings);
    const TIERS = ['low', 'medium', 'high'];
    for (const [k, v] of Object.entries(conf.tiers || {})) {
      if (!TIERS.includes(k)) cfg.errors.push(`config.tiers.${k}: tiers are ${TIERS.join(', ')}`);
      else if (typeof v !== 'string') cfg.errors.push(`config.tiers.${k} must be a model alias or claude-* id`);
    }
    for (const k of ['defaultTier', 'fallbackTier']) if (conf.routing?.[k] && !TIERS.includes(conf.routing[k])) cfg.errors.push(`config.routing.${k} must be one of ${TIERS.join(', ')}`);
  } catch (e) { cfg.errors.push(e.message); }
  r.config = cfg;
  try { r.graph = G.validateGraph(G.loadGraph(c)); } catch (e) { r.graph = { errors: [e.message], warnings: [] }; }
  try { r.documents = validateAllDocs(c); } catch (e) { r.documents = { errors: [e.message], warnings: [] }; }
  try { r.plan = fs.existsSync(c.plan) ? validatePlan(c, readJson(c.plan)) : { errors: [], warnings: ['no plan.json (optional)'] }; } catch (e) { r.plan = { errors: [e.message], warnings: [] }; }
  r.handoffs = { errors: readHandoffs(c).filter((h) => h.invalid).map((h) => `handoffs.jsonl line ${h.invalid} is not valid JSON`), warnings: [] };
  return r;
}
