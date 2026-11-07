// Permission boundary (PreToolUse Bash) and the existing-project / CLAUDE.md / retrieval integration of Database + Mobile Intelligence.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, rmc, ok, repoTelemetry } from './helpers.mjs';
import { project, CONFIG_FIXTURES as F, FakeServer } from './db-helpers.mjs';
import { databaseCommand } from '../scripts/lib/database/cli.mjs';
import { detectDatabaseConfig } from '../scripts/lib/database/config.mjs';
import { discoverCatalog } from '../scripts/lib/database/adapters.mjs';
import { applyModel } from '../scripts/lib/database/store.mjs';
import { CLAUDE_SECTION, CLAUDE_POLICY } from '../scripts/lib/project.mjs';
import { databaseContext, dataMobileContext } from '../scripts/lib/database/context.mjs';
import { ctx } from '../scripts/lib/util.mjs';
import { retrieveTargeted } from '../scripts/lib/context.mjs';

let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry"));

const HOOK = path.join(ROOT, 'scripts', 'hooks.mjs');
const bash = (cwd, command) => {
  const r = spawnSync(process.execPath, [HOOK, 'pre-bash'], { cwd, input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command }, session_id: 'db-hook-test' }), encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: '' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
async function withPlan(env) {
  const dir = project({ ...F.mssqlWebConfig, 'db/migration/V2__c.sql': 'ALTER TABLE dbo.Members ADD Phone nvarchar(20);' });
  const t = detectDatabaseConfig(dir)[0];
  await databaseCommand(dir, { _: ['target', 'confirm', t.id, env] });
  await databaseCommand(dir, { _: ['plan-change'], file: 'db/migration/V2__c.sql' });
  const f = fs.readdirSync(path.join(dir, '.rmcontext/state/database-changes'))[0];
  return { dir, id: f.replace('.json', '') };
}

test('hook: mutating database clients are denied; read-only ones are allowed when no change is active', async () => {
  const dir = project({ 'a.txt': 'x' });
  assert.equal(bash(dir, 'ls -la'), null);
  assert.equal(bash(dir, 'sqlcmd -S srv -Q "DROP TABLE dbo.Members"').permissionDecision, 'deny');
  assert.equal(bash(dir, 'psql -c "UPDATE users SET x=1"').permissionDecision, 'deny');
  assert.equal(bash(dir, 'mysql -e "select 1"'), null, 'a read-only client call is not blocked outside a protected workflow');
});
test('hook: while a change plan is active, direct db clients are denied and migration runners need the CLI', async () => {
  const { dir } = await withPlan('STAGING');
  assert.equal(bash(dir, 'psql -c "select 1"').permissionDecision, 'deny');
  assert.match(bash(dir, 'psql -c "select 1"').permissionDecisionReason, /rmc database/);
  assert.equal(bash(dir, 'php artisan migrate').permissionDecision, 'deny');
  assert.equal(bash(dir, 'flyway migrate').permissionDecision, 'deny');
});
test('hook: a direct migration runner outside any plan asks for confirmation', async () => {
  const dir = project({ 'a.txt': 'x' });
  assert.equal(bash(dir, 'npx prisma migrate deploy').permissionDecision, 'ask');
});
test('hook: approvals and protected steps ask the user; DEV plan steps do not', async () => {
  const stg = await withPlan('STAGING');
  const a = bash(stg.dir, `node rmc.mjs database approve ${stg.id} --stage backup --phrase "APPROVE BACKUP STAGING MembersDb ${stg.id}"`);
  assert.equal(a.permissionDecision, 'ask'); assert.match(a.permissionDecisionReason, /STAGING change/);
  assert.equal(bash(stg.dir, `rmc database apply ${stg.id} --user-requested`).permissionDecision, 'ask');
  assert.equal(bash(stg.dir, `rmc database backup ${stg.id}`), null, 'planning a backup is not a protected step');
  assert.equal(bash(stg.dir, `rmc database backup ${stg.id} --execute`).permissionDecision, 'ask');
  const prod = await withPlan('PRODUCTION');
  assert.equal(bash(prod.dir, `rmc database apply ${prod.id}`).permissionDecision, 'ask');
  const dev = await withPlan('DEV');
  assert.equal(bash(dev.dir, `rmc database apply ${dev.id}`), null, 'DEV migration: no extra prompt from RM Context');
  assert.equal(bash(dev.dir, `rmc database approve ${dev.id} --stage destructive --phrase x`).permissionDecision, 'ask', 'approvals always ask');
});
test('hook: outside an RM Context project nothing happens and the hook never fails', () => {
  const dir = fs.mkdtempSync(path.join(path.dirname(project({}, { init: false })), 'plain-'));
  assert.equal(bash(dir, 'sqlcmd -Q "DROP TABLE x"'), null);
});
test('hooks.json registers pre-bash for Bash', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  assert.ok(j.hooks.PreToolUse.some((h) => h.matcher === 'Bash' && /pre-bash/.test(h.hooks[0].command)));
});

