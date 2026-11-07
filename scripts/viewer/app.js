// RM Context viewer application. Runs inside the single-file viewer after DATA, renderGanttSvg and graph-core are defined.
(function () {
'use strict';
const T0 = performance.now();
const BENCH = location.hash === '#bench' || window.__RMC_BENCH === true;
const D = DATA;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const store = { get(k, d) { try { const v = localStorage.getItem('rmc-viewer:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('rmc-viewer:' + k, JSON.stringify(v)); return true; } catch { return false; } }, del(k) { try { localStorage.removeItem('rmc-viewer:' + k); } catch { /* ignore */ } } };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- icons (Lucide-compatible 24×24 strokes, inline so the viewer stays offline) ----------
const ICON = {
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  tree: '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  graph: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  gantt: '<path d="M10 6h8"/><path d="M12 16h6"/><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M8 11h7"/>',
  handoff: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  settings: '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  menu: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  zoomIn: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M8 11h6"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  focus: '<circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  theme: '<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/>',
  eyeOff: '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  expand: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  flask: '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
};
const icon = (n, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;

// ---------- data model ----------
const LAYERS = D.layers, LAYER_OF = {};
for (const [l, ts] of Object.entries(LAYERS)) for (const t of ts) LAYER_OF[t] = l;
const NODES = D.graph.nodes;
const IDX = new Map(NODES.map((n, i) => [n.id, i]));
const EDGES = D.graph.edges.filter((e) => IDX.has(e.source) && IDX.has(e.target));
const SRC = Int32Array.from(EDGES, (e) => IDX.get(e.source)), DST = Int32Array.from(EDGES, (e) => IDX.get(e.target));
const ETYPE = EDGES.map((e) => e.type);
const IX = buildIndex(NODES.length, SRC, DST);
const layerOf = (n) => LAYER_OF[n.type] || 'unknown';
const shortName = (n) => (n.type === 'file' || n.type === 'test' ? n.name.split('/').pop() : n.name);
const loc = (n) => { const e = (n.evidence || []).find((x) => x.file); return e ? e.file + (e.lines ? ':' + e.lines[0] : '') : ''; };
// Provenance: what the scanner extracted from source vs. what is inferred or added by agents/users.
const prov = (x) => (x.stale ? 'stale' : x.confidence === 'inferred' ? 'inferred' : x.confidence === 'manual' || x.origin === 'manual' ? 'manual' : x.origin === 'agent' ? 'agent' : 'extracted');
const PROV_LABEL = { extracted: 'Extracted', inferred: 'Inferred', manual: 'Manual', agent: 'Agent-verified', stale: 'Stale' };
const provBadge = (x) => { const p = prov(x); return `<span class="badge b-${p === 'agent' ? 'manual' : p}" title="${p === 'extracted' ? 'Extracted from source by the scanner' : p === 'inferred' ? 'Heuristic link — verify against source' : p === 'stale' ? 'Evidence changed since this was recorded' : 'Recorded by an agent or user'}">${PROV_LABEL[p]}</span>`; };
const layerDot = (t) => `<span class="dot" style="background:rgb(var(--l-${LAYER_OF[t] || 'system'}))"></span>`;
function edgesOf(i, filter) { const out = []; for (let k = IX.start[i]; k < IX.start[i + 1]; k++) { const e = IX.adjEdge[k]; if (!filter || filter(e, SRC[e] === i)) out.push(e); } return out; }
const countEdges = (i, type, outgoing) => { let c = 0; for (let k = IX.start[i]; k < IX.start[i + 1]; k++) { const e = IX.adjEdge[k]; if (ETYPE[e] === type && (SRC[e] === i) === outgoing && SRC[e] !== DST[e]) c++; } return c; };

// Group (module) of every node: follow belongs_to up to three hops; otherwise its layer.
const GROUP = new Array(NODES.length);
{
  const up = new Map();
  EDGES.forEach((e, k) => { if (e.type === 'belongs_to') (up.get(SRC[k]) || up.set(SRC[k], []).get(SRC[k])).push(DST[k]); });
  for (let i = 0; i < NODES.length; i++) {
    let g = NODES[i].type === 'module' ? NODES[i].id : null, frontier = [i];
    for (let d = 0; d < 3 && !g && frontier.length; d++) {
      const next = [];
      for (const v of frontier) for (const w of up.get(v) || []) { if (NODES[w].type === 'module') { g = NODES[w].id; break; } next.push(w); }
      frontier = next;
    }
    GROUP[i] = g || 'layer:' + layerOf(NODES[i]);
  }
}
const groupLabel = (g) => (g.startsWith('layer:') ? g.slice(6) + ' (no module)' : NODES[IDX.get(g)]?.name || g);
const MEMBERS = new Map(); GROUP.forEach((g, i) => (MEMBERS.get(g) || MEMBERS.set(g, []).get(g)).push(i));

const FILES = (D.files || []).slice().sort((a, b) => (a.p < b.p ? -1 : 1));
const FILE_BY = new Map(FILES.map((f) => [f.p, f]));
for (const n of NODES) if ((n.type === 'file' || n.type === 'test') && !FILE_BY.has(n.name)) { const f = { p: n.name, lang: n.attrs?.lang, loc: n.attrs?.loc, test: n.type === 'test' }; FILES.push(f); FILE_BY.set(f.p, f); }
FILES.sort((a, b) => (a.p < b.p ? -1 : 1));
const fileNode = (p) => IDX.get('file:' + p) ?? IDX.get('test:' + p);
const DOCS = D.documents || [];
const RTM = new Map((D.rtm || []).map((r) => [r.id, r.status]));
const typeCount = (types) => { const s = new Set(types); let c = 0; for (const n of NODES) if (s.has(n.type)) c++; return c; };

// Global search index: graph nodes, files and documents.
const SEARCH_ITEMS = [
  ...NODES.map((n, i) => ({ kind: 'node', i, name: shortName(n), text: `${n.name} ${n.id} ${n.type}`, weight: IX.deg[i] })),
  ...FILES.filter((f) => fileNode(f.p) == null).map((f) => ({ kind: 'file', p: f.p, name: f.p.split('/').pop(), text: f.p })),
  ...DOCS.map((d) => ({ kind: 'doc', d, name: d.title, text: `${d.id} ${d.title} ${d.type}`, weight: 5 })),
];
const SX = buildSearch(SEARCH_ITEMS);

// ---------- router ----------
function parseRoute() {
  let h = location.hash.replace(/^#\/?/, '');
  const legacy = { graph: 'graph/all', business: 'graph/trace', system: 'graph/project', code: 'graph/files', infra: 'graph/infra', overview: 'overview', project: 'project', documents: 'documents' };
  if (legacy[h]) h = legacy[h];
  const [path, qs] = h.split('?');
  const parts = (path || 'overview').split('/').map(decodeURIComponent);
  return { page: parts[0] || 'overview', sub: parts[1] || '', params: new URLSearchParams(qs || '') };
}
function go(page, sub, params) {
  const q = params && Object.entries(params).filter(([, v]) => v != null && v !== '');
  const h = '#/' + page + (sub ? '/' + encodeURIComponent(sub) : '') + (q && q.length ? '?' + new URLSearchParams(q).toString() : '');
  if (location.hash === h) render(); else location.hash = h;
}
const href = (page, sub, params) => { const q = params && Object.entries(params).filter(([, v]) => v != null && v !== ''); return '#/' + page + (sub ? '/' + encodeURIComponent(sub) : '') + (q && q.length ? '?' + new URLSearchParams(q) : ''); };

// ---------- navigation ----------
const INFRA = LAYERS.infrastructure;
const REQ_TYPES = [...LAYERS.business, 'requirement', 'feature'];
const LISTS = {
  modules: { title: 'Modules', icon: 'layers', types: ['module'], desc: 'Modules inferred from directory structure, with their members.',
    cols: [['Module', (n) => nameCell(n), '2fr'], ['Members', (n, i) => fmt((MEMBERS.get(n.id) || []).length - 1), '90px'], ['Links', (n, i) => fmt(IX.deg[i]), '70px'], ['Provenance', (n) => provBadge(n), '110px']] },
  code: { title: 'Functions & Classes', icon: 'braces', types: ['function', 'class', 'component'], desc: 'Declarations extracted from source. Callers and callees come from import-resolved call sites.',
    cols: [['Name', (n) => nameCell(n), '2fr'], ['Location', (n) => `<span class="font-mono text-2xs text-muted truncate">${esc(loc(n))}</span>`, '2fr'], ['Callers', (n, i) => fmt(countEdges(i, 'calls', false)), '70px'], ['Callees', (n, i) => fmt(countEdges(i, 'calls', true)), '70px'], ['Provenance', (n) => provBadge(n), '110px']] },
  dependencies: { title: 'Dependencies', icon: 'package', types: ['dependency'], desc: 'Declared packages from manifests.',
    cols: [['Package', (n) => nameCell(n), '2fr'], ['Version', (n) => esc(n.attrs?.version || '—'), '1fr'], ['Ecosystem', (n) => esc(n.attrs?.ecosystem || '—'), '100px'], ['Scope', (n) => (n.attrs?.dev ? '<span class="badge">dev</span>' : '<span class="badge">runtime</span>'), '80px'], ['Used by', (n, i) => fmt(countEdges(i, 'depends_on', false)), '70px']] },
  apis: { title: 'API Explorer', icon: 'globe', types: ['api'], desc: 'Routes declared in source, with their handlers and data access.',
    cols: [['Method', (n) => `<span class="badge font-mono">${esc(n.attrs?.method || '—')}</span>`, '80px'], ['Path', (n) => `<span class="font-mono truncate">${esc(n.attrs?.path || n.name)}</span>`, '2fr'], ['Location', (n) => `<span class="font-mono text-2xs text-muted truncate">${esc(loc(n))}</span>`, '2fr'], ['Links', (n, i) => fmt(IX.deg[i]), '60px'], ['Provenance', (n) => provBadge(n), '110px']] },
  data: { title: 'Database Explorer', icon: 'database', types: ['database', 'table', 'entity'], desc: 'Schemas and tables, with the code that reads and writes them.',
    cols: [['Name', (n) => nameCell(n), '2fr'], ['Columns', (n) => fmt(Array.isArray(n.attrs?.columns) ? n.attrs.columns.length : null), '80px'], ['Readers', (n, i) => fmt(countEdges(i, 'reads_from', false)), '80px'], ['Writers', (n, i) => fmt(countEdges(i, 'writes_to', false)), '80px'], ['Provenance', (n) => provBadge(n), '110px']] },
  infra: { title: 'Infrastructure', icon: 'server', types: INFRA, desc: 'Containers, services, pipelines and environments found in configuration. Environment values are never read.',
    cols: [['Name', (n) => nameCell(n), '2fr'], ['Location', (n) => `<span class="font-mono text-2xs text-muted truncate">${esc(loc(n))}</span>`, '2fr'], ['Details', (n) => `<span class="text-muted truncate">${esc(attrSummary(n))}</span>`, '2fr'], ['Provenance', (n) => provBadge(n), '110px']] },
  integrations: { title: 'Integrations', icon: 'plug', types: ['integration'], desc: 'External services the code calls.',
    cols: [['Service', (n) => nameCell(n), '2fr'], ['Kind', (n) => esc(n.attrs?.kind || '—'), '90px'], ['Location', (n) => `<span class="font-mono text-2xs text-muted truncate">${esc(loc(n))}</span>`, '2fr'], ['Used by', (n, i) => fmt(IX.deg[i]), '70px'], ['Provenance', (n) => provBadge(n), '110px']] },
  requirements: { title: 'Business Requirements', icon: 'clipboard', types: REQ_TYPES, desc: 'Requirements, rules, processes and stories, with their traceability status.',
    cols: [['Item', (n) => nameCell(n), '3fr'], ['Type', (n) => esc(n.type.replace(/_/g, ' ')), '1fr'], ['Trace', (n) => (RTM.has(n.id) ? `<span class="badge">${esc(RTM.get(n.id))}</span>` : '—'), '1fr'], ['Provenance', (n) => provBadge(n), '110px']] },
};
function attrSummary(n) { const a = n.attrs || {}; return Object.entries(a).filter(([k, v]) => v !== '' && v != null && k !== 'note').slice(0, 3).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.name : x)).join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '); }
const nameCell = (n) => `<span class="flex items-center gap-2 min-w-0">${layerDot(n.type)}<span class="truncate">${esc(shortName(n))}</span>${n.stale ? '<span class="badge b-stale">stale</span>' : ''}</span>`;

const NAV = [
  ['Workspace', [['overview', 'Overview', 'dashboard', () => ''], ['explorer', 'File Explorer', 'tree', () => FILES.length], ['search', 'Search', 'search', () => '']]],
  ['Code Intelligence', [['list/modules', 'Modules', 'layers'], ['list/code', 'Functions & Classes', 'braces'], ['list/dependencies', 'Dependencies', 'package'], ['list/apis', 'API Explorer', 'globe'], ['list/data', 'Database Explorer', 'database'], ['dbintel', 'Database Intelligence', 'database', () => (D.dbIntel?.targets || []).reduce((a, t) => a + t.objects.filter((o) => o.status !== 'removed').length, 0) || ''], ['mobile', 'Mobile', 'layers', () => (D.dbIntel?.mobile ? D.dbIntel.mobile.manifest.platforms.length : '')]]],
  ['Architecture', [['graph', 'Graph', 'graph', () => NODES.length], ['list/infra', 'Infrastructure', 'server'], ['list/integrations', 'Integrations', 'plug']]],
  ['Project Knowledge', [['list/requirements', 'Business Requirements', 'clipboard'], ['documents', 'Technical Documents', 'doc', () => DOCS.length], ['project', 'Project Management', 'gantt', () => D.plan?.tasks?.length || 0], ['handoffs', 'Agent Handoffs', 'handoff', () => (D.handoffs || []).length], ['notes', 'Notes', 'note', () => (D.notes || []).length]]],
  ['Utilities', [['context', 'Context Status', 'activity', () => ''], ['settings', 'Settings', 'settings', () => '']]],
];
for (const [, items] of NAV) for (const it of items) if (!it[3]) { const L = LISTS[it[0].split('/')[1]]; it[3] = () => typeCount(L.types); }
function drawNav(route) {
  const cur = route.page === 'list' ? 'list/' + route.sub : route.page;
  let html = '';
  for (const [group, items] of NAV) {
    const shown = items.filter((it) => it[3]() !== 0);
    if (!shown.length) continue;
    html += `<div class="h-sec px-3 pt-4 pb-1 md:hidden lg:block">${group}</div><div class="hidden md:block lg:hidden h-px bg-line mx-2 my-2"></div>`;
    for (const [id, label, ic, count] of shown) {
      const n = count();
      html += `<a href="#/${id}" data-nav="${id}" title="${label}" class="flex items-center gap-2.5 mx-2 px-2.5 h-8 rounded-md text-fg no-underline hover:no-underline hover:bg-hover md:justify-center lg:justify-start ${cur === id ? 'bg-accent-soft text-accent font-semibold' : ''}" ${cur === id ? 'aria-current="page"' : ''}>${icon(ic)}<span class="flex-1 truncate md:hidden lg:inline">${label}</span>${n !== '' ? `<span class="text-2xs tabular-nums text-faint md:hidden lg:inline">${fmt(n)}</span>` : ''}</a>`;
    }
  }
  $('#nav-items').innerHTML = html;
}
const navOpen = (on) => { $('#nav').classList.toggle('-translate-x-full', !on); $('#scrim').classList.toggle('hidden', !on); if (on) $('#nav a')?.focus(); };

// ---------- virtual list ----------
function vlist(el, count, rowH, renderRow) {
  el.innerHTML = `<div style="height:${count * rowH}px;position:relative" role="presentation"></div>`;
  const inner = el.firstChild;
  let last = '';
  const paint = (force) => {
    const top = el.scrollTop, h = el.clientHeight || 800;
    const a = Math.max(0, Math.floor(top / rowH) - 10), b = Math.min(count, Math.ceil((top + h) / rowH) + 10);
    if (!force && a + ':' + b === last) return;
    last = a + ':' + b;
    let html = '';
    for (let i = a; i < b; i++) html += `<div style="position:absolute;left:0;right:0;top:${i * rowH}px;height:${rowH}px" data-row="${i}">${renderRow(i)}</div>`;
    inner.innerHTML = html;
  };
  let raf = 0;
  el.onscroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };
  paint(true);
  return { refresh: () => paint(true), reveal(i) { const t = i * rowH; if (t < el.scrollTop || t + rowH > el.scrollTop + el.clientHeight) el.scrollTop = t - el.clientHeight / 2; paint(true); } };
}
// Arrow-key movement between focusable rows inside a virtual list.
function rowKeys(el, sel) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = $$(sel, el), at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    const n = rows[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (n) { n.focus(); n.scrollIntoView({ block: 'nearest' }); }
  });
}

// ---------- page shell ----------
const page = () => $('#page');
function showPage(html) { $('#graph').classList.add('hidden'); const p = page(); p.classList.remove('hidden'); p.innerHTML = html; p.scrollTop = 0; return p; }
const header = (title, sub, extra = '') => `<div class="flex flex-wrap items-end justify-between gap-3 mb-5"><div class="min-w-0"><h1 class="text-xl font-semibold tracking-tight">${title}</h1>${sub ? `<p class="text-muted mt-0.5">${sub}</p>` : ''}</div>${extra}</div>`;
const empty = (msg) => `<div class="card p-8 text-center text-muted">${msg}</div>`;
const statCard = (label, value, hint, link) => `<${link ? `a href="${link}"` : 'div'} class="card p-3.5 block no-underline hover:no-underline ${link ? 'hover:border-accent/50' : ''}"><div class="text-2xs text-muted">${label}</div><div class="text-[22px] font-semibold tabular-nums text-fg mt-0.5">${value}</div>${hint ? `<div class="text-2xs text-faint mt-0.5 truncate">${hint}</div>` : ''}</${link ? 'a' : 'div'}>`;

// ---------- overview ----------
function drawOverview() {
  const m = D.manifest, st = m.stack || {}, s = D.stats;
  const codeN = typeCount(['function', 'class', 'component']);
  const locSum = FILES.reduce((a, f) => a + (f.loc || 0), 0);
  const ec = s.edgeConfidence || {}, edgeTotal = (ec.verified || 0) + (ec.inferred || 0) + (ec.manual || 0) || 1;
  const pct = (v) => Math.round((100 * v) / edgeTotal);
  const docStatus = DOCS.reduce((a, d) => ((a[d.status] = (a[d.status] || 0) + 1), a), {});
  const review = DOCS.filter((d) => d.needsReview).length;
  const rtm = (D.rtm || []).reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  const p = D.progress, lr = D.autoContext?.lastRefresh;
  const mods = [...MEMBERS.entries()].filter(([g]) => !g.startsWith('layer:')).map(([g, ms]) => [g, ms.length - 1]).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxMod = Math.max(1, ...mods.map((x) => x[1]));
  const list = (xs) => (xs && xs.length ? xs.map((x) => `<span class="badge">${esc(x)}</span>`).join(' ') : '<span class="text-faint">none detected</span>');
  showPage(`${header(esc(m.project.name), `Last scan ${esc((m.scan?.timestamp || '').replace('T', ' ').slice(0, 16))} UTC · ${esc(m.scan?.mode || '')}${m.scan?.commit ? ` · commit <code>${esc(m.scan.commit.slice(0, 10))}</code>` : ''} · viewer built ${esc(D.generatedAt.replace('T', ' ').slice(0, 16))} UTC`)}
  <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
    ${statCard('Files indexed', fmt(FILES.length), `${fmt(locSum)} lines`, '#/explorer')}
    ${statCard('Modules', fmt(typeCount(['module'])), '', '#/list/modules')}
    ${statCard('Functions & classes', fmt(codeN), '', '#/list/code')}
    ${statCard('APIs', fmt(typeCount(['api'])), '', '#/list/apis')}
    ${statCard('Tables', fmt(typeCount(['table', 'entity'])), '', '#/list/data')}
    ${statCard('Tests', fmt(typeCount(['test'])), '', '#/explorer')}
  </div>
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
    <section class="card p-4"><h2 class="h-sec mb-3">Knowledge graph</h2>
      <div class="flex items-baseline gap-2"><span class="text-2xl font-semibold tabular-nums">${fmt(s.nodes)}</span><span class="text-muted">nodes</span><span class="text-2xl font-semibold tabular-nums ml-3">${fmt(s.edges)}</span><span class="text-muted">relationships</span></div>
      <div class="flex h-2 rounded overflow-hidden mt-3 bg-raised" role="img" aria-label="Relationship provenance"><i class="bg-ok" style="width:${pct(ec.verified || 0)}%"></i><i class="bg-warn" style="width:${pct(ec.inferred || 0)}%"></i><i class="bg-accent" style="width:${pct(ec.manual || 0)}%"></i></div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-2xs text-muted"><span><span class="dot bg-ok"></span> extracted ${pct(ec.verified || 0)}%</span><span><span class="dot bg-warn"></span> inferred ${pct(ec.inferred || 0)}%</span><span><span class="dot bg-accent"></span> manual ${pct(ec.manual || 0)}%</span>${s.stale ? `<span class="text-danger">${fmt(s.stale)} stale</span>` : ''}</div>
      <div class="mt-4 space-y-1.5">${Object.entries(s.byLayer).map(([l, n]) => `<div class="flex items-center gap-2"><span class="dot" style="background:rgb(var(--l-${l}))"></span><span class="flex-1 capitalize">${l}</span><span class="tabular-nums text-muted">${fmt(n)}</span></div>`).join('')}</div>
      <a href="#/graph" class="btn mt-4">${icon('graph')}Open graph</a></section>
    <section class="card p-4"><h2 class="h-sec mb-3">Technology</h2>
      <dl class="space-y-2.5"><div><dt class="text-2xs text-muted mb-1">Languages</dt><dd>${list(Object.keys(st.languages || {}))}</dd></div><div><dt class="text-2xs text-muted mb-1">Frameworks</dt><dd>${list(st.frameworks)}</dd></div><div><dt class="text-2xs text-muted mb-1">Data stores</dt><dd>${list(st.datastores)}</dd></div><div><dt class="text-2xs text-muted mb-1">Infrastructure</dt><dd>${list(st.infrastructure)}</dd></div></dl>
      <div class="flex gap-4 mt-4 text-muted"><span>${fmt(typeCount(['dependency']))} dependencies</span><span>${fmt(typeCount(['integration']))} integrations</span></div></section>
    <section class="card p-4"><h2 class="h-sec mb-3">Knowledge & delivery</h2>
      <div class="space-y-1.5">
        <div class="flex justify-between"><span>Documents</span><b class="tabular-nums">${fmt(DOCS.length)}</b></div>
        ${Object.entries(docStatus).map(([k, n]) => `<div class="flex justify-between text-muted pl-3"><span>${esc(k)}</span><span class="tabular-nums">${n}</span></div>`).join('')}
        ${review ? `<div class="flex justify-between text-danger pl-3"><span>needs review</span><span class="tabular-nums">${review}</span></div>` : ''}
        <div class="flex justify-between pt-1"><span>Requirements traced</span><b class="tabular-nums">${fmt((D.rtm || []).length)}</b></div>
        ${Object.entries(rtm).map(([k, n]) => `<div class="flex justify-between text-muted pl-3"><span>${esc(k)}</span><span class="tabular-nums">${n}</span></div>`).join('')}
        ${p ? `<div class="flex justify-between pt-1"><span>Verified progress</span><b class="tabular-nums">${p.verifiedPercent}%</b></div><div class="h-1.5 rounded bg-raised overflow-hidden"><i class="block h-full bg-accent" style="width:${Math.max(0, Math.min(100, p.verifiedPercent))}%"></i></div><div class="text-2xs text-muted">reported ${p.reportedPercent}% · planned ${p.plannedPercent == null ? 'n/a' : p.plannedPercent + '%'}</div>` : '<div class="text-muted pt-1">No delivery plan yet.</div>'}
      </div></section>
  </div>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
    <section class="card p-4"><h2 class="h-sec mb-3">Largest modules</h2>${mods.length ? mods.map(([g, n]) => `<a href="${href('graph', 'module', { expand: g })}" class="flex items-center gap-3 py-1 no-underline hover:no-underline text-fg group"><span class="w-40 truncate group-hover:text-accent">${esc(groupLabel(g))}</span><span class="flex-1 h-1.5 bg-raised rounded overflow-hidden"><i class="block h-full bg-l-system/70" style="width:${(100 * n) / maxMod}%"></i></span><span class="w-10 text-right tabular-nums text-muted">${fmt(n)}</span></a>`).join('') : '<p class="text-muted">No modules detected.</p>'}</section>
    <section class="card p-4"><h2 class="h-sec mb-3">Freshness</h2>
      <div class="space-y-1.5"><div class="flex justify-between gap-3"><span>Last scan</span><span class="text-muted text-right">${esc((m.scan?.timestamp || '—').replace('T', ' ').slice(0, 19))}</span></div>
      <div class="flex justify-between gap-3"><span>Last automatic refresh</span><span class="text-muted text-right">${lr ? esc(lr.at.replace('T', ' ').slice(0, 19)) : 'none yet'}</span></div>
      ${lr && lr.changedFiles ? `<div class="text-2xs text-muted">${lr.changedFiles.length} file(s): ${lr.changedFiles.slice(0, 4).map(esc).join(', ')}${lr.changedFiles.length > 4 ? '…' : ''}</div>` : ''}
      <div class="flex justify-between gap-3"><span>Stale graph items</span><span class="${s.stale ? 'text-danger' : 'text-muted'}">${fmt(s.stale || 0)}</span></div>
      <div class="flex justify-between gap-3"><span>Documents needing review</span><span class="${review ? 'text-danger' : 'text-muted'}">${fmt(review)}</span></div></div>
      <a href="#/context" class="btn mt-4">${icon('activity')}Context status</a></section>
  </div>
  <p class="text-2xs text-faint mt-8">Generated by RM Context · by <a href="https://rmtemplate.com" target="_blank" rel="noopener">RM Template</a></p>`);
}

// ---------- file explorer ----------
const TREE = { name: '', path: '', dir: true, kids: new Map(), files: 0 };
for (const f of FILES) {
  let cur = TREE;
  const parts = f.p.split('/');
  parts.forEach((part, k) => {
    cur.files++;
    const leaf = k === parts.length - 1;
    if (!cur.kids.has(part)) cur.kids.set(part, leaf ? { name: part, path: f.p, dir: false, f } : { name: part, path: parts.slice(0, k + 1).join('/'), dir: true, kids: new Map(), files: 0 });
    cur = cur.kids.get(part);
  });
}
const sortedKids = (d) => [...d.kids.values()].sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
const expandedDirs = new Set(store.get('tree', null) || [...TREE.kids.values()].filter((k) => k.dir && TREE.kids.size < 12).map((k) => k.path));
function treeRows(filter) {
  const rows = [];
  const walk = (d, depth) => { for (const k of sortedKids(d)) { if (filter && !k.path.toLowerCase().includes(filter) && !(k.dir && [...FILES].some((f) => f.p.startsWith(k.path + '/') && f.p.toLowerCase().includes(filter)))) continue; rows.push([k, depth]); if (k.dir && (filter || expandedDirs.has(k.path))) walk(k, depth + 1); } };
  walk(TREE, 0);
  return rows;
}
function drawExplorer(route) {
  const sel = route.params.get('p') || '';
  showPage(`<div class="flex flex-col lg:flex-row gap-4 h-full min-h-0">
    <section class="card flex flex-col lg:w-80 xl:w-96 shrink-0 min-h-0 h-[45vh] lg:h-auto">
      <div class="p-3 border-b border-line"><div class="flex items-center justify-between mb-2"><h1 class="font-semibold">Files</h1><span class="text-2xs text-muted">${fmt(FILES.length)} indexed</span></div>
      <input id="tf" class="input" placeholder="Filter files…" aria-label="Filter files" autocomplete="off"></div>
      <div id="tree" class="flex-1 overflow-auto py-1" role="tree" aria-label="Project files"></div>
    </section>
    <section id="fileinfo" class="flex-1 min-w-0 lg:overflow-auto"></section></div>`);
  page().classList.add('lg:overflow-hidden');
  const treeEl = $('#tree');
  let rows = treeRows('');
  let vl;
  const renderRow = (i) => {
    const [k, depth] = rows[i];
    const open = k.dir && (expandedDirs.has(k.path) || $('#tf').value);
    const syms = !k.dir && k.f?.decls?.length;
    return `<button class="row h-7 ${k.path === sel ? 'on' : ''}" style="padding-left:${10 + depth * 14}px" role="treeitem" aria-level="${depth + 1}" ${k.dir ? `aria-expanded="${!!open}"` : ''} data-path="${esc(k.path)}" data-dir="${k.dir ? 1 : ''}" tabindex="${k.path === sel || (!sel && i === 0) ? 0 : -1}">
      ${k.dir ? icon(open ? 'down' : 'right', 'w-3.5 h-3.5 text-faint') + icon('folder', 'icon text-l-system/80') : '<span class="w-3.5"></span>' + icon(k.f?.test ? 'flask' : 'file', 'icon text-faint')}
      <span class="truncate flex-1">${esc(k.name)}</span>${k.dir ? `<span class="text-2xs text-faint">${k.files}</span>` : syms ? `<span class="text-2xs text-faint">${syms}</span>` : ''}</button>`;
  };
  const redraw = () => { rows = treeRows($('#tf').value.trim().toLowerCase()); vl = vlist(treeEl, rows.length, 28, renderRow); };
  redraw();
  const at = rows.findIndex(([k]) => k.path === sel); if (at >= 0) vl.reveal(at);
  const toggle = (p) => { expandedDirs.has(p) ? expandedDirs.delete(p) : expandedDirs.add(p); store.set('tree', [...expandedDirs]); const top = treeEl.scrollTop; redraw(); treeEl.scrollTop = top; vl.refresh(); $(`[data-path="${CSS.escape(p)}"]`, treeEl)?.focus(); };
  treeEl.onclick = (e) => { const b = e.target.closest('[data-path]'); if (!b) return; b.dataset.dir ? toggle(b.dataset.path) : go('explorer', '', { p: b.dataset.path }); };
  treeEl.onkeydown = (e) => {
    const b = document.activeElement.closest?.('[data-path]'); if (!b) return;
    const i = +b.parentElement.dataset.row;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const j = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); vl.reveal(j); $(`[data-row="${j}"] button`, treeEl)?.focus(); }
    else if (e.key === 'ArrowRight' && b.dataset.dir && !expandedDirs.has(b.dataset.path)) { e.preventDefault(); toggle(b.dataset.path); }
    else if (e.key === 'ArrowLeft' && b.dataset.dir && expandedDirs.has(b.dataset.path)) { e.preventDefault(); toggle(b.dataset.path); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); }
  };
  $('#tf').oninput = debounce(redraw, 120);
  $('#fileinfo').innerHTML = sel && FILE_BY.has(sel) ? fileInfo(sel) : sel ? folderInfo(sel) : empty('Select a file to see its symbols, imports, routes, tables, callers, callees, requirements, tests and evidence.');
  bindLinks($('#fileinfo'));
}
function folderInfo(p) {
  const fs = FILES.filter((f) => f.p.startsWith(p + '/'));
  return `<div class="card p-4"><h2 class="font-semibold text-base">${esc(p)}/</h2><p class="text-muted">${fs.length} files · ${fmt(fs.reduce((a, f) => a + (f.loc || 0), 0))} lines</p></div>`;
}
const relLink = (i, extra = '') => { const n = NODES[i]; return `<button class="flex items-center gap-2 w-full text-left px-2 py-1 rounded hover:bg-hover min-w-0" data-node="${esc(n.id)}">${layerDot(n.type)}<span class="text-2xs text-faint w-16 shrink-0 truncate">${esc(n.type)}</span><span class="truncate flex-1">${esc(shortName(n))}</span>${extra}</button>`; };
const section = (title, body, count) => `<section class="card p-4"><h3 class="h-sec mb-2">${title}${count != null ? ` <span class="text-faint font-normal">(${count})</span>` : ''}</h3>${body}</section>`;
const lineRef = (p, line) => `<span class="font-mono text-2xs text-faint">${line ? `L${line}` : ''}</span>`;
function fileInfo(p) {
  const f = FILE_BY.get(p), fi = fileNode(p), n = fi != null ? NODES[fi] : null;
  // Declarations in this file and their graph nodes.
  const declIdx = (f.decls || []).map((d) => IDX.get(`${d.type}:${p}#${d.name}`) ?? IDX.get(`function:${p}#${d.name}`)).filter((x) => x != null);
  const own = new Set([fi, ...declIdx].filter((x) => x != null));
  for (const [i] of [...own].entries()) void i;
  // Nodes whose evidence points at this file (APIs, tables, integrations, containers…).
  const evidenced = []; NODES.forEach((m, i) => { if (!own.has(i) && (m.evidence || []).some((e) => e.file === p) && m.type !== 'module' && m.type !== 'project') evidenced.push(i); });
  const rel = (pred) => { const out = new Map(); for (const i of own) for (const e of edgesOf(i)) { const o = SRC[e] === i ? DST[e] : SRC[e]; if (!own.has(o) && pred(e, SRC[e] === i, NODES[o])) out.set(o, e); } return out; };
  const callers = rel((e, outg) => ETYPE[e] === 'calls' && !outg), callees = rel((e, outg) => ETYPE[e] === 'calls' && outg);
  const importsResolved = rel((e, outg) => ETYPE[e] === 'depends_on' && outg), importedBy = rel((e, outg) => ETYPE[e] === 'depends_on' && !outg);
  const tests = rel((e, outg, o) => ETYPE[e] === 'tested_by' || o.type === 'test');
  const reqs = rel((e, outg, o) => REQ_TYPES.includes(o.type) || o.type === 'use_case' || o.type === 'user_story');
  for (const i of evidenced) for (const e of edgesOf(i)) { const o = SRC[e] === i ? DST[e] : SRC[e]; if (REQ_TYPES.includes(NODES[o].type)) reqs.set(o, e); }
  const ids = new Set([...own, ...evidenced].map((i) => NODES[i].id));
  const docs = DOCS.filter((d) => (d.nodes || []).some((x) => ids.has(x)) || (d.sources || []).includes(p));
  const edgeBadge = (e) => `<span class="badge b-${prov(EDGES[e])}">${PROV_LABEL[prov(EDGES[e])]}</span>`;
  const relList = (m, empty) => (m.size ? [...m].slice(0, 60).map(([o, e]) => relLink(o, edgeBadge(e))).join('') + (m.size > 60 ? `<div class="text-2xs text-muted px-2">+${m.size - 60} more</div>` : '') : `<p class="text-muted text-2xs">${empty}</p>`);
  const evidence = n ? (n.evidence || []) : [];
  return `<div class="space-y-4">
   <div class="card p-4"><div class="flex flex-wrap items-center gap-2 text-2xs text-muted">${icon(f.test ? 'flask' : 'file', 'icon')}<span>${esc(f.lang || 'file')}</span>${f.loc != null ? `<span>· ${fmt(f.loc)} lines</span>` : ''}${f.test ? '<span class="badge">test</span>' : ''}${n ? provBadge(n) : '<span class="badge">not in graph</span>'}</div>
    <h2 class="font-semibold text-base mt-1 break-all">${esc(p)}</h2>
    <div class="flex flex-wrap gap-2 mt-3">${fi != null ? `<button class="btn" data-node="${esc(n.id)}">${icon('list')}Details</button><a class="btn no-underline hover:no-underline" href="${href('graph', 'files', { focus: n.id })}">${icon('graph')}Dependencies graph</a><a class="btn no-underline hover:no-underline" href="${href('graph', 'all', { focus: n.id, impact: 1 })}">${icon('zap')}Change impact</a>` : ''}${evLinks({ file: p })}</div></div>
   <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
   ${section('Symbols', (f.decls || []).length ? (f.decls || []).map((d) => { const i = IDX.get(`${d.type}:${p}#${d.name}`) ?? IDX.get(`function:${p}#${d.name}`); return `<div class="flex items-center gap-2 px-2 py-1 rounded hover:bg-hover">${icon('braces', 'w-3.5 h-3.5 text-l-engineering')}<span class="text-2xs text-faint w-16">${esc(d.type)}</span>${i != null ? `<button class="truncate flex-1 text-left text-accent" data-node="${esc(NODES[i].id)}">${esc(d.name)}</button>` : `<span class="truncate flex-1">${esc(d.name)}</span>`}${lineRef(p, d.line + (d.end && d.end !== d.line ? '-' + d.end : ''))}<span class="badge b-extracted">Extracted</span></div>`; }).join('') : '<p class="text-muted text-2xs">No declarations extracted.</p>', (f.decls || []).length)}
   ${section('Imports', (f.imports || []).length ? (f.imports || []).map((im) => `<div class="flex items-center gap-2 px-2 py-1"><span class="font-mono text-[12px] truncate flex-1">${esc(im.spec)}</span><span class="text-2xs text-muted truncate max-w-[40%]">${esc((im.names || []).join(', '))}</span>${lineRef(p, im.line)}</div>`).join('') + (importsResolved.size ? `<div class="h-sec mt-3 mb-1">Resolved to</div>${relList(importsResolved, '')}` : '') : '<p class="text-muted text-2xs">No imports extracted.</p>', (f.imports || []).length)}
   ${section('Imported by', relList(importedBy, 'No other file imports this one.'), importedBy.size)}
   ${(f.routes || []).length ? section('Routes', f.routes.map((r) => { const i = IDX.get(`api:${r.method} ${r.path}`); return `<div class="flex items-center gap-2 px-2 py-1"><span class="badge font-mono">${esc(r.method)}</span>${i != null ? `<button class="font-mono text-[12px] text-accent truncate flex-1 text-left" data-node="${esc(NODES[i].id)}">${esc(r.path)}</button>` : `<span class="font-mono text-[12px] truncate flex-1">${esc(r.path)}</span>`}${lineRef(p, r.line)}</div>`; }).join(''), f.routes.length) : ''}
   ${(f.dbUses || []).length || (f.tables || []).length ? section('Tables', [...(f.tables || []).map((t) => ({ table: t.name || t, mode: 'defines', line: t.line })), ...(f.dbUses || [])].map((u) => { const i = IDX.get('table:' + u.table); return `<div class="flex items-center gap-2 px-2 py-1">${icon('database', 'w-3.5 h-3.5 text-l-system')}${i != null ? `<button class="truncate flex-1 text-left text-accent" data-node="${esc(NODES[i].id)}">${esc(u.table)}</button>` : `<span class="truncate flex-1">${esc(u.table)}</span>`}<span class="badge">${esc(u.mode)}</span>${lineRef(p, u.line)}</div>`; }).join('')) : ''}
   ${(f.http || []).length ? section('External calls', f.http.map((h) => `<div class="flex items-center gap-2 px-2 py-1">${icon('plug', 'w-3.5 h-3.5 text-l-system')}<span class="truncate flex-1">${esc(h.host)}</span>${lineRef(p, h.line)}</div>`).join(''), f.http.length) : ''}
   ${section('Callers', relList(callers, 'No resolved callers. Calls are linked only for names imported from local files.'), callers.size)}
   ${section('Callees', relList(callees, 'No resolved callees.'), callees.size)}
   ${section('Requirements', relList(reqs, 'No requirement is linked to this file yet.'), reqs.size)}
   ${section('Tests', relList(tests, 'No test linked to this file.'), tests.size)}
   ${evidenced.length ? section('Declared here', evidenced.slice(0, 60).map((i) => relLink(i, provBadge(NODES[i]))).join(''), evidenced.length) : ''}
   ${section('Documents', docs.length ? docs.map(docRow).join('') : '<p class="text-muted text-2xs">No document references this file.</p>', docs.length)}
   ${section('Evidence', evidence.length ? evidence.map(evRow).join('') : '<p class="text-muted text-2xs">No evidence recorded.</p>', evidence.length)}
   </div></div>`;
}
const docRow = (d) => `<div class="flex items-center gap-2 px-2 py-1">${icon('doc', 'w-3.5 h-3.5 text-l-project')}<a href="${href('documents', '', { d: d.id })}" class="truncate flex-1">${esc(d.id)} · ${esc(d.title)}</a><span class="badge">${esc(d.status)}</span>${d.needsReview ? '<span class="badge b-stale">needs review</span>' : ''}</div>`;
function evLinks(e) {
  if (!e.file) return '';
  const rel = '../../' + e.file.split('/').map(encodeURIComponent).join('/');
  let vs = '';
  if (location.protocol === 'file:') { const root = decodeURIComponent(location.pathname).replace(/\/\.rmcontext\/viewer\/[^/]*$/, '').replace(/^\/([A-Za-z]:)/, '$1'); vs = `<a class="btn no-underline hover:no-underline" href="vscode://file/${encodeURI(root + '/' + e.file)}${e.lines ? ':' + e.lines[0] : ''}">${icon('external')}VS Code</a>`; }
  return `<a class="btn no-underline hover:no-underline" href="${rel}" target="_blank" rel="noopener">${icon('external')}Source</a>${vs}`;
}
const evRow = (e) => {
  const where = e.file ? e.file + (e.lines ? ':' + e.lines[0] + (e.lines[1] !== e.lines[0] ? '-' + e.lines[1] : '') : '') : e.type + (e.ref ? ': ' + e.ref : '');
  return `<div class="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-line last:border-0"><span class="font-mono text-[12px] break-all flex-1 min-w-0">${e.file ? `<a href="../../${e.file.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener">${esc(where)}</a>` : esc(where)}</span><span class="badge">${esc(e.type)}</span><span class="badge b-${e.confidence === 'inferred' ? 'inferred' : e.confidence === 'manual' ? 'manual' : 'extracted'}">${esc(e.confidence || '')}</span></div>`;
};

// ---------- entity lists ----------
function drawList(route) {
  const L = LISTS[route.sub];
  if (!L) return drawNotFound();
  const types = new Set(L.types);
  const all = []; NODES.forEach((n, i) => { if (types.has(n.type)) all.push(i); });
  const cols = L.cols.map((c) => c[2]).join(' ');
  showPage(`${header(`${icon(L.icon, 'inline w-5 h-5 -mt-1 mr-1 text-muted')} ${L.title}`, `${fmt(all.length)} items · ${L.desc}`, `<div class="flex gap-2 w-full sm:w-auto"><input id="lf" class="input flex-1 min-w-0 sm:w-64 sm:flex-none"placeholder="Filter ${L.title.toLowerCase()}…" aria-label="Filter" autocomplete="off"><select id="ls" class="input w-auto" aria-label="Sort"><option value="name">Name</option><option value="links">Most linked</option></select></div>`)}
   ${all.length ? `<div class="card flex flex-col overflow-hidden" style="height:calc(100vh - 190px);min-height:320px"><div class="overflow-x-auto flex-1 flex flex-col min-h-0"><div class="min-w-[640px] flex-1 flex flex-col min-h-0"><div class="grid gap-3 px-3 h-9 items-center border-b border-line text-2xs font-semibold text-muted uppercase tracking-wide" style="grid-template-columns:${cols}">${L.cols.map((c) => `<span>${c[0]}</span>`).join('')}</div><div id="lb" class="flex-1 overflow-auto min-h-0"></div></div></div></div>` : empty(`No ${L.title.toLowerCase()} in this project's graph.`)}`);
  if (!all.length) return;
  const lower = all.map((i) => (NODES[i].name + ' ' + NODES[i].id).toLowerCase());
  const draw = () => {
    const f = $('#lf').value.trim().toLowerCase();
    let rows = f ? all.filter((_, k) => lower[k].includes(f)) : all.slice();
    rows.sort($('#ls').value === 'links' ? (a, b) => IX.deg[b] - IX.deg[a] : (a, b) => NODES[a].name.localeCompare(NODES[b].name));
    vlist($('#lb'), rows.length, 36, (k) => { const i = rows[k], n = NODES[i]; return `<button class="grid gap-3 px-3 h-9 items-center w-full text-left hover:bg-hover border-b border-line min-w-0 ${n.id === route.params.get('n') ? 'bg-accent-soft' : ''}" style="grid-template-columns:${cols}" data-node="${esc(n.id)}">${L.cols.map((c) => `<span class="min-w-0 truncate flex">${c[1](n, i)}</span>`).join('')}</button>`; });
  };
  $('#lf').oninput = debounce(draw, 120); $('#ls').onchange = draw;
  draw();
  rowKeys($('#lb'), 'button[data-node]');
  bindLinks(page());
}

// ---------- documents, project, handoffs, notes ----------
function drawDocument(d) {
  showPage(`<a href="#/documents" class="inline-flex items-center gap-1 text-2xs mb-3">${icon('back', 'w-3.5 h-3.5')}All documents</a>
   ${header(`${esc(d.id)} · ${esc(d.title)}`, `${esc(d.type)} · v${esc(d.version)} · ${esc(d.author || '')} · updated ${esc((d.updatedAt || '').slice(0, 10))}`, `<div class="flex flex-wrap items-center gap-2"><span class="badge">${esc(d.status)}</span>${d.needsReview ? '<span class="badge b-stale">needs review</span>' : ''}<a class="btn no-underline hover:no-underline" href="../${esc(d.path)}" target="_blank" rel="noopener">${icon('external')}Markdown file</a></div>`)}
   ${(d.nodes || []).length ? `<div class="flex flex-wrap gap-1 mb-4">${d.nodes.map((x) => (IDX.has(x) ? `<button class="chip" data-node="${esc(x)}">${layerDot(NODES[IDX.get(x)].type)}${esc(shortName(NODES[IDX.get(x)]))}</button>` : `<span class="chip">${esc(x)}</span>`)).join('')}</div>` : ''}
   <article class="card p-5 sm:p-7 max-w-4xl">${d.text ? md(d.text) : '<p class="text-muted">The document file was not found when the viewer was built.</p>'}${d.truncated ? '<p class="text-2xs text-muted mt-4">Truncated in the viewer; open the Markdown file for the rest.</p>' : ''}</article>`);
  bindLinks(page());
  renderMermaid(page());
}
function drawDocuments(route) {
  if (!DOCS.length) return showPage(header('Technical Documents') + empty('No documents yet. Create one with <code>/rmc:document</code>.'));
  const open = route?.params.get('d') && DOCS.find((d) => d.id === route.params.get('d'));
  if (open) return drawDocument(open);
  const types = [...new Set(DOCS.map((d) => d.type))].sort();
  showPage(`${header('Technical Documents', `${DOCS.length} registered. A document becomes Approved only with explicit user approval; approved documents are flagged for review, never rewritten.`, `<select id="dt" class="input w-auto" aria-label="Type"><option value="">All types</option>${types.map((t) => `<option>${esc(t)}</option>`).join('')}</select>`)}<div class="card overflow-x-auto"><table class="tbl min-w-[720px]"><thead><tr><th>ID</th><th>Title</th><th>Type</th><th>Status</th><th>Version</th><th>Author</th><th>Updated</th><th>Linked</th></tr></thead><tbody id="dl"></tbody></table></div>`);
  const draw = () => { const t = $('#dt').value; $('#dl').innerHTML = DOCS.filter((d) => !t || d.type === t).map((d) => `<tr><td class="whitespace-nowrap"><a href="${href('documents', '', { d: d.id })}">${esc(d.id)}</a></td><td><a href="${href('documents', '', { d: d.id })}" class="text-fg">${esc(d.title)}</a>${d.needsReview ? ' <span class="badge b-stale">needs review</span>' : ''}</td><td>${esc(d.type)}</td><td><span class="badge">${esc(d.status)}</span></td><td>v${esc(d.version)}</td><td>${esc(d.author)}</td><td class="whitespace-nowrap">${esc((d.updatedAt || '').slice(0, 10))}</td><td>${(d.nodes || []).slice(0, 4).map((x) => (IDX.has(x) ? `<button class="text-accent" data-node="${esc(x)}">${esc(shortName(NODES[IDX.get(x)]))}</button>` : esc(x))).join(', ') || '—'}</td></tr>`).join(''); bindLinks($('#dl')); };
  $('#dt').onchange = draw; draw();
}
function drawProject() {
  const plan = D.plan;
  if (!plan) return showPage(header('Project Management') + empty('No plan yet. The Project Manager agent creates one with <code>rmc pm init</code>.'));
  const p = D.progress, STAT = ['Planned', 'In Progress', 'Blocked', 'Completed', 'Cancelled'], on = new Set(STAT);
  showPage(`${header(esc(plan.project?.name || 'Project'), `Verified ${p.verifiedPercent}% · reported ${p.reportedPercent}% · planned ${p.plannedPercent == null ? 'n/a' : p.plannedPercent + '%'} (as of ${esc(p.asOf)}). ${D.critical.length ? 'Critical path: ' + D.critical.map(esc).join(' → ') : 'Critical path: not enough dependency/date data.'}`)}
   <div id="gf" class="flex flex-wrap gap-1.5 mb-2">${STAT.map((s) => `<button class="chip" data-s="${s}" aria-pressed="true">${s}</button>`).join('')}</div>
   <div class="card overflow-auto bg-white" id="gantt"></div>
   <section class="card mt-4 overflow-x-auto"><table class="tbl min-w-[860px]"><thead><tr><th>ID</th><th>Task</th><th>Owner</th><th>Planned</th><th>Status</th><th>Progress</th><th>Depends on</th><th>Evidence</th></tr></thead><tbody>${(() => { const parents = new Set(plan.tasks.map((t) => t.parent).filter(Boolean)); return plan.tasks.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.name)}${t.milestone ? ' <span class="badge">milestone</span>' : ''}</td><td>${esc(t.owner || '—')}</td><td class="whitespace-nowrap">${esc(t.start || 'TBD')} → ${esc(t.end || 'TBD')}</td><td><span class="badge">${esc(t.status)}</span></td><td>${parents.has(t.id) ? '—' : (t.progress ?? (t.status === 'Completed' ? 100 : 0)) + '%'}</td><td>${esc((t.dependencies || []).join(', ') || '—')}</td><td>${(t.evidence || []).map((x) => `<span class="badge">${esc(x.type)}</span> ${esc(x.ref)}`).join('<br>') || '—'}</td></tr>`).join(''); })()}</tbody></table></section>`);
  const draw = () => { $('#gantt').innerHTML = renderGanttSvg(plan, { statuses: [...on], critical: D.critical }); };
  $$('#gf button').forEach((b) => (b.onclick = () => { const s = b.dataset.s; on.has(s) ? on.delete(s) : on.add(s); b.classList.toggle('off'); b.setAttribute('aria-pressed', on.has(s)); draw(); }));
  draw();
}
function drawHandoffs() {
  const H = (D.handoffs || []).slice().reverse();
  if (!H.length) return showPage(header('Agent Handoffs') + empty('No hand-offs recorded. Agents record them with <code>rmc handoff add</code>.'));
  const li = (title, xs) => (xs && xs.length ? `<div class="mt-2"><div class="h-sec mb-1">${title}</div><ul class="list-disc pl-5 space-y-0.5">${xs.map((x) => `<li>${esc(typeof x === 'object' ? JSON.stringify(x) : x)}</li>`).join('')}</ul></div>` : '');
  showPage(`${header('Agent Handoffs', `${H.length} recorded, newest first.`)}<div class="space-y-3">${H.map((h) => `<article class="card p-4"><div class="flex flex-wrap items-center gap-2 text-2xs text-muted"><span class="badge font-mono">${esc(h.id)}</span><b class="text-fg">${esc(h.from)}</b>${icon('right', 'w-3 h-3')}<b class="text-fg">${esc(h.to)}</b>${h.workflow ? `<span class="badge">${esc(h.workflow)}</span>` : ''}<span class="ml-auto">${esc((h.at || '').replace('T', ' ').slice(0, 16))}</span></div><p class="mt-2">${esc(h.summary)}</p>${li('Decisions', h.decisions)}${li('Assumptions', h.assumptions)}${li('Open questions', h.openQuestions)}${li('Artifacts', h.artifacts)}${(h.nodes || []).length ? `<div class="flex flex-wrap gap-1 mt-2">${h.nodes.map((x) => (IDX.has(x) ? `<button class="chip" data-node="${esc(x)}">${esc(shortName(NODES[IDX.get(x)]))}</button>` : `<span class="chip">${esc(x)}</span>`)).join('')}</div>` : ''}</article>`).join('')}</div>`);
  bindLinks(page());
}
// Small Markdown renderer for notes and documents: headings, lists, tables, quotes, code fences and Mermaid blocks.
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code class="px-1 rounded bg-raised">$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
function md(text) {
  const out = [], lines = String(text).replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k].trimEnd();
    const fence = /^\s*```\s*([\w-]*)/.exec(l);
    if (fence) {
      closeList();
      const buf = []; while (++k < lines.length && !/^\s*```\s*$/.test(lines[k])) buf.push(lines[k]);
      out.push(fence[1] === 'mermaid' ? `<div class="card p-3 my-3 overflow-x-auto"><pre class="mermaid text-[12px] text-muted whitespace-pre" data-src="${esc(buf.join('\n'))}">${esc(buf.join('\n'))}</pre></div>` : `<pre class="card p-3 my-3 overflow-x-auto font-mono text-[12px] whitespace-pre">${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      closeList();
      const rows = []; for (; k < lines.length && /^\s*\|.*\|\s*$/.test(lines[k]); k++) rows.push(lines[k].trim().slice(1, -1).split('|').map((c) => c.trim()));
      k--;
      const sep = rows[1] && rows[1].every((c) => /^:?-{2,}:?$/.test(c));
      const head = sep ? rows[0] : null, body = sep ? rows.slice(2) : rows;
      out.push(`<div class="overflow-x-auto my-3"><table class="tbl">${head ? `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l), ul = /^\s*[-*+]\s+(.*)$/.exec(l), ol = /^\s*\d+[.)]\s+(.*)$/.exec(l), q = /^>\s?(.*)$/.exec(l);
    if (!(ul || ol)) closeList();
    if (h) { const lv = Math.min(4, h[1].length + 1); out.push(`<h${lv} class="font-semibold ${h[1].length === 1 ? 'text-lg' : h[1].length === 2 ? 'text-base mt-5' : 'mt-3'} mb-1.5">${inline(h[2])}</h${lv}>`); }
    else if (ul || ol) { const t = ul ? 'ul' : 'ol'; if (list !== t) { closeList(); out.push(`<${t} class="${t === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 space-y-0.5 my-1">`); list = t; } out.push(`<li>${inline((ul || ol)[1])}</li>`); }
    else if (q) out.push(`<blockquote class="border-l-2 border-line pl-3 text-muted my-1">${inline(q[1])}</blockquote>`);
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) out.push('<hr class="border-line my-4">');
    else if (l.trim()) out.push(`<p class="my-1.5">${inline(l)}</p>`);
  }
  closeList();
  return out.join('');
}
// Mermaid is evaluated on first use only (it is large), then each diagram is rendered in the current theme.
let mermaidReady = null;
function renderMermaid(root) {
  const nodes = $$('pre.mermaid', root);
  if (!nodes.length) return;
  if (!MERMAID_SRC) { nodes.forEach((n) => n.insertAdjacentHTML('beforebegin', '<div class="text-2xs text-warn mb-1">Mermaid is not embedded in this viewer; rebuild it with rmc viewer.</div>')); return; }
  try { if (!mermaidReady) { (0, eval)(MERMAID_SRC); mermaidReady = window.mermaid; } } catch (e) { mermaidReady = null; return; }
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  mermaidReady.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif' });
  nodes.forEach((n) => { n.removeAttribute('data-processed'); n.textContent = n.dataset.src; });
  mermaidReady.run({ nodes, suppressErrors: true }).catch(() => {}).finally(() => nodes.forEach((n) => { if (!n.querySelector('svg')) n.insertAdjacentHTML('beforebegin', '<div class="text-2xs text-danger mb-1">This diagram has a Mermaid syntax error; its source is shown.</div>'); else n.classList.remove('text-muted'); }));
}
function drawNotes(route) {
  const N = D.notes || [];
  if (!N.length) return showPage(header('Notes') + empty('No context notes yet. Agents write them under <code>.rmcontext/context/</code>.'));
  const cur = route.params.get('f') || N[0].path;
  const note = N.find((x) => x.path === cur) || N[0];
  showPage(`${header('Notes', 'Context notes written by agents and users. Lines that look like credentials are removed when the viewer is built.')}
   <div class="flex flex-col md:flex-row gap-4"><nav class="card p-1 md:w-64 shrink-0 self-start w-full" aria-label="Notes">${N.map((x) => `<a href="${href('notes', '', { f: x.path })}" class="row rounded no-underline hover:no-underline text-fg ${x.path === note.path ? 'on' : ''}">${icon('note', 'icon text-faint')}<span class="truncate">${esc(x.title)}</span></a>`).join('')}</nav>
   <article class="card p-5 flex-1 min-w-0"><div class="text-2xs text-muted font-mono mb-2">.rmcontext/${esc(note.path)}${note.truncated ? ' · truncated' : ''}</div>${md(note.text)}</article></div>`);
  renderMermaid(page());
}

// ---------- search ----------
function searchResults(q, limit) { return search(SX, q, limit).map((k) => SEARCH_ITEMS[k]); }
const resultRow = (it, active) => {
  if (it.kind === 'node') { const n = NODES[it.i]; return `<a href="${href(...nodeRoute(n.id))}" class="flex items-center gap-2.5 px-3 py-2 no-underline hover:no-underline text-fg hover:bg-hover ${active ? 'bg-hover' : ''}" data-hit>${layerDot(n.type)}<span class="truncate flex-1">${esc(shortName(n))}<span class="text-faint text-2xs ml-2">${esc(loc(n) || n.id)}</span></span><span class="badge">${esc(n.type)}</span></a>`; }
  if (it.kind === 'file') return `<a href="${href('explorer', '', { p: it.p })}" class="flex items-center gap-2.5 px-3 py-2 no-underline hover:no-underline text-fg hover:bg-hover ${active ? 'bg-hover' : ''}" data-hit>${icon('file', 'icon text-faint')}<span class="truncate flex-1">${esc(it.p)}</span><span class="badge">file</span></a>`;
  return `<a href="${href('documents', '', { d: it.d.id })}" class="flex items-center gap-2.5 px-3 py-2 no-underline hover:no-underline text-fg hover:bg-hover ${active ? 'bg-hover' : ''}" data-hit>${icon('doc', 'icon text-l-project')}<span class="truncate flex-1">${esc(it.d.id)} · ${esc(it.d.title)}</span><span class="badge">${esc(it.d.status)}</span></a>`;
};
function nodeRoute(id) {
  const n = NODES[IDX.get(id)];
  if (n.type === 'file' || n.type === 'test') return ['explorer', '', { p: n.name }];
  const list = Object.entries(LISTS).find(([, L]) => L.types.includes(n.type));
  return list ? ['list', list[0], { n: id }] : ['graph', 'all', { focus: id }];
}
function drawSearch(route) {
  const q = route.params.get('q') || '';
  showPage(`${header('Search', 'Names, identifiers, paths and documents. Prefix matches; all words must match.')}<input id="sq" class="input max-w-xl mb-4" value="${esc(q)}" placeholder="Search the project…" aria-label="Search the project" autocomplete="off"><div id="sr"></div>`);
  const draw = () => {
    const v = $('#sq').value; const t0 = performance.now(); const R = v.trim() ? searchResults(v, 200) : []; const ms = performance.now() - t0;
    const groups = {}; for (const r of R) { const g = r.kind === 'node' ? layerOf(NODES[r.i]) : r.kind === 'file' ? 'files' : 'documents'; (groups[g] ||= []).push(r); }
    $('#sr').innerHTML = !v.trim() ? '' : R.length ? `<p class="text-2xs text-muted mb-2">${R.length}${R.length === 200 ? '+' : ''} results · ${ms.toFixed(1)} ms</p>` + Object.entries(groups).map(([g, rs]) => `<section class="card mb-3 overflow-hidden"><h2 class="h-sec px-3 pt-3 pb-1 capitalize">${esc(g)} <span class="font-normal">(${rs.length})</span></h2>${rs.map((r) => resultRow(r)).join('')}</section>`).join('') : empty('No matches.');
  };
  $('#sq').oninput = debounce(() => { history.replaceState(null, '', href('search', '', { q: $('#sq').value })); draw(); }, 150);
  draw(); $('#sq').focus();
}
function initSearchBox() {
  const q = $('#q'), box = $('#qres');
  let hits = [], hi = 0;
  const close = () => { box.classList.add('hidden'); q.setAttribute('aria-expanded', 'false'); };
  const paint = () => { box.innerHTML = hits.length ? hits.map((h, k) => resultRow(h, k === hi)).join('') + `<a href="${href('search', '', { q: q.value })}" class="block px-3 py-2 text-2xs border-t border-line">See all results</a>` : '<div class="px-3 py-3 text-muted">No matches</div>'; box.classList.remove('hidden'); q.setAttribute('aria-expanded', 'true'); };
  const run = debounce(() => { const v = q.value.trim(); if (!v) return close(); hits = searchResults(v, 12); hi = 0; paint(); }, 90);
  q.addEventListener('input', run);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, Math.min(hits.length - 1, hi + (e.key === 'ArrowDown' ? 1 : -1))); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); const a = $$('[data-hit]', box)[hi]; if (a) { a.click(); close(); q.blur(); } else if (q.value.trim()) go('search', '', { q: q.value }); }
    else if (e.key === 'Escape') { close(); q.blur(); }
  });
  q.addEventListener('blur', () => setTimeout(close, 180));
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => { if (e.target.closest('a')) { close(); q.blur(); } });
}

// ---------- context status & settings ----------
function drawContext() {
  const a = D.autoContext;
  if (!a) return showPage(header('Context Status') + empty('No automatic-context data.'));
  const c = a.config, lr = a.lastRefresh;
  const on = (v) => `<span class="badge ${v ? 'b-extracted' : ''}">${v ? 'on' : 'off'}</span>`;
  showPage(`${header('Context Status', 'Automatic context runs through Claude Code hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop). It is deterministic: no model calls, no full scans, prompts are never stored.')}
   <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">${statCard('Prompts seen', fmt(a.prompts), `${fmt(a.injected)} with context`)}${statCard('Avg context', fmt(a.avgTokens) + ' tok', `max ${fmt(a.maxTokens)} · budget ${fmt(c.maxContextTokens)}`)}${statCard('Avg retrieval', fmt(a.avgMs) + ' ms', '')}${statCard('Auto-refreshes', fmt(a.refreshes), `${fmt(a.pendingChanges)} pending change(s)`)}</div>
   <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
    <section class="card p-4"><h2 class="h-sec mb-3">Configuration</h2><div class="space-y-1.5">
      <div class="flex justify-between"><span>Automatic context</span>${on(c.enabled)}</div><div class="flex justify-between"><span>Session summary</span>${on(c.sessionStart)}</div><div class="flex justify-between"><span>Prompt retrieval</span>${on(c.promptRetrieval)}</div><div class="flex justify-between"><span>Incremental refresh</span>${on(c.incrementalRefresh)}</div>
      <div class="flex justify-between"><span>Budget per prompt</span><span class="tabular-nums">${fmt(c.maxContextTokens)} tokens</span></div><div class="flex justify-between"><span>Session summary budget</span><span class="tabular-nums">${fmt(c.sessionContextTokens)} tokens</span></div><div class="flex justify-between"><span>Max results · min relevance</span><span class="tabular-nums">${c.maxResults} · ${c.minimumRelevance}</span></div></div>
      <p class="text-2xs text-muted mt-3">Change it in <code>.rmcontext/config.json</code> under <code>autoContext</code>, e.g. <code>{"autoContext": {"enabled": false}}</code>, or set <code>RMC_AUTO_CONTEXT=0</code>. The CLI and commands keep working. Claude Code only.</p></section>
    <section class="card p-4"><h2 class="h-sec mb-3">Last automatic refresh</h2>${lr ? `<div class="space-y-1.5"><div class="flex justify-between gap-3"><span>When</span><span class="text-muted">${esc(lr.at.replace('T', ' ').slice(0, 19))}</span></div><div class="flex justify-between gap-3"><span>Mode</span><span class="badge">${esc(lr.mode)}${lr.fullScan === false ? ' · no full scan' : ''}</span></div><div class="flex justify-between gap-3"><span>Duration</span><span class="tabular-nums">${fmt(lr.durationMs)} ms</span></div>
      ${lr.delta ? `<div class="flex justify-between gap-3"><span>Graph change</span><span class="tabular-nums">+${lr.delta.nodesAdded} ~${lr.delta.nodesChanged} −${lr.delta.nodesRemoved} nodes · +${lr.delta.edgesAdded} −${lr.delta.edgesRemoved} edges</span></div>` : ''}
      ${lr.modules?.length ? `<div class="flex justify-between gap-3"><span>Modules</span><span class="text-right">${lr.modules.map(esc).join(', ')}</span></div>` : ''}
      ${(lr.documentsFlagged || []).length ? `<div class="flex justify-between gap-3"><span>Documents flagged</span><span class="text-danger">${lr.documentsFlagged.map(esc).join(', ')}</span></div>` : ''}
      ${lr.changedFiles?.length ? `<div class="h-sec mt-3 mb-1">Changed files</div>${lr.changedFiles.slice(0, 20).map((f) => `<a href="${href('explorer', '', { p: f })}" class="block font-mono text-[12px] truncate">${esc(f)}</a>`).join('')}` : ''}</div>` : '<p class="text-muted">No automatic refresh yet. It runs when a turn that changed files ends.</p>'}</section>
   </div>
   ${a.errors?.length ? `<section class="card p-4 mt-4"><h2 class="h-sec mb-2 text-danger">Recent hook errors</h2>${a.errors.map((e) => `<div class="font-mono text-[12px]">${esc(e.at)} ${esc(e.hook)}: ${esc(e.message)}</div>`).join('')}</section>` : ''}
   <section class="card p-4 mt-4"><h2 class="h-sec mb-2">Diagnostics</h2><pre class="font-mono text-[12px] whitespace-pre-wrap text-muted">rmc context status        # this summary in the terminal
rmc context "&lt;prompt&gt;"     # what would be injected for a prompt
rmc refresh               # manual incremental refresh</pre></section>`);
}
function drawSettings() {
  const theme = store.get('theme', 'system');
  showPage(`${header('Settings', 'Stored in this browser only.')}
   <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
   <section class="card p-4"><h2 class="h-sec mb-3">Appearance</h2><div class="flex gap-2" role="radiogroup" aria-label="Theme">${['system', 'light', 'dark'].map((t) => `<button class="btn ${theme === t ? 'on' : ''}" role="radio" aria-checked="${theme === t}" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></section>
   <section class="card p-4"><h2 class="h-sec mb-3">Graph</h2><p class="text-muted mb-3">Layouts are computed off the main thread and cached per view, so reopening a view is instant.</p><button class="btn" id="clr">${icon('reset')}Clear cached layouts</button> <span id="clrmsg" class="text-2xs text-muted ml-2"></span></section>
   <section class="card p-4"><h2 class="h-sec mb-3">Keyboard</h2><dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"><dt><kbd class="badge font-mono">/</kbd></dt><dd>Search</dd><dt><kbd class="badge font-mono">Esc</kbd></dt><dd>Close panel or search</dd><dt><kbd class="badge font-mono">↑ ↓ ← →</kbd></dt><dd>Move in tree and lists; pan the graph</dd><dt><kbd class="badge font-mono">+ −</kbd></dt><dd>Zoom the graph</dd><dt><kbd class="badge font-mono">0</kbd></dt><dd>Fit the graph</dd><dt><kbd class="badge font-mono">F</kbd></dt><dd>Focus the selected node</dd><dt><kbd class="badge font-mono">Backspace</kbd></dt><dd>Graph: back</dd></dl></section>
   <section class="card p-4"><h2 class="h-sec mb-3">About this snapshot</h2><div class="space-y-1 text-muted"><div>Built ${esc(D.generatedAt)}</div><div>${fmt(NODES.length)} nodes · ${fmt(EDGES.length)} relationships · ${fmt(FILES.length)} files</div><div>Offline single file — no network requests.</div></div></section></div>`);
  $$('[data-theme]', page()).forEach((b) => (b.onclick = () => { setTheme(b.dataset.theme); drawSettings(); }));
  $('#clr').onclick = () => { let n = 0; try { for (const k of Object.keys(localStorage)) if (k.startsWith('rmc-viewer:layout:')) { localStorage.removeItem(k); n++; } } catch { /* ignore */ } layoutCache.clear(); $('#clrmsg').textContent = `${n} cached layout(s) cleared`; };
}

// ---------- Database Intelligence & Mobile (knowledge store; structure and metadata only) ----------
const ENVC = { PRODUCTION: 'b-stale', STAGING: 'b-stale', UNKNOWN: 'b-stale' };
function drawDbIntel(route) {
  const I = D.dbIntel || { targets: [], changes: [] };
  const all = I.targets;
  if (!all.length) return showPage(header('Database Intelligence', 'Schemas, stored procedures and dependencies from the knowledge store.') + empty('No database knowledge yet. Run <code>rmc database discover</code> (static, no connection) in this project, then rebuild the viewer.'));
  const q = (route.params.get('q') || '').toLowerCase();
  const cards = all.map((t) => {
    const objs = t.objects.filter((o) => !q || (o.name + ' ' + (o.columns || []).map((c) => c.name).join(' ') + ' ' + (o.params || []).map((p) => p.name).join(' ')).toLowerCase().includes(q));
    const row = (o) => {
      const det = o.kind === 'table'
        ? `<div class="text-2xs font-mono text-muted mt-1">${(o.columns || []).map((c) => `${esc(c.name)} ${esc(c.type)}${c.pk ? ' PK' : ''}${c.nullable === false && !c.pk ? ' NOT NULL' : ''}${c.identity ? ' IDENTITY' : ''}`).join(' · ')}</div>${(o.foreignKeys || []).length ? `<div class="text-2xs text-muted">FK: ${o.foreignKeys.map((f) => `${esc(f.columns.join(','))} → ${esc(f.ref)}`).join('; ')}</div>` : ''}${(o.indexes || []).length ? `<div class="text-2xs text-muted">Indexes: ${o.indexes.map((i) => esc(i.name) + (i.unique ? ' (unique)' : '')).join(', ')}</div>` : ''}`
        : `<div class="text-2xs font-mono text-muted mt-1">(${(o.params || []).map((p) => `${esc(p.name)} ${esc(p.type)}${p.mode && p.mode !== 'IN' ? ' ' + esc(p.mode) : ''}`).join(', ')})</div>${(o.refs || []).length ? `<div class="text-2xs text-muted">Touches: ${o.refs.map((r) => `${esc(r.name)} <span class="badge">${esc([r.mode?.join?.('/') || r.kind, r.status || r.confidence].filter(Boolean).join(' · '))}</span>`).join(' ')}</div>` : ''}${o.encrypted ? '<div class="text-2xs text-muted">definition encrypted or unavailable</div>' : ''}${o.review ? '<div class="text-2xs text-muted">flagged for review (secret literal, not stored)</div>' : ''}${o.dynamic ? '<div class="text-2xs text-muted">dynamic SQL: some references unresolved</div>' : ''}`;
      const used = t.mapping.filter((m) => m.object === `${o.schema ? o.schema.toLowerCase() + '.' : ''}${o.name.toLowerCase()}` || m.object === o.name.toLowerCase()).slice(0, 3);
      return `<div class="px-3 py-2 border-b border-line ${o.status === 'removed' ? 'opacity-50' : ''}"><div class="flex items-center gap-2 min-w-0">${icon(o.kind === 'table' ? 'database' : 'braces', 'w-3.5 h-3.5 text-l-system')}<span class="font-medium truncate flex-1">${esc(o.schema ? o.schema + '.' : '')}${esc(o.name)}</span><span class="badge">${esc(o.kind)}</span><span class="badge">${esc(o.confidence || '')}</span>${o.status === 'removed' ? '<span class="badge b-stale">removed</span>' : ''}</div>${det}${used.length ? `<div class="text-2xs text-muted">Used in: ${used.map((m) => `<button class="text-accent font-mono" data-path="${esc(m.file)}">${esc(m.file)}:${m.line}</button>`).join(', ')}</div>` : ''}</div>`;
    };
    return `<section class="card mb-4"><div class="p-3 border-b border-line"><div class="flex flex-wrap items-center gap-2"><h2 class="font-semibold">${esc(t.engine || '')} · ${esc(t.database || t.key)}</h2><span class="badge ${ENVC[t.environment] || ''}">${esc(t.environment || 'UNKNOWN')}</span><span class="badge">${esc(t.scope === 'local' ? 'local (mobile) DB' : 'backend DB')}</span><span class="badge">${esc(t.source || '')}</span></div>
      <p class="text-2xs text-muted mt-1">${esc(t.host || '')}${t.profile ? ' · profile ' + esc(t.profile) : ''} · ${fmt(t.counts?.tables || 0)} tables · ${fmt(t.counts?.procedures || 0)} procedures · ${fmt(t.counts?.views || 0)} views · ${fmt(t.counts?.functions || 0)} functions · discovered ${esc((t.lastDiscoveredAt || '').slice(0, 16).replace('T', ' '))}</p>
      ${(t.limitations || []).length ? `<details class="mt-1 text-2xs text-muted"><summary>${t.limitations.length} limitation(s)</summary><ul class="list-disc pl-5">${t.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>` : ''}</div>
      <div>${objs.length ? objs.map(row).join('') : '<div class="p-4 text-muted">No object matches the filter.</div>'}</div></section>`;
  }).join('');
  const ch = (I.changes || []).length ? `<section class="card p-4 mb-4"><h3 class="h-sec mb-2">Protected changes <span class="text-faint font-normal">(${I.changes.length})</span></h3>${I.changes.map((c) => `<div class="flex flex-wrap items-center gap-2 py-1 border-b border-line"><span class="font-mono text-xs">${esc(c.id)}</span><span class="badge ${ENVC[c.environment] || ''}">${esc(c.environment)}</span><span class="badge">${esc(c.stage)}</span><span class="text-muted truncate">${esc(c.migration || '')} (${esc(c.framework || '')}) → ${esc(c.target || '')}</span><span class="badge">risk ${esc(c.risk || '')}</span><span class="badge">backup ${esc(c.backup || '')}</span></div>`).join('')}</section>` : '';
  showPage(header('Database Intelligence', 'Schemas, stored procedures, dependencies and application usage from the knowledge store. Read-only; definitions and credentials are never shown here.', `<input id="dq" class="input sm:w-64" placeholder="Filter tables, columns, procedures…" value="${esc(route.params.get('q') || '')}" aria-label="Filter">`) + ch + cards);
  $('#dq').onchange = (e) => go('dbintel', '', e.target.value ? { q: e.target.value } : {});
  bindLinks(page());
}
function drawMobile() {
  const M = D.dbIntel?.mobile;
  if (!M) return showPage(header('Mobile', 'Android, Flutter and React Native architecture.') + empty('No mobile knowledge. Run <code>rmc mobile detect</code> in a mobile project, then rebuild the viewer.'));
  const items = (list, f) => (list || []).map(f).join('') || '<span class="text-muted">none</span>';
  const pill = (a) => `<div class="py-1 border-b border-line"><span class="font-medium">${esc(a.name)}</span> <span class="badge">${esc(a.status)}</span> <span class="badge">${esc(a.confidence)}</span>${a.note ? `<div class="text-2xs text-muted">${esc(a.note)}</div>` : ''}<div class="text-2xs font-mono text-muted">${(a.evidence || []).map((e) => `${esc(e.file)}${e.line ? ':' + e.line : ''}`).join(' · ')}</div></div>`;
  const d = M.data || {};
  showPage(header('Mobile', `${M.manifest.platforms.map(esc).join(', ')} · static analysis, no device data`) + `<div class="grid gap-4 lg:grid-cols-2">
    ${section('Architecture', items(M.architecture.architecture, pill), (M.architecture.architecture || []).length)}
    ${section('State management', items(M.state, pill), M.state.length)}
    ${section('Local persistence', items(d.local, pill), (d.local || []).length)}
    ${section('Remote API clients (not the local database)', items(d.remote, pill), (d.remote || []).length)}
    ${section('Caches / key-value', items(d.cache, pill), (d.cache || []).length)}
    ${section('Dependency chains', items((M.deps.chains || []).slice(0, 40), (c) => `<div class="py-1 border-b border-line font-mono text-xs">${esc(c)}</div>`), (M.deps.chains || []).length)}
    ${section('DAOs', items(d.daos, (x) => `<div class="py-1 border-b border-line"><button class="text-accent font-mono" data-path="${esc(x.file)}">${esc(x.name)}</button> <span class="text-2xs text-muted">${(x.queries || []).map((q) => esc(q.method)).join(', ')}</span></div>`), (d.daos || []).length)}
    ${section('Navigation', items(M.navigation.slice(0, 40), (n) => `<div class="py-1 border-b border-line text-xs"><span class="badge">${esc(n.kind)}</span> ${esc(n.destination)}</div>`), M.navigation.length)}
  </div>`);
  bindLinks(page());
}
function drawNotFound() { showPage(header('Not found') + empty('This view does not exist. <a href="#/overview">Go to the overview</a>.')); }

// ---------- details panel ----------
function closeDetails() { $('#detail').classList.add('hidden'); $('#detail').innerHTML = ''; detailId = null; if (G.mounted) { G.selected = -1; requestDraw(); } }
let detailId = null;
function showNode(id) {
  const i = IDX.get(id); if (i == null) return;
  const n = NODES[i]; detailId = id;
  const groups = new Map();
  for (const e of edgesOf(i)) { const outg = SRC[e] === i, k = (outg ? '' : '← ') + ETYPE[e] + (outg ? ' →' : ''); (groups.get(k) || groups.set(k, []).get(k)).push([outg ? DST[e] : SRC[e], e]); }
  const docs = DOCS.filter((d) => (d.nodes || []).includes(id));
  const hs = (D.handoffs || []).filter((h) => (h.nodes || []).includes(id));
  const attrs = Object.entries(n.attrs || {}).filter(([, v]) => v !== '' && v != null);
  const ev = (n.evidence || []).find((e) => e.file);
  const el = $('#detail');
  el.innerHTML = `<div class="sticky top-0 bg-panel z-10 px-4 pt-3 pb-2 border-b border-line"><div class="mx-auto w-10 h-1 rounded bg-line mb-2 md:hidden" aria-hidden="true"></div>
    <div class="flex items-start gap-2"><div class="min-w-0 flex-1"><div class="flex items-center gap-1.5 text-2xs text-muted">${layerDot(n.type)}<span class="capitalize">${esc(layerOf(n))}</span><span>·</span><span>${esc(n.type.replace(/_/g, ' '))}</span></div>
    <h2 class="font-semibold text-[15px] break-words mt-0.5" id="detail-title">${esc(n.name)}</h2></div><button class="btn-icon border-0" id="dclose" aria-label="Close details">${icon('x')}</button></div>
    <div class="flex flex-wrap gap-1.5 mt-2">${provBadge(n)}${n.origin ? `<span class="badge">${esc(n.origin)}</span>` : ''}</div></div>
   <div class="p-4 space-y-4">
    ${n.description ? `<p>${esc(n.description)}</p>` : ''}
    <div class="flex flex-wrap gap-1.5"><a class="btn no-underline hover:no-underline" href="${href('graph', G.mounted && G.preset ? G.preset : 'all', { focus: id })}">${icon('focus')}Focus in graph</a><a class="btn no-underline hover:no-underline" href="${href('graph', 'all', { focus: id, impact: 1 })}">${icon('zap')}Impact</a>${ev ? `<a class="btn no-underline hover:no-underline" href="${href('explorer', '', { p: ev.file })}">${icon('tree')}Open file</a>` : ''}</div>
    <dl class="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-[12.5px]"><dt class="text-muted">ID</dt><dd class="font-mono text-[12px] break-all">${esc(n.id)}</dd><dt class="text-muted">Module</dt><dd class="break-words">${esc(groupLabel(GROUP[i]))}</dd>${attrs.map(([k, v]) => `<dt class="text-muted break-words">${esc(k)}</dt><dd class="break-words">${esc(Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.name + (x.type ? ' ' + x.type : '') : x)).join(', ') : typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>
    <section><h3 class="h-sec mb-1.5">Evidence (${(n.evidence || []).length})</h3>${(n.evidence || []).map(evRow).join('') || '<p class="text-2xs text-muted">No source evidence recorded — treat as unverified.</p>'}</section>
    <section><h3 class="h-sec mb-1.5">Relationships (${IX.start[i + 1] - IX.start[i]})</h3>${[...groups].map(([k, xs]) => `<details class="mb-1" ${xs.length <= 12 ? 'open' : ''}><summary class="cursor-pointer text-2xs text-muted py-1 select-none">${esc(k)} <span class="text-faint">(${xs.length})</span></summary>${xs.slice(0, 50).map(([o, e]) => relLink(o, `<span class="badge b-${prov(EDGES[e])}">${PROV_LABEL[prov(EDGES[e])]}</span>`)).join('')}${xs.length > 50 ? `<div class="text-2xs text-muted px-2">+${xs.length - 50} more — use Focus in graph</div>` : ''}</details>`).join('') || '<p class="text-2xs text-muted">No relationships.</p>'}</section>
    ${docs.length ? `<section><h3 class="h-sec mb-1.5">Documents</h3>${docs.map(docRow).join('')}</section>` : ''}
    ${hs.length ? `<section><h3 class="h-sec mb-1.5">Hand-offs</h3>${hs.map((h) => `<a href="#/handoffs" class="block text-[12.5px] py-0.5">${esc(h.id)} · ${esc(h.from)} → ${esc(h.to)}</a>`).join('')}</section>` : ''}
   </div>`;
  el.classList.remove('hidden');
  el.scrollTop = 0;
  $('#dclose').onclick = () => { closeDetails(); const r = parseRoute(); if (r.params.has('n')) { r.params.delete('n'); history.replaceState(null, '', href(r.page, r.sub, Object.fromEntries(r.params))); } };
  bindLinks(el);
  if (G.mounted && !$('#graph').classList.contains('hidden')) { const m = G.modelIndex.get(id); G.selected = m ?? -1; requestDraw(); }
}
function bindLinks(root) {
  root.addEventListener('click', (e) => {
    const fp = e.target.closest('[data-path]');
    if (fp && root.contains(fp) && !fp.closest('#tree')) { e.preventDefault(); go('explorer', '', { p: fp.dataset.path }); return; }
    const b = e.target.closest('[data-node]');
    if (!b || !root.contains(b)) return;
    e.preventDefault();
    const id = b.dataset.node;
    if (!$('#graph').classList.contains('hidden') && G.modelIndex.has(id)) { selectInGraph(G.modelIndex.get(id), true); return; }
    showNode(id);
  });
}

// ======================================================================
// Graph
// ======================================================================
const ALL_TYPES = Object.values(LAYERS).flat();
const PRESETS = {
  project: { label: 'Project', desc: 'Top-level structure: modules, data stores, integrations and delivery infrastructure.', types: ['project', 'system', 'module', 'feature', 'database', 'integration', 'pipeline', 'deployment', 'environment', 'service', 'container'] },
  module: { label: 'Module', desc: 'Modules as clusters with aggregated relationships. Click a module to expand it.', types: [...LAYERS.system, ...LAYERS.engineering], cluster: 'always' },
  files: { label: 'File dependency', desc: 'Files, tests and packages linked by imports and tests.', types: ['file', 'test', 'dependency'], edges: ['depends_on', 'tested_by'] },
  calls: { label: 'Function call', desc: 'Functions and classes linked by import-resolved calls (inferred).', types: ['function', 'class', 'component'], edges: ['calls'], connectedOnly: true },
  api: { label: 'API', desc: 'Routes with their handlers, data access and integrations.', seed: ['api'], hops: 1, types: ['api', 'file', 'function', 'class', 'table', 'integration', 'requirement', 'feature', 'module'] },
  data: { label: 'Database', desc: 'Databases and tables with the code that reads and writes them.', seed: ['database', 'table', 'entity'], hops: 1, types: ['database', 'table', 'entity', 'api', 'function', 'file', 'module'] },
  infra: { label: 'Infrastructure', desc: 'Containers, services, networks, pipelines and environments.', types: [...LAYERS.infrastructure, 'integration', 'database'] },
  trace: { label: 'Traceability', desc: 'Requirements to implementation, tests and tasks.', seed: [...REQ_TYPES, 'use_case', 'user_story'], hops: 2, edges: ['implements', 'satisfies', 'tested_by', 'related_to', 'blocks', 'belongs_to'], types: ALL_TYPES },
  all: { label: 'Everything', desc: 'The whole knowledge graph. Large graphs start as module clusters.', types: ALL_TYPES, hide: ['function'] },
};
const CLUSTER_AT = 1200;
const G = { mounted: false, preset: null, hidden: new Set(), conf: new Set(['verified', 'inferred', 'manual']), focus: -1, depth: 1, hideUnrelated: true, path: null, impact: null, expanded: new Set(), clustered: null, list: false, selected: -1, pathFrom: -1, history: [], model: null, modelIndex: new Map(), x: null, y: null, cam: { x: 0, y: 0, k: 1 }, layoutReq: 0, layoutBusy: false };
const layoutCache = new Map();

function presetCount(p) {
  const P = PRESETS[p], types = new Set(P.types);
  if (P.seed) { const s = new Set(P.seed); return NODES.some((n) => s.has(n.type)) ? 1 : 0; }
  if (P.connectedOnly) return EDGES.some((e, k) => (!P.edges || P.edges.includes(e.type)) && types.has(NODES[SRC[k]].type) && types.has(NODES[DST[k]].type)) ? 1 : 0;
  return NODES.some((n) => types.has(n.type)) ? 1 : 0;
}

// Build the render model for the current graph state: nodes (or collapsed module clusters) and edges.
function buildModel() {
  const P = PRESETS[G.preset];
  const types = new Set(P.types), edgeOk = P.edges ? new Set(P.edges) : null;
  const okNode = (i) => !G.hidden.has(NODES[i].type) && G.conf.has(NODES[i].confidence || 'verified');
  let base;
  if (G.focus >= 0) {
    base = new Set([...neighborhood(IX, G.focus, G.depth).keys()].filter((i) => i === G.focus || okNode(i)));
    if (!G.hideUnrelated) for (let i = 0; i < NODES.length; i++) if (types.has(NODES[i].type) && okNode(i)) base.add(i);
  } else if (P.seed) {
    const seed = new Set(P.seed); base = new Set();
    let frontier = []; NODES.forEach((n, i) => { if (seed.has(n.type) && okNode(i)) { base.add(i); frontier.push(i); } });
    for (let h = 0; h < (P.hops || 0); h++) {
      const next = [];
      for (const v of frontier) for (let k = IX.start[v]; k < IX.start[v + 1]; k++) { const w = IX.adj[k], e = IX.adjEdge[k]; if (!base.has(w) && types.has(NODES[w].type) && okNode(w) && (!edgeOk || edgeOk.has(ETYPE[e]))) { base.add(w); next.push(w); } }
      frontier = next;
    }
  } else {
    base = new Set(); NODES.forEach((n, i) => { if (types.has(n.type) && okNode(i)) base.add(i); });
    if (P.connectedOnly) { const keep = new Set(); EDGES.forEach((e, k) => { if ((!edgeOk || edgeOk.has(e.type)) && base.has(SRC[k]) && base.has(DST[k]) && SRC[k] !== DST[k]) { keep.add(SRC[k]); keep.add(DST[k]); } }); base = keep; }
  }
  if (G.impact) for (const i of G.impact.keys()) base.add(i);
  if (G.path) for (const i of G.path.nodes) base.add(i);
  const items = [], src = [], dst = [], eref = [], weight = [];
  const modelIndex = new Map();
  const special = G.focus >= 0 || G.path || G.impact;
  const clustered = !special && (P.cluster === 'always' || (G.clustered ?? base.size > CLUSTER_AT)) && base.size > 0;
  const where = new Map(); // node index → model index
  if (clustered) {
    const clusterOf = new Map();
    for (const i of base) {
      const g = GROUP[i];
      if (G.expanded.has(g)) { where.set(i, items.length); modelIndex.set(NODES[i].id, items.length); items.push({ i, id: NODES[i].id, g }); continue; }
      if (!clusterOf.has(g)) { clusterOf.set(g, items.length); modelIndex.set('cluster:' + g, items.length); items.push({ i: -1, id: 'cluster:' + g, g, count: 0, layer: g.startsWith('layer:') ? g.slice(6) : 'system' }); }
      const m = clusterOf.get(g); items[m].count++; where.set(i, m);
      if (NODES[i].type === 'module') modelIndex.set(NODES[i].id, m);
    }
  } else for (const i of base) { where.set(i, items.length); modelIndex.set(NODES[i].id, items.length); items.push({ i, id: NODES[i].id, g: GROUP[i] }); }
  const agg = new Map();
  for (let e = 0; e < EDGES.length; e++) {
    const a = where.get(SRC[e]), b = where.get(DST[e]);
    if (a == null || b == null || a === b) continue;
    if (!G.conf.has(EDGES[e].confidence || 'verified')) continue;
    if (edgeOk && !special && !edgeOk.has(ETYPE[e])) continue;
    if (items[a].i >= 0 && items[b].i >= 0) { src.push(a); dst.push(b); eref.push(e); weight.push(1); continue; }
    const key = a < b ? a * 1048576 + b : b * 1048576 + a;
    if (agg.has(key)) weight[agg.get(key)]++;
    else { agg.set(key, src.length); src.push(a); dst.push(b); eref.push(-1); weight.push(1); }
  }
  const deg = new Int32Array(items.length); for (let k = 0; k < src.length; k++) { deg[src[k]]++; deg[dst[k]]++; }
  items.forEach((it, m) => {
    if (it.i >= 0) { const n = NODES[it.i]; it.type = n.type; it.layer = layerOf(n); it.label = shortName(n); it.r = 3.5 + Math.min(9, Math.sqrt(IX.deg[it.i]) * 1.5); }
    else { it.type = 'cluster'; it.label = groupLabel(it.g); it.r = 9 + Math.sqrt(it.count) * 2.2; }
    it.deg = deg[m];
  });
  return { items, src: Int32Array.from(src), dst: Int32Array.from(dst), eref, weight, modelIndex, clustered, key: `${G.preset}|${G.focus}|${G.depth}|${G.hideUnrelated}|${[...G.expanded].sort()}|${[...G.hidden].sort()}|${[...G.conf].sort()}|${G.path ? G.path.nodes.join(',') : ''}|${G.impact ? G.impact.size : ''}|${clustered}|${items.length}` };
}

// ---------- layout (Web Worker with synchronous fallback, cached per view) ----------
let worker = null, workerFailed = false, pendingLayout = null;
const WORKER_AT = 400; // smaller graphs lay out in a few milliseconds on the main thread
function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    const src = `${layout.toString()}\nonmessage = (e) => { const r = layout(e.data.g, e.data.init); postMessage({ id: e.data.id, x: r.x, y: r.y, iterations: r.iterations }, [r.x.buffer, r.y.buffer]); };`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    // Some browsers refuse blob workers on file:// asynchronously: fall back to the synchronous layout for the pending request.
    worker.onerror = (e) => { e.preventDefault?.(); workerFailed = true; worker = null; G.layoutBusy = false; if (pendingLayout) { const M = pendingLayout; pendingLayout = null; runLayout(M, true); } };
  } catch { workerFailed = true; worker = null; }
  return worker;
}
function layoutInput(M) {
  const n = M.items.length, seeds = new Float64Array(n), group = new Int32Array(n), size = new Float32Array(n), gk = new Map();
  M.items.forEach((it, m) => { seeds[m] = hashStr(it.id); if (!gk.has(it.g)) gk.set(it.g, gk.size); group[m] = gk.get(it.g); size[m] = it.r; });
  return { n, src: M.src, dst: M.dst, seeds, group, size };
}
function cachedPositions(M) {
  const mem = layoutCache.get(M.key);
  if (mem) return { exact: true, ...mem };
  const disk = store.get('layout:' + M.key, null);
  if (disk && disk.n === M.items.length) { const x = Float32Array.from(disk.x), y = Float32Array.from(disk.y); layoutCache.set(M.key, { x, y }); return { exact: true, x, y }; }
  // Warm start from any position we already know (previous model of this session).
  if (G.x && G.model) {
    const x = new Float32Array(M.items.length).fill(NaN), y = new Float32Array(M.items.length).fill(NaN); let known = 0;
    M.items.forEach((it, m) => { const o = G.model.modelIndex.get(it.id); if (o != null && G.model.items[o]?.id === it.id) { x[m] = G.x[o]; y[m] = G.y[o]; known++; } });
    if (known > M.items.length * 0.5) return { exact: false, x, y };
  }
  return null;
}
function saveLayout(M, x, y) {
  layoutCache.set(M.key, { x, y });
  if (M.items.length <= 20000) store.set('layout:' + M.key, { n: M.items.length, x: Array.from(x, Math.round), y: Array.from(y, Math.round) });
}
function runLayout(M, sync) {
  const req = ++G.layoutReq;
  const cached = cachedPositions(M);
  if (cached && cached.exact) return applyLayout(M, cached.x, cached.y, 0, 'cache');
  const input = layoutInput(M), init = cached ? { x: cached.x, y: cached.y } : null;
  const w = !sync && M.items.length >= WORKER_AT && getWorker();
  const t0 = performance.now();
  if (w) {
    G.layoutBusy = true; pendingLayout = M; status(`Laying out ${fmt(M.items.length)} nodes…`);
    w.onmessage = (e) => { if (e.data.id !== req) return; G.layoutBusy = false; pendingLayout = null; saveLayout(M, e.data.x, e.data.y); applyLayout(M, e.data.x, e.data.y, performance.now() - t0, 'worker'); };
    w.postMessage({ id: req, g: input, init });
    // Placeholder positions until the worker answers, so the view is never empty.
    if (!G.x || G.model !== M) { const r = layout(input, init, { iterations: 0 }); setPositions(M, r.x, r.y); fit(); }
    return null;
  }
  const r = layout(input, init);
  saveLayout(M, r.x, r.y);
  return applyLayout(M, r.x, r.y, performance.now() - t0, 'sync', r.iterations);
}
function setPositions(M, x, y) { G.model = M; G.modelIndex = M.modelIndex; G.x = x; G.y = y; buildHitGrid(); requestDraw(); }
function applyLayout(M, x, y, ms, how, iterations) {
  const first = G.model !== M;
  setPositions(M, x, y);
  if (first || how !== 'cache') fit();
  status(`${fmt(M.items.length)} ${M.clustered ? 'nodes & clusters' : 'nodes'} · ${fmt(M.src.length)} relationships${how === 'cache' ? ' · cached layout' : ` · layout ${Math.round(ms)} ms (${how})`}`);
  G.lastLayout = { ms, how, iterations };
  return G.lastLayout;
}

// ---------- rendering ----------
let cv, ctx, W = 0, H = 0, DPR = 1, raf = 0, COLORS = {};
const SQUARE = new Set(['file', 'test', 'table', 'container']), DIAMOND = new Set(LAYERS.project);
function readColors() {
  const cs = getComputedStyle(document.documentElement), c = (v) => `rgb(${cs.getPropertyValue('--' + v).trim()})`;
  COLORS = { fg: c('fg'), muted: c('muted'), faint: c('faint'), line: c('line'), panel: c('panel'), accent: c('accent'), danger: c('danger'), warn: c('warn'), ok: c('ok') };
  for (const l of Object.keys(LAYERS)) COLORS['l-' + l] = c('l-' + l);
  COLORS['l-unknown'] = COLORS.faint;
}
const requestDraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
function highlightSet() {
  const M = G.model; if (!M) return null;
  if (G.path) { const s = new Set(); for (const i of G.path.nodes) { const m = M.modelIndex.get(NODES[i].id); if (m != null) s.add(m); } return s; }
  if (G.impact) { const s = new Set(); for (const i of G.impact.keys()) { const m = M.modelIndex.get(NODES[i].id); if (m != null) s.add(m); } return s; }
  if (G.selected >= 0) { const s = new Set([G.selected]); for (let k = 0; k < M.src.length; k++) { if (M.src[k] === G.selected) s.add(M.dst[k]); else if (M.dst[k] === G.selected) s.add(M.src[k]); } return s; }
  return null;
}
function draw() {
  if (!G.model || !ctx || G.list) return;
  const t0 = performance.now();
  const M = G.model, X = G.x, Y = G.y, cam = G.cam, k = cam.k, items = M.items;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.translate(W / 2 + cam.x, H / 2 + cam.y); ctx.scale(k, k);
  const x0 = (-W / 2 - cam.x) / k - 20, x1 = (W / 2 - cam.x) / k + 20, y0 = (-H / 2 - cam.y) / k - 20, y1 = (H / 2 - cam.y) / k + 20;
  const inView = (m) => X[m] >= x0 && X[m] <= x1 && Y[m] >= y0 && Y[m] <= y1;
  const hl = highlightSet();
  const pathEdges = G.path ? new Set(G.path.edges) : null;
  // Edges: batched into a few paths by style; culled when the segment's box misses the viewport.
  const batches = { verified: new Path2D(), inferred: new Path2D(), manual: new Path2D(), agg: new Path2D(), hl: new Path2D(), stale: new Path2D() };
  const arrows = [];
  let drawnEdges = 0;
  for (let e = 0; e < M.src.length; e++) {
    const a = M.src[e], b = M.dst[e];
    if (Math.max(X[a], X[b]) < x0 || Math.min(X[a], X[b]) > x1 || Math.max(Y[a], Y[b]) < y0 || Math.min(Y[a], Y[b]) > y1) continue;
    const ref = M.eref[e], E = ref >= 0 ? EDGES[ref] : null;
    const on = hl && hl.has(a) && hl.has(b) && (pathEdges ? pathEdges.has(ref) : G.impact ? true : a === G.selected || b === G.selected);
    const p = on ? batches.hl : E && E.stale ? batches.stale : !E ? batches.agg : batches[E.confidence] || batches.verified;
    p.moveTo(X[a], X[b] === X[a] && Y[b] === Y[a] ? Y[a] : Y[a]); p.lineTo(X[b], Y[b]);
    if (on && E) arrows.push(e);
    drawnEdges++;
  }
  ctx.lineWidth = 1 / k;
  const dim = hl ? 0.07 : 0.32;
  const stroke = (p, color, alpha, dash, width) => { ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.setLineDash(dash); if (width) ctx.lineWidth = width / k; ctx.stroke(p); };
  stroke(batches.verified, COLORS.faint, dim, []);
  stroke(batches.inferred, COLORS.faint, dim, [4 / k, 3 / k]);
  stroke(batches.manual, COLORS.faint, dim, [1 / k, 3 / k]);
  stroke(batches.agg, COLORS.faint, hl ? 0.1 : 0.45, [], 1.5);
  stroke(batches.stale, COLORS.danger, hl ? 0.15 : 0.6, [], 1);
  stroke(batches.hl, COLORS.accent, 0.95, [], 1.6);
  ctx.setLineDash([]);
  if (arrows.length && arrows.length < 600) {
    ctx.fillStyle = COLORS.accent; ctx.globalAlpha = 0.95; const ap = new Path2D();
    for (const e of arrows) { const a = M.src[e], b = M.dst[e], ang = Math.atan2(Y[b] - Y[a], X[b] - X[a]), r = items[b].r + 2, s = 6 / Math.max(0.6, k); const tx = X[b] - Math.cos(ang) * r, ty = Y[b] - Math.sin(ang) * r; ap.moveTo(tx, ty); ap.lineTo(tx - Math.cos(ang - 0.45) * s, ty - Math.sin(ang - 0.45) * s); ap.lineTo(tx - Math.cos(ang + 0.45) * s, ty - Math.sin(ang + 0.45) * s); ap.closePath(); }
    ctx.fill(ap);
  }
  // Nodes: one path per (colour, dimmed) bucket.
  const buckets = new Map();
  let drawnNodes = 0;
  const visible = [];
  for (let m = 0; m < items.length; m++) {
    if (!inView(m)) continue;
    const it = items[m], key = it.layer + (hl && !hl.has(m) ? '|d' : '') + (it.i < 0 ? '|c' : '');
    let p = buckets.get(key); if (!p) buckets.set(key, (p = new Path2D()));
    const x = X[m], y = Y[m], r = it.r;
    if (it.i < 0 || !(SQUARE.has(it.type) || DIAMOND.has(it.type))) { p.moveTo(x + r, y); p.arc(x, y, r, 0, Math.PI * 2); }
    else if (SQUARE.has(it.type)) p.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
    else { p.moveTo(x, y - r); p.lineTo(x + r, y); p.lineTo(x, y + r); p.lineTo(x - r, y); p.closePath(); }
    visible.push(m); drawnNodes++;
  }
  for (const [key, p] of buckets) {
    const [layer] = key.split('|'), dimmed = key.includes('|d'), cluster = key.includes('|c');
    ctx.fillStyle = COLORS['l-' + layer] || COLORS.faint;
    ctx.globalAlpha = dimmed ? 0.13 : cluster ? 0.28 : 1; ctx.fill(p);
    if (cluster) { ctx.globalAlpha = dimmed ? 0.2 : 0.9; ctx.strokeStyle = COLORS['l-' + layer] || COLORS.faint; ctx.lineWidth = 1.5 / k; ctx.stroke(p); }
  }
  ctx.globalAlpha = 1;
  // Selection and stale rings.
  for (const m of visible) {
    const it = items[m], n = it.i >= 0 ? NODES[it.i] : null;
    if (m === G.selected || m === G.pathFrom) { ctx.beginPath(); ctx.arc(X[m], Y[m], it.r + 3 / k, 0, Math.PI * 2); ctx.strokeStyle = m === G.pathFrom ? COLORS.warn : COLORS.fg; ctx.lineWidth = 2.2 / k; ctx.stroke(); }
    else if (n && n.stale) { ctx.beginPath(); ctx.arc(X[m], Y[m], it.r + 1.5 / k, 0, Math.PI * 2); ctx.strokeStyle = COLORS.danger; ctx.lineWidth = 1.5 / k; ctx.stroke(); }
  }
  // Labels: important or zoomed-in nodes only, capped per frame.
  ctx.font = `${11.5 / k}px Inter, "Segoe UI", system-ui, sans-serif`; ctx.textBaseline = 'middle';
  let labels = 0;
  const all = visible.length < 90;
  const ranked = visible.length > 400 ? visible.slice().sort((a, b) => items[b].r - items[a].r) : visible;
  for (const m of ranked) {
    if (labels > 350) break;
    const it = items[m];
    const important = it.i < 0 || m === G.selected || (hl && hl.has(m) && hl.size < 80) || it.r * k > 9 || (k > 1.4 && it.r * k > 5);
    if (!(all || important) || (hl && !hl.has(m) && it.i >= 0)) continue;
    const text = (it.i < 0 ? `${it.label} (${fmt(it.count)})` : it.label).slice(0, 42);
    ctx.lineWidth = 3 / k; ctx.strokeStyle = COLORS.panel; ctx.globalAlpha = 0.9; ctx.strokeText(text, X[m] + it.r + 3 / k, Y[m]);
    ctx.globalAlpha = 1; ctx.fillStyle = it.i < 0 ? COLORS.fg : COLORS.fg; ctx.fillText(text, X[m] + it.r + 3 / k, Y[m]);
    labels++;
  }
  G.lastDraw = { ms: performance.now() - t0, nodes: drawnNodes, edges: drawnEdges, labels };
}
// Spatial hash for O(1) hit testing.
let HIT = null;
function buildHitGrid() {
  const M = G.model, C = 40, grid = new Map();
  for (let m = 0; m < M.items.length; m++) { const key = Math.floor(G.x[m] / C) + ',' + Math.floor(G.y[m] / C); (grid.get(key) || grid.set(key, []).get(key)).push(m); }
  HIT = { C, grid, maxR: Math.max(10, ...M.items.slice(0, 5000).map((it) => it.r)) };
}
function hitTest(px, py) {
  if (!HIT || !G.model) return -1;
  const { C, grid } = HIT, k = G.cam.k, reach = Math.ceil((HIT.maxR + 6 / k) / C);
  const cx = Math.floor(px / C), cy = Math.floor(py / C);
  let best = -1, bd = Infinity;
  for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) for (const m of grid.get(cx + i + ',' + (cy + j)) || []) {
    const d = (G.x[m] - px) ** 2 + (G.y[m] - py) ** 2, r = G.model.items[m].r + 5 / k;
    if (d < r * r && d < bd) { best = m; bd = d; }
  }
  return best;
}
function resize() { if (!cv) return; const r = cv.getBoundingClientRect(); DPR = window.devicePixelRatio || 1; W = r.width; H = r.height; cv.width = Math.max(1, W * DPR); cv.height = Math.max(1, H * DPR); requestDraw(); }
function fit() {
  const M = G.model; if (!M || !M.items.length || !W) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let m = 0; m < M.items.length; m++) { minX = Math.min(minX, G.x[m]); maxX = Math.max(maxX, G.x[m]); minY = Math.min(minY, G.y[m]); maxY = Math.max(maxY, G.y[m]); }
  const k = Math.max(0.03, Math.min(2.2, Math.min((W - 60) / (maxX - minX + 40 || 1), (H - 60) / (maxY - minY + 40 || 1))));
  G.cam = { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k };
  requestDraw();
}
function zoomBy(f, sx = W / 2, sy = H / 2) { const c = G.cam, wx = (sx - W / 2 - c.x) / c.k, wy = (sy - H / 2 - c.y) / c.k, k = Math.max(0.02, Math.min(8, c.k * f)); c.x -= wx * (k - c.k); c.y -= wy * (k - c.k); c.k = k; requestDraw(); }
function centerOn(m, minK = 1.1) { const c = G.cam; c.k = Math.max(c.k, minK); c.x = -G.x[m] * c.k; c.y = -G.y[m] * c.k; requestDraw(); }
const toWorld = (cx, cy) => { const r = cv.getBoundingClientRect(); return [(cx - r.left - W / 2 - G.cam.x) / G.cam.k, (cy - r.top - H / 2 - G.cam.y) / G.cam.k]; };

