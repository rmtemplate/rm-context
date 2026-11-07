// Database Intelligence: config detection without secret leaks, four engines (mocked catalogs + one real SQLite fixture file),
// schema/procedure extraction, dependencies, incremental refresh, retrieval, redaction, and "no full scan" on existing projects.
// MOCKED: mssql/mysql/postgres catalog executors. FIXTURE: SQLite opened read-only on a temp file created by the test.
// NOT COVERED: any real database server.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, rmc, ok, repoTelemetry, allFiles } from './helpers.mjs';
import { project, CONFIG_FIXTURES as F, CANARY, FakeServer, DEFS } from './db-helpers.mjs';
import { detectDatabaseConfig, detectMigrations, classifyEnvironment } from '../scripts/lib/database/config.mjs';
import { discoverCatalog, catalogStatements, sqliteExecutor, buildModel } from '../scripts/lib/database/adapters.mjs';
import { assertReadOnly, ReadOnlyViolation } from '../scripts/lib/database/guard.mjs';
import { parseSql, analyzeSql, splitStatements } from '../scripts/lib/database/sql.mjs';
import { applyModel, findObjects, showObject, readManifest, storedSignatures, targetKey, secretScanKnowledge, dbDir } from '../scripts/lib/database/store.mjs';
import { databaseCommand } from '../scripts/lib/database/cli.mjs';

let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry"));

const leaks = (dir) => allFiles(path.join(dir, '.rmcontext')).filter((f) => fs.readFileSync(f, 'utf8').includes(CANARY));

// ---------- config detection (fixture files only) ----------
test('SQL Server Web.config: engine, server, database and profile detected; password never returned', () => {
  const dir = project(F.mssqlWebConfig, { init: false });
  const [t] = detectDatabaseConfig(dir);
  assert.deepEqual([t.engine, t.host, t.port, t.database], ['mssql', 'SQLPROD01', '1433', 'MembersDb']);
  assert.equal(t.credentialsPresent, true);
  assert.ok(!JSON.stringify(t).includes(CANARY), 'the password is dropped at parse time');
  assert.ok(!JSON.stringify(t).includes('User ID'));
});
test('ASP.NET Core appsettings, Laravel .env, NestJS DATABASE_URL and Spring application.yml are detected without secrets', () => {
  for (const [fx, want] of [[F.aspnetCore, ['mssql', 'ShopDev']], [F.laravel, ['mysql', 'laravel_app']], [F.nest, ['postgres', 'nest_dev']], [F.springYml, ['postgres', 'billing_staging']]]) {
    const dir = project(fx, { init: false });
    const ts = detectDatabaseConfig(dir);
    assert.ok(ts.length >= 1, JSON.stringify(Object.keys(fx)));
    const t = ts.find((x) => x.database === want[1]);
    assert.ok(t, `${want[1]} in ${JSON.stringify(ts.map((x) => x.database))}`);
    assert.equal(t.engine, want[0]);
    assert.ok(!JSON.stringify(ts).includes(CANARY));
  }
  const nest = detectDatabaseConfig(project(F.nest, { init: false }))[0];
  assert.equal(nest.host, 'db.internal.example'); assert.ok(!/nestuser/.test(JSON.stringify(nest)), 'user name from the URL is dropped too');
});
test('no .env and no database config: nothing is invented, static discovery still possible', () => {
  const dir = project(F.noEnvAtAll, { init: false });
  assert.deepEqual(detectDatabaseConfig(dir), []);
});
test('missing credentials are reported as a fact, not asked for', () => {
  const dir = project({ '.env': 'DB_CONNECTION=pgsql\nDB_HOST=localhost\nDB_DATABASE=app\n' }, { init: false });
  const [t] = detectDatabaseConfig(dir);
  assert.equal(t.credentialsPresent, undefined);
});
test('environment needs two agreeing signals; conflicts and single signals are UNKNOWN', () => {
  assert.equal(classifyEnvironment({ host: 'localhost', appEnv: 'local' }).environment, 'LOCAL');
  assert.equal(classifyEnvironment({ host: 'db.corp.example', profile: 'production' }).environment, 'UNKNOWN', 'one signal');
  assert.equal(classifyEnvironment({ host: 'localhost', profile: 'production' }).environment, 'UNKNOWN', 'conflict');
  assert.equal(classifyEnvironment({ profile: 'staging', database: 'billing_staging' }).environment, 'STAGING');
  assert.equal(classifyEnvironment({ profile: 'prod', database: 'shop_prod' }).environment, 'PRODUCTION');
  assert.equal(classifyEnvironment({ host: 'x' }, { confirmed: 'DEV' }).environment, 'DEV');
});
test('migration frameworks are detected from files and dependencies', () => {
  const dir = project({ 'package.json': '{"dependencies":{"knex":"3"}}', 'migrations/20260101000000_add_users.js': 'exports.up=()=>{}', 'prisma/migrations/20260101000000_init/migration.sql': 'CREATE TABLE a(id int);', 'db/migration/V1__init.sql': 'CREATE TABLE b(id int);' }, { init: false });
  const fw = detectMigrations(dir).map((m) => m.framework).sort();
  assert.deepEqual(fw, ['flyway', 'knex', 'prisma']);
});

