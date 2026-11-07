// PreToolUse(Bash) permission boundary for database work. Deterministic; no model calls; reads plan metadata only.
// Returns { decision: 'ask' | 'deny', reason } or null (allow). Complements the CLI/adapter enforcement; it never replaces it.
import fs from 'node:fs';
import path from 'node:path';
import { classifyShell } from './guard.mjs';

function plans(c) {
  const d = c.p('state', 'database-changes');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).flatMap((f) => { try { return [JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))]; } catch { return []; } });
}
const active = (p) => !['applied', 'cancelled'].includes(p.stage);

export function preBash(c, input) {
  const cmd = String(input?.tool_input?.command || '');
  if (!cmd || !c) return null;
  const k = classifyShell(cmd).kind;
  if (k === 'other') return null;
  const all = plans(c);
  const protectedActive = all.filter((p) => active(p) && ['STAGING', 'PRODUCTION'].includes(p.environment));
  if (k === 'db-client-mutating') return { decision: 'deny', reason: 'RM Context: a database client was invoked with a mutating statement. Schema changes go through migrations and `rmc database plan-change` / `apply`; discovery is read-only. Nothing was run.' };
  if (k === 'db-client') {
    if (all.some(active)) return { decision: 'deny', reason: 'RM Context: a database change plan is active. Do not use database clients directly during a protected workflow; use `rmc database …` so the environment policy, approvals and audit apply.' };
    return null;
  }
  if (k === 'migration-runner') {
    if (protectedActive.length) return { decision: 'deny', reason: `RM Context: ${protectedActive[0].environment} change ${protectedActive[0].id} is in progress. Run migrations only through \`rmc database apply\`; a migration that worked elsewhere is not approval here.` };
    return { decision: 'ask', reason: 'RM Context: this runs a database migration directly. Confirm the target database/environment first (`rmc database status`); STAGING and PRODUCTION migrations must go through `rmc database plan-change`.' };
  }
  if (k === 'rmc-protected') {
    const id = /\bCHG-\d{8}-[A-Z0-9]{4}\b/.exec(cmd)?.[0];
    const plan = id ? all.find((p) => p.id === id) : null;
    const isApprove = /\bdatabase\s+approve\b/.test(cmd);
    const isExec = /\bdatabase\s+(backup\b[^|;&]*--execute|apply|approve)\b/.test(cmd);
    if (!isExec) return null;
    if (plan && ['STAGING', 'PRODUCTION'].includes(plan.environment)) return { decision: 'ask', reason: `RM Context: ${isApprove ? 'record an approval for' : 'execute a protected step of'} ${plan.environment} change ${plan.id} on ${plan.target?.database || plan.target?.id}. Only approve if YOU reviewed the migration, impact, backup and rollback plan.` };
    if (isApprove) return { decision: 'ask', reason: `RM Context: recording an approval${plan ? ` for ${plan.environment}` : ''} change. Confirm you reviewed the impact.` };
    if (plan?.destructive?.length) return { decision: 'ask', reason: `RM Context: applying destructive ${plan.environment} migration ${plan.id} (${plan.destructive[0]}).` };
  }
  return null;
}