// ---------- graph state transitions ----------
const snapshot = () => ({ preset: G.preset, focus: G.focus, depth: G.depth, path: G.path, impact: G.impact, expanded: new Set(G.expanded), selected: G.model && G.selected >= 0 ? G.model.items[G.selected].id : null, clustered: G.clustered });
function pushHistory() { G.history.push(snapshot()); if (G.history.length > 30) G.history.shift(); }
function restore(s) { Object.assign(G, { preset: s.preset, focus: s.focus, depth: s.depth, path: s.path, impact: s.impact, expanded: new Set(s.expanded), clustered: s.clustered }); rebuild(); if (s.selected && G.modelIndex.has(s.selected)) selectInGraph(G.modelIndex.get(s.selected)); }
function rebuild(sync) {
  const M = buildModel();
  G.selected = -1; G.pathFrom = -1;
  if (G.list) { G.model = M; G.modelIndex = M.modelIndex; drawGraphList(); }
  else runLayout(M, sync);
  drawGraphChrome(); // after the model exists, so model-dependent controls render
}
function selectInGraph(m, center) {
  const M = G.model; if (!M || m < 0) return;
  const it = M.items[m];
  if (G.pathFrom >= 0 && it.i >= 0) {
    const from = M.items[G.pathFrom].i, res = shortestPath(IX, from, it.i);
    G.pathFrom = -1;
    if (!res) { status(`No path between ${NODES[from].name} and ${NODES[it.i].name}.`); requestDraw(); return; }
    pushHistory(); G.path = res; G.impact = null; rebuild();
    showPathPanel(); return;
  }
  if (it.i < 0) { pushHistory(); G.expanded.add(it.g); rebuild(); const mi = G.modelIndex.get(it.g); if (mi != null) { G.selected = mi; showNode(it.g); } return; }
  G.selected = m;
  if (center) centerOn(m);
  showNode(it.id);
  requestDraw();
  drawGraphChrome();
}
function showPathPanel() {
  const p = G.path; if (!p) return;
  const el = $('#detail');
  el.innerHTML = `<div class="sticky top-0 bg-panel px-4 pt-3 pb-2 border-b border-line flex items-start gap-2"><div class="flex-1"><div class="text-2xs text-muted">Path · ${p.edges.length} step(s)</div><h2 class="font-semibold text-[15px]">${esc(NODES[p.nodes[0]].name)} → ${esc(NODES[p.nodes.at(-1)].name)}</h2></div><button class="btn-icon border-0" id="dclose" aria-label="Close">${icon('x')}</button></div>
   <ol class="p-4 space-y-1">${p.nodes.map((i, k) => `<li>${relLink(i)}${k < p.edges.length ? `<div class="pl-8 text-2xs text-muted py-0.5">${SRC[p.edges[k]] === i ? '' : '← '}${esc(ETYPE[p.edges[k]])}${SRC[p.edges[k]] === i ? ' →' : ''} <span class="badge b-${prov(EDGES[p.edges[k]])}">${PROV_LABEL[prov(EDGES[p.edges[k]])]}</span></div>` : ''}</li>`).join('')}</ol>`;
  el.classList.remove('hidden'); bindLinks(el); $('#dclose').onclick = closeDetails;
}
const status = (t) => { const s = $('#gstatus'); if (s) s.textContent = t; };