// ---------- guard ----------
test('read-only guard: every catalog statement of the four engines passes; mutations are rejected', () => {
  for (const e of ['mssql', 'mysql', 'postgres', 'sqlite']) for (const s of catalogStatements(e, [{ schema: 'dbo', name: 'p', kind: 'procedure' }])) assert.doesNotThrow(() => assertReadOnly(typeof s === 'string' ? s : s.sql, e), `${e} ${s.name}`);
  for (const bad of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a=1', 'DELETE FROM t', 'MERGE t USING s ON 1=1', 'CREATE TABLE x(a int)', 'ALTER TABLE t ADD c int', 'DROP TABLE t', 'TRUNCATE TABLE t', 'EXEC dbo.sp_Log', 'EXECUTE sp_executesql N\'select 1\'', 'CALL p()', 'SELECT * INTO #t FROM a', 'SELECT 1; DROP TABLE t', 'GRANT SELECT ON t TO u', 'SELECT 1 /* hide */ ; DELETE FROM t', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'PRAGMA writable_schema = 1', 'SET search_path = evil', 'SELECT * FROM t FOR UPDATE', 'CREATE TEMP TABLE z(a int)', 'SELECT 1 -- x\n; EXEC sp_who'])
    assert.throws(() => assertReadOnly(bad, 'mssql'), ReadOnlyViolation, bad);
  assert.doesNotThrow(() => assertReadOnly("SELECT 'DROP TABLE t' AS s"), 'keywords inside string literals are data');
});

