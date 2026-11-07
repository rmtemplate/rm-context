// Protected schema-change workflow. Enforcement lives here (CLI + adapter layer), not in prompts:
//  - environment policy (DEV migration-first, STAGING/PRODUCTION user-controlled), UNKNOWN always blocks
//  - approvals bound to environment + target identity + plan + stage + exact statements / migration fingerprint
//  - a mutation gate: only statements whose hash is registered in the approved plan can reach an executor
//  - an audit trail with hashes and metadata only (never SQL text, secrets or connection strings)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ctx, readJson, writeJson, writeFile, now, RmcError, fail } from '../util.mjs';
import { sha256, parseSql, objKey, splitStatements } from './sql.mjs';
import { assertReadOnly, guardedExecutor } from './guard.mjs';
import { PROTECTED, classifyEnvironment, detectMigrations, detectDatabaseConfig } from './config.mjs';
import { backupName, procedureBackup, tableBackup, existsQuery, tableVerifyQueries, definitionQueryFor, verifyProcedureBackup, BackupBlocked, datePart } from './backup.mjs';
import { showObject, dbDir } from './store.mjs';
import { ensureIgnored } from '../project.mjs';

export class ChangeBlocked extends RmcError {}
const block = (m) => { throw new ChangeBlocked(m); };

export const changesDir = (root) => ctx(root).p('state', 'database-changes');
export const auditFile = (root) => ctx(root).p('state', 'database-audit.jsonl');
export const backupsDir = (root, date) => ctx(root).p('backups', 'database', date);
const planFile = (root, id) => path.join(changesDir(root), `${id}.json`);

// ---------- policy ----------
export function policyFor(env) {
  switch (env) {
    case 'LOCAL': case 'DEV': case 'TEST':
      return { env, tier: 'dev', backup: false, nativeBackup: false, apply: 'agent-after-target-verified', approvals: [], destructiveApproval: true, description: 'migration-first; no backup objects; the agent may run the reviewed migration after the target is verified' };
    case 'STAGING':
      return { env, tier: 'staging', backup: true, nativeBackup: false, apply: 'user-controlled', approvals: ['backup', 'apply'], destructiveApproval: true, description: 'the user applies; a Claude apply needs a verified backup and two approvals' };
    case 'PRODUCTION':
      return { env, tier: 'production', backup: true, nativeBackup: 'high-risk', apply: 'user-controlled', approvals: ['backup', 'apply'], destructiveApproval: true, description: 'strict; migration is generated only unless the user explicitly asks Claude to apply; backup, native backup attestation for high risk, two approvals' };
    default:
      return { env: 'UNKNOWN', tier: 'blocked', backup: true, apply: 'blocked', approvals: [], description: 'environment not identified: every mutation is blocked' };
  }
}

// ---------- audit ----------
export function audit(root, ev) {
  const line = { at: now(), actor: ev.actor || process.env.RMC_ACTOR || 'cli', session: process.env.RMC_SESSION_ID || process.env.CLAUDE_SESSION_ID || '', ...ev };
  delete line.sql; delete line.password; delete line.connectionString;
  fs.mkdirSync(path.dirname(auditFile(root)), { recursive: true });
  fs.appendFileSync(auditFile(root), JSON.stringify(line) + '\n');
  return line;
}