function mountGraph() {
  if (G.mounted) return;
  G.mounted = true;
  const el = $('#graph');
  el.innerHTML = `<div class="flex flex-col h-full">
    <div class="border-b border-line bg-panel px-3 py-2 space-y-2">
      <div class="flex items-center gap-2 overflow-x-auto pb-0.5" role="tablist" aria-label="Graph views" id="gpresets"></div>
      <div class="flex flex-wrap items-center gap-1.5" id="gtools"></div>
      <nav class="flex flex-wrap items-center gap-1 text-2xs text-muted min-h-[18px]" aria-label="Graph history" id="gcrumbs"></nav>
    </div>
    <div class="relative flex-1 min-h-0">
      <canvas id="cv" class="block w-full h-full touch-none cursor-grab outline-none" tabindex="0" aria-label="Knowledge graph canvas. Use the list view for an accessible alternative." role="img"></canvas>
      <div id="glist" class="absolute inset-0 overflow-auto bg-bg hidden"></div>
      <div id="gtip" class="pointer-events-none absolute z-10 hidden card px-2 py-1 text-2xs shadow-lg max-w-xs"></div>
      <div id="glegend" class="absolute left-2 bottom-2 card p-2 max-w-[calc(100%-1rem)] max-h-[40%] overflow-auto text-2xs"></div>
      <div id="gstatus" class="absolute right-2 bottom-2 text-2xs text-muted bg-panel/90 px-2 py-1 rounded border border-line hidden sm:block" aria-live="polite"></div>
    </div></div>`;
  cv = $('#cv'); ctx = cv.getContext('2d');
  readColors();
  new ResizeObserver(() => { const had = W; resize(); if (!had && G.model) fit(); }).observe(cv);
  // Pointer: drag to pan, pinch to zoom, tap to select, double-tap to focus.
  const pts = new Map(); let downAt = null, moved = false, pinch = 0, lastTap = 0;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); downAt = [e.clientX, e.clientY, G.cam.x, G.cam.y]; moved = false; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } cv.classList.add('cursor-grabbing'); });
  cv.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) { const [wx, wy] = toWorld(e.clientX, e.clientY), m = hitTest(wx, wy), tip = $('#gtip'); if (m >= 0) { const it = G.model.items[m]; tip.innerHTML = `<b>${esc(it.i < 0 ? it.label : NODES[it.i].name)}</b> <span class="text-muted">${it.i < 0 ? `${fmt(it.count)} items · click to expand` : esc(it.type)}</span>`; const r = cv.getBoundingClientRect(); tip.style.left = Math.min(e.clientX - r.left + 12, W - 200) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px'; tip.classList.remove('hidden'); cv.style.cursor = 'pointer'; } else { tip.classList.add('hidden'); cv.style.cursor = ''; } return; }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) { const r = cv.getBoundingClientRect(); zoomBy(d / pinch, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top); } pinch = d; moved = true; return; }
    if (!downAt) return;
    const dx = e.clientX - downAt[0], dy = e.clientY - downAt[1];
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (moved) { G.cam.x = downAt[2] + dx; G.cam.y = downAt[3] + dy; requestDraw(); }
  });
  const up = (e) => {
    pts.delete(e.pointerId); cv.classList.remove('cursor-grabbing');
    if (pts.size) { pinch = 0; return; }
    if (!moved && downAt && e.type === 'pointerup') {
      const [wx, wy] = toWorld(e.clientX, e.clientY), m = hitTest(wx, wy), now = performance.now();
      if (m >= 0 && now - lastTap < 350 && G.selected === m && G.model.items[m].i >= 0) focusOn(G.model.items[m].i);
      else if (m >= 0) selectInGraph(m);
      else { if (G.pathFrom >= 0) { G.pathFrom = -1; drawGraphChrome(); } closeDetails(); }
      lastTap = now;
    }
    downAt = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => $('#gtip').classList.add('hidden'));
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  cv.addEventListener('keydown', (e) => {
    const step = 60;
    const keys = { '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(0.8), '0': fit, ArrowLeft: () => { G.cam.x += step; requestDraw(); }, ArrowRight: () => { G.cam.x -= step; requestDraw(); }, ArrowUp: () => { G.cam.y += step; requestDraw(); }, ArrowDown: () => { G.cam.y -= step; requestDraw(); }, f: () => G.selected >= 0 && G.model.items[G.selected].i >= 0 && focusOn(G.model.items[G.selected].i), Backspace: back };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });
}
function focusOn(i, opts = {}) { pushHistory(); G.focus = i; G.path = null; G.impact = opts.impact ? impactOf(IX, ETYPE, D.propagation, i, 4, (w) => NODES[w].type === 'project') : null; rebuild(); const m = G.modelIndex.get(NODES[i].id); if (m != null) { G.selected = m; showNode(NODES[i].id); requestDraw(); } drawGraphChrome(); }
function back() { const s = G.history.pop(); if (s) restore(s); drawGraphChrome(); }
function resetGraph() { pushHistory(); Object.assign(G, { focus: -1, path: null, impact: null, expanded: new Set(), clustered: null, hidden: new Set(PRESETS[G.preset].hide || []), conf: new Set(['verified', 'inferred', 'manual']), pathFrom: -1 }); closeDetails(); rebuild(); }

function drawGraphChrome() {
  const P = PRESETS[G.preset], M = G.model;
  $('#gpresets').innerHTML = Object.entries(PRESETS).filter(([k]) => presetCount(k)).map(([k, p]) => `<a href="#/graph/${k}" role="tab" aria-selected="${k === G.preset}" class="shrink-0 px-2.5 h-7 inline-flex items-center rounded-md no-underline hover:no-underline text-[12px] ${k === G.preset ? 'bg-accent-soft text-accent font-semibold' : 'text-muted hover:bg-hover hover:text-fg'}">${p.label}</a>`).join('');
  const sel = M && G.selected >= 0 ? M.items[G.selected] : null;
  const typesHere = [...new Set(P.types)].filter((t) => NODES.some((n) => n.type === t));
  $('#gtools').innerHTML = `
    <div class="relative"><input id="gq" class="input h-8 w-44 sm:w-56" placeholder="Find in graph…" aria-label="Find in graph" autocomplete="off"><div id="gqres" class="absolute z-20 mt-1 w-72 max-w-[80vw] card shadow-xl hidden max-h-72 overflow-auto"></div></div>
    <button class="btn-icon" data-act="back" title="Back (Backspace)" aria-label="Back" ${G.history.length ? '' : 'disabled'}>${icon('back')}</button>
    <button class="btn-icon" data-act="zin" title="Zoom in (+)" aria-label="Zoom in">${icon('zoomIn')}</button>
    <button class="btn-icon" data-act="zout" title="Zoom out (−)" aria-label="Zoom out">${icon('zoomOut')}</button>
    <button class="btn-icon" data-act="fit" title="Fit (0)" aria-label="Fit to screen">${icon('fit')}</button>
    <button class="btn-icon" data-act="reset" title="Reset view" aria-label="Reset view">${icon('reset')}</button>
    <span class="w-px h-5 bg-line mx-0.5"></span>
    <button class="btn" data-act="focus" ${sel && sel.i >= 0 ? '' : 'disabled'} title="Show only the selected node's neighbourhood (F)">${icon('focus')}Focus</button>
    <select class="input h-8 w-auto pr-6" data-act="depth" aria-label="Neighbourhood depth" ${G.focus >= 0 ? '' : 'disabled'}>${[1, 2, 3].map((d) => `<option value="${d}" ${G.depth === d ? 'selected' : ''}>${d} hop${d > 1 ? 's' : ''}</option>`).join('')}</select>
    <button class="btn ${G.hideUnrelated ? 'on' : ''}" data-act="unrelated" aria-pressed="${G.hideUnrelated}" ${G.focus >= 0 ? '' : 'disabled'} title="Hide nodes outside the focused neighbourhood">${icon('eyeOff')}Hide unrelated</button>
    <button class="btn ${G.pathFrom >= 0 ? 'on' : ''}" data-act="path" ${sel && sel.i >= 0 ? '' : 'disabled'} title="Trace the shortest path from the selected node to another">${icon('route')}${G.pathFrom >= 0 ? 'Pick target…' : 'Trace path'}</button>
    <button class="btn" data-act="impact" ${sel && sel.i >= 0 ? '' : 'disabled'} title="Change impact (same rules as rmc impact)">${icon('zap')}Impact</button>
    ${M && (M.clustered || G.expanded.size) && P.cluster !== 'always' ? `<button class="btn" data-act="cluster" title="${M.clustered ? 'Render every node' : 'Group by module'}">${icon('expand')}${M.clustered ? 'Show all nodes' : 'Group by module'}</button>` : ''}
    ${G.expanded.size ? `<button class="btn" data-act="collapse">Collapse modules</button>` : ''}
    <span class="w-px h-5 bg-line mx-0.5"></span>
    <button class="btn ${G.list ? 'on' : ''}" data-act="list" aria-pressed="${G.list}" title="Accessible list of the visible graph">${icon('list')}List</button>`;
  const crumbs = [`<button class="hover:text-fg" data-crumb="-1">${esc(P.label)}</button>`];
  G.history.slice(-4).forEach((h, k, arr) => void 0);
  if (G.expanded.size) crumbs.push(`<span>${icon('right', 'w-3 h-3 inline')}</span><span>expanded: ${[...G.expanded].slice(0, 3).map((g) => esc(groupLabel(g))).join(', ')}${G.expanded.size > 3 ? '…' : ''}</span>`);
  if (G.focus >= 0) crumbs.push(`<span>${icon('right', 'w-3 h-3 inline')}</span><span>focus: <b class="text-fg">${esc(shortName(NODES[G.focus]))}</b> (${G.depth} hop${G.depth > 1 ? 's' : ''})</span>`);
  if (G.impact) crumbs.push(`<span>${icon('right', 'w-3 h-3 inline')}</span><span class="text-accent">impact: ${G.impact.size - 1} affected</span>`);
  if (G.path) crumbs.push(`<span>${icon('right', 'w-3 h-3 inline')}</span><span class="text-accent">path: ${esc(shortName(NODES[G.path.nodes[0]]))} → ${esc(shortName(NODES[G.path.nodes.at(-1)]))} (${G.path.edges.length})</span>`);
  if (G.pathFrom >= 0) crumbs.push(`<span class="text-warn ml-2">Select the target node for the path, or click empty space to cancel.</span>`);
  $('#gcrumbs').innerHTML = `<span class="text-faint mr-1">${esc(P.desc)}</span>` + (crumbs.length > 1 || G.history.length ? ' · ' + crumbs.join(' ') : '');
  $$('#gtools [data-act]').forEach((b) => {
    const act = b.dataset.act;
    if (b.tagName === 'SELECT') b.onchange = () => { pushHistory(); G.depth = +b.value; rebuild(); };
    else b.onclick = () => ({
      back, zin: () => zoomBy(1.3), zout: () => zoomBy(0.77), fit, reset: resetGraph,
      focus: () => focusOn(sel.i), unrelated: () => { G.hideUnrelated = !G.hideUnrelated; rebuild(); },
      path: () => { G.pathFrom = G.pathFrom >= 0 ? -1 : G.selected; drawGraphChrome(); requestDraw(); },
      impact: () => focusOn(sel.i, { impact: true }),
      cluster: () => { pushHistory(); G.clustered = !M.clustered; G.expanded = new Set(); rebuild(); },
      collapse: () => { pushHistory(); G.expanded = new Set(); rebuild(); },
      list: () => { G.list = !G.list; $('#glist').classList.toggle('hidden', !G.list); if (G.list) drawGraphList(); else { if (!G.x || G.x.length !== G.model.items.length) runLayout(G.model); requestDraw(); } drawGraphChrome(); },
    }[act]());
  });
  $$('[data-crumb]', $('#gcrumbs')).forEach((b) => (b.onclick = () => { if (G.focus >= 0 || G.path || G.impact || G.expanded.size) { pushHistory(); G.focus = -1; G.path = null; G.impact = null; G.expanded = new Set(); rebuild(); } }));
  // Find in graph (indexed search, debounced).
  const gq = $('#gq'), gr = $('#gqres');
  gq.oninput = debounce(() => {
    const v = gq.value.trim(); if (!v) { gr.classList.add('hidden'); return; }
    const hits = search(SX, v, 40).map((k) => SEARCH_ITEMS[k]).filter((h) => h.kind === 'node').slice(0, 12);
    gr.innerHTML = hits.length ? hits.map((h) => { const n = NODES[h.i], inModel = G.modelIndex.has(n.id); return `<button class="row" data-gid="${esc(n.id)}">${layerDot(n.type)}<span class="truncate flex-1">${esc(shortName(n))}</span><span class="text-2xs ${inModel ? 'text-faint' : 'text-warn'}">${inModel ? esc(n.type) : 'focus'}</span></button>`; }).join('') : '<div class="px-3 py-2 text-muted">No matches</div>';
    gr.classList.remove('hidden');
  }, 120);
  gq.onkeydown = (e) => { if (e.key === 'Enter') { const b = $('[data-gid]', gr); if (b) b.click(); } if (e.key === 'Escape') gr.classList.add('hidden'); if (e.key === 'ArrowDown') { e.preventDefault(); $('[data-gid]', gr)?.focus(); } };
  gr.onkeydown = (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const bs = $$('[data-gid]', gr), k = bs.indexOf(document.activeElement); bs[Math.max(0, Math.min(bs.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus(); } };
  gr.onclick = (e) => { const b = e.target.closest('[data-gid]'); if (!b) return; gr.classList.add('hidden'); gq.value = ''; const id = b.dataset.gid; if (G.modelIndex.has(id) && G.model.items[G.modelIndex.get(id)].id === id) selectInGraph(G.modelIndex.get(id), true); else focusOn(IDX.get(id)); };
  // Legend: type filters and confidence filters.
  const legendOpen = $('#glegend details') ? $('#glegend details').open : innerWidth >= 768;
  $('#glegend').innerHTML = `<details ${legendOpen ? 'open' : ''}><summary class="cursor-pointer select-none text-muted font-semibold mb-1">Legend & filters</summary><div class="flex flex-wrap gap-1 max-w-[560px]">${typesHere.map((t) => `<button class="chip ${G.hidden.has(t) ? 'off' : ''}" data-type="${t}" aria-pressed="${!G.hidden.has(t)}">${layerDot(t)}${esc(t.replace(/_/g, ' '))} <span class="text-faint">${fmt(typeCount([t]))}</span></button>`).join('')}</div>
    <div class="flex flex-wrap items-center gap-1 mt-1.5">${['verified', 'inferred', 'manual'].map((c) => `<button class="chip ${G.conf.has(c) ? '' : 'off'}" data-conf="${c}" aria-pressed="${G.conf.has(c)}"><svg width="18" height="6" aria-hidden="true"><line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" ${c === 'inferred' ? 'stroke-dasharray="4 3"' : c === 'manual' ? 'stroke-dasharray="1 3"' : ''}/></svg>${c === 'verified' ? 'extracted' : c}</button>`).join('')}<span class="text-faint ml-1">● node ■ file/table ◆ delivery ◯ module cluster · red = stale</span></div></details>`;
  $$('[data-type]', $('#glegend')).forEach((b) => (b.onclick = () => { const t = b.dataset.type; G.hidden.has(t) ? G.hidden.delete(t) : G.hidden.add(t); rebuild(); }));
  $$('[data-conf]', $('#glegend')).forEach((b) => (b.onclick = () => { const c = b.dataset.conf; G.conf.has(c) ? G.conf.delete(c) : G.conf.add(c); rebuild(); }));
}
function drawGraphList() {
  const M = G.model, el = $('#glist');
  const order = M.items.map((_, m) => m).sort((a, b) => M.items[b].deg - M.items[a].deg);
  el.innerHTML = `<div class="px-4 pt-3 pb-2 text-2xs text-muted">${fmt(M.items.length)} items · ${fmt(M.src.length)} relationships in this view, most connected first. Select an item for its relationships.</div><div id="glv" class="h-[calc(100%-36px)] overflow-auto"></div>`;
  vlist($('#glv'), order.length, 34, (k) => { const m = order[k], it = M.items[m]; return `<button class="row h-[34px] border-b border-line" data-m="${m}">${it.i < 0 ? icon('layers', 'icon text-faint') : layerDot(it.type)}<span class="truncate flex-1">${esc(it.i < 0 ? `${it.label} — ${fmt(it.count)} items` : NODES[it.i].name)}</span><span class="text-2xs text-faint">${esc(it.type)}</span><span class="text-2xs tabular-nums text-muted w-12 text-right">${fmt(it.deg)}</span></button>`; });
  $('#glv').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) selectInGraph(+b.dataset.m); };
  rowKeys($('#glv'), 'button[data-m]');
}
function drawGraph(route) {
  mountGraph();
  page().classList.add('hidden'); $('#graph').classList.remove('hidden');
  const preset = PRESETS[route.sub] ? route.sub : (Object.keys(PRESETS).find((k) => k === 'project' && presetCount(k) && NODES.length > CLUSTER_AT) || 'all');
  const focusId = route.params.get('focus'), expand = route.params.get('expand');
  if (preset !== G.preset) { if (G.preset) pushHistory(); Object.assign(G, { preset, focus: -1, path: null, impact: null, expanded: new Set(), clustered: null, hidden: new Set(PRESETS[preset].hide || []), pathFrom: -1 }); }
  if (expand) G.expanded.add(expand);
  resize();
  if (focusId && IDX.has(focusId)) { const i = IDX.get(focusId); if (G.focus !== i || (route.params.get('impact') && !G.impact)) { focusOn(i, { impact: !!route.params.get('impact') }); return; } }
  if (!G.model || G.model.key.split('|')[0] !== G.preset || expand) rebuild(); else { drawGraphChrome(); requestDraw(); }
  if (route.params.get('n') && G.modelIndex.has(route.params.get('n'))) selectInGraph(G.modelIndex.get(route.params.get('n')), true);
}

// ---------- theme ----------
function setTheme(t) { store.set('theme', t); if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; readColors(); requestDraw(); }

// ---------- render loop ----------
const PAGES = { dbintel: drawDbIntel, mobile: drawMobile, overview: drawOverview, explorer: drawExplorer, list: drawList, graph: drawGraph, documents: drawDocuments, project: drawProject, handoffs: drawHandoffs, notes: drawNotes, search: drawSearch, context: drawContext, settings: drawSettings };
function render() {
  const route = parseRoute();
  drawNav(route);
  navOpen(false);
  page().classList.remove('lg:overflow-hidden');
  (PAGES[route.page] || drawNotFound)(route);
  const n = route.params.get('n');
  if (n && IDX.has(n) && route.page !== 'graph') showNode(n);
  else if (route.page !== 'graph' && detailId && !n) closeDetails();
  document.title = `${D.manifest.project.name} — RM Context`;
  store.set('route', location.hash);
}

// ---------- boot ----------
$('#pname').textContent = D.manifest.project.name;
$('#pmeta').textContent = `${fmt(NODES.length)} nodes · ${fmt(EDGES.length)} relationships`;
{ const t = store.get('theme', 'system'); if (t !== 'system') document.documentElement.dataset.theme = t; }
$('#theme').onclick = () => { const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; setTheme(dark ? 'light' : 'dark'); if (['project', 'documents', 'notes'].includes(parseRoute().page)) render(); };
$('#menu').onclick = () => navOpen(true);
$('#scrim').onclick = () => navOpen(false);
$('#navclose').onclick = () => navOpen(false);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { readColors(); requestDraw(); });
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape' && !typing) { if (!$('#scrim').classList.contains('hidden')) navOpen(false); else if (G.pathFrom >= 0) { G.pathFrom = -1; drawGraphChrome(); requestDraw(); } else closeDetails(); }
});
initSearchBox();
if (!BENCH) {
  window.addEventListener('hashchange', render);
  if (!location.hash || location.hash === '#') { const last = store.get('route', null); if (last && last.startsWith('#/')) history.replaceState(null, '', last); }
  render();
} else runBench();