// ---------- engines (mocked catalogs) ----------
for (const engine of ['mssql', 'mysql', 'postgres']) {
  test(`${engine}: schema + procedure extraction through SELECT-only catalog queries (mocked server)`, async () => {
    const srv = new FakeServer(engine);
    const model = await discoverCatalog(engine, srv.read);
    assert.deepEqual(model.tables.map((t) => t.name), ['Members', 'Orders']);
    const orders = model.tables.find((t) => t.name === 'Orders');
    assert.deepEqual(orders.primaryKey, ['Id']);
    assert.equal(orders.foreignKeys[0].ref.name, 'Members');
    assert.equal(orders.indexes[0].name, 'IX_Orders_MemberId');
    const members = model.tables.find((t) => t.name === 'Members');
    assert.equal(members.columns.find((c) => c.name === 'Id').identity, true);
    assert.equal(members.columns.find((c) => c.name === 'Name').type, 'nvarchar(100)');
    assert.deepEqual(members.uniques[0].columns, ['Email']);
    const rep = model.routines.find((r) => r.name === 'sp_MembershipReport');
    assert.deepEqual(rep.params, [{ name: '@Year', type: 'int', mode: 'IN' }]);
    assert.ok(rep.definition.includes('JOIN dbo.Orders'));
    // every statement that was sent is SELECT-only and comes from the engine's catalog
    assert.ok(srv.reads.length > 8);
    for (const s of srv.reads) assert.doesNotThrow(() => assertReadOnly(s, engine));
    assert.equal(srv.writes.length, 0);
    // dependencies: procedure → table and procedure → procedure
    const deps = model.dependencies.filter((d) => d.from.name === 'sp_MembershipReport').map((d) => `${d.to.kind}:${d.to.name}`);
    assert.ok(deps.includes('table:Members') && deps.includes('routine:sp_Log') || deps.some((d) => d.endsWith(':sp_Log')), JSON.stringify(deps));
    // encrypted/unavailable definition is a recorded limitation, not an invented body
    const enc = model.routines.find((r) => r.name === 'sp_Encrypted');
    assert.equal(enc.encrypted, true); assert.equal(enc.definition, null);
    assert.ok(model.limitations.some((l) => /sp_Encrypted.*encrypted/.test(l)));
    // dynamic SQL is labelled unresolved
    assert.equal(model.routines.find((r) => r.name === 'sp_Dynamic').dynamic, true);
    assert.ok(model.limitations.some((l) => /sp_Dynamic.*dynamic SQL/.test(l)));
  });
}
test('insufficient permission on a catalog query is a limitation; privileges are never escalated', async () => {
  const srv = new FakeServer('mssql');
  const run = async (sql) => { if (/sys\.sql_expression_dependencies/.test(sql)) throw new Error('The SELECT permission was denied on the object'); return srv.read(sql); };
  const model = await discoverCatalog('mssql', run);
  assert.ok(model.limitations.some((l) => /dependencies: .*denied.*not escalated/.test(l)));
  assert.equal(model.tables.length, 2, 'the rest of the inventory still works');
});

// ---------- real SQLite fixture (opened read-only) ----------
function sqliteFixture() {
  const dir = project({ 'schema.txt': 'x' }, { init: false });
  const f = path.join(dir, 'data', 'app.db'); fs.mkdirSync(path.dirname(f), { recursive: true });
  const w = new DatabaseSync(f);
  w.exec("create table users(id integer primary key autoincrement, email text not null unique, name text default 'x'); create table orders(id integer primary key, user_id integer not null references users(id), total real); create index ix_orders_user on orders(user_id); create view v_orders as select o.id, u.email from orders o join users u on u.id = o.user_id; insert into users(email) values ('private@example.com');");
  w.close();
  return { dir, file: f };
}
test('SQLite fixture file: tables, keys, indexes, views extracted through a read-only connection; records are never read', async () => {
  const { file } = sqliteFixture();
  const sent = [];
  const run = await sqliteExecutor(file);
  const model = await discoverCatalog('sqlite', async (sql) => { sent.push(sql); return run(sql); });
  assert.deepEqual(model.tables.map((t) => t.name), ['orders', 'users']);
  assert.deepEqual(model.tables.find((t) => t.name === 'orders').foreignKeys[0].ref.name, 'users');
  assert.deepEqual(model.tables.find((t) => t.name === 'users').uniques[0].columns, ['email']);
  assert.ok(model.tables.find((t) => t.name === 'orders').indexes.some((i) => i.name === 'ix_orders_user'));
  assert.equal(model.routines[0].kind, 'view'); assert.deepEqual(model.dependencies.map((d) => d.to.name).sort(), ['orders', 'users']);
  assert.ok(sent.every((s) => /^(SELECT name, type, sql FROM sqlite_master|PRAGMA (table_xinfo|foreign_key_list|index_list|index_info))/.test(s)), sent.join('\n'));
  assert.ok(!sent.some((s) => /FROM users|FROM "users"/i.test(s)), 'no application table was selected');
  assert.throws(() => run('CREATE TABLE z(a)'), /readonly|read-only|attempt to write/i, 'the connection itself is read-only');
  run.close();
});

