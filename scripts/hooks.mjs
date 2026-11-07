#!/usr/bin/env node
// Claude Code lifecycle hooks for RM Context. Deterministic and fast: no LLM calls, no full scans, never blocks the session.
//   session-start  → compact project summary (+ exports RMC_CLI for Bash)
//   prompt         → relevant .rmcontext knowledge for the submitted prompt, within the token budget, plus an optional
//                    one-line routing suggestion (deterministic classifier; Claude decides whether to delegate)
//   post-tool      → records files changed by Write/Edit/MultiEdit/NotebookEdit, or a possibly-mutating Bash command
//   stop           → one coalesced incremental refresh for everything recorded during the turn, plus the turn's own
//                    main-session token usage (read from the transcript, metadata only)
//   pre-bash       → database permission boundary: ask before protected steps, deny db clients/migration runners during a protected change
//   pre-agent      → RM Context agents run in the foreground, one at a time (denies run_in_background / a second agent /
//                    an agent started inside an RM Context agent); during a workflow only the started stage's agent and model
//   post-agent     → reports the model that actually ran, read from the subagent transcript (never from configuration),
//                    and records the subagent's cumulative token usage from the same transcript
//   subagent-start → the started workflow stage's knowledge package, added to that agent's context
//   subagent-stop  → completion evidence (actual model, mode, full usage) for background agents; releases the one-agent lock
// Hooks never call the Agent tool or a model: the main session runs every agent (/rmc:run drives it through rmc workflow).
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
    // /rmc:run <task>: the knowledge for the task itself is retrieved now; the command body drives the workflow.
    const run = /^\/(?:rmc:)?run\s+([\s\S]+)/.exec(prompt.trim())?.[1] || null;
    const eligible = prompt.trim().length >= 8 && !prompt.trim().startsWith('/');
    const parts = [];
    let hits = 0;
    if (c) {
      const D = await import('./lib/delegation.mjs');
      const done = D.endTurn(sid, c.root, input.transcript_path); // the previous prompt's turn, if Stop never ran (interrupted)
      if (done?.outcome) X.logEvent(c, { event: 'suggestion-outcome', sid, ...done.outcome });
      if (done?.usage) X.logEvent(c, { event: 'turn-usage', sid, ...done.usage });
      if (conf.enabled && conf.promptRetrieval && (eligible || run)) {
        const r = X.retrieve(c, run || prompt);
        hits = r.hits;
        X.logEvent(c, { event: 'prompt', terms: r.terms, hits: r.hits, tokens: r.text ? r.tokens : 0, ms: r.ms });
        if (r.text) parts.push(r.text);
      }
      // Main-session model advice (never an agent): a hint only, once per phase, when the desired family differs from the active one.
      if (eligible && conf.enabled) {
        try {
          const R = await import('./lib/routing.mjs'); const SM = await import('./lib/session-model.mjs');
          const k = R.classifyPrompt(prompt, { hits, projectName: JSON.parse(fs.readFileSync(c.manifest, 'utf8')).project?.name });
          const ss = D.readSession(sid);
          if (ss.sessionModel) {
            const userModel = /\b(use|pakai|gunakan|switch to|stay on)\s+(opus|sonnet|haiku)\b/i.exec(prompt)?.[2];
            const plan = SM.planMainSession({ category: k.category, signals: k.signals, activeModel: ss.sessionModel, initialModel: ss.initialModel || ss.sessionModel, userModel });
            if (!ss.initialModel) { ss.initialModel = ss.sessionModel; D.writeSession(sid, ss); }
            const hint = SM.sessionHint(plan);
            if (hint && ss.advised !== plan.desiredModel) { parts.push(hint); SM.recordSession(c, plan); const s2 = D.readSession(sid); s2.advised = plan.desiredModel; D.writeSession(sid, s2); }
            else if (!hint && plan.action === 'none') { const s2 = D.readSession(sid); if (s2.advised) { delete s2.advised; D.writeSession(sid, s2); } }
          }
        } catch { /* advice is optional */ }
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
    // The workflow guard runs first: preAgent takes the one-agent lock when it allows a call.
    const deny = (c ? (await import('./lib/workflow.mjs')).guard(c, input) : null) || D.preAgent(input, delegation);
    if (deny) {
      if (c) X.logEvent(c, { event: 'delegation-denied', sid: input.session_id, agent: input.tool_input?.subagent_type, kind: deny.kind });
      emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny.reason } });
    }
  }

  else if (event === 'pre-bash') {
    // Permission boundary for database work: ask before protected steps, deny direct db clients during a protected change.
    const r = c ? (await import('./lib/database/hook.mjs')).preBash(c, input) : null;
    if (r) {
      X.logEvent(c, { event: 'database-guard', sid: input.session_id, decision: r.decision });
      emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason } });
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
        (await import('./lib/workflow.mjs')).recordRun(c, input.session_id, { agent: input.tool_input.subagent_type, delegationId: input.tool_use_id || null,
          requested: input.tool_input.model || null, status: 'failed', failure: 'Agent tool call failed' });
      }
    }
    else if (D.isRmcAgent(input.tool_input?.subagent_type)) {
      const f = D.agentFacts(input);
      // Finished = it returned synchronously, or its SubagentStop already ran. A background launch keeps the lock (and
      // its usage is partial) until SubagentStop records the completed run.
      const stopped = D.takeStopped(input.session_id, f.agentId) != null;
      const running = Boolean(f.async) && !stopped;
      if (f.usage && !running) delete f.usage.partial;
      if (running) D.holdLock(input.session_id, f.agentId); else D.clearLock(input.session_id);
      if (c) {
        // Link the delegation to the current prompt's suggestion and rmc route, if any (same session, same project).
        const role = String(f.agent).replace(/^(rmc|rm-context):/, '');
        const t = D.updateTurn(input.session_id, c.root, (x) => { x.agents.push(role); });
        // Metadata only (agent, models, mode, size, correlation ids): never the prompt or the agent's output.
        X.logEvent(c, { event: 'delegation', sid: input.session_id, promptId: t?.id || null, suggestionId: t?.suggestion?.id || null,
          followed: t?.suggestion ? t.suggestion.agent === role : null, routeId: t?.route?.agent === role ? t.route.id : null,
          delegationId: input.tool_use_id || null, agentId: f.agentId, agent: f.agent, requested: f.requested, actual: Object.keys(f.models),
          shape: f.shape || (f.async ? 'background' : null), status: running ? 'started' : 'completed', tokens: f.tokens, ms: f.durationMs,
          startedAt: f.durationMs != null ? new Date(Date.now() - f.durationMs).toISOString() : null, usage: f.usage });
        if (running) D.notePending(input.session_id, f.agentId, { promptId: t?.id || null, suggestionId: t?.suggestion?.id || null, routeId: t?.route?.agent === role ? t.route.id : null,
          delegationId: input.tool_use_id || null, agent: f.agent, requested: f.requested, startedAt: new Date().toISOString() });
        (await import('./lib/workflow.mjs')).recordRun(c, input.session_id, { agent: f.agent, agentId: f.agentId, delegationId: input.tool_use_id || null, requested: f.requested,
          actual: Object.keys(f.models), mode: f.shape || (f.async ? 'background' : null), status: running ? 'started' : 'completed', usage: f.usage, ms: f.durationMs });
      }
      emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: D.postAgentText(f) } });
    }
  }

  else if (event === 'subagent-start') {
    // Documented contract: input agent_id + agent_type; output hookSpecificOutput.additionalContext for the subagent.
    const D = await import('./lib/delegation.mjs');
    if (c && D.isRmcAgent(input.agent_type)) {
      const text = (await import('./lib/workflow.mjs')).subagentStart(c, input);
      if (text) emit({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } });
    }
  }

  else if (event === 'subagent-stop') {
    // Documented contract: agent_id, agent_type, agent_transcript_path (the subagent's own transcript), last_assistant_message
    // (not stored: it is the agent's output).
    const D = await import('./lib/delegation.mjs');
    if (D.isRmcAgent(input.agent_type)) {
      const sid = input.session_id;
      D.releaseLock(sid, input.agent_id);
      const t = D.transcriptFacts(input.agent_transcript_path);
      const pend = D.takePending(sid, input.agent_id);
      if (!pend) D.noteStopped(sid, input.agent_id); // foreground: PostToolUse follows and logs the delegation itself
      if (c) {
        if (pend) X.logEvent(c, { event: 'delegation', sid, ...pend, agentId: input.agent_id, actual: Object.keys(t.models), shape: t.shape || 'background', status: 'completed',
          ms: Date.now() - Date.parse(pend.startedAt), usage: t.usage, completedBy: 'SubagentStop' });
        (await import('./lib/workflow.mjs')).recordRun(c, sid, { agent: input.agent_type, agentId: input.agent_id, delegationId: pend?.delegationId, actual: Object.keys(t.models),
          mode: t.shape || (pend ? 'background' : null), status: 'completed', usage: t.usage });
      }
    }
  }

  else if (event === 'stop') {
    const D = await import('./lib/delegation.mjs');
    const lock = D.lockHeld(input.session_id);
    if (!lock?.async) D.clearLock(input.session_id); // a background agent still holds the lock until its SubagentStop
    const done = c ? D.endTurn(input.session_id, c.root, input.transcript_path) : null;
    if (done?.outcome) X.logEvent(c, { event: 'suggestion-outcome', sid: input.session_id, ...done.outcome });
    if (done?.usage) X.logEvent(c, { event: 'turn-usage', sid: input.session_id, ...done.usage });
    const msgs = [];
    if (c && conf.enabled && conf.incrementalRefresh && !input.stop_hook_active) {
      const s = await X.applyPending(c);
      if (s) {
        X.logEvent(c, { event: 'refresh', mode: s.mode, unchanged: !!s.unchanged, files: s.changedFiles?.length || 0, ms: s.durationMs });
        if (!s.unchanged) msgs.push(X.formatRefresh(s));
      }
    }
    // An unfinished workflow is reported to the user as unfinished, never as done (unless its agent is still running).
    const wf = c ? (await import('./lib/workflow.mjs')).stopCheck(c, input.session_id, Boolean(lock?.async)) : null;
    if (wf) { X.logEvent(c, { event: 'workflow', id: wf.w.id, status: 'incomplete', phase: 'turn-end' }); msgs.push(wf.text); }
    if (msgs.length) emit({ systemMessage: msgs.join('\n') });
  }
} catch (err) {
  // A hook must never break the user's session: record the problem and carry on.
  try { if (c) (await import('./lib/context.mjs')).logEvent(c, { event: 'error', hook: event, message: String(err?.message || err).slice(0, 300) }); } catch { /* ignore */ }
}
process.exit(0);