// ---------- benchmark mode (#bench): synchronous timings recorded on <body data-bench> ----------
function runBench() {
  const R = {}, now = () => performance.now();
  R.bootMs = +(now()).toFixed(1); R.appInitMs = +(now() - T0).toFixed(1);
  let t = now(); history.replaceState(null, '', '#/overview'); drawOverview(); R.overviewMs = +(now() - t).toFixed(1);
  t = now(); history.replaceState(null, '', '#/explorer'); drawExplorer(parseRoute()); R.explorerMs = +(now() - t).toFixed(1);
  t = now(); drawList({ sub: 'code', params: new URLSearchParams() }); R.listMs = +(now() - t).toFixed(1);
  mountGraph(); page().classList.add('hidden'); $('#graph').classList.remove('hidden'); resize();
  const prep = (preset, clustered) => { layoutCache.clear(); Object.assign(G, { preset, focus: -1, path: null, impact: null, expanded: new Set(), clustered, hidden: new Set(PRESETS[preset].hide || []), model: null, x: null }); };
  // Comparable to the baseline: the full graph without functions, every node rendered.
  prep('all', false);
  t = now(); const M = buildModel(); R.modelMs = +(now() - t).toFixed(1); R.visibleNodes = M.items.length; R.visibleEdges = M.src.length;
  t = now(); const L = runLayout(M, true); R.layoutMs = +(now() - t).toFixed(1); R.layoutIterations = L.iterations;
  t = now(); draw(); R.firstDrawMs = +(now() - t).toFixed(1);
  t = now(); draw(); R.redrawMs = +(now() - t).toFixed(1); R.drawnNodes = G.lastDraw.nodes; R.drawnEdges = G.lastDraw.edges;
  t = now(); runLayout(M, true); R.cachedLayoutMs = +(now() - t).toFixed(1);
  t = now(); const hits = search(SX, 'fn1', 30); R.searchMs = +(now() - t).toFixed(2); R.searchHits = hits.length;
  t = now(); selectInGraph(Math.floor(M.items.length / 2)); R.selectMs = +(now() - t).toFixed(1);
  t = now(); const a = M.items[0].i, b = M.items[M.items.length - 1].i; const p = shortestPath(IX, a, b); R.pathMs = +(now() - t).toFixed(2); R.pathLength = p ? p.edges.length : null;
  // What a user sees first on a large graph: module clusters.
  prep('all', null);
  t = now(); const C = buildModel(); runLayout(C, true); draw(); R.clusterFirstPaintMs = +(now() - t).toFixed(1); R.clusterItems = C.items.length; R.clustered = C.clustered;
  t = now(); const big = [...MEMBERS.entries()].filter(([g]) => !g.startsWith('layer:')).sort((x, y) => y[1].length - x[1].length)[0]; if (big) { G.expanded.add(big[0]); const X = buildModel(); runLayout(X, true); draw(); R.expandItems = X.items.length; } R.expandMs = +(now() - t).toFixed(1);
  R.heapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
  R.domElements = document.getElementsByTagName('*').length;
  R.workerAvailable = !!getWorker();
  document.body.dataset.bench = JSON.stringify(R);
}
})();