// ---------- plan ----------
const newId = () => `CHG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
export const loadPlan = (root, id) => { const f = planFile(root, id); if (!fs.existsSync(f)) fail(`No such change plan: ${id}`); return readJson(f); };
export const savePlan = (root, p) => { p.updatedAt = now(); writeJson(planFile(root, p.id), p); return p; };
export function listPlans(root) { const d = changesDir(root); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))) : []; }

function readTargets(root) { return detectDatabaseConfig(root); }
export function confirmedEnvironments(root) { return readJson(ctx(root).config, {}).database?.targets || {}; }
export function resolveTarget(root, { targetId, targets } = {}) {
  const list = targets || readTargets(root);
  const conf = confirmedEnvironments(root);
  const pick = targetId ? list.find((t) => t.id === targetId || t.id.startsWith(targetId) || t.database === targetId) : (list.length === 1 ? list[0] : null);
  if (!pick) block(targetId ? `Target "${targetId}" was not found among detected targets.` : `${list.length} database targets were detected; choose one with --target <id>. Nothing was changed.`);
  const env = classifyEnvironment({ ...pick }, { confirmed: conf[pick.id]?.environment });
  return { ...pick, environment: env.environment, environmentSignals: env.signals, environmentNote: env.note };
}

// A plan from a reviewed migration file. `objects` can be passed for non-SQL migrations (EF/Laravel/Django) whose DDL cannot be parsed statically.
export function planChange(root, { file, targetId, objects = [], targets, text, framework, nowFn = () => new Date() }) {
  const target = resolveTarget(root, { targetId, targets });
  const pol = policyFor(target.environment);
  const abs = path.resolve(root, file);
  if (!abs.startsWith(path.resolve(root) + path.sep)) block('The migration file must be inside the project.');
  if (!fs.existsSync(abs)) block(`Migration file not found: ${file}`);
  const body = text ?? fs.readFileSync(abs, 'utf8');
  const fw = framework || detectMigrations(root).find((m) => path.posix.normalize(file).includes(m.dir.replace(/\\/g, '/')))?.framework || (/\.sql$/i.test(file) ? 'plain-sql' : 'unknown');
  const parsed = /\.sql$/i.test(file) || /\bCREATE|ALTER|DROP\b/i.test(body) ? parseSql(body, { engine: target.engine }) : { ops: [], tables: [], routines: [] };
  const ops = parsed.ops.filter((o) => o.kind !== 'data' || o.destructive);
  const extra = objects.map((s) => { const m = /^(table|procedure|function|view|trigger):([\w$.#-]+)$/i.exec(s); if (!m) block(`--object must look like table:dbo.Name (got "${s}")`); const [schema, name] = m[2].includes('.') ? m[2].split('.') : ['', m[2]]; return { op: 'declared', kind: m[1].toLowerCase(), schema, name }; });
  const affected = [...ops.filter((o) => o.kind && o.kind !== 'data'), ...extra];
  const destructive = ops.filter((o) => o.destructive).map((o) => `${o.op} ${o.kind}${o.name ? ' ' + o.name : ''}: ${o.destructive}`);
  const unparsed = !affected.length;
  const nonSqlRisk = unparsed && !/\.sql$/i.test(file);
  const risk = destructive.length || nonSqlRisk ? 'high' : affected.some((o) => o.kind === 'table') ? 'medium' : 'low';
  const id = newId();
  const migs = detectMigrations(root).find((m) => m.framework === fw);
  const plan = {
    id, createdAt: now(), stage: 'planned',
    environment: target.environment, environmentSignals: target.environmentSignals, environmentNote: target.environmentNote,
    target: { id: target.id, engine: target.engine, database: target.database || '', host: target.host || target.hostFromEnv || '', profile: target.profile || '', source: target.source },
    policy: pol,
    migration: { file: path.posix.normalize(file), framework: fw, fingerprint: sha256(body), runner: migs?.up || null, down: migs?.down || null, hasRollback: /\bDOWN\b|\bdown\s*\(|rollback|undo|\.down\./i.test(body) || Boolean(migs?.down) },
    affected, destructive, risk, unparsed: unparsed ? 'migration objects could not be determined statically: pass --object kind:schema.name for each affected object' : undefined,
    backup: { required: pol.backup && affected.length > 0, status: pol.backup ? 'not-started' : 'not-required' },
    approvals: [], nativeBackup: pol.nativeBackup ? { required: pol.nativeBackup === true || risk !== 'low', reference: null } : { required: false },
    allowedStatements: {}, // stage -> [hash]
    dateKey: datePart(nowFn()),
    notes: [],
  };
  if (pol.tier === 'blocked') plan.blockedReason = `Environment is UNKNOWN (${target.environmentNote || 'insufficient evidence'}). Confirm it with: rmc database target confirm ${target.id} <LOCAL|DEV|TEST|STAGING|PRODUCTION>`;
  if (!plan.migration.hasRollback) plan.notes.push('No rollback/down migration was detected: add one, or the rollback instructions must be written by hand before applying outside DEV.');
  savePlan(root, plan);
  writeChangeArtifacts(root, plan, body);
  audit(root, { event: 'plan-change', planId: id, environment: plan.environment, target: plan.target.id, operation: 'plan', result: 'ok', migrationFingerprint: plan.migration.fingerprint.slice(0, 16) });
  return plan;
}

function writeChangeArtifacts(root, plan, body) {
  ensureIgnored(ctx(root));
  const dir = path.join(backupsDir(root, plan.dateKey), 'change-plan', plan.id);
  writeJson(path.join(dir, 'plan.json'), { id: plan.id, environment: plan.environment, target: plan.target, migration: plan.migration, affected: plan.affected, destructive: plan.destructive, risk: plan.risk, policy: plan.policy.description });
  writeFile(path.join(dir, 'migration.reviewed.sql'), body);
  writeFile(path.join(dir, 'checklist.md'), checklistFor(plan));
}

function checklistFor(plan) {
  const p = plan.policy;
  const l = [`# Change ${plan.id} — ${plan.environment}`, '', `Target: ${plan.target.engine} · ${plan.target.database || '(database from config)'} · ${plan.target.host || ''}`, `Migration: ${plan.migration.file} (${plan.migration.framework}) · risk ${plan.risk}`, ''];
  if (plan.destructive.length) l.push('Destructive operations:', ...plan.destructive.map((d) => `- ${d}`), '');
  if (p.tier === 'dev') l.push('1. Confirm the target is the DEV database.', '2. Review the migration.', `3. Run: ${plan.migration.runner || '(your migration command)'}`, '4. Verify the schema/application.', plan.migration.down ? `5. Rollback: ${plan.migration.down}` : '');
  else l.push('Manual apply (default — Claude changes nothing):', '1. Take a database-native backup/snapshot.', '2. Optionally create object backups named <object>_rmc_YYYYMMDD (`rmc database backup <id>`).', `3. Apply the reviewed migration: ${plan.migration.runner || '(your tooling)'}`, '4. Verify tables, procedures and application behaviour.', '5. Keep the rollback script from change-plan/' + plan.id + '/rollback.sql.');
  return l.filter((x) => x !== undefined).join('\n') + '\n';
}

