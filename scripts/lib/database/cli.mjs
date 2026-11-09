// `rmc database …` — thin command layer over config/adapters/store/change. Discovery is read-only everywhere.
import fs from 'node:fs';
import path from 'node:path';
import { ctx, readJson, writeJson, requireInit, fail, now, sha1 } from '../util.mjs';
import { detectDatabaseConfig, detectMigrations, detectSchemaSources, classifyEnvironment, walkFiles, ENVIRONMENTS, PROTECTED } from './config.mjs';
import { discoverCatalog, buildModel, attachDefinitions, catalogStatements, sqliteExecutor, sqliteWriteExecutor, cliExecutor, catalogStatements as stmts } from './adapters.mjs';
import { parseSql, sensitiveSql, analyzeSql, objKey } from './sql.mjs';
import { applyModel, readManifest, findObjects, showObject, mapApplication, toGraph, storedSignatures, targetKey, dbDir } from './store.mjs';
import * as chg from './change.mjs';
import { loadGraph, saveGraph, upsert, graphExists } from '../graph.mjs';
import { logEvent } from '../context.mjs';

export const DB_HELP = `database — Database Intelligence (discovery is READ-ONLY in every environment)
  rmc database status                         detected targets (no secrets), environment, migrations, knowledge, pending changes
  rmc database discover [--target <id>] [--static] [--catalog-file <json>]
        [--connect --approve <target-id> [--cred-env user=ENV,password=ENV]]
                                              static (SQL scripts) by default; a connection needs explicit approval and is SELECT-only
  rmc database refresh [--target <id>] …      incremental: only changed objects are re-read
  rmc database find "<terms>"                 table / column / procedure / parameter lookup
  rmc database show table|procedure|view|function <name> [--definition]
  rmc database inspect table|procedure <name> alias of show
  rmc database catalog-sql [--engine <e>]     print the SELECT-only catalog queries (run them yourself, then --catalog-file)
  rmc database map [--target <id>]            application → database mapping from source evidence
  rmc database target confirm <id> <ENV>      record LOCAL|DEV|TEST|STAGING|PRODUCTION for a detected target
  rmc database migrations                     migration framework and runner
  Protected changes (DEV: migration only · STAGING: user applies · PRODUCTION: strict):
  rmc database plan-change --file <migration> [--target <id>] [--object table:dbo.Name …]
  rmc database change status [<id>]
  rmc database package <id>                   manual package (migration, rollback, checklist); changes nothing
  rmc database backup <id> [--execute --approve …]   plan (default) or create _rmc_YYYYMMDD backup objects
  rmc database verify-backup <id>
  rmc database native-backup <id> --ref <snapshot id>   attest a database-native backup (PRODUCTION)
  rmc database rollback <id>                  prepare the rollback script (never executed automatically)
  rmc database approve <id> --stage backup|apply|destructive --phrase "<exact phrase>"
  rmc database apply <id> [--user-requested] [--confirm-target]
  rmc database cancel <id>`;

const targets = (root) => detectDatabaseConfig(root);
const pickTarget = (root, args) => chg.resolveTarget(root, { targetId: typeof args.target === 'string' ? args.target : undefined, targets: targets(root) });
const guardEnv = (t, what) => { if (t.environment === 'UNKNOWN') return `${what}: environment is UNKNOWN (${t.environmentNote || 'no evidence'}); confirm with \`rmc database target confirm ${t.id} <ENV>\``; return null; };