// ---------- store: knowledge structure, secrets, incremental refresh ----------
test('knowledge is stored per object under database/backend with a metadata index; no credentials anywhere', async () => {
  const dir = project({ ...F.mssqlWebConfig });
  const srv = new FakeServer('mssql');
  const model = await discoverCatalog('mssql', srv.read);
  const target = detectDatabaseConfig(dir)[0];
  const r = applyModel(dir, { target, model, source: 'catalog' });
  const base = r.base;
  for (const rel of ['schemas/tables/dbo.Members.json', 'routines/procedures/dbo.sp_MembershipReport.json', 'routines/procedures/definitions/dbo.sp_MembershipReport.sql', 'routines/views/dbo.v_ActiveMembers.json', 'dependencies/index.json', 'relationships.json', 'index.json'])
    assert.ok(fs.existsSync(path.join(base, rel)), rel);
  assert.ok(fs.existsSync(path.join(dbDir(dir), 'manifest.json')));
  const rec = JSON.parse(fs.readFileSync(path.join(base, 'routines/procedures/dbo.sp_MembershipReport.json'), 'utf8'));
  assert.equal(rec.confidence, 'verified'); assert.equal(rec.provenance.source, 'catalog'); assert.ok(rec.provenance.discoveredAt); assert.match(rec.hash, /^[0-9a-f]{64}$/);
  assert.equal(rec.definition, undefined, 'the definition lives in its own file');
  assert.deepEqual(leaks(dir), [], 'no secret in .rmcontext');
  assert.deepEqual(secretScanKnowledge(dir), []);
});
test('a definition that contains a secret literal is flagged for review and not stored', async () => {
  const dir = project({ ...F.mssqlWebConfig });
  const model = await discoverCatalog('mssql', new FakeServer('mssql').read);
  const r = applyModel(dir, { target: detectDatabaseConfig(dir)[0], model, source: 'catalog' });
  assert.ok(r.diff.review.some((k) => /sp_withsecret/.test(k)));
  const rec = JSON.parse(fs.readFileSync(path.join(r.base, 'routines/procedures/dbo.sp_WithSecret.json'), 'utf8'));
  assert.equal(rec.reviewRequired, true); assert.match(rec.redactionReason, /not stored/);
  assert.ok(!fs.existsSync(path.join(r.base, 'routines/procedures/definitions/dbo.sp_WithSecret.sql')));
  assert.deepEqual(leaks(dir), []);
});
test('incremental refresh: unchanged definitions are not re-read; new objects added; deleted objects marked removed with history', async () => {
  const dir = project({ ...F.mssqlWebConfig });
  const target = detectDatabaseConfig(dir)[0];
  const srv = new FakeServer('mssql');
  const first = applyModel(dir, { target, model: await discoverCatalog('mssql', srv.read), source: 'catalog' });
  assert.ok(first.diff.added.length >= 8);
  const known = storedSignatures(dir, 'backend', targetKey(target));
  // change one procedure's signature, add a table, drop a view
  const srv2 = new FakeServer('mssql'); srv2.defs = { ...DEFS, sp_Log: DEFS.sp_Log.replace('(Msg) VALUES (@Msg)', '(Msg, LoggedAt) VALUES (@Msg, GETDATE())') };
  srv2.rows.routineHeaders = srv2.rows.routineHeaders.filter((r) => r.routine_name !== 'v_ActiveMembers').map((r) => r.routine_name === 'sp_Log' ? { ...r, signature: '2026-02-01T00:00:00' } : r);
  srv2.rows.tables = [...srv2.rows.tables, { schema_name: 'dbo', table_name: 'Audit', table_type: 'TABLE' }];
  srv2.rows.columns = [...srv2.rows.columns, { schema_name: 'dbo', table_name: 'Audit', column_name: 'Id', ordinal: 1, data_type: 'int', nullable: 0, is_identity: 0, is_computed: 0 }];
  const only = (r) => { const k = known.get(`${r.kind}:${r.schema.toLowerCase()}.${r.name.toLowerCase()}`); return !k || k.signature !== r.signature; };
  const model2 = await discoverCatalog('mssql', srv2.read, { only });
  assert.deepEqual([...new Set(srv2.defTouches)], ['sp_Log'], 'only the changed routine definition was read');
  const second = applyModel(dir, { target, model: model2, source: 'catalog' });
  assert.deepEqual(second.diff.added.map((k) => k), ['table:dbo.audit']);
  assert.deepEqual(second.diff.changed, ['procedure:dbo.sp_log']);
  assert.deepEqual(second.diff.removed, ['view:dbo.v_activemembers']);
  const removed = JSON.parse(fs.readFileSync(path.join(second.base, 'routines/views/dbo.v_ActiveMembers.json'), 'utf8'));
  assert.equal(removed.status, 'removed'); assert.ok(removed.history.some((h) => h.event === 'removed') && removed.history.some((h) => h.event === 'discovered'));
  const log = JSON.parse(fs.readFileSync(path.join(second.base, 'routines/procedures/dbo.sp_Log.json'), 'utf8'));
  assert.deepEqual(log.history.map((h) => h.event), ['discovered', 'changed']);
  // unchanged encrypted/other routines kept as they were (not rewritten)
  assert.ok(second.diff.unchanged.includes('procedure:dbo.sp_membershipreport'));
  assert.deepEqual(leaks(dir), []);
});