// ---------- approvals ----------
export const approvalPhrase = (plan, stage) => `APPROVE ${stage.toUpperCase()} ${plan.environment} ${plan.target.database || plan.target.id} ${plan.id}`;
function stageDigest(plan, stage) { return sha256(JSON.stringify([stage, plan.environment, plan.target.id, plan.id, plan.migration.fingerprint, plan.allowedStatements[stage] || []])).slice(0, 16); }
export function recordApproval(root, id, stage, phrase, { ttlMinutes = 120, nowFn = () => new Date() } = {}) {
  const plan = loadPlan(root, id);
  if (plan.policy.tier === 'blocked') block(plan.blockedReason);
  const need = approvalPhrase(plan, stage);
  if (String(phrase || '').trim() !== need) block(`Approval phrase mismatch. The exact phrase for this plan, environment and stage is:\n  ${need}\nApprovals are bound to ${plan.environment} / ${plan.target.id} / ${plan.id} and cannot be reused elsewhere.`);
  const t = nowFn();
  plan.approvals = plan.approvals.filter((a) => a.stage !== stage);
  plan.approvals.push({ stage, environment: plan.environment, target: plan.target.id, digest: stageDigest(plan, stage), at: t.toISOString(), expiresAt: new Date(t.getTime() + ttlMinutes * 60000).toISOString() });
  savePlan(root, plan);
  audit(root, { event: 'approval', planId: id, environment: plan.environment, target: plan.target.id, operation: stage, approvalRef: `${stage}:${stageDigest(plan, stage)}`, result: 'recorded' });
  return plan;
}
export function hasApproval(plan, stage, nowFn = () => new Date()) {
  const a = plan.approvals.find((x) => x.stage === stage);
  return Boolean(a && a.environment === plan.environment && a.target === plan.target.id && a.digest === stageDigest(plan, stage) && new Date(a.expiresAt) > nowFn());
}