function staticModel(root, target) {
  const files = walkFiles(root); const src = detectSchemaSources(root, { files });
  const sqlFiles = [...new Set([...src['sql-script'], ...src['schema-dump']])].filter((f) => !/node_modules|\.rmcontext/.test(f));
  const tables = new Map(), routines = new Map(); const limitations = []; const used = [];
  for (const f of sqlFiles) {
    let text; try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (text.length > 2_000_000) { limitations.push(`${f}: skipped (larger than 2 MB)`); continue; }
    const p = parseSql(text, { engine: target.engine }); if (!p.tables.length && !p.routines.length) continue;
    used.push(f);
    for (const t of p.tables) tables.set(objKey(t.schema, t.name), { ...t, _file: f });
    for (const r of p.routines) routines.set(`${r.kind}:${objKey(r.schema, r.name)}`, { ...r, signature: '', _file: f });
  }
  if (src.dacpac.length) limitations.push(`${src.dacpac.length} DACPAC/sqlproj file(s) found; DACPAC binaries are not parsed (planned).`);
  if (src['orm-model'].length) limitations.push(`${src['orm-model'].length} ORM model file(s) found; entity classes are not parsed into tables here (no structure is invented).`);
  if (!used.length) limitations.push('No SQL script with CREATE TABLE/PROCEDURE was found: no structure was recorded.');
  limitations.push('Static discovery reflects scripts, not the live database: objects created outside these scripts are unknown.');
  const model = { engine: target.engine, database: target.database || '', version: '', tables: [...tables.values()], routines: [...routines.values()], sequences: [], dependencies: [], limitations, sourceFiles: used };
  for (const r of model.routines) for (const ref of r.refs || []) model.dependencies.push({ from: { schema: r.schema, name: r.name }, to: { schema: ref.schema || r.schema, name: ref.name, kind: ref.kind, ...(ref.crossDatabase ? { database: ref.extra[0] } : {}) }, mode: ref.mode, evidence: 'definition-parse', confidence: 'inferred' });
  for (const r of model.routines) if (r.definition) { const s = sensitiveSql(r.definition); if (s.length) model.limitations.push(`${r.schema}.${r.name}: definition contains ${s.join(', ')} — flagged for review and not stored`); }
  return model;
}

async function liveRead(root, target, args, deps) {
  const prov = deps.executor?.(target, 'read');
  if (prov) return prov;
  if (target.engine === 'sqlite') { const f = target.sources?.find((s) => s.source === 'sqlite-file')?.file; if (!f) fail('No SQLite file is known for this target.'); return sqliteExecutor(path.join(root, f)); }
  const cred = {}; if (typeof args['cred-env'] === 'string') for (const kv of args['cred-env'].split(',')) { const [k, v] = kv.split('='); if (k && v) cred[k.trim()] = v.trim(); }
  return cliExecutor(target, { credEnv: cred });
}

