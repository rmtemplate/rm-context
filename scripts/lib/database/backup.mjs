// Backup object generation (engine-specific) and verification. Pure functions: they return the exact SQL the adapter WOULD send;
// nothing runs here. Names follow <object>_rmc_YYYYMMDD (date in Asia/Jakarta unless the project sets another timezone).
import { IDENT_LIMIT, lit, CATALOG } from './adapters.mjs';
import { normalizeDefinition, sha256, objKey, splitName } from './sql.mjs';

export class BackupBlocked extends Error { constructor(msg, blockers = []) { super(msg); this.blockers = blockers; } }

export function datePart(now = new Date(), tz = 'Asia/Jakarta') {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return p.replace(/-/g, '');
}
export function timePart(now = new Date(), tz = 'Asia/Jakarta') {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now).replace(/:/g, '');
}
// Never truncates: a name over the engine limit is an error the user must resolve.
export function backupName(engine, base, { now = new Date(), tz = 'Asia/Jakarta', extraTimestamp = false } = {}) {
  const name = `${base}_rmc_${datePart(now, tz)}${extraTimestamp ? `_${timePart(now, tz)}` : ''}`;
  const limit = IDENT_LIMIT[engine] || 63;
  if (name.length > limit) throw new BackupBlocked(`Backup name "${name}" is ${name.length} characters; ${engine} allows ${limit}. Nothing was truncated: choose a shorter approved name.`, ['identifier-length']);
  return name;
}

export const quoteId = (engine, id) => engine === 'mssql' ? `[${String(id).replace(/]/g, ']]')}]` : engine === 'mysql' ? `\`${String(id).replace(/`/g, '``')}\`` : `"${String(id).replace(/"/g, '""')}"`;
export const qualified = (engine, schema, name) => (schema && engine !== 'mysql' && engine !== 'sqlite' ? `${quoteId(engine, schema)}.` : '') + quoteId(engine, name);

// SELECT used to detect an existing object with the backup name (read-only).
export function existsQuery(engine, kind, schema, name) {
  if (engine === 'sqlite') return `SELECT name FROM sqlite_master WHERE name = ${lit(name)}`;
  if (engine === 'mssql') return `SELECT o.name AS name FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = ${lit(schema)} AND o.name = ${lit(name)}`;
  if (engine === 'mysql') return `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ${lit(name)} UNION ALL SELECT routine_name FROM information_schema.routines WHERE routine_schema = DATABASE() AND routine_name = ${lit(name)}`;
  return `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${lit(schema)} AND c.relname = ${lit(name)} UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${lit(schema)} AND p.proname = ${lit(name)}`;
}

// ---------- procedure / function / view backup ----------
export function procedureBackup(engine, original, newName) {
  if (!original.definition) throw new BackupBlocked(`${original.schema}.${original.name}: the definition is ${original.encrypted ? 'encrypted' : 'not available'}. Provide its DDL or take a native backup; no backup object was created.`, ['definition-unavailable']);
  const kw = original.kind === 'view' ? 'VIEW' : original.kind === 'function' ? 'FUNCTION' : 'PROC(?:EDURE)?';
  const rx = new RegExp(String.raw`(\b(?:CREATE|ALTER)\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:${kw})\s+(?:IF\s+NOT\s+EXISTS\s+)?)((?:\[[^\]]+\]|"[^"]+"|\`[^\`]+\`|[\w$#@]+)(?:\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|\`[^\`]+\`|[\w$#@]+))?)`, 'i');
  const m = rx.exec(original.definition);
  if (!m) throw new BackupBlocked(`${original.name}: the definition header could not be parsed; no backup was generated. Provide the DDL manually.`, ['definition-unparsed']);
  const word = /PROC/i.test(m[1]) ? (engine === 'mssql' ? 'PROCEDURE' : 'PROCEDURE') : original.kind === 'view' ? 'VIEW' : 'FUNCTION';
  const create = engine === 'postgres' && original.kind !== 'view' ? 'CREATE OR REPLACE' : 'CREATE';
  const head = `${create} ${word} `;
  const target = qualified(engine, original.schema, newName);
  const body = original.definition.slice(m.index + m[0].length);
  const ddl = original.definition.slice(0, m.index) + head + target + body;
  const statements = engine === 'mysql' && /\bBEGIN\b/i.test(ddl) ? [ddl.trim()] : [ddl.trim()];
  return { kind: original.kind, statements, ddl: ddl.trim(), originalHash: sha256(original.definition), note: 'The backup is created with CREATE under the new name. It is never executed and no application reference is repointed.' };
}

// Compare original vs backup definitions after safe normalization (names and CREATE/ALTER form removed).
export function verifyProcedureBackup(origDef, origName, backupDef, backupName_) {
  const a = normalizeDefinition(origDef, [origName]); const b = normalizeDefinition(backupDef, [backupName_]);
  return { ok: a === b, originalNormalizedHash: sha256(a).slice(0, 16), backupNormalizedHash: sha256(b).slice(0, 16) };
}