// ---------- mutation gate ----------
// Statements reach a write-capable executor ONLY through here. Every statement hash must be registered on the plan for the stage
// being executed, the plan must be in the right state, and the environment/identity must match. Direct SQL cannot pass.
export async function gatedExecute(root, plan, stage, statements, run, { nowFn } = {}) {
  assertGate(plan, stage, nowFn);
  const allowed = new Set(plan.allowedStatements[stage] || []);
  const sent = [];
  for (const s of statements) {
    const h = sha256(s);
    if (!allowed.has(h)) { audit(root, { event: 'blocked', planId: plan.id, environment: plan.environment, operation: stage, result: 'statement-not-in-plan', stmt: h.slice(0, 16) }); block(`Statement ${h.slice(0, 12)} is not part of the approved ${stage} plan: refusing to send it.`); }
  }
  for (const s of statements) { await run(s); sent.push(sha256(s).slice(0, 16)); }
  return sent;
}
function assertGate(plan, stage, nowFn) {
  if (plan.policy.tier === 'blocked') block(plan.blockedReason);
  if (!PROTECTED.has(plan.environment) && plan.policy.tier !== 'dev') block('Environment is not identified.');
  if (stage === 'backup') {
    if (!hasApproval(plan, 'backup', nowFn)) block(`Backup needs approval first: ${approvalPhrase(plan, 'backup')}`);
  } else if (stage === 'apply') {
    if (PROTECTED.has(plan.environment)) {
      if (plan.backup.required && plan.backup.status !== 'verified') block('The backup is not verified: the migration will not run. Run `rmc database verify-backup` first.');
      if (!hasApproval(plan, 'apply', nowFn)) block(`Final approval is required before the migration runs: ${approvalPhrase(plan, 'apply')}`);
      if (plan.nativeBackup?.required && !plan.nativeBackup.reference) block('PRODUCTION: a database-native backup/snapshot is required for this change. Record its reference with `rmc database native-backup <id> --ref <snapshot id>` (the CLI cannot verify it for you).');
    } else if (plan.destructive.length && !hasApproval(plan, 'destructive', nowFn)) block(`Destructive migration in ${plan.environment}: impact explanation and approval required — ${approvalPhrase(plan, 'destructive')}`);
  }
}

// ---------- identity ----------
const IDENTITY_SQL = { mssql: 'SELECT DB_NAME() AS database_name', mysql: 'SELECT DATABASE() AS database_name', postgres: 'SELECT current_database() AS database_name', sqlite: "SELECT 'main' AS database_name" };
export async function verifyIdentity(plan, probe, { allowUnverifiedDev = false } = {}) {
  if (plan.policy.tier === 'blocked') block(plan.blockedReason);
  if (!probe) { if (PROTECTED.has(plan.environment)) block(`Cannot verify the live database identity for ${plan.environment}: no read-only connection was provided. Nothing was changed.`); if (!allowUnverifiedDev) block('Target identity could not be verified: confirm the target with --confirm-target after checking the database name.'); return { verified: false }; }
  const exec = guardedExecutor(probe, { engine: plan.target.engine });
  const rows = await exec(IDENTITY_SQL[plan.target.engine]);
  const got = String(rows?.[0]?.database_name ?? '').toLowerCase();
  const want = String(plan.target.database || '').toLowerCase();
  if (plan.target.engine !== 'sqlite' && want && got !== want) block(`Target mismatch: the connection reports database "${got}" but the plan targets "${want}" (${plan.environment}). Nothing was changed.`);
  return { verified: true, database: got };
}

