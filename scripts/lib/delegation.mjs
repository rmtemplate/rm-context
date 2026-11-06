// Delegation guard for RM Context agents (Claude Code hooks). Deterministic, no model calls.
//   PreToolUse  (Agent/Task) → deny background execution and a second RM Context agent while one is still running.
//   PostToolUse (Agent/Task) → read the subagent's own transcript and report the model that actually ran and whether
//                              it ran in the foreground, so the main session never reports a configured model as fact.
// Only agents of this plugin (rmc:*) are guarded; other plugins' agents are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsage, fileSize } from './usage.mjs';

export const isRmcAgent = (t) => /^(rmc|rm-context):/.test(String(t || ''));
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const safe = (sid) => String(sid || 'default').replace(/[^\w-]/g, '');
const lockFile = (sid) => path.join(os.tmpdir(), `rmc-delegation-${safe(sid)}.json`);
const readLock = (sid) => { try { return JSON.parse(fs.readFileSync(lockFile(sid), 'utf8')); } catch { return null; } };
export const clearLock = (sid) => { try { fs.rmSync(lockFile(sid), { force: true }); } catch { /* ignore */ } };

// Returns { kind: 'background' | 'concurrent', reason } to deny, or null to allow. conf.background: 'deny' (default) | 'allow'.
export function preAgent(input, conf = {}) {
  const ti = input.tool_input || {};
  if (!isRmcAgent(ti.subagent_type)) return null;
  const allowBg = conf.background === 'allow' || process.env.RMC_ALLOW_BACKGROUND === '1';
  if (ti.run_in_background && !allowBg) {
    return { kind: 'background', reason: 'RM Context delegates in the foreground. Call the Agent tool again without run_in_background and wait for its result. '
      + '(Only if the user explicitly asked for background or parallel work: set "delegation": { "background": "allow" } in .rmcontext/config.json.)' };
  }
  if (allowBg) return null; // background/parallel explicitly allowed: no one-at-a-time lock
  const lock = readLock(input.session_id);
  if (lock && lock.toolUseId !== input.tool_use_id && Date.now() - lock.at < LOCK_TTL_MS) {
    return { kind: 'concurrent', reason: `RM Context runs one agent at a time: ${lock.agent} is still running. Wait for its result, then delegate the next role.` };
  }
  try { fs.writeFileSync(lockFile(input.session_id), JSON.stringify({ toolUseId: input.tool_use_id, agent: ti.subagent_type, at: Date.now() })); } catch { /* ignore */ }
  return null;
}

