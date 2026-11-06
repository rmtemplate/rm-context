// Delegation guard for RM Context agents (Claude Code hooks). Deterministic, no model calls.
//   PreToolUse  (Agent/Task) → deny background execution and a second RM Context agent while one is still running.
//   PostToolUse (Agent/Task) → read the subagent's own transcript and report the model that actually ran and whether
//                              it ran in the foreground, so the main session never reports a configured model as fact.
// Only agents of this plugin (rmc:*) are guarded; other plugins' agents are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isRmcAgent = (t) => /^(rmc|rm-context):/.test(String(t || ''));
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const lockFile = (sid) => path.join(os.tmpdir(), `rmc-delegation-${String(sid || 'default').replace(/[^\w-]/g, '')}.json`);
const readLock = (sid) => { try { return JSON.parse(fs.readFileSync(lockFile(sid), 'utf8')); } catch { return null; } };
export const clearLock = (sid) => { try { fs.rmSync(lockFile(sid), { force: true }); } catch { /* ignore */ } };

// Returns a deny reason, or null to allow. conf.background: 'deny' (default) | 'allow'.
export function preAgent(input, conf = {}) {
  const ti = input.tool_input || {};
  if (!isRmcAgent(ti.subagent_type)) return null;
  const allowBg = conf.background === 'allow' || process.env.RMC_ALLOW_BACKGROUND === '1';
  if (ti.run_in_background && !allowBg) {
    return 'RM Context delegates in the foreground. Call the Agent tool again without run_in_background and wait for its result. '
      + '(Only if the user explicitly asked for background or parallel work: set "delegation": { "background": "allow" } in .rmcontext/config.json.)';
  }
  if (allowBg) return null; // background/parallel explicitly allowed: no one-at-a-time lock
  const lock = readLock(input.session_id);
  if (lock && lock.toolUseId !== input.tool_use_id && Date.now() - lock.at < LOCK_TTL_MS) {
    return `RM Context runs one agent at a time: ${lock.agent} is still running. Wait for its result, then delegate the next role.`;
  }
  try { fs.writeFileSync(lockFile(input.session_id), JSON.stringify({ toolUseId: input.tool_use_id, agent: ti.subagent_type, at: Date.now() })); } catch { /* ignore */ }
  return null;
}

// Execution facts for one finished delegation, from Claude Code's own records (never from configuration).
export function agentFacts(input) {
  const ti = input.tool_input || {};
  const res = input.tool_response || {};
  const id = res.agentId || res.agent_id;
  const facts = { agent: ti.subagent_type, requested: ti.model || null, models: {}, shape: null, async: res.isAsync === true || res.status === 'async_launched' || undefined };
  if (input.transcript_path && id) {
    const dir = path.join(input.transcript_path.replace(/\.jsonl$/, ''), 'subagents');
    try { const m = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), 'utf8')); facts.shape = m.requestShape || null; } catch { /* older Claude Code: no meta file */ }
    try {
      for (const line of fs.readFileSync(path.join(dir, `agent-${id}.jsonl`), 'utf8').split('\n')) {
        if (!line.includes('"assistant"')) continue;
        try { const d = JSON.parse(line); const m = d.type === 'assistant' && d.message?.model; if (m && m !== '<synthetic>') facts.models[m] = (facts.models[m] || 0) + 1; } catch { /* partial line */ }
      }
    } catch { /* transcript not found */ }
  }
  if (!Object.keys(facts.models).length && typeof res.resolvedModel === 'string') facts.resolvedModel = res.resolvedModel;
  const usage = res.usage || {};
  facts.tokens = res.totalTokens ?? (usage.input_tokens != null ? (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : null);
  facts.durationMs = res.totalDurationMs ?? null;
  return facts;
}

export function postAgentText(f) {
  const role = String(f.agent).replace(/^(rmc|rm-context):/, '');
  const bg = f.async || f.shape === 'background';
  const actual = Object.keys(f.models);
  const parts = [`[RM CONTEXT] Delegation check for ${role}:`];
  parts.push(bg ? 'it ran in the BACKGROUND (not the foreground mode RM Context requires); say so to the user.' : f.shape ? `it ran in the ${f.shape === 'sync' ? 'foreground' : f.shape} mode (Claude Code requestShape).` : 'its execution mode was not recorded.');
  if (actual.length) parts.push(`Actual model (subagent transcript): ${actual.join(', ')}; requested: ${f.requested || 'none (inherited)'}.`);
  else if (bg) parts.push('The actual model is not known yet because the agent is still running.');
  else parts.push(`The actual model could not be verified from execution metadata${f.resolvedModel ? ` (Claude Code resolved "${f.resolvedModel}" before launch)` : ''}; do not tell the user the model switch succeeded.`);
  if (actual.length && f.requested && !actual.some((m) => m.includes(f.requested))) parts.push(`The actual model differs from the requested "${f.requested}": tell the user.`);
  return parts.join(' ');
}