// ---------- backup stage ----------
export async function planBackup(root, id, { model, probe, nowFn = () => new Date(), tz = 'Asia/Jakarta' } = {}) {
  const plan = loadPlan(root, id);
  if (!plan.policy.backup) block(`${plan.environment} does not use backup objects (migration-first policy).`);
  if (plan.policy.tier === 'blocked') block(plan.blockedReason);
  if (plan.stage === 'cancelled') block('This change was cancelled.');
  const eng = plan.target.engine; const items = []; const blockers = [];
  const exists = [];
  for (const o of plan.affected.filter((x) => x.op !== 'create' && ['table', 'procedure', 'function', 'view', 'trigger'].includes(x.kind))) {
    const rec = model ? (o.kind === 'table' ? model.tables.find((t) => objKey(t.schema, t.name) === objKey(o.schema, o.name)) : model.routines.find((r) => r.kind === o.kind && objKey(r.schema, r.name) === objKey(o.schema, o.name))) : null;
    const stored = showObject(root, o.kind, o.schema ? `${o.schema}.${o.name}` : o.name, { definition: true });
    const orig = rec || stored;
    if (!orig) { blockers.push(`${o.kind} ${o.schema}.${o.name}: original not inspected — run discovery/inspect first (original is required before any backup)`); continue; }
    let name; try { name = backupName(eng, o.name, { now: nowFn(), tz }); } catch (e) { blockers.push(e.message); continue; }
    try {
      const gen = o.kind === 'table' ? tableBackup(eng, { ...orig, schema: o.schema || orig.schema, name: o.name }, name) : procedureBackup(eng, { ...orig, kind: o.kind, schema: o.schema || orig.schema, name: o.name }, name);
      if (gen.blockers?.length) { blockers.push(...gen.blockers.map((b) => `${o.kind} ${o.name}: ${b}`)); continue; }
      items.push({ kind: o.kind, schema: o.schema || orig.schema || '', original: o.name, backup: name, statements: gen.statements, preserved: gen.preserved, notPreserved: gen.notPreserved, originalHash: gen.originalHash || sha256(JSON.stringify(orig.columns || '')) });
      exists.push({ schema: o.schema || orig.schema || '', name, kind: o.kind });
    } catch (e) { if (e instanceof BackupBlocked) blockers.push(`${o.kind} ${o.name}: ${e.message}`); else throw e; }
  }
  // never overwrite or drop: refuse when a backup name already exists
  if (probe && exists.length) {
    const exec = guardedExecutor(probe, { engine: eng });
    for (const e of exists) { const r = await exec(existsQuery(eng, e.kind, e.schema, e.name)); if (r?.length) blockers.push(`${e.name} already exists: it will not be overwritten or dropped. Approve an extra timestamp suffix (e.g. ${e.name}_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}) or choose another name.`); }
  }
  plan.backup = { ...plan.backup, required: true, status: blockers.length ? 'blocked' : 'planned', items: items.map((i) => ({ ...i, statements: undefined, statementHashes: i.statements.map((s) => sha256(s)) })), blockers, plannedAt: now() };
  plan.allowedStatements.backup = items.flatMap((i) => i.statements.map((s) => sha256(s)));
  plan.stage = blockers.length ? 'backup-blocked' : 'backup-planned';
  savePlan(root, plan);
  // local DDL artifact (no credentials)
  const dir = path.join(backupsDir(root, plan.dateKey), 'change-plan', plan.id);
  writeFile(path.join(dir, 'backup.statements.sql'), items.map((i) => `-- ${i.kind} ${i.original} → ${i.backup}\n${i.statements.join(';\n')};\n`).join('\n'));
  audit(root, { event: 'plan-backup', planId: id, environment: plan.environment, target: plan.target.id, operation: 'backup-plan', result: blockers.length ? 'blocked' : 'ok', backupRef: items.map((i) => i.backup).join(',') });
  return { plan, items, blockers };
}

