// Protected schema changes and environment policy (DEV migration-first, STAGING user-controlled, PRODUCTION strict).
// EVERYTHING HERE IS MOCKED: FakeServer is an in-memory fake that records the exact SQL the adapter would send; the migration
// runner is a stub. No real database, no real DDL, no live credentials. Real-DB behaviour is listed as NOT VERIFIED in the report.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoTelemetry, allFiles } from './helpers.mjs';
import { project, CONFIG_FIXTURES as F, CANARY, FakeServer, kinds } from './db-helpers.mjs';
import { databaseCommand } from '../scripts/lib/database/cli.mjs';
import { detectDatabaseConfig } from '../scripts/lib/database/config.mjs';
import { discoverCatalog } from '../scripts/lib/database/adapters.mjs';
import { applyModel, showObject } from '../scripts/lib/database/store.mjs';
import * as chg from '../scripts/lib/database/change.mjs';
import { backupName, tableBackup, procedureBackup, BackupBlocked } from '../scripts/lib/database/backup.mjs';
import { assertReadOnly, classifyShell } from '../scripts/lib/database/guard.mjs';

let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry"));

const NOW = () => new Date('2026-11-06T18:30:00Z'); // 2026-11-07 01:30 in Asia/Jakarta
const SQL_ADD = 'ALTER TABLE dbo.Members ADD Phone NVARCHAR(20) NULL;\n';
const SQL_PROC = "ALTER PROCEDURE dbo.sp_MembershipReport @Year int AS SELECT 1 AS changed;\n";
const SQL_DROP = 'DROP TABLE dbo.Orders;\n';

async function scenario(env, { migration = SQL_ADD, extra = {}, server = {}, engine = 'mssql' } = {}) {
  const dir = project({ ...F.mssqlWebConfig, 'db/migration/V2__change.sql': migration, ...extra });
  const t = detectDatabaseConfig(dir)[0];
  if (env) await databaseCommand(dir, { _: ['target', 'confirm', t.id, env] });
  const srv = new FakeServer(engine, server);
  const model = await discoverCatalog(engine, srv.read);
  applyModel(dir, { target: t, model, source: 'catalog' });
  srv.reads.length = 0;
  const migrations = []; const runMigration = (cmd, args) => { migrations.push([cmd, ...args]); return { status: 0 }; };
  const deps = { executor: (_t, mode) => (mode === 'write' ? srv.write : srv.read), runMigration, now: NOW, model };
  const cli = (...a) => databaseCommand(dir, { _: a.filter((x) => typeof x === 'string'), ...Object.assign({}, ...a.filter((x) => typeof x === 'object')) }, deps);
  const plan = async (file = 'db/migration/V2__change.sql', o = {}) => { await cli('plan-change', { file, ...o }); const id = chg.listPlans(dir).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop().id; return chg.loadPlan(dir, id); };
  const approve = (p, stage) => cli('approve', p.id, { stage, phrase: chg.approvalPhrase(p, stage) });
  return { dir, t, srv, model, migrations, deps, cli, plan, approve };
}
const noBackupObjects = (srv) => assert.ok(!srv.writes.some((s) => /_rmc_/.test(s)));
const audit = (dir) => fs.readFileSync(chg.auditFile(dir), 'utf8').trim().split('\n').map(JSON.parse);

