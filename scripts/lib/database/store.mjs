// Database knowledge store: .rmcontext/database/<scope>/<target>/… with per-object fingerprints, incremental refresh,
// removed-object marking, history, secret redaction and a retrieval index. Credentials are never written here.
import fs from 'node:fs';
import path from 'node:path';
import { ctx, readJson, writeJson, writeFile, now, slug } from '../util.mjs';
import { sha256, objKey, sensitiveSql, analyzeSql, normalizeDefinition } from './sql.mjs';
import { findSecrets } from '../ignore.mjs';

const HISTORY_MAX = 20;
export const dbDir = (root) => ctx(root).p('database');
const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 120) || '_';
export const targetKey = (t) => slug([t.engine, t.database || t.host || 'db', t.profile || ''].filter(Boolean).join('-'));
const ROUT_DIR = { procedure: 'procedures', function: 'functions', view: 'views', trigger: 'triggers' };

function stableJson(o) { return JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v)); }
const tableHash = (t) => sha256(stableJson({ c: t.columns, pk: t.primaryKey, fk: t.foreignKeys, u: t.uniques, ck: t.checks, i: t.indexes }));
const routineHash = (r) => sha256(stableJson({ k: r.kind, p: r.params, d: r.definition == null ? r.signature : normalizeDefinition(r.definition), t: r.table }));

export function redactMetadata(text) {
  // last line of defence: nothing secret-looking leaves for disk
  return findSecrets(String(text)).length ? '[redacted]' : text;
}

export function readManifest(root) { return readJson(path.join(dbDir(root), 'manifest.json'), { schema: 1, targets: {} }); }

function loadObjects(base, sub) {
  const out = new Map(); const dir = path.join(base, sub);
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) { try { const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); out.set(`${o.kind}:${objKey(o.schema, o.name)}`, { o, file: path.join(dir, f) }); } catch { /* skip unreadable */ } }
  return out;
}

export function storedSignatures(root, scope, tkey) {
  const base = path.join(dbDir(root), scope, tkey);
  const m = new Map();
  for (const k of Object.values(ROUT_DIR)) for (const [key, { o }] of loadObjects(base, path.join('routines', k))) m.set(key, { signature: o.signature, status: o.status, hash: o.hash });
  return m;
}