export async function databaseCommand(root, args, deps = {}) {
  const c = ctx(root); requireInit(c);
  const [sub, a1, a2] = args._;
  const out = [];
  const say = (...x) => out.push(x.join(' '));
  const json = Boolean(args.json);
  const result = (o) => (json ? JSON.stringify(o, null, 2) : out.join('\n'));
  switch (sub) {
    case undefined: case 'help': return DB_HELP;
    case 'status': {
      const ts = targets(root); const conf = chg.confirmedEnvironments(root); const mig = detectMigrations(root); const man = readManifest(root);
      const data = { targets: ts.map((t) => ({ ...t, environment: chg.resolveTarget(root, { targetId: t.id, targets: ts }).environment })), migrations: mig, knowledge: man.targets, pendingChanges: chg.listPlans(root).filter((p) => !['applied', 'cancelled'].includes(p.stage)).map(chg.statusOf), confirmed: conf };
      if (json) return JSON.stringify(data, null, 2);
      say(`Database targets detected: ${ts.length}${ts.length ? '' : ' (none: no configuration found; static SQL discovery still works)'}`);
      for (const t of data.targets) say(`- ${t.engine || 'unknown engine'} · ${t.database || '(db from env)'} · ${t.host || t.hostFromEnv || 'no host'} · profile ${t.profile || '-'} · ${t.environment}${t.credentialsPresent ? ' · credentials present (not read)' : ''}\n    id ${t.id} · from ${t.sources.map((s) => s.file).join(', ')}${t.orm ? ` · ${t.orm}` : ''}`);
      say(`Migrations: ${mig.length ? mig.map((m) => `${m.framework} (${m.count})`).join(', ') : 'none detected'}`);
      const kt = Object.entries(man.targets);
      say(`Knowledge: ${kt.length ? kt.map(([k, v]) => `${k}: ${v.counts.tables} tables, ${v.counts.procedures} procedures, ${v.counts.views} views (${v.source}, ${v.lastDiscoveredAt?.slice(0, 10)})`).join('; ') : 'not discovered yet — run: rmc database discover'}`);
      for (const p of data.pendingChanges) say(`Change ${p.id}: ${p.stage} · ${p.environment} · ${p.target} · backup ${p.backup}`);
      return out.join('\n');
    }
    case 'discover': case 'refresh': {
      const refresh = sub === 'refresh';
      const t = pickTarget(root, args);
      const stamp = now();
      let model, source, sourceFile;
      let live = null;
      if (typeof args['catalog-file'] === 'string') {
        const rows = readJson(path.resolve(root, args['catalog-file']));
        model = buildModel(t.engine, rows.rows || rows); if (rows.definitions) attachDefinitions(model, rows.definitions);
        source = 'catalog'; sourceFile = args['catalog-file'];
        for (const r of model.routines) if (r.definition) { const s = sensitiveSql(r.definition); if (s.length) { model.limitations.push(`${r.schema}.${r.name}: definition contains ${s.join(', ')} — not stored`); } }
      } else if (args.connect) {
        const g = guardEnv(t, 'Connection refused'); if (g) fail(g);
        if (args.approve !== t.id) {
          fail(`Read-only inspection needs your explicit approval.\n  Target : ${t.engine} · database ${t.database || '(from env)'} · host ${t.host || t.hostFromEnv || 'local'} · profile ${t.profile || '-'}\n  Environment: ${t.environment}${PROTECTED.has(t.environment) ? ' (PROTECTED: SELECT-only metadata reads, nothing else)' : ''}\n  Credentials: never displayed or stored. Supply them via environment variables: --cred-env user=ENVVAR,password=ENVVAR\n  To approve this exact target run again with: --approve ${t.id}`);
        }
        live = await liveRead(root, t, args, deps);
        const known = refresh ? storedSignatures(root, 'backend', targetKey(t)) : null;
        const only = known ? (r) => { const k = known.get(`${r.kind}:${objKey(r.schema, r.name)}`); return !k || k.status === 'removed' || !r.signature || k.signature !== r.signature; } : undefined;
        model = await discoverCatalog(t.engine, live, { only });
        if (known) for (const r of model.routines) if (r.definition === undefined) { /* unchanged: header only */ }
        source = 'catalog'; sourceFile = undefined;
        live.close?.();
        audit(root, 'discover', t, model.statements);
      } else {
        model = staticModel(root, t); source = 'script'; sourceFile = model.sourceFiles.join(', ').slice(0, 300) || undefined;
        if (refresh) {
          const sig = readJson(ctx(root).p('database', 'sources.json'), {}); const cur = {};
          for (const f of model.sourceFiles) { const st = fs.statSync(path.join(root, f)); cur[f] = `${st.size}:${Math.round(st.mtimeMs)}`; }
          writeJson(ctx(root).p('database', 'sources.json'), cur);
          if (JSON.stringify(sig) === JSON.stringify(cur) && readManifest(root).targets[targetKey(t)]) return json ? JSON.stringify({ unchanged: true }) : 'No SQL source changed since the last discovery: nothing was re-read.';
        } else { const cur = {}; for (const f of model.sourceFiles) { const st = fs.statSync(path.join(root, f)); cur[f] = `${st.size}:${Math.round(st.mtimeMs)}`; } writeJson(ctx(root).p('database', 'sources.json'), cur); }
      }
      const r = applyModel(root, { scope: 'backend', target: t, model, source, sourceFile, stamp });
      const mp = mapApplication(root, { files: walkFiles(root), tkey: r.key });
      if (graphExists(c)) { const g = loadGraph(c); toGraph(root, g, upsert, { tkey: r.key, configFile: t.sources?.[0]?.file }); saveGraph(c, g); }
      if (!args.quiet) logEvent(c, { event: 'database', action: sub, source, objects: r.diff.added.length + r.diff.changed.length, removed: r.diff.removed.length });
      const d = r.diff;
      if (json) return JSON.stringify({ target: t.id, environment: t.environment, source, ...d, mapped: mp.items.length, limitations: r.limitations }, null, 2);
      say(`${refresh ? 'Refreshed' : 'Discovered'} ${t.engine} · ${model.database || t.database || '(database)'} [${t.environment}] from ${source === 'catalog' ? (args['catalog-file'] ? 'a catalog export' : 'catalog views (read-only)') : 'SQL scripts (no connection)'}`);
      say(`added ${d.added.length} · changed ${d.changed.length} · removed ${d.removed.length} · unchanged ${d.unchanged.length}${d.review.length ? ` · ${d.review.length} flagged for review (secret literal; definition not stored)` : ''}`);
      say(`application mapping: ${mp.items.length} call/ORM site(s), ${mp.chain.length} service/repository link(s)`);
      for (const l of r.limitations.slice(0, 6)) say(`limitation: ${l}`);
      return out.join('\n');
    }
    case 'find': {
      const q = args._.slice(1).join(' '); if (!q) fail('Usage: rmc database find "<table|column|procedure|parameter>"');
      const hits = findObjects(root, q, { limit: Number(args.limit) || 10 });
      if (json) return JSON.stringify(hits, null, 2);
      return hits.length ? hits.map((h) => `${h.kind} ${h.schema ? h.schema + '.' : ''}${h.name} (${h.why.join(', ')})`).join('\n') : 'No recorded database object matched. Nothing is invented: run `rmc database discover` or read the schema source.';
    }
    case 'show': case 'inspect': {
      const kind = a1; const name = args._.slice(2).join(' ');
      if (!['table', 'procedure', 'view', 'function', 'trigger'].includes(kind) || !name) fail('Usage: rmc database show table|procedure|view|function <name> [--definition]');
      const rec = showObject(root, kind, name, { definition: Boolean(args.definition) });
      if (!rec) fail(`No recorded ${kind} named "${name}". Run discovery first; the CLI never invents structure.`);
      if (json) return JSON.stringify(rec, null, 2);
      say(`${rec.kind} ${rec.schema ? rec.schema + '.' : ''}${rec.name} · ${rec.status} · ${rec.confidence} · ${rec.provenance.source}${rec.provenance.file ? ` (${rec.provenance.file})` : ''} · discovered ${rec.provenance.discoveredAt?.slice(0, 10)}`);
      if (rec.columns) say(`columns: ${rec.columns.map((x) => `${x.name} ${x.type}${x.pk ? ' PK' : ''}${x.nullable ? '' : ' NOT NULL'}${x.identity ? ' IDENTITY' : ''}`).join(', ')}`), rec.foreignKeys?.length && say(`foreign keys: ${rec.foreignKeys.map((f) => `${f.columns.join(',')} → ${f.ref.name}(${(f.refColumns || []).join(',')})`).join('; ')}`), rec.indexes?.length && say(`indexes: ${rec.indexes.map((i) => `${i.name}(${i.columns.join(',')})${i.unique ? ' unique' : ''}`).join('; ')}`);
      if (rec.params) say(`parameters: ${rec.params.map((p) => `${p.name} ${p.type}${p.mode !== 'IN' ? ' ' + p.mode : ''}`).join(', ') || '(none)'}`);
      if (rec.encrypted) say('definition: ENCRYPTED or inaccessible (recorded as a limitation)');
      if (rec.reviewRequired) say(`review required: ${rec.redactionReason}`);
      if (rec.dependsOn?.length) say(`depends on: ${rec.dependsOn.map((d) => `${d.to} [${d.mode || d.toKind}, ${d.confidence}${d.status ? ', ' + d.status : ''}]`).join('; ')}`);
      if (rec.usedBy?.length) say(`used by: ${rec.usedBy.map((d) => d.from).join(', ')}`);
      if (rec.application?.length) say(`application: ${rec.application.slice(0, 8).map((x) => `${x.file}:${x.line} (${x.role}, ${x.evidence})`).join('; ')}`);
      if (rec.definition) say('', rec.definition);
      return out.join('\n');
    }
    case 'catalog-sql': {
      const eng = typeof args.engine === 'string' ? args.engine : (pickTarget(root, args).engine);
      return catalogStatements(eng).map((s) => (typeof s === 'string' ? s : `-- ${s.name}\n${s.sql};`)).join('\n\n');
    }
    case 'map': {
      const t = pickTarget(root, args); const m = mapApplication(root, { files: walkFiles(root), tkey: targetKey(t) });
      return json ? JSON.stringify(m, null, 2) : `application mapping: ${m.items.length} site(s), ${m.chain.length} link(s) (only call/ORM/declared-type evidence is recorded)`;
    }
    case 'migrations': { const m = detectMigrations(root); return json ? JSON.stringify(m, null, 2) : m.length ? m.map((x) => `${x.framework}: ${x.count} file(s) in ${x.dir} · run: ${x.up || 'manual'} · down: ${x.down || 'manual'}`).join('\n') : 'No migration framework detected.'; }
    case 'target': {
      if (a1 !== 'confirm') fail('Usage: rmc database target confirm <id> <LOCAL|DEV|TEST|STAGING|PRODUCTION>');
      const id = args._[2], env = String(args._[3] || '').toUpperCase();
      if (!ENVIRONMENTS.includes(env) || env === 'UNKNOWN') fail(`Environment must be one of ${ENVIRONMENTS.filter((e) => e !== 'UNKNOWN').join(', ')}`);
      const t = targets(root).find((x) => x.id === id || x.id.startsWith(id)); if (!t) fail('Unknown target id; see `rmc database status`.');
      const cfg = readJson(c.config, {}); cfg.database = cfg.database || {}; cfg.database.targets = { ...(cfg.database.targets || {}), [t.id]: { environment: env, confirmedAt: now() } }; writeJson(c.config, cfg);
      return `Target ${t.id} is recorded as ${env}. (Only a non-secret identity and the environment name are stored.)`;
    }
    case 'plan-change': {
      if (typeof args.file !== 'string') fail('Usage: rmc database plan-change --file <migration> [--target <id>] [--object table:dbo.Name]');
      const objs = [].concat(args.object || []).filter((x) => typeof x === 'string');
      const plan = chg.planChange(root, { file: args.file, targetId: typeof args.target === 'string' ? args.target : undefined, objects: objs, targets: targets(root), nowFn: deps.now });
      if (json) return JSON.stringify(chg.statusOf(plan), null, 2);
      say(`Change plan ${plan.id} · ${plan.environment} · ${plan.target.engine} ${plan.target.database || ''} · risk ${plan.risk}`);
      say(`policy: ${plan.policy.description}`);
      say(`migration: ${plan.migration.file} (${plan.migration.framework})${plan.migration.runner ? ` · runner: ${plan.migration.runner}` : ' · no runner detected'}`);
      say(`affected: ${plan.affected.map((o) => `${o.op} ${o.kind} ${o.name}`).join(', ') || 'unknown'}`);
      if (plan.destructive.length) say(`DESTRUCTIVE: ${plan.destructive.join('; ')}`);
      if (plan.unparsed) say(`note: ${plan.unparsed}`);
      if (plan.blockedReason) say(`BLOCKED: ${plan.blockedReason}`);
      else if (plan.policy.tier === 'dev') say(`next: review the migration, then \`rmc database apply ${plan.id}\`${plan.destructive.length ? ` (destructive: approve first with phrase "${chg.approvalPhrase(plan, 'destructive')}")` : ''}. No backup objects in ${plan.environment}.`);
      else say(`next: default is a manual package → \`rmc database package ${plan.id}\`. If the user asks Claude to apply: backup plan → approvals → backup → verify → final approval.`);
      return out.join('\n');
    }
    case 'change': {
      if (a1 !== 'status') fail('Usage: rmc database change status [<id>]');
      const id = args._[2];
      const list = id ? [chg.loadPlan(root, id)] : chg.listPlans(root);
      return json ? JSON.stringify(list.map(chg.statusOf), null, 2) : list.length ? list.map((p) => { const s = chg.statusOf(p); return `${s.id} · ${s.stage} · ${s.environment} · ${s.target} · risk ${s.risk} · backup ${s.backup} · approvals [${s.approvals.join(',')}] · native ${s.nativeBackup} · rollback ${s.rollback}`; }).join('\n') : 'No change plans.';
    }
    case 'approve': {
      const p = chg.recordApproval(root, a1, String(args.stage || ''), typeof args.phrase === 'string' ? args.phrase : '', { nowFn: deps.now });
      return `Approval recorded for ${args.stage} on ${p.environment} / ${p.target.database || p.target.id} (valid 2 hours, bound to this plan and environment).`;
    }
    case 'package': { const p = chg.manualPackage(root, a1); return `Manual package ready: ${p.package.dir}\nClaude changed nothing in the database. Apply it yourself, then verify.`; }
    case 'rollback': { const r = chg.prepareRollback(root, a1); return `Rollback script saved (${r.plan.rollback.file}). It is never run automatically.${r.caveats.length ? '\nCaveats:\n- ' + r.caveats.join('\n- ') : ''}`; }
    case 'native-backup': { chg.recordNativeBackup(root, a1, String(args.ref || '')); return 'Native backup/snapshot reference recorded (attested by you; the CLI cannot verify it).'; }
    case 'cancel': { chg.cancelChange(root, a1); return `Change ${a1} cancelled. No database change was made by RM Context.`; }
    case 'backup': {
      const plan0 = chg.loadPlan(root, a1);
      const t = targets(root).find((x) => x.id === plan0.target.id);
      const probe = deps.executor ? deps.executor(t || plan0.target, 'read') : (args.connect ? await liveRead(root, t || plan0.target, args, deps) : null);
      const model = deps.model || null;
      const res = await chg.planBackup(root, a1, { model, probe, nowFn: deps.now });
      say(`Backup plan for ${a1} (${res.plan.environment}): ${res.items.length} object(s)`);
      for (const i of res.items) say(`- ${i.kind} ${i.original} → ${i.backup}\n    preserved: ${i.preserved?.join(', ') || 'definition'}\n    not preserved: ${i.notPreserved?.join('; ') || 'n/a'}`);
      for (const b of res.blockers) say(`BLOCKER: ${b}`);
      if (!args.execute) { if (!res.blockers.length) say(`approve with: ${chg.approvalPhrase(res.plan, 'backup')}`); return out.join('\n'); }
      if (res.blockers.length) fail('Backup blocked; nothing was created.');
      const w = deps.executor ? deps.executor(t || plan0.target, 'write') : (t?.engine === 'sqlite' ? await sqliteWriteExecutor(path.join(root, t.sources.find((s) => s.source === 'sqlite-file').file)) : cliExecutor(t || plan0.target, { write: true }));
      await chg.createBackup(root, a1, { run: w, probe, items: res.items, nowFn: deps.now });
      w.close?.();
      say('Backup objects created. Next: rmc database verify-backup ' + a1);
      return out.join('\n');
    }
    case 'verify-backup': {
      const plan0 = chg.loadPlan(root, a1); const t = targets(root).find((x) => x.id === plan0.target.id);
      const probe = deps.executor ? deps.executor(t || plan0.target, 'read') : await liveRead(root, t || plan0.target, args, deps);
      const v = await chg.verifyBackup(root, a1, { probe });
      for (const r of v.results) say(`${r.ok ? 'OK  ' : 'FAIL'} ${r.object} → ${r.backup} (${r.check}) ${JSON.stringify(r.detail)}`);
      say(v.ok ? 'Backup VERIFIED.' : 'Backup NOT verified: the change is blocked.');
      if (!v.ok) { return out.join('\n'); }
      return out.join('\n');
    }
    case 'apply': {
      const plan0 = chg.loadPlan(root, a1); const t = targets(root).find((x) => x.id === plan0.target.id);
      const probe = deps.executor ? deps.executor(t || plan0.target, 'read') : (args.connect ? await liveRead(root, t || plan0.target, args, deps) : null);
      const r = await chg.applyChange(root, a1, { probe, run: deps.runMigration, confirmTarget: Boolean(args['confirm-target']), userRequestedApply: Boolean(args['user-requested']), nowFn: deps.now });
      return r.ok ? `Migration applied (${r.plan.environment}). Verify the result, then keep the rollback script.` : `Migration command failed (status ${r.plan.applyResult.status}). Review before retrying; rollback: ${r.plan.rollback?.file || 'not prepared'}`;
    }
    default: fail(`Unknown database command "${sub}". Run: rmc database help`);
  }
}