// ---------- DEV: migration-first, no backup objects ----------
test('DEV: a schema change is a migration; no backup objects, snapshots or _rmc_ names are produced', async () => {
  const s = await scenario('DEV');
  const p = await s.plan();
  assert.equal(p.environment, 'DEV'); assert.equal(p.policy.backup, false); assert.equal(p.backup.status, 'not-required');
  assert.equal(p.migration.framework, 'flyway'); assert.equal(p.migration.runner, 'flyway migrate');
  await assert.rejects(() => s.cli('backup', p.id), /does not use backup objects/);
  noBackupObjects(s.srv);
  assert.ok(!allFiles(path.join(s.dir, '.rmcontext')).some((f) => /_rmc_\d{8}/.test(f)));
});
test('DEV: the reviewed migration runs through the project\'s own migration command after the target is verified', async () => {
  const s = await scenario('DEV');
  const p = await s.plan();
  const out = await s.cli('apply', p.id);
  assert.match(out, /Migration applied \(DEV\)/);
  assert.deepEqual(s.migrations, [['flyway', 'migrate']], 'existing framework runner, not raw SQL');
  assert.equal(s.srv.writes.length, 0, 'RM Context itself sends no SQL; the framework does');
  assert.ok(s.srv.reads.some((q) => /DB_NAME\(\)/.test(q)), 'identity was verified with a read-only probe');
  assert.equal(chg.loadPlan(s.dir, p.id).stage, 'applied');
});
test('DEV: a destructive migration needs impact review and approval even in DEV', async () => {
  const s = await scenario('DEV', { migration: SQL_DROP });
  const p = await s.plan();
  assert.ok(p.destructive.some((d) => /drop table Orders/.test(d)));
  await assert.rejects(() => s.cli('apply', p.id), /Destructive migration in DEV/);
  assert.equal(s.migrations.length, 0);
  await s.approve(p, 'destructive');
  await s.cli('apply', p.id); assert.equal(s.migrations.length, 1);
});
test('DEV approval is not valid for STAGING or PRODUCTION; approvals are bound to environment, target and plan', async () => {
  const dev = await scenario('DEV', { migration: SQL_DROP }); const pd = await dev.plan(); await dev.approve(pd, 'destructive');
  const stg = await scenario('STAGING'); const ps = await stg.plan();
  await assert.rejects(() => stg.cli('approve', ps.id, { stage: 'backup', phrase: chg.approvalPhrase(pd, 'destructive') }), /phrase mismatch/);
  await assert.rejects(() => stg.cli('approve', ps.id, { stage: 'backup', phrase: chg.approvalPhrase(pd, 'backup') }), /phrase mismatch/, 'a DEV phrase does not work for STAGING');
  // copying an approval record across plans does not validate
  const stolen = chg.loadPlan(dev.dir, pd.id).approvals[0];
  const p2 = chg.loadPlan(stg.dir, ps.id); p2.approvals.push({ ...stolen, stage: 'apply' }); assert.equal(chg.hasApproval(p2, 'apply'), false);
  // a change to the plan after approval invalidates it
  const prod = await scenario('PRODUCTION'); const pp = await prod.plan(); await prod.cli('backup', pp.id); await prod.approve(pp, 'backup');
  const fresh = chg.loadPlan(prod.dir, pp.id); assert.equal(chg.hasApproval(fresh, 'backup', NOW), true);
  fresh.allowedStatements.backup = ['deadbeef']; assert.equal(chg.hasApproval(fresh, 'backup', NOW), false);
});

// ---------- UNKNOWN ----------
test('UNKNOWN environment blocks every mutation path and no connection is opened', async () => {
  const s = await scenario(null);
  const p = await s.plan();
  assert.equal(p.environment, 'UNKNOWN'); assert.match(p.blockedReason, /target confirm/);
  await assert.rejects(() => s.cli('approve', p.id, { stage: 'backup', phrase: chg.approvalPhrase(p, 'backup') }), /UNKNOWN/);
  await assert.rejects(() => s.cli('backup', p.id), /UNKNOWN/);
  await assert.rejects(() => s.cli('apply', p.id, { 'user-requested': true }), /UNKNOWN/);
  assert.equal(s.migrations.length, 0); assert.equal(s.srv.writes.length, 0);
  await assert.rejects(() => s.cli('discover', { connect: true, approve: s.t.id }), /UNKNOWN/);
});
test('target mismatch is blocked: the live identity must equal the plan\'s database', async () => {
  const s = await scenario('DEV', { server: { database: 'SomethingElseDb' } });
  const p = await s.plan();
  await assert.rejects(() => s.cli('apply', p.id), /Target mismatch/);
  assert.equal(s.migrations.length, 0);
});

