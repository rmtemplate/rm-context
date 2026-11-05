// Documentation engine: catalog-driven templates, registry metadata, lifecycle, validation, export.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, writeJson, writeFile, now, fail, slug, PLUGIN_ROOT, esc } from './util.mjs';
import { findSecrets } from './ignore.mjs';
import * as G from './graph.mjs';
import { AGENTS, rtmMarkdown } from './project.mjs';

const META_START = '<!-- rmc:meta:start -->', META_END = '<!-- rmc:meta:end -->';
const GEN_START = '<!-- rmc:generated:start -->', GEN_END = '<!-- rmc:generated:end -->';
const BASIS = ['confirmed', 'assumption', 'open question', 'recommendation'];
const PLACEHOLDERS = [/\{\{[^}]*\}\}/, /lorem ipsum/i, /\bTODO:\s*fill\b/i, /\[insert [^\]]*\]/i, /<placeholder>/i];

export function catalog(c) {
  const base = readJson(path.join(PLUGIN_ROOT, 'templates', 'catalog.json'));
  const local = c && fs.existsSync(c.p('templates', 'catalog.json')) ? readJson(c.p('templates', 'catalog.json')) : null;
  if (local?.types) Object.assign(base.types, local.types);
  return base;
}
const loadRegistry = (c) => readJson(c.registry, { schemaVersion: 2, documents: [] });
const saveRegistry = (c, r) => writeJson(c.registry, r);

function findDoc(c, ref) {
  const reg = loadRegistry(c);
  const norm = String(ref).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\.rmcontext\//, '');
  const d = reg.documents.find((x) => x.id === ref || x.path === norm || path.resolve(c.base, x.path) === path.resolve(c.root, ref));
  if (!d) fail(`No registered document "${ref}". List with: rmc doc list`);
  return { reg, d };
}