export async function createBackup(root, id, { run, probe, items: itemsIn, nowFn }) {
  const plan = loadPlan(root, id);
  if (plan.backup.status === 'blocked') block(`Backup plan has blockers: ${plan.backup.blockers.join('; ')}`);
  if (plan.backup.status === 'not-started') block('Plan the backup first.');
  await verifyIdentity(plan, probe);
  const items = itemsIn; if (!items?.length) block('No backup statements to run.');
  const stmts = items.flatMap((i) => i.statements);
  await gatedExecute(root, plan, 'backup', stmts, run, { nowFn });
  plan.backup.status = 'created'; plan.stage = 'backup-created'; plan.backup.createdAt = now();
  savePlan(root, plan);
  audit(root, { event: 'backup-created', planId: id, environment: plan.environment, target: plan.target.id, operation: 'backup', backupRef: plan.backup.items.map((i) => i.backup).join(','), approvalRef: `backup:${stageDigest(plan, 'backup')}`, stmts: stmts.map((s) => sha256(s).slice(0, 12)), result: 'ok' });
  return plan;
}

// Verification uses read-only queries only. A backup is "verified" only if EVERY check passes.
export async function verifyBackup(root, id, { probe, model }) {
  const plan = loadPlan(root, id);
  if (!['created', 'verified'].includes(plan.backup.status)) block('No backup was created for this plan.');
  const exec = guardedExecutor(probe, { engine: plan.target.engine });
  const results = [];
  for (const it of plan.backup.items) {
    if (it.kind === 'table') {
      const q = tableVerifyQueries(plan.target.engine, it.schema, it.original, it.backup);
      const a = Number((await exec(q.origCount))[0]?.n), b = Number((await exec(q.backupCount))[0]?.n);
      let structure = 'skipped';
      if (q.origCols) { const oc = await exec(q.origCols), bc = await exec(q.backupCols); structure = JSON.stringify(oc.map((c) => [c.column_name, String(c.data_type).toLowerCase(), String(c.nullable)])) === JSON.stringify(bc.map((c) => [c.column_name, String(c.data_type).toLowerCase(), String(c.nullable)])) ? 'match' : 'mismatch'; }
      results.push({ object: it.original, backup: it.backup, check: 'row-count+structure', ok: a === b && structure !== 'mismatch', detail: { original: a, backup: b, structure } });
    } else {
      const defQ = (n) => definitionQueryFor(plan.target.engine, it.schema, n, it.kind);
      const o = (await exec(defQ(it.original)))[0], bk = (await exec(defQ(it.backup)))[0];
      if (!o?.definition || !bk?.definition) results.push({ object: it.original, backup: it.backup, check: 'definition', ok: false, detail: 'definition missing' });
      else { const v = verifyProcedureBackup(o.definition, it.original, bk.definition, it.backup); results.push({ object: it.original, backup: it.backup, check: 'definition-hash', ok: v.ok, detail: { original: v.originalNormalizedHash, backup: v.backupNormalizedHash } }); }
    }
  }
  const ok = results.length > 0 && results.every((r) => r.ok);
  plan.backup.status = ok ? 'verified' : 'verification-failed'; plan.backup.verification = { at: now(), results }; plan.stage = ok ? 'backup-verified' : 'backup-failed';
  savePlan(root, plan);
  writeManifest(root, plan);
  audit(root, { event: 'verify-backup', planId: id, environment: plan.environment, target: plan.target.id, operation: 'verify-backup', result: ok ? 'verified' : 'failed' });
  return { ok, results, plan };
}

function writeManifest(root, plan) {
  const dir = backupsDir(root, plan.dateKey);
  const f = path.join(dir, 'manifest.json'); const m = readJson(f, { entries: [] });
  m.entries = m.entries.filter((e) => e.changeRequest !== plan.id);
  for (const it of plan.backup.items || []) m.entries.push({ changeRequest: plan.id, environment: plan.environment, database: plan.target.database, engine: plan.target.engine, original: `${it.schema}.${it.original}`, backup: `${it.schema}.${it.backup}`, kind: it.kind, operation: 'backup', originalFingerprint: it.originalHash, status: plan.backup.status, verifiedAt: plan.backup.verification?.at, rollback: `change-plan/${plan.id}/rollback.sql`, at: plan.backup.createdAt });
  writeJson(f, m);
}