// Apply a discovered canonical model. Only changed objects are rewritten; unseen objects are marked removed (never deleted).
export function applyModel(root, { scope = 'backend', target, model, source = 'catalog', sourceFile, partial = false, stamp = now() }) {
  const tkey = targetKey({ ...target, engine: target.engine || model.engine });
  const base = path.join(dbDir(root), scope, tkey);
  const diff = { added: [], changed: [], removed: [], unchanged: [], review: [] };
  const record = (dir, kind, obj, hash, extra) => {
    const key = `${kind}:${objKey(obj.schema, obj.name)}`;
    const file = path.join(base, dir, `${safeName(obj.schema ? `${obj.schema}.${obj.name}` : obj.name)}.json`);
    const prev = existing.get(key);
    seen.add(key);
    if (prev && prev.o.hash === hash && prev.o.status === 'active') { diff.unchanged.push(key); return; }
    const history = [...(prev?.o.history || []), { at: stamp, event: prev ? (prev.o.status === 'removed' ? 'reappeared' : 'changed') : 'discovered', hash }].slice(-HISTORY_MAX);
    const rec = { ...extra, kind, schema: obj.schema || '', name: obj.name, hash, status: 'active', provenance: { source, ...(sourceFile ? { file: sourceFile } : {}), discoveredAt: prev?.o.provenance?.discoveredAt || stamp, updatedAt: stamp }, confidence: source === 'catalog' ? 'verified' : 'inferred', history };
    writeJson(file, rec);
    (prev ? diff.changed : diff.added).push(key);
  };
  const existing = new Map();
  for (const sub of ['schemas/tables', 'routines/procedures', 'routines/functions', 'routines/views', 'routines/triggers']) for (const [k, v] of loadObjects(base, sub)) existing.set(k, v);
  const seen = new Set();

  for (const t of model.tables) {
    const { ddl, ...rest } = t;
    record('schemas/tables', 'table', t, tableHash(t), { ...(ddl ? { ddl } : {}), columns: rest.columns, primaryKey: rest.primaryKey, foreignKeys: rest.foreignKeys, uniques: rest.uniques, checks: rest.checks, indexes: rest.indexes });
  }
  for (const r of model.routines) {
    const dir = `routines/${ROUT_DIR[r.kind] || 'functions'}`;
    const kept = r.definition === undefined; // header only (unchanged routine in an incremental refresh): keep stored record
    if (kept) { const key = `${r.kind}:${objKey(r.schema, r.name)}`; if (existing.has(key)) { seen.add(key); diff.unchanged.push(key); continue; } }
    const secrets = r.definition ? sensitiveSql(r.definition) : [];
    const hash = routineHash(r);
    const defFile = r.definition && !secrets.length ? `${safeName(r.schema ? `${r.schema}.${r.name}` : r.name)}.sql` : null;
    const extra = {
      params: r.params, signature: r.signature || '', table: r.table, encrypted: Boolean(r.encrypted) || undefined,
      definitionFile: defFile ? `${dir}/definitions/${defFile}` : undefined, definitionHash: r.definition ? sha256(r.definition) : undefined,
      reviewRequired: secrets.length ? true : undefined, redactionReason: secrets.length ? `definition contains ${secrets.join(', ')}; it was not stored` : undefined,
      dynamicSql: r.dynamic || undefined, unresolved: r.dynamic ? ['dynamic SQL: referenced objects may be missing'] : undefined,
      references: (r.refs || []).map((x) => ({ kind: x.kind, schema: x.schema, name: x.name, mode: x.mode, ...(x.crossDatabase ? { database: x.extra[0], status: 'unresolved' } : {}), confidence: 'inferred', evidence: 'definition-parse' })),
    };
    const before = diff.added.length + diff.changed.length;
    record(dir, r.kind, r, hash, extra);
    if (secrets.length) diff.review.push(`${r.kind}:${objKey(r.schema, r.name)}`);
    if (defFile && diff.added.length + diff.changed.length > before) writeFile(path.join(base, dir, 'definitions', defFile), r.definition.endsWith('\n') ? r.definition : r.definition + '\n');
  }
  if (!partial) for (const [key, v] of existing) if (!seen.has(key) && v.o.status !== 'removed') {
    writeJson(v.file, { ...v.o, status: 'removed', removedAt: stamp, history: [...(v.o.history || []), { at: stamp, event: 'removed', hash: v.o.hash }].slice(-HISTORY_MAX) });
    diff.removed.push(key);
  }

  // dependencies (catalog = verified, definition-parse = inferred) and sequences
  const deps = model.dependencies.map((d) => ({ from: `${objKey(d.from.schema, d.from.name)}`, to: `${objKey(d.to.schema, d.to.name)}`, toKind: d.to.kind, mode: d.mode, ...(d.to.database ? { database: d.to.database, status: 'unresolved' } : {}), evidence: d.evidence, confidence: d.confidence }));
  const depFile = path.join(base, 'dependencies', 'index.json');
  const prevDeps = readJson(depFile, { items: [] }).items;
  const present = new Set(model.routines.map((r) => objKey(r.schema, r.name)));
  const refreshed = new Set(model.routines.filter((r) => r.definition !== undefined).map((r) => objKey(r.schema, r.name)));
  const newFrom = new Set(deps.map((d) => d.from));
  const mergedDeps = [...prevDeps.filter((p) => present.has(p.from) && !refreshed.has(p.from) && !newFrom.has(p.from)), ...deps];
  if (JSON.stringify(prevDeps) !== JSON.stringify(mergedDeps)) writeJson(depFile, { updatedAt: stamp, items: mergedDeps });
  // table-to-table relationships
  const rel = model.tables.flatMap((t) => t.foreignKeys.map((f) => ({ from: objKey(t.schema, t.name), columns: f.columns, to: objKey(f.ref.schema || t.schema, f.ref.name), refColumns: f.refColumns, name: f.name, confidence: source === 'catalog' ? 'verified' : 'inferred' })));
  if (!partial || rel.length) writeJson(path.join(base, 'relationships.json'), { updatedAt: stamp, items: rel });

  const index = buildIndex(base);
  writeJson(path.join(base, 'index.json'), index);
  const manifest = readManifest(root);
  const prevT = manifest.targets[tkey] || {};
  manifest.targets[tkey] = {
    scope, engine: target.engine || model.engine, database: model.database || target.database || '', host: target.host || undefined, profile: target.profile || undefined,
    environment: target.environment || 'UNKNOWN', source, sourceFile, orm: target.orm || undefined,
    firstDiscoveredAt: prevT.firstDiscoveredAt || stamp, lastDiscoveredAt: stamp,
    counts: { tables: index.counts.table || 0, procedures: index.counts.procedure || 0, functions: index.counts.function || 0, views: index.counts.view || 0, triggers: index.counts.trigger || 0, removed: index.removed },
    limitations: [...new Set(model.limitations)].slice(0, 40), reviewRequired: index.review,
  };
  manifest.updatedAt = stamp;
  writeJson(path.join(dbDir(root), 'manifest.json'), manifest);
  return { key: tkey, base, diff, limitations: model.limitations };
}