// ---------- table backup ----------
const colDefMssql = (c) => `${quoteId('mssql', c.name)} ${c.type}${c.identity ? ' IDENTITY(1,1)' : ''}${c.nullable ? ' NULL' : ' NOT NULL'}${c.default != null ? ` DEFAULT ${c.default}` : ''}`;
export function tableBackup(engine, t, newName) {
  const blockers = [], preserved = [], notPreserved = [];
  const src = qualified(engine, t.schema, t.name), dst = qualified(engine, t.schema, newName);
  const cols = t.columns.map((c) => quoteId(engine, c.name)).join(', ');
  const statements = [];
  const computed = t.columns.filter((c) => c.computed);
  if (engine === 'mssql') {
    if (computed.length) blockers.push(`computed column(s) ${computed.map((c) => c.name).join(', ')} cannot be reproduced from catalog metadata`);
    if (!blockers.length) {
      const defs = t.columns.map(colDefMssql);
      if (t.primaryKey.length) defs.push(`CONSTRAINT ${quoteId(engine, `PK_${newName}`)} PRIMARY KEY (${t.primaryKey.map((c) => quoteId(engine, c)).join(', ')})`);
      t.uniques.forEach((u, i) => defs.push(`CONSTRAINT ${quoteId(engine, `UQ_${newName}_${i + 1}`)} UNIQUE (${u.columns.map((c) => quoteId(engine, c)).join(', ')})`));
      t.checks.forEach((k, i) => defs.push(`CONSTRAINT ${quoteId(engine, `CK_${newName}_${i + 1}`)} CHECK ${/^\(/.test(k.definition) ? k.definition : `(${k.definition})`}`));
      statements.push(`CREATE TABLE ${dst} (\n  ${defs.join(',\n  ')}\n)`);
      t.indexes.forEach((ix, i) => statements.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteId(engine, `${ix.name}_rmc${i + 1}`)} ON ${dst} (${ix.columns.map((c) => quoteId(engine, c)).join(', ')})`));
      const hasId = t.columns.some((c) => c.identity);
      if (hasId) statements.push(`SET IDENTITY_INSERT ${dst} ON`);
      statements.push(`INSERT INTO ${dst} (${cols}) SELECT ${cols} FROM ${src}`);
      if (hasId) statements.push(`SET IDENTITY_INSERT ${dst} OFF`);
      preserved.push('columns', 'types', 'nullability', 'identity (seed/increment assumed 1,1: verify)', 'defaults', 'primary key', 'unique constraints', 'check constraints', 'indexes', 'row data');
    }
  } else if (engine === 'mysql') {
    statements.push(`CREATE TABLE ${dst} LIKE ${src}`, `INSERT INTO ${dst} SELECT * FROM ${src}`);
    preserved.push('columns', 'types', 'nullability', 'AUTO_INCREMENT column', 'defaults', 'primary key', 'unique keys', 'indexes', 'engine/charset options', 'row data');
  } else if (engine === 'postgres') {
    if (computed.length) notPreserved.push('generated column expressions are copied by INCLUDING ALL; verify on a copy first');
    statements.push(`CREATE TABLE ${dst} (LIKE ${src} INCLUDING ALL)`, `INSERT INTO ${dst} OVERRIDING SYSTEM VALUE SELECT * FROM ${src}`);
    preserved.push('columns', 'types', 'nullability', 'defaults', 'identity', 'check constraints', 'primary key', 'unique constraints', 'indexes', 'row data');
  } else if (engine === 'sqlite') {
    if (!t.ddl) blockers.push('the original CREATE TABLE statement is not recorded; run discovery against the database or provide the DDL');
    else {
      const rx = /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+))/i;
      if (!rx.test(t.ddl)) blockers.push('the original CREATE TABLE statement could not be parsed');
      else {
        statements.push(t.ddl.replace(rx, `$1${quoteId('sqlite', newName)}`).trim());
        t.indexes.forEach((ix, i) => statements.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteId('sqlite', `${ix.name}_rmc${i + 1}`)} ON ${quoteId('sqlite', newName)} (${ix.columns.map((c) => quoteId('sqlite', c)).join(', ')})`));
        statements.push(`INSERT INTO ${dst} (${cols}) SELECT ${cols} FROM ${src}`);
        preserved.push('columns', 'types', 'nullability', 'defaults', 'primary key/autoincrement', 'unique', 'check', 'indexes', 'row data');
      }
    }
  } else blockers.push(`engine ${engine} has no backup strategy`);
  if (t.foreignKeys.length) notPreserved.push(`${t.foreignKeys.length} foreign key(s) are recorded in the local DDL artifact but not recreated on the backup table`);
  notPreserved.push('triggers, permissions and statistics are not copied');
  return { statements, blockers, preserved, notPreserved, large: false };
}

// Read-only verification statements (row count + column structure of both tables).
export function tableVerifyQueries(engine, schema, name, backup) {
  const cnt = (n) => `SELECT COUNT(*) AS n FROM ${qualified(engine, schema, n)}`;
  const cols = (n) => engine === 'sqlite' ? null
    : engine === 'mssql' ? `SELECT c.name AS column_name, ty.name AS data_type, c.is_nullable AS nullable, c.is_identity AS is_identity FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(${lit(`${schema}.${n}`)}) ORDER BY c.column_id`
      : engine === 'mysql' ? `SELECT column_name AS column_name, column_type AS data_type, is_nullable AS nullable, extra AS is_identity FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ${lit(n)} ORDER BY ordinal_position`
        : `SELECT column_name AS column_name, data_type AS data_type, is_nullable AS nullable, is_identity AS is_identity FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(n)} ORDER BY ordinal_position`;
  return { origCount: cnt(name), backupCount: cnt(backup), origCols: cols(name), backupCols: cols(backup) };
}

export function definitionQueryFor(engine, schema, name, kind) { return CATALOG[engine]?.definition({ schema, name, kind }); }
export { objKey, splitName };