// ---------- rollback ----------
export function prepareRollback(root, id, { model } = {}) {
  const plan = loadPlan(root, id);
  const dir = path.join(backupsDir(root, plan.dateKey), 'change-plan', plan.id);
  const lines = [`-- Rollback for ${plan.id} (${plan.environment}). GENERATED, NEVER EXECUTED AUTOMATICALLY.`, '-- Review every line; a backup object existing does not mean this rollback is proven to work.', ''];
  const caveats = [];
  for (const it of plan.backup?.items || []) {
    if (it.kind === 'table') { lines.push(`-- table ${it.original}: data and structure were copied to ${it.backup}.`, `-- Restore means: rename/replace the changed table with ${it.backup} AFTER checking FK, triggers, permissions and rows written since deployment.`, ''); caveats.push(`${it.original}: rows written after the change would be lost if the backup is restored over it`); }
    else {
      const rec = showObject(root, it.kind, it.schema ? `${it.schema}.${it.original}` : it.original, { definition: true });
      if (rec?.definition) lines.push(`-- ${it.kind} ${it.original}: original definition (re-create it with ALTER/CREATE OR REPLACE)`, rec.definition.replace(/\bCREATE\b(\s+(?:OR\s+\w+\s+)?(?:PROC(?:EDURE)?|FUNCTION|VIEW))/i, plan.target.engine === 'mssql' ? 'ALTER$1' : 'CREATE OR REPLACE$1'), '');
      else caveats.push(`${it.original}: original definition not stored; rollback must come from ${it.backup} or the native backup`);
    }
  }
  if (plan.migration.down) lines.push(`-- Framework down: ${plan.migration.down}`);
  for (const c of plan.notes) caveats.push(c);
  const impact = ['Review foreign keys, indexes, triggers, permissions and dependent objects before running.', 'Data changed after the migration is not recovered by restoring the structure.'];
  writeFile(path.join(dir, 'rollback.sql'), lines.join('\n') + '\n');
  writeJson(path.join(dir, 'rollback.notes.json'), { caveats, impact });
  plan.rollback = { file: `change-plan/${plan.id}/rollback.sql`, preparedAt: now(), caveats: caveats.length, complete: caveats.length === 0 };
  savePlan(root, plan);
  audit(root, { event: 'rollback-prepared', planId: id, environment: plan.environment, target: plan.target.id, operation: 'rollback', result: plan.rollback.complete ? 'complete' : 'with-caveats' });
  return { plan, caveats };
}

// ---------- package for the user to apply themselves ----------
export function manualPackage(root, id) {
  const plan = loadPlan(root, id);
  const dir = path.join(backupsDir(root, plan.dateKey), 'change-plan', plan.id, 'package');
  const mig = path.join(backupsDir(root, plan.dateKey), 'change-plan', plan.id, 'migration.reviewed.sql');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(mig)) fs.copyFileSync(mig, path.join(dir, 'migration.sql'));
  writeFile(path.join(dir, 'README.md'), checklistFor(plan) + '\nBackup guidance: take a database-native backup/snapshot first. Object backups use <object>_rmc_YYYYMMDD in the same database and schema.\n');
  const rb = prepareRollback(root, id).plan;
  const rbf = path.join(backupsDir(root, rb.dateKey), 'change-plan', rb.id, 'rollback.sql'); if (fs.existsSync(rbf)) fs.copyFileSync(rbf, path.join(dir, 'rollback.sql'));
  const p2 = loadPlan(root, id); p2.stage = 'package-ready'; p2.package = { dir: path.relative(root, dir).split(path.sep).join('/'), at: now() }; savePlan(root, p2);
  audit(root, { event: 'package', planId: id, environment: plan.environment, target: plan.target.id, operation: 'manual-package', result: 'ok' });
  return p2;
}