function buildIndex(base) {
  const items = []; const counts = {}; let removed = 0; const review = [];
  const add = (sub) => { for (const { o } of loadObjects(base, sub).values()) { if (o.status === 'removed') removed++; else counts[o.kind] = (counts[o.kind] || 0) + 1; if (o.reviewRequired) review.push(`${o.kind}:${o.schema}.${o.name}`);
    items.push({ kind: o.kind, schema: o.schema, name: o.name, status: o.status, hash: o.hash.slice(0, 12), ...(o.columns ? { columns: o.columns.map((c) => c.name) } : {}), ...(o.params ? { params: o.params.map((p) => p.name) } : {}), ...(o.references?.length ? { refs: o.references.map((r) => r.name) } : {}), ...(o.encrypted ? { encrypted: true } : {}) }); } };
  for (const sub of ['schemas/tables', 'routines/procedures', 'routines/functions', 'routines/views', 'routines/triggers']) add(sub);
  items.sort((a, b) => (a.kind + a.schema + a.name).localeCompare(b.kind + b.schema + b.name));
  return { generatedAt: now(), counts, removed, review, items };
}

// ---------- retrieval ----------
export function loadIndexes(root) {
  const m = readManifest(root); const out = [];
  for (const [tkey, t] of Object.entries(m.targets)) { const f = path.join(dbDir(root), t.scope, tkey, 'index.json'); if (fs.existsSync(f)) out.push({ tkey, scope: t.scope, target: t, ...JSON.parse(fs.readFileSync(f, 'utf8')) }); }
  return out;
}
const terms = (q) => String(q).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
export function findObjects(root, query, { limit = 10, includeRemoved = false } = {}) {
  const ts = terms(query); const hits = [];
  for (const idx of loadIndexes(root)) for (const it of idx.items) {
    if (it.status === 'removed' && !includeRemoved) continue;
    const full = `${it.schema}.${it.name}`.toLowerCase(); let score = 0; const why = [];
    for (const t of ts) {
      if (it.name.toLowerCase() === t) { score += 10; why.push(`name ${t}`); }
      else if (it.name.toLowerCase().includes(t)) { score += 4; why.push(`name~${t}`); }
      if (it.columns?.some((c) => c.toLowerCase() === t)) { score += 5; why.push(`column ${t}`); }
      if (it.params?.some((p) => p.toLowerCase().replace(/^@/, '') === t)) { score += 5; why.push(`parameter ${t}`); }
      if (it.refs?.some((r) => r.toLowerCase() === t)) { score += 3; why.push(`references ${t}`); }
      if (full.includes(t) && !why.length) score += 1;
    }
    if (score) hits.push({ score, kind: it.kind, schema: it.schema, name: it.name, scope: idx.scope, target: idx.tkey, why: [...new Set(why)].slice(0, 3), status: it.status });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function showObject(root, kind, name, { definition = false } = {}) {
  const m = readManifest(root); const want = name.toLowerCase().replace(/^dbo\./, (s) => s);
  for (const [tkey, t] of Object.entries(m.targets)) {
    const base = path.join(dbDir(root), t.scope, tkey);
    const subs = kind === 'table' ? ['schemas/tables'] : kind === 'procedure' ? ['routines/procedures'] : kind === 'view' ? ['routines/views'] : kind === 'function' ? ['routines/functions'] : ['routines/triggers'];
    for (const sub of subs) for (const { o } of loadObjects(base, sub).values()) {
      if (`${o.schema}.${o.name}`.toLowerCase() === want || o.name.toLowerCase() === want) {
        const rec = { ...o, target: tkey, scope: t.scope };
        if (definition && o.definitionFile) { const f = path.join(base, o.definitionFile); if (fs.existsSync(f)) rec.definition = fs.readFileSync(f, 'utf8'); }
        const deps = readJson(path.join(base, 'dependencies', 'index.json'), { items: [] }).items;
        rec.dependsOn = deps.filter((d) => d.from === objKey(o.schema, o.name));
        rec.usedBy = deps.filter((d) => d.to === objKey(o.schema, o.name));
        const map = readJson(path.join(base, 'application-mapping', 'index.json'), { items: [] }).items;
        rec.application = map.filter((x) => x.object === objKey(o.schema, o.name) || x.object === o.name.toLowerCase());
        return rec;
      }
    }
  }
  return null;
}

// ---------- application mapping (evidence from source only) ----------
const SRC = /\.(cs|java|kt|py|php|ts|js|go|rb|sql|xml|dart)$/i;
const ROLE = [['controller', /controller|handler|resource|route/i], ['repository', /repositor|dao|store|gateway|dal|mapper/i], ['service', /service|manager|usecase|facade/i]];
const roleOf = (f) => (ROLE.find(([, rx]) => rx.test(path.basename(f))) || ['other'])[0];

export function mapApplication(root, { files, scope = 'backend', tkey, maxFiles = 3000 }) {
  const base = path.join(dbDir(root), scope, tkey);
  const idx = JSON.parse(fs.readFileSync(path.join(base, 'index.json'), 'utf8'));
  const procs = idx.items.filter((i) => i.kind === 'procedure' && i.status !== 'removed');
  const tables = idx.items.filter((i) => i.kind === 'table' && i.status !== 'removed');
  const items = []; const roleFiles = new Map();
  const callRx = (n) => new RegExp(String.raw`(?:EXEC(?:UTE)?\s+|CALL\s+|StoredProcedure|CommandText\s*=\s*|callproc\(|\.execute\(|FromSqlRaw\(|ExecuteSqlRaw\(|@Procedure|@NamedStoredProcedureQuery|StoredProcedureQuery\(|Procedure\(|query\(|select\(|statement\()[^\n;]{0,80}?\b(?:\w+\.)?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'i');
  let n = 0;
  for (const f of files) {
    if (!SRC.test(f) || n++ > maxFiles) continue;
    let text; try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; } if (text.length > 400_000) continue;
    const lines = text.split('\n');
    for (const p of procs) { if (!text.toLowerCase().includes(p.name.toLowerCase())) continue; const rx = callRx(p.name); const li = lines.findIndex((l) => rx.test(l)); if (li >= 0) items.push({ object: objKey(p.schema, p.name), objectKind: 'procedure', file: f, line: li + 1, role: roleOf(f), evidence: 'call-site', confidence: 'verified' }); }
    for (const t of tables) {
      const rxT = new RegExp(String.raw`(?:@Table\(\s*name\s*=\s*"|\[Table\(\s*"|__tablename__\s*=\s*['"]|\$table\s*=\s*['"]|(?:FROM|JOIN|INTO|UPDATE)\s+(?:\w+\.)?|\.table\(\s*['"]|db\.set\(\s*['"]|@Entity\(\s*['"]|tableName\s*[:=]\s*['"])${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'i');
      if (!text.toLowerCase().includes(t.name.toLowerCase())) continue;
      const li = lines.findIndex((l) => rxT.test(l)); if (li >= 0) items.push({ object: objKey(t.schema, t.name), objectKind: 'table', file: f, line: li + 1, role: roleOf(f), evidence: /@Table|\[Table|__tablename__|\$table|@Entity/.test(lines[li]) ? 'orm-declaration' : 'query-text', confidence: /@Table|\[Table|__tablename__|\$table|@Entity/.test(lines[li]) ? 'verified' : 'inferred' });
    }
    if (items.some((i) => i.file === f)) roleFiles.set(f, { cls: path.basename(f).replace(/\.[^.]+$/, ''), text });
  }
  // Service → Repository: only where the service file names the repository's class (declared type / import).
  const chain = [];
  const repos = [...roleFiles].filter(([f]) => roleOf(f) === 'repository');
  for (const f of files) {
    if (!SRC.test(f) || roleOf(f) !== 'service' && roleOf(f) !== 'controller') continue;
    let text; try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const [rf, r] of repos) { const li = text.split('\n').findIndex((l) => new RegExp(String.raw`\b${r.cls}\b`).test(l)); if (li >= 0 && f !== rf) chain.push({ from: f, to: rf, fromRole: roleOf(f), edge: roleOf(f) === 'service' ? 'Service→Repository' : 'Route/Controller→Repository', line: li + 1, evidence: 'declared-type', confidence: 'verified' }); }
  }
  const out = { updatedAt: now(), items, chain };
  writeJson(path.join(base, 'application-mapping', 'index.json'), out);
  return out;
}

// ---------- graph integration (agent-origin, evidence-bound; tables annotate scan-owned nodes) ----------
export function toGraph(root, g, upsertFn, { tkey, scope = 'backend', configFile }) {
  const base = path.join(dbDir(root), scope, tkey);
  const map = readJson(path.join(base, 'application-mapping', 'index.json'), { items: [] }).items;
  const nodes = []; const edges = [];
  const ev = (file, line) => [{ type: 'call', file, ...(line ? { lines: [line, line] } : {}) }];
  for (const sub of ['routines/procedures', 'routines/views']) for (const { o } of loadObjects(base, sub).values()) {
    if (o.status === 'removed') continue;
    const file = o.provenance?.file || configFile || null; if (!file) continue;
    nodes.push({ id: `procedure:${tkey}.${o.schema}.${o.name}`.toLowerCase(), type: 'function', name: `${o.schema ? o.schema + '.' : ''}${o.name}`, description: `${o.kind} in the database (${tkey})`, confidence: o.confidence, origin: 'agent', evidence: [{ type: 'schema', file }], attrs: { kind: o.kind === 'procedure' ? 'stored_procedure' : o.kind, params: (o.params || []).map((p) => p.name), target: tkey } });
  }
  const have = new Set(g.nodes.map((n) => n.id).concat(nodes.map((n) => n.id)));
  for (const m of map) {
    const fileId = `file:${m.file}`; if (!have.has(fileId)) continue;
    if (m.objectKind === 'procedure') { const pid = `procedure:${tkey}.${m.object}`.toLowerCase(); if (have.has(pid)) edges.push({ source: fileId, type: 'calls', target: pid, confidence: 'verified', origin: 'agent', evidence: ev(m.file, m.line) }); }
    else if (m.confidence === 'verified' || m.evidence === 'query-text') { const tid = `table:${m.object.split('.').pop()}`; if (have.has(tid)) edges.push({ source: fileId, type: m.evidence === 'query-text' ? 'reads_from' : 'depends_on', target: tid, confidence: m.confidence, origin: 'agent', evidence: ev(m.file, m.line) }); }
  }
  return upsertFn(g, { nodes, edges }, { origin: 'agent' });
}

export function secretScanKnowledge(root) {
  const hits = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (findSecrets(fs.readFileSync(p, 'utf8')).length) hits.push(path.relative(root, p)); } };
  walk(dbDir(root)); return hits;
}