// ---------- per-session turn state (tmp file, metadata only, never prompt text) ----------
// One "turn" per submitted prompt: its routing suggestion, the rmc route taken for it and the RM Context agents that ran.
// rmc route reuses the suggestion's classification (same session, same project, same prompt, not expired), and stats can
// tell a followed suggestion from an ignored one. A new prompt, Stop or expiry ends the turn, so an older prompt's
// classification is never reused.
export const TURN_TTL_MS = 30 * 60 * 1000;
const sessionFile = (sid) => path.join(os.tmpdir(), `rmc-session-${safe(sid)}.json`);
export const readSession = (sid) => { try { return JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')); } catch { return {}; } };
export const writeSession = (sid, s) => { try { fs.writeFileSync(sessionFile(sid), JSON.stringify(s)); } catch { /* ignore */ } };
export const clearSession = (sid) => { try { fs.rmSync(sessionFile(sid), { force: true }); } catch { /* ignore */ } };

export function currentTurn(sid, root) {
  if (!sid) return null;
  const t = readSession(sid).turn;
  return t && t.root === root && Date.now() - t.at < TURN_TTL_MS ? t : null;
}

// transcript: the main transcript path. Its size now is where this prompt's usage starts (per-prompt allocation).
// A session's first prompt fires before Claude Code creates the file (observed, 2.1.319): nothing precedes it, offset 0.
export function startTurn(sid, root, suggestion, transcript) {
  if (!sid) return null;
  const s = readSession(sid);
  const offset = transcript ? fileSize(transcript) ?? 0 : null;
  s.turn = { id: `P-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: Date.now(), root, suggestion: suggestion || null, route: null, agents: [],
    tx: offset != null ? { path: transcript, offset } : null };
  writeSession(sid, s);
  return s.turn;
}

export function updateTurn(sid, root, fn) {
  const s = readSession(sid);
  if (!s.turn || s.turn.root !== root) return null;
  fn(s.turn);
  writeSession(sid, s);
  return s.turn;
}

const outcomeOf = (t) => (t.agents.includes(t.suggestion.agent) ? 'followed' : t.agents.length ? 'other-agent' : 'direct');

// Ends the current turn. Returns the outcome of its suggestion (null if it had none):
// followed = the suggested agent ran · other-agent = a different RM Context agent ran · direct = no RM Context agent ran.
// transcript: the main transcript, so the turn's own main-session usage is measured too (see turnUsage).
export function endTurn(sid, root, transcript) {
  if (!sid) return null;
  const s = readSession(sid);
  const t = s.turn;
  if (!t) return null;
  delete s.turn;
  writeSession(sid, s);
  if (t.root !== root) return null;
  const outcome = t.suggestion ? { suggestionId: t.suggestion.id, promptId: t.id, agent: t.suggestion.agent, outcome: outcomeOf(t), viaRoute: Boolean(t.route) } : null;
  return { outcome, usage: turnUsage(t, transcript) };
}

// Main-session usage of one turn: the transcript from the offset recorded at the prompt ("task" allocation). Without an
// offset the whole transcript is read and marked "session" allocation, so it is never presented as one task's cost.
// Sidechain lines are skipped: subagent usage is recorded per delegation from its own transcript.
export function turnUsage(t, transcript) {
  const file = t.tx?.path || transcript;
  const u = readUsage(file, { from: t.tx?.offset || 0, skipSidechain: true });
  if (!u || !u.calls) return null;
  return { promptId: t.id, suggestionId: t.suggestion?.id || null, category: t.suggestion?.category || null, decision: t.suggestion?.decision || null,
    outcome: t.suggestion ? outcomeOf(t) : t.agents.length ? 'delegated' : 'direct', delegations: t.agents.length,
    allocation: t.tx ? 'task' : 'session', calls: u.calls, mainAt: u.at, main: u.groups, overhead: u.overhead, ms: Date.now() - t.at };
}

// Execution facts for one finished delegation, from Claude Code's own records (never from configuration).
export function agentFacts(input) {
  const ti = input.tool_input || {};
  const res = input.tool_response || {};
  const id = res.agentId || res.agent_id;
  const facts = { agent: ti.subagent_type, agentId: id || null, requested: ti.model || null, models: {}, shape: null, usage: null, async: res.isAsync === true || res.status === 'async_launched' || undefined };
  if (input.transcript_path && id) {
    const dir = path.join(input.transcript_path.replace(/\.jsonl$/, ''), 'subagents');
    try { const m = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), 'utf8')); facts.shape = m.requestShape || null; } catch { /* older Claude Code: no meta file */ }
    try {
      for (const line of fs.readFileSync(path.join(dir, `agent-${id}.jsonl`), 'utf8').split('\n')) {
        if (!line.includes('"assistant"')) continue;
        try { const d = JSON.parse(line); const m = d.type === 'assistant' && d.message?.model; if (m && m !== '<synthetic>') facts.models[m] = (facts.models[m] || 0) + 1; } catch { /* partial line */ }
      }
    } catch { /* transcript not found */ }
    // Cumulative usage of every API call the subagent made (one per message id). A background agent may still be running: partial.
    const u = readUsage(path.join(dir, `agent-${id}.jsonl`));
    if (u?.calls) facts.usage = { calls: u.calls, at: u.at, groups: u.groups, partial: facts.async || facts.shape === 'background' || undefined };
  }
  if (!Object.keys(facts.models).length && typeof res.resolvedModel === 'string') facts.resolvedModel = res.resolvedModel;
  // tokens = Claude Code's totalTokens: the context size of the agent's LAST API call, not its cumulative usage (kept for
  // compatibility; analytics use facts.usage).
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
  else if (bg) parts.push('Status: Delegation started; actual model not yet verified (the agent is still running).');
  else parts.push(`The actual model could not be verified from execution metadata${f.resolvedModel ? ` (Claude Code resolved "${f.resolvedModel}" before launch)` : ''}; do not tell the user the model switch succeeded. Status: Delegation started; actual model not yet verified.`);
  if (actual.length && f.requested && !actual.some((m) => m.includes(f.requested))) parts.push(`The actual model differs from the requested "${f.requested}": tell the user.`);
  return parts.join(' ');
}