// ---------- discovery is read-only everywhere ----------
test('discovery is read-only in LOCAL, DEV, TEST, STAGING, PRODUCTION: only SELECT-only catalog statements are sent', async () => {
  for (const env of ['LOCAL', 'DEV', 'TEST', 'STAGING', 'PRODUCTION']) {
    const s = await scenario(env);
    s.srv.reads.length = 0;
    const out = await s.cli('discover', { connect: true, approve: s.t.id });
    assert.match(out, new RegExp(`\\[${env}\\]`));
    assert.ok(s.srv.reads.length > 8, env);
    for (const q of s.srv.reads) assert.doesNotThrow(() => assertReadOnly(q), `${env}: ${q.slice(0, 60)}`);
    assert.equal(s.srv.writes.length, 0, env);
    assert.ok(!s.srv.reads.some((q) => /FROM (dbo\.)?Members\b(?! m)/i.test(q) && !/sys\.|information_schema/i.test(q)), 'no application rows selected');
  }
});
test('the guarded executor rejects a mutating statement before it reaches the server (direct SQL cannot bypass)', async () => {
  const srv = new FakeServer('mssql');
  await assert.rejects(() => discoverCatalog('mssql', async (sql) => srv.read(sql), {}).then(() => { throw new Error('ok'); }), /ok/); // baseline
  const { guardedExecutor } = await import('../scripts/lib/database/guard.mjs');
  const ex = guardedExecutor(srv.write, { engine: 'mssql' });
  for (const bad of ['DROP TABLE dbo.Members', 'CREATE TABLE x(a int)', "EXEC dbo.sp_MembershipReport 2026", 'SELECT * INTO bk FROM dbo.Members']) await assert.rejects(() => ex(bad), /read-only|Only SELECT|forbidden|rejected/i, bad);
  assert.equal(srv.writes.length, 0);
});

