#!/usr/bin/env node
// Claude Code lifecycle hooks for RM Context. Deterministic and fast: no LLM calls, no full scans, never blocks the session.
//   session-start  → compact project summary (+ exports RMC_CLI for Bash)
//   prompt         → relevant .rmcontext knowledge for the submitted prompt, within the token budget, plus an optional
//                    one-line routing suggestion (deterministic classifier; Claude decides whether to delegate)
//   post-tool      → records files changed by Write/Edit/MultiEdit/NotebookEdit, or a possibly-mutating Bash command
//   stop           → one coalesced incremental refresh for everything recorded during the turn, plus the turn's own
//                    main-session token usage (read from the transcript, metadata only)
//   pre-agent      → RM Context agents run in the foreground, one at a time (denies run_in_background / a second agent)
//   post-agent     → reports the model that actually ran, read from the subagent transcript (never from configuration),
//                    and records the subagent's cumulative token usage from the same transcript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rmc.mjs');
const event = process.argv[2];

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
let input = {};
try { input = raw ? JSON.parse(raw) : {}; } catch { /* malformed input: behave as if empty */ }

const emit = (obj) => process.stdout.write(JSON.stringify(obj));
let c = null;

try {
  const X = await import('./lib/context.mjs');
  c = X.findProject(input.cwd || process.cwd());
  const conf = X.autoConfig(c);

  if (event === 'session-start') {
    const D = await import('./lib/delegation.mjs');
    D.clearLock(input.session_id);
    if (input.session_id) {
      const s = D.readSession(input.session_id);
      const model = typeof input.model === 'string' ? input.model : input.model?.id;
      if (model) s.sessionModel = model;
      D.writeSession(input.session_id, s);
    }
    // forward slashes: sourced by bash, also on Windows. RMC_SESSION_ID lets `rmc route --suggested` find this session's current prompt.
    if (process.env.CLAUDE_ENV_FILE) fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export RMC_CLI="${CLI.replace(/\\/g, '/')}"\n${input.session_id ? `export RMC_SESSION_ID="${String(input.session_id).replace(/[^\w-]/g, '')}"\n` : ''}`);
    const text = X.sessionSummary(c, CLI);
    if (text) emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
  }

  else if (event === 'prompt') {
    const prompt = String(input.prompt || '');
    const sid = input.session_id;
    const eligible = prompt.trim().length >= 8 && !prompt.trim().startsWith('/');
    const parts = [];
    let hits = 0;
    if (c) {
      const D = await import('./lib/delegation.mjs');
      const done = D.endTurn(sid, c.root, input.transcript_path); // the previous prompt's turn, if Stop never ran (interrupted)
      if (done?.outcome) X.logEvent(c, { event: 'suggestion-outcome', sid, ...done.outcome });
      if (done?.usage) X.logEvent(c, { event: 'turn-usage', sid, ...done.usage });
      if (conf.enabled && conf.promptRetrieval && eligible) {
        const r = X.retrieve(c, prompt);
        hits = r.hits;
        X.logEvent(c, { event: 'prompt', terms: r.terms, hits: r.hits, tokens: r.text ? r.tokens : 0, ms: r.ms });
        if (r.text) parts.push(r.text);
      }
      const s = eligible ? (await import('./lib/routing.mjs')).suggestForPrompt(c, prompt, { sessionModel: D.readSession(sid).sessionModel, hits }) : null;
      const { text, ...meta } = s || {};
      const turn = D.startTurn(sid, c.root, s ? meta : null, input.transcript_path);
      if (s) {
        // Metadata only: category, agent, model and confidence, never the prompt.
        X.logEvent(c, { event: 'suggestion', sid, promptId: turn?.id || null, ...meta });
        parts.push(text);
      }
    }
    if (parts.length) emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } });
  }

  else if (event === 'post-tool') {
    if (c && conf.enabled && conf.incrementalRefresh) X.recordChange(c, input);
  }

  else if (event === 'pre-agent') {
    const D = await import('./lib/delegation.mjs');
    const delegation = c && fs.existsSync(c.config) ? JSON.parse(fs.readFileSync(c.config, 'utf8')).delegation || {} : {};
    const deny = D.preAgent(input, delegation);
    if (deny) {
      if (c) X.logEvent(c, { event: 'delegation-denied', sid: input.session_id, agent: input.tool_input?.subagent_type, kind: deny.kind });
      emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny.reason } });
    }
  }

  else if (event === 'post-agent') {
    const D = await import('./lib/delegation.mjs');
    if (input.hook_event_name === 'PostToolUseFailure') {
      D.clearLock(input.session_id);
      // A failed RM Context delegation is still one delegation: recorded with status failed (no error text, which can carry content).
      if (c && D.isRmcAgent(input.tool_input?.subagent_type)) {
        const t = D.currentTurn(input.session_id, c.root);
        X.logEvent(c, { event: 'delegation', sid: input.session_id, promptId: t?.id || null, suggestionId: t?.suggestion?.id || null, delegationId: input.tool_use_id || null,
          agent: input.tool_input.subagent_type, requested: input.tool_input.model || null, actual: [], status: 'failed' });
      }
    }
    else if (D.isRmcAgent(input.tool_input?.subagent_type)) {
      D.clearLock(input.session_id);
      const f = D.agentFacts(input);
      if (c) {
        // Link the delegation to the current prompt's suggestion and rmc route, if any (same session, same project).
        const role = String(f.agent).replace(/^(rmc|rm-context):/, '');
        const t = D.updateTurn(input.session_id, c.root, (x) => { x.agents.push(role); });
        // Metadata only (agent, models, mode, size, correlation ids): never the prompt or the agent's output.
        X.logEvent(c, { event: 'delegation', sid: input.session_id, promptId: t?.id || null, suggestionId: t?.suggestion?.id || null,
          followed: t?.suggestion ? t.suggestion.agent === role : null, routeId: t?.route?.agent === role ? t.route.id : null,
          delegationId: input.tool_use_id || null, agentId: f.agentId, agent: f.agent, requested: f.requested, actual: Object.keys(f.models),
          shape: f.shape || (f.async ? 'background' : null), status: f.async ? 'started' : 'completed', tokens: f.tokens, ms: f.durationMs,
          startedAt: f.durationMs != null ? new Date(Date.now() - f.durationMs).toISOString() : null, usage: f.usage });
      }
      emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: D.postAgentText(f) } });
    }
  }

  else if (event === 'stop') {
    const D = await import('./lib/delegation.mjs');
    D.clearLock(input.session_id);
    const done = c ? D.endTurn(input.session_id, c.root, input.transcript_path) : null;
    if (done?.outcome) X.logEvent(c, { event: 'suggestion-outcome', sid: input.session_id, ...done.outcome });
    if (done?.usage) X.logEvent(c, { event: 'turn-usage', sid: input.session_id, ...done.usage });
    if (c && conf.enabled && conf.incrementalRefresh && !input.stop_hook_active) {
      const s = await X.applyPending(c);
      if (s) {
        X.logEvent(c, { event: 'refresh', mode: s.mode, unchanged: !!s.unchanged, files: s.changedFiles?.length || 0, ms: s.durationMs });
        if (!s.unchanged) emit({ systemMessage: X.formatRefresh(s) });
      }
    }
  }
} catch (err) {
  // A hook must never break the user's session: record the problem and carry on.
  try { if (c) (await import('./lib/context.mjs')).logEvent(c, { event: 'error', hook: event, message: String(err?.message || err).slice(0, 300) }); } catch { /* ignore */ }
}
process.exit(0);
