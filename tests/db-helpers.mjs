// Mock databases and project fixtures for Database Intelligence tests. No real database is ever contacted:
// every executor here is an in-memory fake that records the exact SQL the adapter would send.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG } from '../scripts/lib/database/adapters.mjs';
import { ok } from './helpers.mjs';

export function project(files = {}, { init = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-db-'));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  if (init) ok(dir, 'init', '--no-claude-md');
  return dir;
}

// ---- config fixtures (all passwords/tokens are fake canaries; tests assert they never reach knowledge/agents)
export const CANARY = 'Sup3rSecretCanary99';
export const CONFIG_FIXTURES = {
  mssqlWebConfig: { 'Web.config': `<configuration><connectionStrings><add name="Main" connectionString="Data Source=SQLPROD01,1433;Initial Catalog=MembersDb;User ID=sa;Password=${CANARY};" providerName="System.Data.SqlClient" /></connectionStrings></configuration>`,
    'Web.Release.config': '<configuration></configuration>' },
  aspnetCore: { 'appsettings.json': JSON.stringify({ ConnectionStrings: { Default: `Server=localhost;Database=ShopDev;User Id=app;Password=${CANARY};TrustServerCertificate=True` } }), 'appsettings.Development.json': '{}' },
  laravel: { '.env': `APP_ENV=local\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=laravel_app\nDB_USERNAME=root\nDB_PASSWORD=${CANARY}\n`, 'config/database.php': "<?php return ['default' => env('DB_CONNECTION', 'mysql'), 'connections' => []];" },
  nest: { '.env': `NODE_ENV=development\nDATABASE_URL=postgres://nestuser:${CANARY}@db.internal.example:5432/nest_dev\n`, 'package.json': '{"dependencies":{"@nestjs/core":"10","typeorm":"0.3"}}' },
  springYml: { 'src/main/resources/application.yml': `spring:\n  datasource:\n    url: jdbc:postgresql://pg.staging.example:5432/billing_staging\n    username: billing\n    password: ${CANARY}\n`, 'src/main/resources/application-staging.yml': 'spring:\n  profiles: staging\n' },
  noEnvAtAll: { 'README.md': '# nothing here\n' },
};

// ---- canonical catalog rows (shared by the mssql / mysql / postgres mocks)
const S = 'dbo';
const base = () => ({
  info: [{ database_name: 'MembersDb', version: '16.0' }],
  tables: [{ schema_name: S, table_name: 'Members', table_type: 'TABLE' }, { schema_name: S, table_name: 'Orders', table_type: 'TABLE' }],
  columns: [
    { schema_name: S, table_name: 'Members', column_name: 'Id', ordinal: 1, data_type: 'int', nullable: 0, is_identity: 1, is_computed: 0 },
    { schema_name: S, table_name: 'Members', column_name: 'Name', ordinal: 2, data_type: 'nvarchar', max_length: 100, nullable: 0, is_identity: 0, is_computed: 0 },
    { schema_name: S, table_name: 'Members', column_name: 'Email', ordinal: 3, data_type: 'nvarchar', max_length: 200, nullable: 1, is_identity: 0, is_computed: 0 },
    { schema_name: S, table_name: 'Orders', column_name: 'Id', ordinal: 1, data_type: 'int', nullable: 0, is_identity: 1, is_computed: 0 },
    { schema_name: S, table_name: 'Orders', column_name: 'MemberId', ordinal: 2, data_type: 'int', nullable: 0, is_identity: 0, is_computed: 0 },
    { schema_name: S, table_name: 'Orders', column_name: 'Total', ordinal: 3, data_type: 'decimal', nullable: 1, is_identity: 0, is_computed: 0 },
  ],
  keys: [
    { schema_name: S, table_name: 'Members', constraint_name: 'PK_Members', constraint_type: 'PRIMARY KEY', column_name: 'Id', ordinal: 1 },
    { schema_name: S, table_name: 'Orders', constraint_name: 'PK_Orders', constraint_type: 'PRIMARY KEY', column_name: 'Id', ordinal: 1 },
    { schema_name: S, table_name: 'Members', constraint_name: 'UQ_Members_Email', constraint_type: 'UNIQUE', column_name: 'Email', ordinal: 1 },
  ],
  foreignKeys: [{ schema_name: S, table_name: 'Orders', constraint_name: 'FK_Orders_Members', column_name: 'MemberId', ref_schema: S, ref_table: 'Members', ref_column: 'Id', ordinal: 1 }],
  indexes: [{ schema_name: S, table_name: 'Orders', index_name: 'IX_Orders_MemberId', is_unique: 0, column_name: 'MemberId', ordinal: 1 }],
  checks: [],
  routineHeaders: [
    { schema_name: S, routine_name: 'sp_MembershipReport', routine_type: 'procedure', signature: '2026-01-01T00:00:00' },
    { schema_name: S, routine_name: 'sp_Log', routine_type: 'procedure', signature: '2026-01-01T00:00:00' },
    { schema_name: S, routine_name: 'sp_Encrypted', routine_type: 'procedure', signature: '2026-01-01T00:00:00' },
    { schema_name: S, routine_name: 'sp_Dynamic', routine_type: 'procedure', signature: '2026-01-01T00:00:00' },
    { schema_name: S, routine_name: 'sp_WithSecret', routine_type: 'procedure', signature: '2026-01-01T00:00:00' },
    { schema_name: S, routine_name: 'v_ActiveMembers', routine_type: 'view', signature: '2026-01-01T00:00:00' },
  ],
  params: [{ schema_name: S, routine_name: 'sp_MembershipReport', param_name: '@Year', data_type: 'int', mode: 'IN', ordinal: 1 }, { schema_name: S, routine_name: 'sp_Log', param_name: '@Msg', data_type: 'nvarchar', mode: 'IN', ordinal: 1 }],
  triggerTables: [],
  dependencies: [{ schema_name: S, routine_name: 'sp_MembershipReport', ref_schema: S, ref_name: 'Members', ref_kind: 'USER_TABLE' }, { schema_name: S, routine_name: 'sp_MembershipReport', ref_schema: S, ref_name: 'sp_Log', ref_kind: 'SQL_STORED_PROCEDURE' }],
  sequences: [],
});
export const DEFS = {
  sp_MembershipReport: `CREATE PROCEDURE dbo.sp_MembershipReport @Year int AS\nBEGIN\n  SELECT m.Id, m.Name, o.Total FROM dbo.Members m JOIN dbo.Orders o ON o.MemberId = m.Id WHERE YEAR(o.Id) = @Year;\n  EXEC dbo.sp_Log @Msg = 'report';\nEND`,
  sp_Log: 'CREATE PROCEDURE dbo.sp_Log @Msg nvarchar(200) AS INSERT INTO dbo.AuditLog (Msg) VALUES (@Msg)',
  sp_Encrypted: null,
  sp_Dynamic: "CREATE PROCEDURE dbo.sp_Dynamic @t sysname AS BEGIN DECLARE @sql nvarchar(max) = 'SELECT * FROM ' + @t; EXEC(@sql); END",
  sp_WithSecret: `CREATE PROCEDURE dbo.sp_WithSecret AS BEGIN CREATE LOGIN svc WITH PASSWORD = '${CANARY}'; END`,
  v_ActiveMembers: 'CREATE VIEW dbo.v_ActiveMembers AS SELECT Id, Name FROM dbo.Members WHERE Email IS NOT NULL',
};

export class FakeServer {
  constructor(engine = 'mssql', { rows = base(), defs = { ...DEFS }, counts = { Members: 120, Orders: 480 }, database = 'MembersDb', existing = [] } = {}) {
    this.engine = engine; this.rows = rows; this.defs = defs; this.counts = { ...counts }; this.database = database; this.existing = new Set(existing);
    this.reads = []; this.writes = []; this.created = new Map(); this.faithful = true; this.defTouches = [];
  }
  get cat() { return CATALOG[this.engine]; }
  read = async (sql) => {
    this.reads.push(sql);
    const c = this.cat;
    for (const k of Object.keys(this.rows)) if (c[k] && sql === c[k]) return this.rows[k];
    if (/DB_NAME\(\)|current_database\(\)|DATABASE\(\) AS database_name|'main' AS database_name/.test(sql) && /database_name/.test(sql)) return [{ database_name: this.database }];
    const lit = /= '([^']+)'(?:[^']*)$/.exec(sql)?.[1];
    if (/ AS definition,/.test(sql)) {
      const names = [...sql.matchAll(/= '([^']+)'/g)].map((m) => m[1]); const nm = names[names.length - 1];
      this.defTouches.push(nm);
      if (nm in this.defs) return [{ schema_name: S, routine_name: nm, definition: this.defs[nm], is_encrypted: this.defs[nm] == null ? 1 : 0 }];
      if (this.created.has(nm)) { const o = this.created.get(nm); return [{ schema_name: S, routine_name: nm, definition: o.def, is_encrypted: 0 }]; }
      return [];
    }
    if (/^SELECT COUNT\(\*\) AS n FROM/.test(sql)) { const nm = /FROM (?:\S+\.)?[`"\[]?(\w+)[`"\]]?$/.exec(sql)?.[1]; const t = this.created.get(nm); return [{ n: t ? (this.faithful ? t.count : t.count - 1) : this.counts[nm] ?? 0 }]; }
    if (/AS column_name, /.test(sql) && /ordinal|column_id/.test(sql) && !/ FROM sys\.tables|information_schema\.tables/.test(sql)) { const nm = /table_name = '([^']+)'|OBJECT_ID\('(?:\w+\.)?(\w+)'\)/.exec(sql); const name = nm?.[1] || nm?.[2]; const base_ = (this.created.get(name) || {}).of || name; return this.rows.columns.filter((x) => x.table_name === base_).map((x) => ({ column_name: x.column_name, data_type: x.data_type, nullable: x.nullable, is_identity: x.is_identity })); }
    if (/_rmc_/.test(sql) || /sqlite_master WHERE name =|sys\.objects o JOIN sys\.schemas s ON s\.schema_id = o\.schema_id WHERE s\.name =/.test(sql)) { const nm = [...sql.matchAll(/= '([^']+)'/g)].map((m) => m[1]).pop(); return this.existing.has(nm) || this.created.has(nm) ? [{ name: nm }] : []; }
    void lit;
    return [];
  };
  write = async (sql) => {
    this.writes.push(sql);
    const m = /CREATE (?:TABLE|PROCEDURE|OR REPLACE PROCEDURE|FUNCTION|VIEW)\s+(?:IF NOT EXISTS\s+)?(?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?(\w+_rmc_\d{8}(?:_\d{6})?)[`"\]]?/i.exec(sql);
    if (m) { const nm = m[1]; const orig = nm.replace(/_rmc_\d{8}(_\d{6})?$/, ''); this.created.set(nm, { of: orig, count: /TABLE/i.test(sql) ? 0 : undefined, def: sql }); }
    const ins = /INSERT INTO (?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?(\w+_rmc_\d{8}(?:_\d{6})?)[`"\]]?/i.exec(sql);
    if (ins) { const t = this.created.get(ins[1]); if (t) t.count = this.counts[t.of] ?? 0; }
    return [];
  };
}

export const kinds = (sqls) => sqls.map((s) => s.trim().split(/\s+/)[0].toUpperCase());
export const readme = (...a) => a.join('\n');