// ---------- STAGING ----------
test('STAGING: Claude does not apply by default; a manual package is produced and nothing in the database changes', async () => {
  const s = await scenario('STAGING');
  const p = await s.plan();
  assert.equal(p.policy.apply, 'user-controlled');
  await assert.rejects(() => s.cli('apply', p.id), /does not apply migrations by default/);
  const out = await s.cli('package', p.id);
  assert.match(out, /Claude changed nothing in the database/);
  const dir = path.join(s.dir, '.rmcontext/backups/database/20261107/change-plan', p.id, 'package');
  for (const f of ['migration.sql', 'rollback.sql', 'README.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /native backup/i);
  assert.equal(s.srv.writes.length, 0); assert.equal(s.migrations.length, 0);
});
test('STAGING Claude-apply: backup is planned, approved, created, verified, then the final approval and the reviewed migration (in that order)', async () => {
  const s = await scenario('STAGING');
  const p = await s.plan();
  const order = [];
  // 1 apply is blocked until a verified backup exists
  await assert.rejects(() => s.cli('apply', p.id, { 'user-requested': true }), /backup is not verified|Rollback instructions|Final approval/);
  // 2 backup plan (no writes yet)
  const plan = await s.cli('backup', p.id);
  assert.match(plan, /table Members → Members_rmc_20261107/); assert.match(plan, /not preserved: .*foreign key|triggers, permissions/);
  assert.equal(s.srv.writes.length, 0, 'planning a backup sends nothing'); order.push('plan');
  // 3 backup creation needs approval first
  await assert.rejects(() => s.cli('backup', p.id, { execute: true }), /Backup needs approval first/);
  await s.approve(chg.loadPlan(s.dir, p.id), 'backup');
  await s.cli('backup', p.id, { execute: true }); order.push('create');
  assert.deepEqual(kinds(s.srv.writes).filter((k, i, a) => a.indexOf(k) === i).sort(), ['CREATE', 'INSERT', 'SET'].sort());
  assert.match(s.srv.writes[0], /^CREATE TABLE \[dbo\]\.\[Members_rmc_20261107\]/);
  assert.match(s.srv.writes.join('\n'), /IDENTITY\(1,1\)[\s\S]*PRIMARY KEY[\s\S]*SET IDENTITY_INSERT[\s\S]*INSERT INTO \[dbo\]\.\[Members_rmc_20261107\][\s\S]*SELECT .* FROM \[dbo\]\.\[Members\]/);
  assert.ok(!s.srv.writes.some((q) => /^(DROP|TRUNCATE|DELETE|UPDATE|EXEC)/i.test(q)), 'backup never drops or overwrites');
  // 4 still blocked: created but not verified
  await assert.rejects(() => s.cli('apply', p.id, { 'user-requested': true }), /backup is not verified/);
  const v = await s.cli('verify-backup', p.id); assert.match(v, /Backup VERIFIED/); order.push('verify');
  // 5 rollback + final approval
  await assert.rejects(() => s.cli('apply', p.id, { 'user-requested': true }), /Final approval/);
  await s.approve(chg.loadPlan(s.dir, p.id), 'apply');
  await assert.rejects(() => s.cli('apply', p.id, { 'user-requested': true }), /Rollback instructions must be prepared/);
  await s.cli('rollback', p.id);
  await s.cli('apply', p.id, { 'user-requested': true }); order.push('apply');
  assert.deepEqual(s.migrations, [['flyway', 'migrate']]);
  assert.deepEqual(order, ['plan', 'create', 'verify', 'apply']);
  const ev = audit(s.dir).map((e) => e.event);
  assert.deepEqual(ev.filter((e, i, a) => a.indexOf(e) === i).filter((e) => ['plan-change', 'plan-backup', 'backup-created', 'verify-backup', 'rollback-prepared', 'apply-start', 'apply'].includes(e)), ['plan-change', 'plan-backup', 'backup-created', 'verify-backup', 'rollback-prepared', 'apply-start', 'apply']);
  const mf = JSON.parse(fs.readFileSync(path.join(s.dir, '.rmcontext/backups/database/20261107/manifest.json'), 'utf8')).entries[0];
  assert.deepEqual([mf.environment, mf.original, mf.backup, mf.status, mf.operation], ['STAGING', 'dbo.Members', 'dbo.Members_rmc_20261107', 'verified', 'backup']);
});
test('backup failure or an unverifiable backup blocks the migration', async () => {
  const s = await scenario('STAGING');
  const p = await s.plan(); await s.cli('backup', p.id); await s.approve(chg.loadPlan(s.dir, p.id), 'backup');
  s.srv.faithful = false; // backup row count differs
  await s.cli('backup', p.id, { execute: true });
  const v = await s.cli('verify-backup', p.id); assert.match(v, /NOT verified/); assert.match(v, /FAIL/);
  assert.equal(chg.loadPlan(s.dir, p.id).backup.status, 'verification-failed');
  await s.approve(chg.loadPlan(s.dir, p.id), 'apply'); await s.cli('rollback', p.id);
  await assert.rejects(() => s.cli('apply', p.id, { 'user-requested': true }), /backup is not verified/);
  assert.equal(s.migrations.length, 0);
});
test('an existing backup name is never overwritten or dropped', async () => {
  const s = await scenario('STAGING', { server: { existing: ['Members_rmc_20261107'] } });
  const p = await s.plan();
  const out = await s.cli('backup', p.id);
  assert.match(out, /BLOCKER: Members_rmc_20261107 already exists: it will not be overwritten or dropped/);
  assert.equal(chg.loadPlan(s.dir, p.id).backup.status, 'blocked');
  await assert.rejects(() => s.cli('backup', p.id, { execute: true }), /blocked|blockers|Backup blocked/i);
  assert.equal(s.srv.writes.length, 0);
});
test('cancel makes no change and clears approvals', async () => {
  const s = await scenario('STAGING'); const p = await s.plan(); await s.cli('backup', p.id); await s.approve(chg.loadPlan(s.dir, p.id), 'backup');
  await s.cli('cancel', p.id);
  const c = chg.loadPlan(s.dir, p.id); assert.equal(c.stage, 'cancelled'); assert.deepEqual(c.approvals, []);
  assert.equal(s.srv.writes.length, 0); assert.equal(s.migrations.length, 0);
  await assert.rejects(() => s.cli('apply', p.id, { 'user-requested': true }), /cancelled/);
});

// ---------- PRODUCTION ----------
test('PRODUCTION: never applied automatically; apply needs approval, verified object backup and a native backup attestation', async () => {
  const s = await scenario('PRODUCTION', { migration: SQL_DROP.replace('Orders', 'Orders') });
  const p = await s.plan();
  assert.equal(p.policy.tier, 'production'); assert.equal(p.nativeBackup.required, true);
  await assert.rejects(() => s.cli('apply', p.id), /does not apply migrations by default/);
  await s.cli('backup', p.id); await s.approve(chg.loadPlan(s.dir, p.id), 'backup'); await s.cli('backup', p.id, { execute: true }); await s.cli('verify-backup', p.id);
  await s.cli('rollback', p.id); await s.approve(chg.loadPlan(s.dir, p.id), 'apply');
  await assert.rejects(() => s.cli('apply', p.id, { 'user-requested': true }), /native backup\/snapshot is required/);
  await s.cli('native-backup', p.id, { ref: 'snap-2026-11-07-0130' });
  assert.equal(chg.loadPlan(s.dir, p.id).nativeBackup.attested, true);
  await s.cli('apply', p.id, { 'user-requested': true });
  assert.equal(s.migrations.length, 1);
  assert.ok(audit(s.dir).some((e) => e.event === 'native-backup' && e.result === 'attested'));
});
test('PRODUCTION: a QA pass or a DEV/STAGING success is not approval; the exact phrase names environment, database and plan', async () => {
  const s = await scenario('PRODUCTION'); const p = await s.plan();
  assert.equal(chg.approvalPhrase(p, 'apply'), `APPROVE APPLY PRODUCTION MembersDb ${p.id}`);
  await assert.rejects(() => s.cli('approve', p.id, { stage: 'apply', phrase: 'looks good, QA passed' }), /phrase mismatch/);
  await assert.rejects(() => s.cli('approve', p.id, { stage: 'apply', phrase: chg.approvalPhrase(p, 'apply').replace('PRODUCTION', 'STAGING') }), /phrase mismatch/);
});
test('mutation gate: a statement that is not part of the approved plan can never reach an executor', async () => {
  const s = await scenario('STAGING'); const p = await s.plan(); await s.cli('backup', p.id); await s.approve(chg.loadPlan(s.dir, p.id), 'backup');
  const pl = chg.loadPlan(s.dir, p.id);
  await assert.rejects(() => chg.gatedExecute(s.dir, pl, 'backup', ['DROP TABLE dbo.Members'], s.srv.write, { nowFn: NOW }), /not part of the approved backup plan/);
  await assert.rejects(() => chg.gatedExecute(s.dir, pl, 'backup', ['CREATE TABLE evil (a int)'], s.srv.write, { nowFn: NOW }), /not part of the approved/);
  assert.equal(s.srv.writes.length, 0);
  assert.ok(audit(s.dir).some((e) => e.event === 'blocked' && e.result === 'statement-not-in-plan'));
});
test('a migration changed after review is refused', async () => {
  const s = await scenario('DEV'); const p = await s.plan();
  fs.appendFileSync(path.join(s.dir, 'db/migration/V2__change.sql'), 'DROP TABLE dbo.Members;\n');
  await assert.rejects(() => s.cli('apply', p.id), /changed after it was reviewed/);
  assert.equal(s.migrations.length, 0);
});
test('no migration runner (plain SQL): the CLI refuses to execute raw SQL and offers the package instead', async () => {
  const dir = project({ ...F.mssqlWebConfig, 'sql/change.sql': SQL_ADD });
  const t = detectDatabaseConfig(dir)[0]; await databaseCommand(dir, { _: ['target', 'confirm', t.id, 'DEV'] });
  await databaseCommand(dir, { _: ['plan-change'], file: 'sql/change.sql' }, { now: NOW });
  const p = chg.listPlans(dir)[0]; assert.equal(p.migration.runner, null);
  await assert.rejects(() => databaseCommand(dir, { _: ['apply', p.id], 'confirm-target': true }, { runMigration: () => { throw new Error('ran'); } }), /No migration runner/);
});

// ---------- backup generation per engine ----------
test('backup names: _rmc_YYYYMMDD in Asia/Jakarta, no silent truncation, optional extra timestamp', () => {
  assert.equal(backupName('mssql', 'Members', { now: new Date('2026-11-06T18:30:00Z') }), 'Members_rmc_20261107');
  assert.equal(backupName('mssql', 'Members', { now: new Date('2026-11-06T16:30:00Z') }), 'Members_rmc_20261106', 'still the 6th in Jakarta at 23:30');
  assert.equal(backupName('mssql', 'sp_MembershipReport', { now: new Date('2026-11-07T00:00:00Z') }), 'sp_MembershipReport_rmc_20261107');
  assert.match(backupName('mssql', 'Members', { now: new Date('2026-11-07T08:30:45Z'), extraTimestamp: true }), /^Members_rmc_20261107_153045$/);
  assert.equal(backupName('mssql', 'Members', { now: new Date('2026-11-07T00:00:00Z'), tz: 'UTC' }), 'Members_rmc_20261107');
  assert.throws(() => backupName('postgres', 'x'.repeat(60)), (e) => e instanceof BackupBlocked && /allows 63/.test(e.message));
  assert.throws(() => backupName('mysql', 'y'.repeat(52)), BackupBlocked);
});
test('procedure backup: CREATE under the suffixed name with the original body; never EXEC; encrypted definitions stop', async () => {
  const s = await scenario('STAGING', { migration: SQL_PROC });
  const p = await s.plan(); assert.ok(p.affected.some((a) => a.kind === 'procedure' && a.op === 'alter'));
  await s.cli('backup', p.id); await s.approve(chg.loadPlan(s.dir, p.id), 'backup'); await s.cli('backup', p.id, { execute: true });
  assert.equal(s.srv.writes.length, 1);
  assert.match(s.srv.writes[0], /^CREATE PROCEDURE \[dbo\]\.\[sp_MembershipReport_rmc_20261107\] @Year int AS/);
  assert.match(s.srv.writes[0], /JOIN dbo\.Orders o ON o\.MemberId = m\.Id/, 'original body preserved');
  assert.ok(!s.srv.writes.some((q) => /^EXEC/i.test(q)));
  assert.match(await s.cli('verify-backup', p.id), /definition-hash/);
  assert.equal(chg.loadPlan(s.dir, p.id).backup.status, 'verified');
  assert.throws(() => procedureBackup('mssql', { kind: 'procedure', schema: 'dbo', name: 'sp_Encrypted', definition: null, encrypted: true }, 'sp_Encrypted_rmc_20261107'), (e) => e instanceof BackupBlocked && /encrypted/.test(e.message));
});
test('table backup strategies per engine; characteristics that cannot be preserved block instead of continuing', () => {
  const t = { schema: 'dbo', name: 'Members', columns: [{ name: 'Id', type: 'int', nullable: false, identity: true, pk: true }, { name: 'Name', type: 'nvarchar(100)', nullable: false, default: "('x')" }], primaryKey: ['Id'], foreignKeys: [{ columns: ['X'], ref: { name: 'Y' }, refColumns: ['Id'] }], uniques: [{ name: 'u', columns: ['Name'] }], checks: [], indexes: [{ name: 'ix', columns: ['Name'], unique: false }] };
  const ms = tableBackup('mssql', t, 'Members_rmc_20261107');
  assert.match(ms.statements[0], /\[Id\] int IDENTITY\(1,1\) NOT NULL,[\s\S]*\[Name\] nvarchar\(100\) NOT NULL DEFAULT \('x'\)[\s\S]*PRIMARY KEY \(\[Id\]\)[\s\S]*UNIQUE \(\[Name\]\)/);
  assert.ok(ms.statements.some((q) => /^CREATE INDEX/.test(q)) && ms.statements.some((q) => /SET IDENTITY_INSERT .* ON/.test(q)));
  assert.ok(ms.notPreserved.some((n) => /foreign key/.test(n)));
  assert.deepEqual(tableBackup('mysql', t, 'Members_rmc_20261107').statements, ['CREATE TABLE `Members_rmc_20261107` LIKE `Members`', 'INSERT INTO `Members_rmc_20261107` SELECT * FROM `Members`']);
  assert.deepEqual(tableBackup('postgres', t, 'Members_rmc_20261107').statements, ['CREATE TABLE "dbo"."Members_rmc_20261107" (LIKE "dbo"."Members" INCLUDING ALL)', 'INSERT INTO "dbo"."Members_rmc_20261107" OVERRIDING SYSTEM VALUE SELECT * FROM "dbo"."Members"']);
  const sq = tableBackup('sqlite', { ...t, schema: 'main', ddl: 'CREATE TABLE "Members" (Id integer primary key, Name text)' }, 'Members_rmc_20261107');
  assert.match(sq.statements[0], /^CREATE TABLE "Members_rmc_20261107"/);
  assert.deepEqual(tableBackup('sqlite', t, 'x').blockers.length, 1, 'no recorded DDL → blocked');
  const comp = tableBackup('mssql', { ...t, columns: [...t.columns, { name: 'Full', type: 'nvarchar(10)', nullable: true, computed: true }] }, 'Members_rmc_20261107');
  assert.equal(comp.statements.length, 0); assert.match(comp.blockers[0], /computed column/);
});
test('table backup against a real SQLite fixture file preserves structure and data (fixture, not a user database)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { sqliteExecutor, sqliteWriteExecutor } = await import('../scripts/lib/database/adapters.mjs');
  const dir = project({ ...F.noEnvAtAll });
  const f = path.join(dir, 'app.db'); const w = new DatabaseSync(f);
  w.exec("create table users(id integer primary key autoincrement, email text not null unique, name text default 'x'); create index ix_users_name on users(name); insert into users(email,name) values ('a@example.com','A'),('b@example.com','B');"); w.close();
  const read = await sqliteExecutor(f); const model = await discoverCatalog('sqlite', read); read.close();
  const t = model.tables[0];
  const gen = tableBackup('sqlite', t, backupName('sqlite', 'users', { now: NOW() }));
  assert.equal(gen.blockers.length, 0);
  const wr = await sqliteWriteExecutor(f); for (const q of gen.statements) wr(q); wr.close();
  const chk = new DatabaseSync(f, { readOnly: true });
  assert.equal(chk.prepare('select count(*) n from users_rmc_20261107').get().n, 2);
  assert.deepEqual(chk.prepare('pragma table_info(users_rmc_20261107)').all().map((c) => [c.name, c.type, c.notnull, c.pk]), chk.prepare('pragma table_info(users)').all().map((c) => [c.name, c.type, c.notnull, c.pk]));
  assert.ok(chk.prepare("select 1 from sqlite_master where type='index' and tbl_name='users_rmc_20261107'").all().length >= 1);
  chk.close();
});

// ---------- rollback ----------
test('rollback is generated but never executed automatically, and does not claim to be proven', async () => {
  const s = await scenario('STAGING', { migration: SQL_PROC });
  const p = await s.plan(); await s.cli('backup', p.id); await s.approve(chg.loadPlan(s.dir, p.id), 'backup'); await s.cli('backup', p.id, { execute: true });
  const writesBefore = s.srv.writes.length;
  const out = await s.cli('rollback', p.id);
  assert.match(out, /never run automatically/);
  const f = path.join(s.dir, '.rmcontext/backups/database/20261107/change-plan', p.id, 'rollback.sql');
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /GENERATED, NEVER EXECUTED AUTOMATICALLY/); assert.match(text, /does not mean this rollback is proven/);
  assert.match(text, /ALTER PROCEDURE dbo\.sp_MembershipReport/, 'original definition kept for restore');
  assert.equal(s.srv.writes.length, writesBefore, 'preparing a rollback sends no SQL');
  const notes = JSON.parse(fs.readFileSync(path.join(path.dirname(f), 'rollback.notes.json'), 'utf8')); assert.ok(notes.impact.length >= 2);
});