function metaBlock(d, type) {
  return [META_START, `| Field | Value |`, `|---|---|`, `| Document | ${d.id} — ${d.title} |`, `| Type | ${type.title} |`, `| Status | ${d.status} |`,
    `| Version | ${d.version} |`, `| Author | ${d.author} |`, `| Created | ${d.createdAt} |`, `| Updated | ${d.updatedAt} |`,
    ...(d.approvedBy ? [`| Approved | ${d.approvedBy} at ${d.approvedAt} |`] : []),
    ...(d.sources?.length ? [`| Sources | ${d.sources.map((s) => '`' + s + '`').join(', ')} |`] : []),
    ...(d.nodes?.length ? [`| Graph nodes | ${d.nodes.map((s) => '`' + s + '`').join(', ')} |`] : []), META_END].join('\n');
}
function writeMeta(c, d) {
  const file = c.p(d.path);
  const type = catalog(c).types[d.type];
  const cur = fs.readFileSync(file, 'utf8');
  const a = cur.indexOf(META_START), b = cur.indexOf(META_END);
  const next = a >= 0 && b > a ? cur.slice(0, a) + metaBlock(d, type) + cur.slice(b + META_END.length) : cur.replace(/^(# .*\n)/, `$1\n${metaBlock(d, type)}\n`);
  writeFile(file, next);
}

// ---------- graph-backed generated content ----------
function evRef(n) { const e = (n.evidence || []).find((x) => x.file); return e ? `\`${e.file}${e.lines ? ':' + e.lines[0] : ''}\`` : '—'; }
async function generated(c, kind) {
  const g = G.loadGraph(c);
  const ix = G.index(g);
  const of = (t) => g.nodes.filter((n) => n.type === t).sort((a, b) => a.id.localeCompare(b.id));
  const pm = await import('./pm.mjs');
  switch (kind) {
    case 'erd': {
      const tables = of('table');
      if (!tables.length) return '_No tables found in schema or migration files. Model planned entities here and mark them as planned._';
      const id = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
      const lines = ['```mermaid', 'erDiagram'];
      for (const t of tables) {
        const cols = t.attrs?.columns || [];
        lines.push(`  ${id(t.name)} {`, ...cols.slice(0, 40).map((col) => `    ${String(col.type).split('(')[0].replace(/[^A-Za-z0-9_]/g, '_') || 'field'} ${id(col.name)}`), '  }');
      }
      for (const e of g.edges.filter((e) => e.type === 'depends_on' && ix.byId.get(e.source)?.type === 'table' && ix.byId.get(e.target)?.type === 'table'))
        lines.push(`  ${id(ix.byId.get(e.target).name)} ||--o{ ${id(ix.byId.get(e.source).name)} : "${e.confidence === 'verified' ? 'FK' : 'FK (inferred)'}"`);
      lines.push('```', '', '| Table | Columns | Source |', '|---|---|---|', ...tables.map((t) => `| ${t.name} | ${(t.attrs?.columns || []).length} | ${evRef(t)} |`));
      return lines.join('\n');
    }
    case 'api': {
      const apis = of('api');
      if (!apis.length) return '_No routes detected by the scanner. Document planned endpoints below and mark them as planned._';
      return ['| Method | Path | Implemented in | Handler | Confidence |', '|---|---|---|---|---|', ...apis.map((a) => {
        const impl = ix.inc(a.id).filter((e) => e.type === 'implements').map((e) => `\`${ix.byId.get(e.source).name}\``).join(', ') || '—';
        const handler = ix.out(a.id).filter((e) => e.type === 'calls').map((e) => `\`${e.target.split('#').pop()}\``).join(', ') || '—';
        return `| ${a.attrs?.method || ''} | \`${a.attrs?.path || a.name}\` | ${impl} (${evRef(a)}) | ${handler} | ${a.confidence} |`;
      }), '', '_Route prefixes from router mounting or route groups are not resolved by the scanner; confirm full paths in source._'].join('\n');
    }
    case 'dictionary': {
      const tables = of('table');
      if (!tables.length) return '_No tables detected._';
      return tables.map((t) => [`### ${t.name}`, `Source: ${evRef(t)}`, '', '| Column | Type | Meaning | Classification |', '|---|---|---|---|',
        ...(t.attrs?.columns || []).map((col) => `| ${col.name} | ${col.type} | Open Question | Open Question |`)].join('\n')).join('\n\n');
    }
    case 'rtm': return rtmMarkdown(c).replace(/^# .*\n+/, '');
    case 'infra': {
      const items = g.nodes.filter((n) => G.layerOf(n.type) === 'infrastructure').sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
      if (!items.length) return '_No infrastructure files (Dockerfile, compose, CI, Kubernetes, Terraform, nginx) were found._';
      const deps = g.edges.filter((e) => G.layerOf(ix.byId.get(e.source)?.type) === 'infrastructure' && G.layerOf(ix.byId.get(e.target)?.type) === 'infrastructure');
      const mid = (s) => 'n' + s.replace(/[^A-Za-z0-9]/g, '_');
      return ['```mermaid', 'flowchart LR', ...items.map((n) => `  ${mid(n.id)}["${n.type}: ${n.name.replace(/"/g, "'")}"]`),
        ...deps.map((e) => `  ${mid(e.source)} -->|${e.type}| ${mid(e.target)}`), '```', '',
        '| Type | Name | Details | Source |', '|---|---|---|---|',
        ...items.map((n) => `| ${n.type} | ${n.name} | ${Object.entries(n.attrs || {}).filter(([k]) => k !== 'variables').map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ') || '—'} | ${evRef(n)} |`)].join('\n');
    }
    case 'cicd': {
      const ps = of('pipeline');
      if (!ps.length) return '_No CI configuration found._';
      return ['| Pipeline | Triggers | Jobs | Source |', '|---|---|---|---|', ...ps.map((p) => `| ${p.name} | ${p.attrs?.triggers || '—'} | ${(p.attrs?.jobs || []).join(', ') || '—'} | ${evRef(p)} |`)].join('\n');
    }
    case 'env': {
      const envs = of('environment').filter((e) => e.attrs?.variables);
      if (!envs.length) return '_No env template (.env.example etc.) found. Variable names must be collected from deployment configuration._';
      const vars = [...new Set(envs.flatMap((e) => e.attrs.variables))].sort();
      return ['Variable names only — values are never read or recorded.', '', `| Variable | Declared in | local | staging | production |`, '|---|---|---|---|---|',
        ...vars.map((v) => `| \`${v}\` | ${envs.filter((e) => e.attrs.variables.includes(v)).map(evRef).join(', ')} | ? | ? | ? |`)].join('\n');
    }
    case 'raid': {
      const table = (type, head, row) => { const xs = of(type); return xs.length ? [head, head.replace(/[^|]+/g, '---'), ...xs.map(row)].join('\n') : `_No ${type} nodes recorded._`; };
      const a = (n, k) => n.attrs?.[k] || '?';
      return ['From the project graph (agents record these with `rmc graph upsert`).', '',
        '**Risks**', table('risk', '| ID | Risk | Likelihood | Impact | Owner | Status |', (n) => `| ${n.id} | ${n.name} | ${a(n, 'likelihood')} | ${a(n, 'impact')} | ${a(n, 'owner')} | ${a(n, 'status')} |`), '',
        '**Assumptions**', table('assumption', '| ID | Assumption | Raised by | Status |', (n) => `| ${n.id} | ${n.name} | ${a(n, 'raisedBy')} | ${a(n, 'status')} |`), '',
        '**Issues**', table('issue', '| ID | Issue | Severity | Owner | Status |', (n) => `| ${n.id} | ${n.name} | ${a(n, 'severity')} | ${a(n, 'owner')} | ${a(n, 'status')} |`), '',
        '**Open questions**', table('question', '| ID | Question | Ask | Status |', (n) => `| ${n.id} | ${n.name} | ${a(n, 'ask')} | ${a(n, 'status')} |`)].join('\n');
    }
    case 'wbs': return pm.wbsMarkdown(c);
    case 'gantt': return pm.mermaidGantt(c) + '\n\n' + pm.criticalPathMarkdown(c);
    case 'roadmap': return pm.roadmapMarkdown(c);
    default: return '';
  }
}

// ---------- commands ----------
export async function newDoc(c, typeKey, { title, author, nodes = [], sources = [] }) {
  const cat = catalog(c);
  const type = cat.types[typeKey] || fail(`Unknown document type "${typeKey}". See: rmc doc types`);
  if (!title) fail('--title is required');
  if (!author || (!AGENTS.includes(author) && author !== 'user')) fail(`--author must be one of: ${AGENTS.join(', ')}, user`);
  const reg = loadRegistry(c);
  const n = reg.documents.filter((d) => d.type === typeKey).length + 1;
  const id = `${type.prefix}-${String(n).padStart(3, '0')}`;
  const rel = `documents/${type.layer}/${id}-${slug(title)}.md`;
  if (fs.existsSync(c.p(rel))) fail(`${rel} already exists; refusing to overwrite`);
  const g = G.loadGraph(c);
  const known = new Set(g.nodes.map((x) => x.id));
  const missing = nodes.filter((x) => !known.has(x));
  if (missing.length) fail(`Unknown graph node(s): ${missing.join(', ')}`);
  const stamp = now();
  const d = { id, type: typeKey, title, path: rel, layer: type.layer, status: 'Draft', version: 1, author, createdAt: stamp, updatedAt: stamp,
    sources, nodes, history: [{ version: 1, at: stamp, author, status: 'Draft', note: 'Created from template' }] };
  const gen = type.generated ? await generated(c, type.generated) : null;
  const local = c.p('templates', `${typeKey}.md`);
  let body;
  if (fs.existsSync(local)) body = fs.readFileSync(local, 'utf8').replaceAll('{{title}}', title).replaceAll('{{id}}', id);
  else body = type.sections.map((s, i) => `## ${s.h}\n\n<!-- guide: ${s.g}${s.opt ? ' (optional section)' : ''} -->\n` +
    (i === 0 && gen ? `\n${GEN_START}\n${gen}\n${GEN_END}\n` : '')).join('\n');
  writeFile(c.p(rel), `# ${title}\n\n${metaBlock(d, type)}\n\n${body}`);
  reg.documents.push(d);
  saveRegistry(c, reg);
  return `Created ${id} at .rmcontext/${rel} (Draft). Fill every section, then: rmc doc validate ${id}`;
}

function sectionsOf(text) {
  const out = new Map();
  const parts = text.split(/^## +/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const h = (nl < 0 ? p : p.slice(0, nl)).trim().toLowerCase();
    const body = nl < 0 ? '' : p.slice(nl + 1);
    out.set(h, body.replace(/<!--[\s\S]*?-->/g, '').trim());
  }
  return out;
}

export function validateDoc(c, d, { graph } = {}) {
  const errors = [], warnings = [];
  const cat = catalog(c);
  const type = cat.types[d.type];
  if (!type) return { errors: [`${d.id}: unknown type ${d.type}`], warnings };
  if (!cat.statuses.includes(d.status)) errors.push(`status "${d.status}" is not one of ${cat.statuses.join(', ')}`);
  if (!Number.isInteger(d.version) || d.version < 1) errors.push('version must be a positive integer');
  if (!AGENTS.includes(d.author) && d.author !== 'user') errors.push(`author "${d.author}" is not a known agent or "user"`);
  for (const k of ['createdAt', 'updatedAt']) if (Number.isNaN(Date.parse(d[k]))) errors.push(`${k} is not an ISO timestamp`);
  if (d.status === 'Approved' && !(d.approvedBy && d.approvedAt)) errors.push('Approved documents need approvedBy and approvedAt (set via rmc doc status … --approved-by)');
  const file = c.p(d.path);
  if (!fs.existsSync(file)) return { errors: [...errors, `file missing: .rmcontext/${d.path}`], warnings };
  const text = fs.readFileSync(file, 'utf8');
  const secs = sectionsOf(text);
  for (const s of type.sections) {
    const body = secs.get(s.h.toLowerCase());
    if (body === undefined) { if (!s.opt) errors.push(`missing section "## ${s.h}"`); }
    else if (!body && !s.opt) errors.push(`section "${s.h}" is empty`);
  }
  for (const re of PLACEHOLDERS) if (re.test(text)) errors.push(`placeholder text found (${re})`);
  for (const h of findSecrets(text)) errors.push(`line ${h.line}: secret-like content (${h.kind}) — remove it`);
  const content = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const rule of type.rules || []) {
    const [name, arg] = rule.split(':');
    if (name === 'basis') {
      const tables = [...content.matchAll(/^\|(.+)\|\s*\n\|[-:| ]+\|\s*\n((?:\|.*\|\s*\n?)*)/gm)];
      const withBasis = tables.filter((t) => t[1].split('|').map((x) => x.trim().toLowerCase()).includes('basis'));
      if (!withBasis.length) errors.push('rule basis: no table with a "Basis" column (Confirmed / Assumption / Open Question / Recommendation)');
      for (const t of withBasis) {
        const cols = t[1].split('|').map((x) => x.trim().toLowerCase());
        const idx = cols.indexOf('basis');
        for (const row of t[2].split('\n').filter((r) => r.trim().startsWith('|'))) {
          const cell = (row.trim().replace(/^\||\|$/g, '').split('|')[idx] || '').trim().toLowerCase().replace(/\*/g, '');
          if (!BASIS.includes(cell)) errors.push(`rule basis: row "${row.trim().slice(0, 60)}" has Basis "${cell}"`);
        }
      }
    }
    if (name === 'evidence' && !(d.sources?.length) && !/`?[\w./-]+\.[a-z]{1,6}:\d+/i.test(content)) errors.push('rule evidence: cite at least one source location (path/file.ext:line) or add --sources');
    if (name === 'mermaid') {
      const blocks = [...content.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
      if (!blocks.length) errors.push('rule mermaid: no ```mermaid diagram');
      else if (arg && !blocks.some((b) => b.startsWith(arg))) errors.push(`rule mermaid: needs a ${arg} diagram`);
    }
    if (name === 'adr-status' && !/\b(Proposed|Accepted|Deprecated|Superseded)\b/.test(secs.get('status') || '')) errors.push('rule adr-status: Status must be Proposed, Accepted, Deprecated or Superseded');
    if (name === 'plan' && !fs.existsSync(c.plan)) errors.push('rule plan: project-management/plan.json does not exist (rmc pm init)');
  }
  const g = graph || G.loadGraph(c);
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const n of d.nodes || []) if (!ids.has(n)) warnings.push(`linked node ${n} no longer exists in the graph`);
  for (const s of d.sources || []) if (!fs.existsSync(path.join(c.root, s))) warnings.push(`source ${s} no longer exists`);
  if (d.needsReview) warnings.push('sources changed since the last revision — review and run rmc doc revise');
  return { errors, warnings };
}

export function validateAllDocs(c) {
  const reg = loadRegistry(c);
  const graph = G.loadGraph(c);
  const errors = [], warnings = [];
  const ids = new Set();
  for (const d of reg.documents) {
    if (ids.has(d.id)) errors.push(`${d.id}: duplicate id`);
    ids.add(d.id);
    const r = validateDoc(c, d, { graph });
    errors.push(...r.errors.map((e) => `${d.id}: ${e}`));
    warnings.push(...r.warnings.map((e) => `${d.id}: ${e}`));
  }
  return { errors, warnings };
}

function revise(c, ref, { note, author, snapshot = true }) {
  if (!note) fail('--note is required: describe what changed');
  const { reg, d } = findDoc(c, ref);
  const file = c.p(d.path);
  const hist = c.p('documents', '.history', d.id, `v${d.version}.md`);
  if (snapshot) writeFile(hist, fs.readFileSync(file, 'utf8'));
  const wasApproved = d.status === 'Approved';
  d.version += 1;
  d.updatedAt = now();
  if (wasApproved) { d.status = 'Under Review'; delete d.approvedBy; delete d.approvedAt; }
  delete d.needsReview;
  d.history.push({ version: d.version, at: d.updatedAt, author: author || d.author, status: d.status, note: note + (wasApproved ? ' (approval cleared by revision)' : '') });
  saveRegistry(c, reg);
  writeMeta(c, d);
  return `${d.id} is now v${d.version}${wasApproved ? '; it was Approved, so it is back to Under Review' : ''}. Previous version: .rmcontext/${path.relative(c.base, hist).replace(/\\/g, '/')}`;
}

async function regenerate(c, ref, { author }) {
  const { d } = findDoc(c, ref);
  const type = catalog(c).types[d.type];
  if (!type.generated) fail(`${d.type} documents have no generated content`);
  const file = c.p(d.path);
  const cur = fs.readFileSync(file, 'utf8');
  const a = cur.indexOf(GEN_START), b = cur.indexOf(GEN_END);
  if (a < 0 || b < a) fail(`${d.id} has no rmc:generated block to refresh`);
  const next = cur.slice(0, a + GEN_START.length) + '\n' + (await generated(c, type.generated)) + '\n' + cur.slice(b);
  if (next === cur) return `${d.id}: generated content already current`;
  writeFile(c.p('documents', '.history', d.id, `v${d.version}.md`), cur);
  writeFile(file, next);
  return revise(c, d.id, { note: 'Regenerated graph/plan-derived content', author, snapshot: false });
}

function setStatus(c, ref, status, { approvedBy, by }) {
  const cat = catalog(c);
  if (!cat.statuses.includes(status)) fail(`Status must be one of: ${cat.statuses.join(', ')}`);
  const { reg, d } = findDoc(c, ref);
  if (status === 'Approved') {
    if (!approvedBy) fail('Approval must name the approving person: --approved-by "<name or role>". Only record approval the user explicitly gave.');
    d.approvedBy = approvedBy; d.approvedAt = now();
  }
  if (status === 'Under Review' || status === 'Approved') {
    const { errors } = validateDoc(c, { ...d, status: 'Draft' });
    if (errors.length) fail(`${d.id} does not validate yet:\n  ${errors.join('\n  ')}`);
  }
  if (status === 'Superseded' && by) d.supersededBy = by;
  d.status = status;
  d.updatedAt = now();
  d.history.push({ version: d.version, at: d.updatedAt, author: approvedBy || 'user', status, note: `Status → ${status}` });
  saveRegistry(c, reg);
  writeMeta(c, d);
  return `${d.id} → ${status}`;
}

export function flagStaleDocuments(c, changedFiles) {
  if (!fs.existsSync(c.registry) || !changedFiles?.length) return [];
  const reg = loadRegistry(c);
  const set = new Set(changedFiles);
  const flagged = [];
  for (const d of reg.documents) if (!d.needsReview && (d.sources || []).some((s) => set.has(s))) { d.needsReview = true; flagged.push(d.id); }
  if (flagged.length) saveRegistry(c, reg);
  return flagged;
}

// ---------- export ----------
export function mdToHtml(md) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => /^(https?:|#|\.{0,2}\/|[\w-]+\.)/.test(u) ? `<a href="${u}">${t}</a>` : t).replace(/&lt;br&gt;/g, '<br>');
  const out = [];
  const lines = md.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const lang = l.slice(3).trim(); const buf = [];
      while (++i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i]);
      out.push(lang === 'mermaid' ? `<pre class="mermaid">${esc(buf.join('\n'))}</pre>` : `<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^#{1,6} /.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`); }
    else if (/^\|.*\|\s*$/.test(l) && /^\|[-:| ]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
      const head = cells(l); i++;
      const rows = [];
      while (i + 1 < lines.length && /^\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${inline(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^\s*([-*]|\d+\.) /.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.) /, ''));
      i--;
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x.replace(/^\[ \] /, '☐ ').replace(/^\[x\] /i, '☑ '))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (/^> /.test(l)) out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`);
    else if (l.trim() && !/^<!--/.test(l)) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('\n');
}

const DOC_CSS = `:root{--fg:#16161d;--muted:#5b5b66;--line:#e4e4ea;--accent:#5b4cf0;--bg:#fff;--code:#f5f5f8}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8ee;--muted:#a0a0ad;--line:#2c2c36;--accent:#9d93ff;--bg:#121217;--code:#1c1c24}}
body{font:15px/1.6 Inter,"Segoe UI",system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:960px;margin:40px auto;padding:0 16px}
h1{font-size:26px;margin:0 0 16px}h2{font-size:19px;margin:32px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}h3{font-size:16px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--code)}code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:13px}pre{background:var(--code);padding:12px;overflow:auto;border-radius:6px}
a{color:var(--accent)}blockquote{border-left:3px solid var(--accent);margin:8px 0;padding:2px 12px;color:var(--muted)}
.mermaid{background:transparent}@media print{body{margin:0;max-width:none}table{display:table}}`;

export function findChrome() {
  const env = process.env.RMC_CHROME;
  const cands = [env, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
  for (const b of cands) {
    if (b.includes('/') || b.includes('\\')) { if (fs.existsSync(b)) return b; continue; }
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [b], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.split('\n')[0].trim();
  }
  return null;
}
// Windows browsers launched from WSL need Windows paths.
export const hostPath = (bin, p) => (bin.startsWith('/mnt/') ? spawnSync('wslpath', ['-w', p], { encoding: 'utf8' }).stdout.trim() : p);

function exportDoc(c, ref, format) {
  const { d } = findDoc(c, ref);
  const src = c.p(d.path);
  const outDir = c.p('documents', 'exports');
  const base = path.join(outDir, `${d.id}-v${d.version}`);
  const md = fs.readFileSync(src, 'utf8');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.id)} ${esc(d.title)}</title><style>${DOC_CSS}</style></head><body>
${mdToHtml(md)}
<script type="module">
// Mermaid renders when online; offline, diagrams stay readable as source.
try { const m = await import('https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs'); m.default.initialize({ startOnLoad: false, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral' }); await m.default.run(); window.__rmcMermaidDone = true; } catch (e) { window.__rmcMermaidDone = true; }
</script></body></html>`;
  if (format === 'html') { writeFile(base + '.html', html); return `Exported .rmcontext/${path.relative(c.base, base + '.html').replace(/\\/g, '/')}`; }
  if (format === 'pdf') {
    const chrome = findChrome();
    if (!chrome) fail('PDF export needs Chrome, Chromium or Edge. Install one or set RMC_CHROME to its path. HTML export works without it.');
    writeFile(base + '.html', html);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=8000', `--print-to-pdf=${hostPath(chrome, base + '.pdf')}`, hostPath(chrome, base + '.html')], { encoding: 'utf8', timeout: 90000 });
    if (!fs.existsSync(base + '.pdf')) fail(`PDF export failed (${chrome}): ${(r.stderr || r.error?.message || '').slice(0, 300)}`);
    return `Exported .rmcontext/${path.relative(c.base, base + '.pdf').replace(/\\/g, '/')}`;
  }
  if (format === 'docx') {
    const p = spawnSync('pandoc', ['--version']);
    if (p.status !== 0) fail('DOCX export needs pandoc (https://pandoc.org). Not installed — use html or pdf instead.');
    fs.mkdirSync(outDir, { recursive: true });
    const clean = md.replace(/<!--[\s\S]*?-->/g, '');
    const tmp = base + '.tmp.md';
    fs.writeFileSync(tmp, clean);
    const r = spawnSync('pandoc', [tmp, '-f', 'gfm', '-o', base + '.docx'], { encoding: 'utf8' });
    fs.rmSync(tmp, { force: true });
    if (r.status !== 0) fail(`pandoc failed: ${r.stderr}`);
    return `Exported .rmcontext/${path.relative(c.base, base + '.docx').replace(/\\/g, '/')} (Mermaid diagrams appear as code blocks in DOCX)`;
  }
  fail('--format must be html, pdf or docx');
}