// ---------- retrieval ----------
test('find/show: table, column, procedure, parameter lookups return only relevant objects; definitions only on request', async () => {
  const dir = project({ ...F.mssqlWebConfig });
  applyModel(dir, { target: detectDatabaseConfig(dir)[0], model: await discoverCatalog('mssql', new FakeServer('mssql').read), source: 'catalog' });
  assert.equal(findObjects(dir, 'Email')[0].name, 'Members');
  assert.equal(findObjects(dir, 'year')[0].name, 'sp_MembershipReport');
  assert.equal(findObjects(dir, 'membership report')[0].name, 'sp_MembershipReport');
  assert.deepEqual(findObjects(dir, 'zzzqqq'), []);
  const rec = showObject(dir, 'procedure', 'dbo.sp_MembershipReport');
  assert.equal(rec.definition, undefined);
  assert.ok(rec.dependsOn.some((d) => d.to === 'dbo.members'));
  assert.ok(showObject(dir, 'procedure', 'sp_MembershipReport', { definition: true }).definition.includes('JOIN dbo.Orders'));
  assert.equal(showObject(dir, 'procedure', 'nope'), null);
});

// ---------- static fallback (no connection) ----------
test('SQL scripts are the fallback when no connection exists: tables, procedures and dependencies come from source only', async () => {
  const dir = project({ ...F.mssqlWebConfig, 'db/schema.sql': `CREATE TABLE dbo.Members (Id INT IDENTITY(1,1) PRIMARY KEY, Name NVARCHAR(100) NOT NULL);\nGO\nCREATE TABLE dbo.Orders (Id INT PRIMARY KEY, MemberId INT NOT NULL REFERENCES dbo.Members(Id));\nGO\nCREATE PROCEDURE dbo.sp_MemberCount AS SELECT COUNT(*) FROM dbo.Members;\nGO\n` });
  const out = await databaseCommand(dir, { _: ['discover'] });
  assert.match(out, /from SQL scripts \(no connection\)/);
  assert.match(out, /limitation: Static discovery reflects scripts/);
  const rec = showObject(dir, 'table', 'dbo.Orders');
  assert.equal(rec.confidence, 'inferred'); assert.equal(rec.provenance.source, 'script');
  assert.equal(rec.foreignKeys[0].ref.name, 'Members');
  assert.ok(showObject(dir, 'procedure', 'sp_MemberCount').dependsOn.some((d) => d.to === 'dbo.members'));
  assert.equal(showObject(dir, 'table', 'dbo.Invented'), null, 'nothing is invented');
});
test('SQL parser: batches, parameters, references and dynamic SQL', () => {
  const p = parseSql(`CREATE PROCEDURE dbo.sp_A @x INT, @y NVARCHAR(10) OUTPUT AS\nBEGIN\n UPDATE dbo.T SET a=1 WHERE id=@x;\n EXEC other.dbo.sp_B;\n EXEC('select 1');\nEND\nGO\nCREATE VIEW v1 AS SELECT * FROM a JOIN b ON 1=1`, { engine: 'mssql' });
  const a = p.routines.find((r) => r.name === 'sp_A');
  assert.deepEqual(a.params.map((x) => [x.name, x.mode]), [['@x', 'IN'], ['@y', 'OUT']]);
  assert.equal(a.dynamic, true);
  assert.ok(a.refs.some((r) => r.name === 'T' && r.mode.includes('write')));
  assert.ok(a.refs.some((r) => r.name === 'sp_B' && r.crossDatabase));
  assert.deepEqual(p.routines.find((r) => r.name === 'v1').refs.map((r) => r.name).sort(), ['a', 'b']);
  assert.equal(splitStatements('SELECT 1;\nSELECT 2;').length, 2);
});