// ---------- secrets, artifacts, existing knowledge ----------
test('no credentials, connection strings or SQL text reach knowledge, audit, plans or telemetry; backups are git-ignored', async () => {
  const s = await scenario('STAGING');
  const p = await s.plan(); await s.cli('backup', p.id); await s.approve(chg.loadPlan(s.dir, p.id), 'backup'); await s.cli('backup', p.id, { execute: true }); await s.cli('verify-backup', p.id); await s.cli('rollback', p.id);
  for (const f of allFiles(path.join(s.dir, '.rmcontext'))) { const t = fs.readFileSync(f, 'utf8'); assert.ok(!t.includes(CANARY), f); assert.ok(!/Password\s*=|User ID\s*=/i.test(t), f); }
  const raw = fs.readFileSync(chg.auditFile(s.dir), 'utf8');
  assert.ok(!/CREATE TABLE|INSERT INTO|SELECT /i.test(raw), 'audit holds hashes and metadata, never SQL text');
  for (const e of audit(s.dir)) assert.ok(e.at && e.event && e.environment !== undefined);
  const tele = path.join(s.dir, '.rmcontext/state/autocontext.jsonl');
  if (fs.existsSync(tele)) assert.ok(!/_rmc_|CREATE TABLE/.test(fs.readFileSync(tele, 'utf8')), 'backup artifacts are not in telemetry');
  const gi = fs.readFileSync(path.join(s.dir, '.rmcontext/.gitignore'), 'utf8'); assert.match(gi, /^backups\/$/m);
  assert.equal(showObject(s.dir, 'table', 'dbo.Members') !== null, true, 'existing knowledge is not deleted by a change workflow');
});
test('shell classification used by the permission hook', () => {
  assert.equal(classifyShell('sqlcmd -S srv -Q "DROP TABLE x"').kind, 'db-client-mutating');
  assert.equal(classifyShell('psql -c "select 1"').kind, 'db-client');
  assert.equal(classifyShell('php artisan migrate').kind, 'migration-runner');
  assert.equal(classifyShell('npx prisma migrate deploy').kind, 'migration-runner');
  assert.equal(classifyShell('node rmc.mjs database apply CHG-1').kind, 'rmc-protected');
  assert.equal(classifyShell('ls -la').kind, 'other');
});
