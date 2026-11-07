// Read-only guard: the one gate every statement sent by database discovery must pass.
// It is an allow-list: only SELECT / WITH…SELECT / SHOW / read-only PRAGMA / session read-only SET / EXPLAIN-free metadata reads.
// Anything else is rejected before it reaches an executor. This runs in the CLI/adapter, not in a prompt.
import { RmcError } from '../util.mjs';
import { blank, sha256 } from './sql.mjs';

export class ReadOnlyViolation extends RmcError {}

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|REPLACE|GRANT|REVOKE|DENY|EXEC|EXECUTE|CALL|DO|COPY|LOAD|VACUUM|REINDEX|ATTACH|DETACH|BULK|OPENROWSET|OPENQUERY|OPENDATASOURCE|DBCC|RESTORE|BACKUP|KILL|SHUTDOWN|RECONFIGURE|LOCK|UNLOCK|RENAME|ANALYZE|OPTIMIZE|REPAIR|FLUSH|PURGE|HANDLER|PREPARE|DEALLOCATE|SAVEPOINT|COMMIT|ROLLBACK|BEGIN|START|DECLARE|USE|WAITFOR|SET_CONFIG|PG_TERMINATE_BACKEND|PG_SLEEP|LO_IMPORT|LO_EXPORT|DBLINK|XP_CMDSHELL|SP_EXECUTESQL|SP_CONFIGURE|SP_ADDLOGIN|SP_ADDSRVROLEMEMBER)\b/i;
const ALLOWED_PRAGMA = /^PRAGMA\s+(table_info|table_xinfo|table_list|foreign_key_list|index_list|index_info|index_xinfo|database_list|user_version|schema_version|encoding|page_count|page_size|collation_list)\b/i;
const ALLOWED_SET = /^SET\s+(SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION\s+READ\s+ONLY|SESSION\s+TRANSACTION\s+READ\s+ONLY|TRANSACTION\s+READ\s+ONLY|default_transaction_read_only\s*=\s*(on|true)|NOCOUNT\s+ON|LOCK_TIMEOUT\s+\d+|TRANSACTION\s+ISOLATION\s+LEVEL\s+READ\s+UNCOMMITTED|statement_timeout\s*=\s*\d+)/i;

// Returns the cleaned single statement or throws ReadOnlyViolation with a reason.
export function assertReadOnly(sql, engine = '') {
  const text = String(sql ?? '');
  const code = blank(text).trim().replace(/;+\s*$/, '');
  if (!code) throw new ReadOnlyViolation('Empty statement rejected.');
  if (/;/.test(code)) throw new ReadOnlyViolation('Multiple statements rejected: discovery sends one SELECT-only statement at a time.');
  if (ALLOWED_SET.test(code)) return text;
  if (/^PRAGMA\b/i.test(code)) {
    if (ALLOWED_PRAGMA.test(code) && !/=/.test(code)) return text;
    throw new ReadOnlyViolation('Only read-only metadata PRAGMA statements are allowed.');
  }
  if (!/^(SELECT|WITH|SHOW|VALUES)\b/i.test(code)) throw new ReadOnlyViolation(`Only SELECT / WITH / SHOW metadata queries are allowed; got "${code.split(/\s+/)[0].toUpperCase()}".`);
  if (/\bINTO\b/i.test(code) && /^SELECT\b/i.test(code) && !/\bINSERT\b/i.test(code)) {
    // SELECT … INTO creates a table (T-SQL/PG). MySQL "INTO OUTFILE/@var" writes too.
    throw new ReadOnlyViolation('SELECT … INTO is a write and is rejected.');
  }
  const m = FORBIDDEN.exec(code);
  if (m) throw new ReadOnlyViolation(`Statement contains a forbidden keyword for discovery: ${m[1].toUpperCase()}.`);
  if (/\bFOR\s+UPDATE\b|\bFOR\s+SHARE\b|\bLOCK\s+IN\b/i.test(code)) throw new ReadOnlyViolation('Locking reads are rejected.');
  return text;
}

export function isReadOnly(sql, engine) { try { assertReadOnly(sql, engine); return true; } catch { return false; } }

// A recording executor wrapper. `run(sql)` is the real (or mocked) driver; every statement is guarded, hashed, and recorded.
// The raw SQL is kept in memory for tests; the audit trail only receives hashes.
export function guardedExecutor(run, { engine, onStatement } = {}) {
  const sent = [];
  const exec = async (sql, params) => {
    assertReadOnly(sql, engine);
    const entry = { sql, hash: sha256(sql).slice(0, 16) };
    sent.push(entry);
    onStatement?.({ hash: entry.hash });
    return run(sql, params);
  };
  exec.sent = sent;
  return exec;
}

// Words in a shell command that make a database client call a mutation or a bypass of the protected workflow.
export const DB_CLIENTS = /(^|[\s;&|(])(sqlcmd|osql|bcp|mysql|mariadb|mysqladmin|mysqldump|psql|pg_dump|pg_restore|createdb|dropdb|sqlite3|sqlplus|mongosh|mongo|redis-cli)(\s|$)/i;
export const MUTATING_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|RENAME|RESTORE)\b/i;
export const MIGRATION_RUNNERS = /\b(artisan\s+migrate|prisma\s+(migrate|db\s+push)|dotnet\s+ef\s+database\s+update|flyway\s+(migrate|clean|repair)|knex\s+migrate|typeorm\s+migration:(run|revert)|alembic\s+(upgrade|downgrade)|manage\.py\s+migrate|liquibase\s+(update|rollback)|sequelize(-cli)?\s+db:migrate|rails\s+db:(migrate|rollback)|rake\s+db:migrate)\b/i;

export function classifyShell(cmd) {
  const c = String(cmd || '');
  if (/\brmc\b[^|;&]*\bdatabase\s+(approve|backup|apply|migrate)\b/i.test(c)) return { kind: 'rmc-protected' };
  if (MIGRATION_RUNNERS.test(c)) return { kind: 'migration-runner' };
  if (DB_CLIENTS.test(c)) return { kind: MUTATING_WORDS.test(c.replace(/--[\w-]+/g, '')) ? 'db-client-mutating' : 'db-client' };
  return { kind: 'other' };
}
