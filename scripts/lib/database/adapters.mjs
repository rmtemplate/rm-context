// Engine adapters. Each adapter owns (1) SELECT-only catalog queries aliased to canonical column names,
// (2) the normalizer that turns catalog rows into one canonical model, (3) identifier rules, and later (backup.mjs) DDL generation.
// Nothing here executes anything by itself: executors are injected (mocked in tests, node:sqlite or a CLI client live).
import { spawnSync } from 'node:child_process';
import { guardedExecutor, assertReadOnly } from './guard.mjs';
import { analyzeSql, sha256, objKey } from './sql.mjs';

export const IDENT_LIMIT = { mssql: 128, mysql: 64, postgres: 63, sqlite: 1024 };
export const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const safeIdent = (s) => { if (!/^[\w$# .@-]{1,256}$/.test(String(s))) throw new Error(`Unsafe identifier: ${JSON.stringify(String(s).slice(0, 40))}`); return s; };

// ---------- catalog queries (SELECT-only) ----------
const MSSQL = {
  info: `SELECT DB_NAME() AS database_name, CAST(SERVERPROPERTY('ProductVersion') AS varchar(64)) AS version`,
  tables: `SELECT s.name AS schema_name, t.name AS table_name, 'TABLE' AS table_type FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.is_ms_shipped = 0 ORDER BY s.name, t.name`,
  columns: `SELECT s.name AS schema_name, t.name AS table_name, c.name AS column_name, c.column_id AS ordinal, ty.name AS data_type, c.max_length AS max_length, c.precision AS num_precision, c.scale AS num_scale, c.is_nullable AS nullable, c.is_identity AS is_identity, c.is_computed AS is_computed, OBJECT_DEFINITION(c.default_object_id) AS default_value FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE t.is_ms_shipped = 0 ORDER BY s.name, t.name, c.column_id`,
  keys: `SELECT s.name AS schema_name, t.name AS table_name, i.name AS constraint_name, CASE WHEN i.is_primary_key = 1 THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS constraint_type, c.name AS column_name, ic.key_ordinal AS ordinal FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE (i.is_primary_key = 1 OR i.is_unique_constraint = 1) AND ic.is_included_column = 0 ORDER BY s.name, t.name, i.name, ic.key_ordinal`,
  foreignKeys: `SELECT s.name AS schema_name, t.name AS table_name, fk.name AS constraint_name, pc.name AS column_name, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column, fkc.constraint_column_id AS ordinal FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.tables t ON t.object_id = fk.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id`,
  indexes: `SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name, i.is_unique AS is_unique, c.name AS column_name, ic.key_ordinal AS ordinal FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.name IS NOT NULL AND i.is_primary_key = 0 AND ic.is_included_column = 0 ORDER BY s.name, t.name, i.name, ic.key_ordinal`,
  checks: `SELECT s.name AS schema_name, t.name AS table_name, cc.name AS constraint_name, cc.definition AS definition FROM sys.check_constraints cc JOIN sys.tables t ON t.object_id = cc.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id`,
  routineHeaders: `SELECT s.name AS schema_name, o.name AS routine_name, CASE o.type WHEN 'P' THEN 'procedure' WHEN 'V' THEN 'view' WHEN 'TR' THEN 'trigger' ELSE 'function' END AS routine_type, CONVERT(varchar(33), o.modify_date, 126) AS signature FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('P','V','FN','IF','TF','TR') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
  params: `SELECT s.name AS schema_name, o.name AS routine_name, p.name AS param_name, ty.name AS data_type, CASE WHEN p.is_output = 1 THEN 'OUT' ELSE 'IN' END AS mode, p.parameter_id AS ordinal FROM sys.parameters p JOIN sys.objects o ON o.object_id = p.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id JOIN sys.types ty ON ty.user_type_id = p.user_type_id WHERE o.type IN ('P','FN','IF','TF') AND o.is_ms_shipped = 0 AND p.parameter_id > 0 ORDER BY s.name, o.name, p.parameter_id`,
  triggerTables: `SELECT s.name AS schema_name, o.name AS routine_name, ts.name AS table_schema, t.name AS table_name FROM sys.triggers tr JOIN sys.objects o ON o.object_id = tr.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id JOIN sys.tables t ON t.object_id = tr.parent_id JOIN sys.schemas ts ON ts.schema_id = t.schema_id`,
  dependencies: `SELECT s.name AS schema_name, o.name AS routine_name, d.referenced_schema_name AS ref_schema, d.referenced_entity_name AS ref_name, ro.type_desc AS ref_kind, d.referenced_database_name AS ref_database FROM sys.sql_expression_dependencies d JOIN sys.objects o ON o.object_id = d.referencing_id JOIN sys.schemas s ON s.schema_id = o.schema_id LEFT JOIN sys.objects ro ON ro.object_id = d.referenced_id WHERE o.type IN ('P','V','FN','IF','TF','TR') AND d.referenced_entity_name IS NOT NULL`,
  sequences: `SELECT s.name AS schema_name, q.name AS sequence_name FROM sys.sequences q JOIN sys.schemas s ON s.schema_id = q.schema_id`,
  definition: ({ schema, name }) => `SELECT s.name AS schema_name, o.name AS routine_name, m.definition AS definition, CASE WHEN m.definition IS NULL THEN 1 ELSE 0 END AS is_encrypted FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = ${lit(schema)} AND o.name = ${lit(name)}`,
};
const MYSQL = {
  info: `SELECT DATABASE() AS database_name, VERSION() AS version`,
  tables: `SELECT table_schema AS schema_name, table_name AS table_name, table_type AS table_type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
  columns: `SELECT table_schema AS schema_name, table_name AS table_name, column_name AS column_name, ordinal_position AS ordinal, column_type AS data_type, character_maximum_length AS max_length, CASE WHEN is_nullable = 'YES' THEN 1 ELSE 0 END AS nullable, CASE WHEN extra LIKE '%auto_increment%' THEN 1 ELSE 0 END AS is_identity, CASE WHEN extra LIKE '%GENERATED%' THEN 1 ELSE 0 END AS is_computed, column_default AS default_value FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`,
  keys: `SELECT tc.table_schema AS schema_name, tc.table_name AS table_name, tc.constraint_name AS constraint_name, tc.constraint_type AS constraint_type, k.column_name AS column_name, k.ordinal_position AS ordinal FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name WHERE tc.table_schema = DATABASE() AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE') ORDER BY tc.table_name, tc.constraint_name, k.ordinal_position`,
  foreignKeys: `SELECT table_schema AS schema_name, table_name AS table_name, constraint_name AS constraint_name, column_name AS column_name, referenced_table_schema AS ref_schema, referenced_table_name AS ref_table, referenced_column_name AS ref_column, ordinal_position AS ordinal FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL ORDER BY table_name, constraint_name, ordinal_position`,
  indexes: `SELECT table_schema AS schema_name, table_name AS table_name, index_name AS index_name, CASE WHEN non_unique = 0 THEN 1 ELSE 0 END AS is_unique, column_name AS column_name, seq_in_index AS ordinal FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY' ORDER BY table_name, index_name, seq_in_index`,
  checks: `SELECT tc.table_schema AS schema_name, tc.table_name AS table_name, cc.constraint_name AS constraint_name, cc.check_clause AS definition FROM information_schema.check_constraints cc JOIN information_schema.table_constraints tc ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema WHERE tc.table_schema = DATABASE()`,
  routineHeaders: `SELECT routine_schema AS schema_name, routine_name AS routine_name, LOWER(routine_type) AS routine_type, CAST(last_altered AS CHAR) AS signature FROM information_schema.routines WHERE routine_schema = DATABASE() UNION ALL SELECT table_schema, table_name, 'view', MD5(view_definition) FROM information_schema.views WHERE table_schema = DATABASE() UNION ALL SELECT trigger_schema, trigger_name, 'trigger', MD5(action_statement) FROM information_schema.triggers WHERE trigger_schema = DATABASE()`,
  params: `SELECT specific_schema AS schema_name, specific_name AS routine_name, parameter_name AS param_name, dtd_identifier AS data_type, COALESCE(parameter_mode, 'IN') AS mode, ordinal_position AS ordinal FROM information_schema.parameters WHERE specific_schema = DATABASE() AND ordinal_position > 0 ORDER BY specific_name, ordinal_position`,
  triggerTables: `SELECT trigger_schema AS schema_name, trigger_name AS routine_name, event_object_schema AS table_schema, event_object_table AS table_name FROM information_schema.triggers WHERE trigger_schema = DATABASE()`,
  dependencies: null, // MySQL has no dependency catalog: derived from definitions (labelled inferred)
  sequences: null,
  definition: ({ schema, name, kind }) => kind === 'view'
    ? `SELECT table_schema AS schema_name, table_name AS routine_name, view_definition AS definition, 0 AS is_encrypted FROM information_schema.views WHERE table_schema = ${lit(schema)} AND table_name = ${lit(name)}`
    : kind === 'trigger'
      ? `SELECT trigger_schema AS schema_name, trigger_name AS routine_name, action_statement AS definition, 0 AS is_encrypted FROM information_schema.triggers WHERE trigger_schema = ${lit(schema)} AND trigger_name = ${lit(name)}`
      : `SELECT routine_schema AS schema_name, routine_name AS routine_name, routine_definition AS definition, 0 AS is_encrypted FROM information_schema.routines WHERE routine_schema = ${lit(schema)} AND routine_name = ${lit(name)}`,
};
const PG = {
  info: `SELECT current_database() AS database_name, version() AS version`,
  tables: `SELECT table_schema AS schema_name, table_name AS table_name, table_type AS table_type FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name`,
  columns: `SELECT table_schema AS schema_name, table_name AS table_name, column_name AS column_name, ordinal_position AS ordinal, data_type AS data_type, character_maximum_length AS max_length, CASE WHEN is_nullable = 'YES' THEN 1 ELSE 0 END AS nullable, CASE WHEN is_identity = 'YES' OR column_default LIKE 'nextval(%' THEN 1 ELSE 0 END AS is_identity, CASE WHEN is_generated = 'ALWAYS' THEN 1 ELSE 0 END AS is_computed, column_default AS default_value FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position`,
  keys: `SELECT tc.table_schema AS schema_name, tc.table_name AS table_name, tc.constraint_name AS constraint_name, tc.constraint_type AS constraint_type, k.column_name AS column_name, k.ordinal_position AS ordinal FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name WHERE tc.constraint_type IN ('PRIMARY KEY','UNIQUE') AND tc.table_schema NOT IN ('pg_catalog','information_schema') ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, k.ordinal_position`,
  foreignKeys: `SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname AS constraint_name, a.attname AS column_name, rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname AS ref_column, u.ord AS ordinal FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(ck, fk, ord) ON true JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.ck JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = u.fk WHERE con.contype = 'f' ORDER BY n.nspname, c.relname, con.conname, u.ord`,
  indexes: `SELECT schemaname AS schema_name, tablename AS table_name, indexname AS index_name, CASE WHEN indexdef LIKE 'CREATE UNIQUE%' THEN 1 ELSE 0 END AS is_unique, indexdef AS column_name, 1 AS ordinal FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, tablename, indexname`,
  checks: `SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname AS constraint_name, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE con.contype = 'c'`,
  routineHeaders: `SELECT n.nspname AS schema_name, p.proname AS routine_name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS routine_type, md5(pg_get_functiondef(p.oid)) AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind IN ('f','p') UNION ALL SELECT schemaname, viewname, 'view', md5(definition) FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema') UNION ALL SELECT n.nspname, t.tgname, 'trigger', md5(pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal`,
  params: `SELECT specific_schema AS schema_name, regexp_replace(specific_name, '_[0-9]+$', '') AS routine_name, parameter_name AS param_name, data_type AS data_type, parameter_mode AS mode, ordinal_position AS ordinal FROM information_schema.parameters WHERE specific_schema NOT IN ('pg_catalog','information_schema') ORDER BY specific_schema, specific_name, ordinal_position`,
  triggerTables: `SELECT n.nspname AS schema_name, t.tgname AS routine_name, n.nspname AS table_schema, c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal`,
  dependencies: `SELECT DISTINCT n.nspname AS schema_name, v.relname AS routine_name, rn.nspname AS ref_schema, r.relname AS ref_name, 'table' AS ref_kind FROM pg_depend d JOIN pg_rewrite w ON w.oid = d.objid JOIN pg_class v ON v.oid = w.ev_class JOIN pg_namespace n ON n.oid = v.relnamespace JOIN pg_class r ON r.oid = d.refobjid JOIN pg_namespace rn ON rn.oid = r.relnamespace WHERE v.relkind = 'v' AND r.oid <> v.oid AND rn.nspname NOT IN ('pg_catalog','information_schema')`,
  sequences: `SELECT sequence_schema AS schema_name, sequence_name AS sequence_name FROM information_schema.sequences`,
  definition: ({ schema, name, kind }) => kind === 'view'
    ? `SELECT schemaname AS schema_name, viewname AS routine_name, definition AS definition, 0 AS is_encrypted FROM pg_views WHERE schemaname = ${lit(schema)} AND viewname = ${lit(name)}`
    : kind === 'trigger'
      ? `SELECT n.nspname AS schema_name, t.tgname AS routine_name, pg_get_triggerdef(t.oid) AS definition, 0 AS is_encrypted FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${lit(schema)} AND t.tgname = ${lit(name)}`
      : `SELECT n.nspname AS schema_name, p.proname AS routine_name, pg_get_functiondef(p.oid) AS definition, 0 AS is_encrypted FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${lit(schema)} AND p.proname = ${lit(name)}`,
};
export const CATALOG = { mssql: MSSQL, mysql: MYSQL, postgres: PG };
const QUERY_ORDER = ['info', 'tables', 'columns', 'keys', 'foreignKeys', 'indexes', 'checks', 'routineHeaders', 'params', 'triggerTables', 'dependencies', 'sequences'];

// Every catalog statement the adapter can send for an engine (used by `catalog-sql`, tests and the guard self-check).
export function catalogStatements(engine, routines = []) {
  if (engine === 'sqlite') return ["SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"];
  const c = CATALOG[engine]; if (!c) throw new Error(`Unsupported engine: ${engine}`);
  const out = QUERY_ORDER.filter((k) => c[k]).map((k) => ({ name: k, sql: c[k] }));
  for (const r of routines) out.push({ name: `definition:${r.name}`, sql: c.definition(r) });
  return out;
}

// ---------- canonical model ----------
const num = (v) => v === true || v === 1 || v === '1' || v === 'YES' || v === 't' || v === 'true';
const uniqOrdered = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const typeOf = (c) => { const base = String(c.data_type || ''); if (c.max_length != null && /char|binary|text/i.test(base) && !/\(/.test(base)) return `${base}(${Number(c.max_length) < 0 ? 'max' : c.max_length})`; return base; };

export function buildModel(engine, rows, { limitations = [] } = {}) {
  const r = (k) => rows[k] || [];
  const model = { engine, database: r('info')[0]?.database_name || '', version: r('info')[0]?.version || '', tables: [], routines: [], sequences: [], dependencies: [], limitations: [...limitations] };
  const tkey = (x) => objKey(x.schema_name, x.table_name);
  const tables = new Map();
  for (const t of r('tables')) tables.set(tkey(t), { schema: t.schema_name, name: t.table_name, columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [], indexes: [] });
  for (const c of r('columns')) tables.get(tkey(c))?.columns.push({ name: c.column_name, type: typeOf(c), nullable: num(c.nullable), identity: num(c.is_identity), computed: num(c.is_computed), ...(c.default_value != null ? { default: String(c.default_value) } : {}) });
  for (const [, rs] of uniqOrdered(r('keys'), (x) => `${tkey(x)}|${x.constraint_name}|${x.constraint_type}`)) {
    const t = tables.get(tkey(rs[0])); if (!t) continue;
    const cols = rs.sort((a, b) => a.ordinal - b.ordinal).map((x) => x.column_name);
    if (/primary/i.test(rs[0].constraint_type)) { t.primaryKey = cols; for (const c of t.columns) if (cols.includes(c.name)) { c.pk = true; c.nullable = false; } }
    else t.uniques.push({ name: rs[0].constraint_name, columns: cols });
  }
  for (const [, rs] of uniqOrdered(r('foreignKeys'), (x) => `${tkey(x)}|${x.constraint_name}`)) {
    const t = tables.get(tkey(rs[0])); if (!t) continue; rs.sort((a, b) => a.ordinal - b.ordinal);
    t.foreignKeys.push({ name: rs[0].constraint_name, columns: rs.map((x) => x.column_name), ref: { schema: rs[0].ref_schema, name: rs[0].ref_table }, refColumns: rs.map((x) => x.ref_column) });
  }
  for (const [, rs] of uniqOrdered(r('indexes'), (x) => `${tkey(x)}|${x.index_name}`)) {
    const t = tables.get(tkey(rs[0])); if (!t) continue; rs.sort((a, b) => a.ordinal - b.ordinal);
    t.indexes.push({ name: rs[0].index_name, unique: num(rs[0].is_unique), columns: engine === 'postgres' ? [String(rs[0].column_name).replace(/^.*\(/, '').replace(/\).*$/, '')] : rs.map((x) => x.column_name) });
  }
  for (const c of r('checks')) tables.get(tkey(c))?.checks.push({ name: c.constraint_name, definition: c.definition });
  model.tables = [...tables.values()];
  const paramsBy = uniqOrdered(r('params'), (p) => objKey(p.schema_name, p.routine_name));
  const trig = new Map(r('triggerTables').map((t) => [objKey(t.schema_name, t.routine_name), { schema: t.table_schema, name: t.table_name }]));
  for (const h of r('routineHeaders')) {
    const k = objKey(h.schema_name, h.routine_name);
    const params = (paramsBy.get(k) || []).sort((a, b) => a.ordinal - b.ordinal).map((p) => ({ name: p.param_name, type: p.data_type, mode: String(p.mode || 'IN').toUpperCase() }));
    model.routines.push({ kind: h.routine_type, schema: h.schema_name, name: h.routine_name, params, signature: h.signature || '', ...(trig.get(k) ? { table: trig.get(k) } : {}) });
  }
  for (const d of r('dependencies')) model.dependencies.push({ from: { schema: d.schema_name, name: d.routine_name }, to: { schema: d.ref_schema || d.schema_name, name: d.ref_name, kind: String(d.ref_kind || '').toLowerCase().includes('proc') ? 'routine' : 'table', ...(d.ref_database ? { database: d.ref_database } : {}) }, evidence: 'catalog', confidence: 'verified' });
  model.sequences = r('sequences').map((s) => ({ schema: s.schema_name, name: s.sequence_name }));
  return model;
}

// attach definitions (rows from definition queries) to model routines and derive static references
export function attachDefinitions(model, defRows) {
  for (const row of defRows) {
    const rt = model.routines.find((x) => objKey(x.schema, x.name) === objKey(row.schema_name, row.routine_name));
    if (!rt) continue;
    if (num(row.is_encrypted) || row.definition == null) { rt.definition = null; rt.encrypted = true; model.limitations.push(`${rt.schema}.${rt.name}: definition is encrypted or not accessible with the current permissions`); continue; }
    rt.definition = String(row.definition);
    const a = analyzeSql(rt.definition, { selfName: [rt.schema, rt.name] });
    rt.refs = a.refs; rt.dynamic = a.dynamic; rt.crossDatabase = a.crossDatabase;
    if (a.dynamic) model.limitations.push(`${rt.schema}.${rt.name}: dynamic SQL — some references are unresolved`);
  }
  return model;
}

// ---------- discovery orchestration ----------
// `exec(sql)` must return an array of row objects. It is wrapped in the read-only guard; any non-SELECT throws before sending.
export async function discoverCatalog(engine, run, { onStatement, withDefinitions = true, only } = {}) {
  const exec = guardedExecutor(run, { engine, onStatement });
  if (engine === 'sqlite') return discoverSqlite(exec, { withDefinitions });
  const c = CATALOG[engine]; if (!c) throw new Error(`Unsupported engine: ${engine}`);
  const rows = {}; const limitations = [];
  for (const k of QUERY_ORDER) {
    if (!c[k]) { if (k === 'dependencies') limitations.push('This engine has no dependency catalog: references are derived from definitions and labelled inferred.'); continue; }
    try { rows[k] = await exec(c[k]); } catch (e) { rows[k] = []; limitations.push(`${k}: ${String(e.message).split('\n')[0].slice(0, 160)} (insufficient permission or unsupported; not escalated)`); }
  }
  const model = buildModel(engine, rows, { limitations });
  if (withDefinitions) {
    const defs = [];
    for (const r of model.routines) {
      if (only && !only(r)) continue;
      try { defs.push(...await exec(c.definition(r))); } catch (e) { limitations.push(`${r.schema}.${r.name}: definition not readable (${String(e.message).split('\n')[0].slice(0, 100)})`); }
    }
    attachDefinitions(model, defs);
    if (!c.dependencies) for (const r of model.routines) for (const ref of r.refs || []) model.dependencies.push({ from: { schema: r.schema, name: r.name }, to: { schema: ref.schema || r.schema, name: ref.name, kind: ref.kind, ...(ref.crossDatabase ? { database: ref.extra[0] } : {}) }, mode: ref.mode, evidence: 'definition-parse', confidence: ref.crossDatabase ? 'inferred' : 'inferred' });
  }
  model.statements = exec.sent.map((s) => s.hash);
  return model;
}

async function discoverSqlite(exec, { withDefinitions }) {
  const master = await exec("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const model = { engine: 'sqlite', database: 'main', version: '', tables: [], routines: [], sequences: [], dependencies: [], limitations: ['SQLite has no stored procedures; views and triggers are read from sqlite_master.'] };
  for (const o of master.filter((x) => x.type === 'table')) {
    const q = `"${String(o.name).replace(/"/g, '""')}"`;
    const info = await exec(`PRAGMA table_xinfo(${q})`);
    const fks = await exec(`PRAGMA foreign_key_list(${q})`);
    const idx = await exec(`PRAGMA index_list(${q})`);
    const t = { schema: 'main', name: o.name, columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [], indexes: [], ddl: o.sql };
    for (const c of info) { t.columns.push({ name: c.name, type: c.type || '', nullable: !c.notnull && !c.pk, identity: Boolean(c.pk) && /INTEGER/i.test(c.type || '') && info.filter((x) => x.pk).length === 1, computed: Number(c.hidden) >= 2, ...(c.dflt_value != null ? { default: String(c.dflt_value) } : {}), ...(c.pk ? { pk: true } : {}) }); }
    t.primaryKey = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    for (const [, rs] of uniqOrdered(fks, (f) => f.id)) t.foreignKeys.push({ columns: rs.map((f) => f.from), ref: { schema: 'main', name: rs[0].table }, refColumns: rs.map((f) => f.to).filter(Boolean) });
    for (const ix of idx) {
      const cols = (await exec(`PRAGMA index_info(${JSON.stringify(ix.name)})`)).map((c) => c.name);
      if (ix.origin === 'pk') continue;
      if (ix.origin === 'u') t.uniques.push({ name: ix.name, columns: cols }); else t.indexes.push({ name: ix.name, unique: Boolean(ix.unique), columns: cols });
    }
    model.tables.push(t);
  }
  for (const o of master.filter((x) => x.type === 'view' || x.type === 'trigger')) {
    const rt = { kind: o.type, schema: 'main', name: o.name, params: [], signature: sha256(o.sql || '').slice(0, 16) };
    if (withDefinitions) { rt.definition = o.sql || null; const a = analyzeSql(o.sql || '', { selfName: ['main', o.name] }); rt.refs = a.refs; rt.dynamic = a.dynamic; for (const ref of a.refs) model.dependencies.push({ from: { schema: 'main', name: o.name }, to: { schema: 'main', name: ref.name, kind: ref.kind }, mode: ref.mode, evidence: 'definition-parse', confidence: 'inferred' }); }
    model.routines.push(rt);
  }
  model.statements = exec.sent.map((s) => s.hash);
  return model;
}

// ---------- live executors ----------
// SQLite: node:sqlite opened read-only. Reads sqlite_master and PRAGMAs only (the guard allows nothing else).
export async function sqliteExecutor(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const run = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  run.close = () => db.close();
  return run;
}

// Server engines through the vendor CLI. Credentials come only from environment variables the user names; they are never
// placed on argv and never logged. Read-only is requested at session level where the engine supports it, and the guard
// still rejects any non-SELECT. Not exercised against a live server by the test-suite.
export function cliExecutor(target, { env = process.env, credEnv = {}, spawn = spawnSync, write = false } = {}) {
  const e = { ...env };
  const user = credEnv.user ? env[credEnv.user] : '';
  const pass = credEnv.password ? env[credEnv.password] : '';
  const host = target.host || (target.hostFromEnv ? env[target.hostFromEnv.replace(/^env:/, '')] : '') || 'localhost';
  const db = target.database;
  const x = (cmd, args, parse, input) => { const r = spawn(cmd, args, { encoding: 'utf8', env: e, input, maxBuffer: 256 * 1024 * 1024 }); if (r.error) throw new Error(`${cmd} could not be started: ${r.error.code || r.error.message}`); if (r.status !== 0) throw new Error(String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || `${cmd} exited ${r.status}`); return parse(String(r.stdout || '')); };
  if (write) {
    // Write mode is used ONLY by change.gatedExecute for statements registered in an approved plan.
    if (target.engine === 'postgres') { if (pass) e.PGPASSWORD = pass; return (sql) => x('psql', ['-X', '-q', '-h', host, ...(target.port ? ['-p', target.port] : []), ...(user ? ['-U', user] : []), '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql], () => []); }
    if (target.engine === 'mysql') { if (pass) e.MYSQL_PWD = pass; return (sql) => x('mysql', ['--batch', '-h', host, ...(target.port ? ['-P', target.port] : []), ...(user ? ['-u', user] : []), '-D', db, '-e', sql], () => []); }
    if (target.engine === 'mssql') { if (pass) e.SQLCMDPASSWORD = pass; return (sql) => x('sqlcmd', ['-S', target.port ? `${host},${target.port}` : host, ...(user ? ['-U', user] : ['-E']), '-d', db, '-b', '-Q', sql], () => []); }
    throw new Error(`No live write executor for engine ${target.engine}`);
  }
  if (target.engine === 'postgres') {
    if (pass) e.PGPASSWORD = pass; e.PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=60000';
    return (sql) => x('psql', ['-X', '-q', '-A', '-t', '-h', host, ...(target.port ? ['-p', target.port] : []), ...(user ? ['-U', user] : []), '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql.replace(/;+\s*$/, '')}) t`], (o) => JSON.parse(o.trim() || '[]'));
  }
  if (target.engine === 'mysql') {
    if (pass) e.MYSQL_PWD = pass;
    return (sql) => x('mysql', ['--batch', '--raw', '-h', host, ...(target.port ? ['-P', target.port] : []), ...(user ? ['-u', user] : []), '--init-command=SET SESSION TRANSACTION READ ONLY', '-D', db, '-e', sql], (o) => { const [h, ...ls] = o.split('\n').filter((l, i) => i === 0 || l.length); const cols = (h || '').split('\t'); return ls.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v === 'NULL' ? null : v]))); });
  }
  if (target.engine === 'mssql') {
    if (pass) e.SQLCMDPASSWORD = pass;
    return (sql) => x('sqlcmd', ['-S', target.port ? `${host},${target.port}` : host, ...(user ? ['-U', user] : ['-E']), '-d', db, '-b', '-y', '0', '-h', '-1', '-K', 'ReadOnly', '-Q', `SET NOCOUNT ON; ${sql.replace(/;+\s*$/, '')} FOR JSON PATH`], (o) => JSON.parse(o.replace(/\r?\n/g, '').trim() || '[]'));
  }
  throw new Error(`No live executor for engine ${target.engine}`);
}

// SQLite write executor (local files only), used solely through the mutation gate.
export async function sqliteWriteExecutor(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  const run = (sql) => { db.exec(sql); return []; };
  run.close = () => db.close();
  return run;
}

export { assertReadOnly };