export async function cli(c, sub, rest, args) {
  const list = (v) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
  switch (sub) {
    case 'types': {
      const cat = catalog(c);
      if (args.json) return JSON.stringify(Object.fromEntries(Object.entries(cat.types).map(([k, t]) => [k, { title: t.title, layer: t.layer, owner: t.owner, generated: !!t.generated, rules: t.rules }])), null, 2);
      const by = {};
      for (const [k, t] of Object.entries(cat.types)) (by[t.layer] ||= []).push(`  ${k.padEnd(24)} ${t.title} — ${t.owner}${t.generated ? ' (prefilled from graph/plan)' : ''}${t.rules?.length ? ` [${t.rules.join(', ')}]` : ''}`);
      return Object.entries(by).map(([l, xs]) => `${l}\n${xs.join('\n')}`).join('\n\n');
    }
    case 'new': return newDoc(c, rest[0], { title: args.title, author: args.author, nodes: list(args.nodes), sources: list(args.sources) });
    case 'validate': {
      const r = rest[0] ? (() => { const { d } = findDoc(c, rest[0]); return validateDoc(c, d); })() : validateAllDocs(c);
      if (r.errors.length) process.exitCode = 1;
      return [r.errors.length ? `✘ ${r.errors.length} error(s)` : '✔ valid', ...r.errors.map((e) => `  error: ${e}`), ...r.warnings.map((w) => `  warn:  ${w}`)].join('\n');
    }
    case 'revise': return revise(c, rest[0] || fail('Usage: rmc doc revise <id|path> --note "…"'), { note: args.note, author: args.author });
    case 'regenerate': return regenerate(c, rest[0] || fail('Usage: rmc doc regenerate <id>'), { author: args.author });
    case 'status': return setStatus(c, rest[0] || fail('Usage: rmc doc status <id> <status>'), rest.slice(1).join(' '), { approvedBy: args['approved-by'], by: args.by });
    case 'export': return exportDoc(c, rest[0] || fail('Usage: rmc doc export <id> --format html|pdf|docx'), args.format || 'html');
    case 'list': case undefined: {
      const reg = loadRegistry(c);
      return reg.documents.length ? reg.documents.map((d) => `${d.id.padEnd(12)} ${d.status.padEnd(12)} v${d.version}  ${d.title}  (.rmcontext/${d.path})${d.needsReview ? '  NEEDS REVIEW' : ''}`).join('\n') : 'No documents yet. Create one: rmc doc new <type> --title "…" --author <agent>';
    }
    default: fail(`Unknown doc subcommand: ${sub}`);
  }
}