test('CLAUDE.md managed section: policy 5 covers database/mobile knowledge, reuse, targeted refresh and the environment policy; stays compact', () => {
  assert.equal(CLAUDE_POLICY, 5);
  for (const re of [/\.rmcontext\/database\/.*\.rmcontext\/mobile\//, /schema, procedures, API mapping and architecture/, /Reuse the repository, DAO, DTO, model, ViewModel, UseCase or composable/, /do not recreate logic/, /targeted .*refresh|rmc mobile detect/, /not a full scan/, /Discovery is read-only everywhere/, /DEV: migrations in the project's framework, no backup objects/, /STAGING: prepare migration, rollback and checklist for the user to apply/, /PRODUCTION: strict/, /UNKNOWN: change nothing/]) assert.match(CLAUDE_SECTION, re);
  assert.ok(CLAUDE_SECTION.length / 3.5 < 1000);
});
test('init (new project) runs static detection only; an initialized project gets a hint, not a discovery', async () => {
  const d = project({ ...F.mssqlWebConfig, 'db/schema.sql': 'CREATE TABLE dbo.Members (Id INT PRIMARY KEY);' }, { init: false });
  const out = ok(d, 'init', '--no-claude-md');
  assert.match(out, /Database: 1 target\(s\) detected \(no connection opened\)/);
  assert.ok(fs.existsSync(path.join(d, '.rmcontext/database/manifest.json')));
  // existing project without database knowledge: policy update only
  const e = project({ ...F.mssqlWebConfig, 'db/schema.sql': 'CREATE TABLE dbo.Members (Id INT PRIMARY KEY);' });
  fs.rmSync(path.join(e, '.rmcontext/database'), { recursive: true, force: true }); // a project initialized before this feature
  const scan = fs.readFileSync(path.join(e, '.rmcontext/state/scan.json'), 'utf8');
  const up = ok(e, 'init', '--no-claude-md');
  assert.match(up, /Policy update for an initialized project \(no scan/); assert.match(up, /Optional one-time targeted discovery \(no full scan, no connection\): rmc database discover/);
  assert.ok(!fs.existsSync(path.join(e, '.rmcontext/database/manifest.json')), 'no automatic discovery');
  assert.equal(fs.readFileSync(path.join(e, '.rmcontext/state/scan.json'), 'utf8'), scan);
});
test('workflow knowledge: only matching database objects are added, bounded, without definitions or credentials', async () => {
  const dir = project({ ...F.mssqlWebConfig });
  const model = await discoverCatalog('mssql', new FakeServer('mssql').read);
  applyModel(dir, { target: detectDatabaseConfig(dir)[0], model, source: 'catalog' });
  const t = databaseContext(dir, 'fix the membership report procedure so it filters by year');
  assert.match(t, /procedure dbo\.sp_MembershipReport\(@Year\) · touches dbo\.members/i); assert.ok(!/BEGIN|SELECT m\.Id/.test(t), 'no definition'); assert.ok(t.length <= 900);
  assert.equal(databaseContext(dir, 'change the button colour on the landing page'), '');
  const r = retrieveTargeted(ctx(dir), 'fix the membership report procedure so it filters by year', { criteria: ['the Year parameter is validated'], maxContextTokens: 900 });
  assert.match(r.text, /Database objects/); assert.ok(r.tokens <= 900);
  assert.equal(retrieveTargeted(ctx(dir), 'change the button colour on the landing page', {}).text.includes('Database objects'), false);
  assert.equal(dataMobileContext(dir, 'zzz'), '');
  const wh = rmc(dir, 'workflow', 'plan', '--json');
  void wh;
});