// ---------- apply ----------
// run(cmd,args,opts) is injectable. The migration runner is the project's own command (detected), never a command typed by an agent.
export async function applyChange(root, id, { probe, run = spawnSync, confirmTarget = false, userRequestedApply = false, nowFn, readBody } = {}) {
  const plan = loadPlan(root, id);
  const reasons = [];
  if (plan.policy.tier === 'blocked') block(plan.blockedReason);
  if (plan.stage === 'cancelled') block('This change was cancelled.');
  if (PROTECTED.has(plan.environment) && !userRequestedApply) block(`${plan.environment}: Claude does not apply migrations by default. Use \`rmc database package ${id}\` for a manual package, or have the user explicitly ask for a Claude apply (--user-requested).`);
  if (!plan.migration.runner) block(`No migration runner was detected for framework "${plan.migration.framework}". Apply the package manually; the CLI will not execute raw SQL.`);
  const body = readBody ? readBody() : fs.readFileSync(path.join(backupsDir(root, plan.dateKey), 'change-plan', plan.id, 'migration.reviewed.sql'), 'utf8');
  const cur = path.join(root, plan.migration.file);
  const live = fs.existsSync(cur) ? fs.readFileSync(cur, 'utf8') : body;
  if (sha256(live) !== plan.migration.fingerprint) block('The migration file changed after it was reviewed. Re-plan the change; nothing was run.');
  await verifyIdentity(plan, probe, { allowUnverifiedDev: confirmTarget });
  assertGate(plan, 'apply', nowFn);
  if (plan.unparsed && PROTECTED.has(plan.environment)) block(plan.unparsed);
  if (!plan.rollback && PROTECTED.has(plan.environment)) block('Rollback instructions must be prepared before applying: run `rmc database rollback ' + id + '`.');
  const [cmd, ...args] = plan.migration.runner.replace(/^npx\s+/, 'npx ').split(/\s+/);
  audit(root, { event: 'apply-start', planId: id, environment: plan.environment, target: plan.target.id, operation: 'apply', approvalRef: PROTECTED.has(plan.environment) ? `apply:${stageDigest(plan, 'apply')}` : 'policy:dev', result: 'started' });
  const r = run(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  const ok = !r.error && r.status === 0;
  plan.stage = ok ? 'applied' : 'apply-failed'; plan.appliedAt = now(); plan.applyResult = { status: r.status, error: r.error ? String(r.error.code || r.error.message) : undefined };
  savePlan(root, plan);
  audit(root, { event: 'apply', planId: id, environment: plan.environment, target: plan.target.id, operation: 'apply', original: plan.affected.map((o) => o.name).join(','), backupRef: (plan.backup.items || []).map((i) => i.backup).join(',') || undefined, result: ok ? 'ok' : `failed(${r.status})` });
  return { ok, plan, reasons };
}

export function cancelChange(root, id) {
  const plan = loadPlan(root, id); plan.stage = 'cancelled'; plan.approvals = []; savePlan(root, plan);
  audit(root, { event: 'cancel', planId: id, environment: plan.environment, target: plan.target.id, operation: 'cancel', result: 'ok' });
  return plan;
}
export function recordNativeBackup(root, id, ref) {
  const plan = loadPlan(root, id);
  if (!/^[\w./:@ -]{3,120}$/.test(ref || '')) block('Provide a short reference for the native backup/snapshot (an id or name, never a path with credentials).');
  plan.nativeBackup = { ...plan.nativeBackup, reference: ref, recordedAt: now(), attested: true, note: 'attested by the user: the CLI cannot verify a native backup' };
  savePlan(root, plan);
  audit(root, { event: 'native-backup', planId: id, environment: plan.environment, target: plan.target.id, operation: 'native-backup', result: 'attested' });
  return plan;
}
export function statusOf(plan) {
  return { id: plan.id, stage: plan.stage, environment: plan.environment, target: `${plan.target.engine}:${plan.target.database || plan.target.id}`, risk: plan.risk, policy: plan.policy.description, backup: plan.backup.status, approvals: plan.approvals.map((a) => a.stage), nativeBackup: plan.nativeBackup?.required ? (plan.nativeBackup.reference ? 'attested' : 'required') : 'not required', rollback: plan.rollback ? (plan.rollback.complete ? 'prepared' : 'prepared with caveats') : 'not prepared' };
}
export { splitStatements };