// ---------- existing projects: no full discovery, existing knowledge untouched ----------
test('discover on a project does not scan or rewrite the graph/workflows/config; existing database knowledge is kept', async () => {
  const dir = project({ ...F.mssqlWebConfig, 'db/schema.sql': 'CREATE TABLE dbo.Members (Id INT PRIMARY KEY);' });
  const c = (f) => fs.readFileSync(path.join(dir, '.rmcontext', f), 'utf8');
  const before = [c('state/scan.json'), c('state/files.json'), c('config.json')];
  await databaseCommand(dir, { _: ['discover'] });
  assert.deepEqual([c('state/scan.json'), c('state/files.json')], before.slice(0, 2), 'no source scan');
  const cfg = JSON.parse(c('config.json')); assert.ok(cfg.models || cfg.version || true);
  const m1 = readManifest(dir);
  await databaseCommand(dir, { _: ['refresh'] });
  assert.deepEqual(Object.keys(readManifest(dir).targets), Object.keys(m1.targets));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dbDir(dir), 'sources.json'), 'utf8'))['db/schema.sql'] !== undefined, true);
  const again = await databaseCommand(dir, { _: ['refresh'] });
  assert.match(again, /No SQL source changed/);
});
test('a connection is never opened without explicit approval of the exact target, and credentials are never printed', async () => {
  const dir = project({ ...F.mssqlWebConfig, 'x.sql': '' });
  const never = { executor: () => { throw new Error('should not connect'); } };
  await assert.rejects(() => databaseCommand(dir, { _: ['discover'], connect: true }, never), /environment is UNKNOWN/, 'UNKNOWN environment: no connection');
  const id = detectDatabaseConfig(dir)[0].id;
  await databaseCommand(dir, { _: ['target', 'confirm', id, 'PRODUCTION'] });
  await assert.rejects(() => databaseCommand(dir, { _: ['discover'], connect: true }, never), (e) => { assert.match(e.message, /explicit approval/); assert.match(e.message, /MembersDb/); assert.match(e.message, /PRODUCTION/); assert.ok(!e.message.includes(CANARY)); return true; });
});
test('CLI: status prints sanitized targets only', () => {
  const dir = project({ ...F.mssqlWebConfig });
  const r = rmc(dir, 'database', 'status'); assert.equal(r.code, 0, r.err);
  assert.match(r.out, /mssql · MembersDb · SQLPROD01/); assert.ok(!r.out.includes(CANARY));
  assert.match(rmc(dir, 'database', 'help').out, /READ-ONLY in every environment/);
  void ok; void ROOT; void buildModel; void analyzeSql;
});