function audit(root, op, t, hashes = []) { chg.audit(root, { event: op, operation: op, environment: t.environment, target: t.id, result: 'ok', stmts: hashes.slice(0, 200) }); }

// New-project init: static detection only (config files, SQL scripts, mobile build files). Never opens a connection.
export async function initIntel(root) {
  const lines = [];
  try {
    const ts = detectDatabaseConfig(root);
    const src = detectSchemaSources(root);
    if (ts.length || src['sql-script'].length) {
      const out = await databaseCommand(root, { _: ['discover'], quiet: true });
      lines.push(`Database: ${ts.length} target(s) detected (no connection opened). ${out.split('\n')[1] || ''}`.trim());
    }
  } catch (e) { if (!/targets were detected|not found/.test(e.message)) lines.push(`Database discovery skipped: ${String(e.message).split('\n')[0]}`); else lines.push('Database: several targets detected; run `rmc database discover --target <id>`.'); }
  try {
    const M = await import('../mobile.mjs');
    const r = M.detectMobile(root);
    if (r.platforms.length) { M.saveMobile(root, r); lines.push(`Mobile: ${r.platforms.map((p) => p.platform).join(', ')} · ${r.architecture.map((a) => a.name).slice(0, 4).join(', ') || 'no pattern'}`); }
  } catch { /* optional */ }
  return lines;
}

// Existing projects: no automatic discovery. One line tells the user the targeted, one-time commands exist.
export async function intelHint(root) {
  try {
    const hint = [];
    if (!fs.existsSync(path.join(dbDir(root), 'manifest.json')) && (detectDatabaseConfig(root).length || detectSchemaSources(root)['sql-script'].length)) hint.push('rmc database discover');
    if (!fs.existsSync(path.join(root, '.rmcontext', 'mobile', 'manifest.json'))) { const M = await import('../mobile.mjs'); if (M.detectPlatforms(root, walkFiles(root)).length) hint.push('rmc mobile detect'); }
    return hint.length ? [`Optional one-time targeted discovery (no full scan, no connection): ${hint.join(' · ')}`] : [];
  } catch { return []; }
}
