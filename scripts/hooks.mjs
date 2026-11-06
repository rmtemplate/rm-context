#!/usr/bin/env node
// Claude Code lifecycle hooks for RM Context. Deterministic and fast: no LLM calls, no full scans, never blocks the session.
//   session-start  → compact project summary (+ exports RMC_CLI for Bash)
//   prompt         → relevant .rmcontext knowledge for the submitted prompt, within the token budget
//   post-tool      → records files changed by Write/Edit/MultiEdit/NotebookEdit, or a possibly-mutating Bash command
//   stop           → one coalesced incremental refresh for everything recorded during the turn
//   pre-agent      → RM Context agents run in the foreground, one at a time (denies run_in_background / a second agent)
//   post-agent     → reports the model that actually ran, read from the subagent transcript (never from configuration)
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
    (await import('./lib/delegation.mjs')).clearLock(input.session_id);
    if (process.env.CLAUDE_ENV_FILE) fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export RMC_CLI="${CLI.replace(/\\/g, '/')}"\n`); // forward slashes: sourced by bash, also on Windows
    const text = X.sessionSummary(c, CLI);
    if (text) emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
  }

  else if (event === 'prompt') {
    const prompt = String(input.prompt || '');
    if (c && conf.enabled && conf.promptRetrieval && prompt.trim().length >= 8 && !prompt.trim().startsWith('/')) {
      const r = X.retrieve(c, prompt);
      X.logEvent(c, { event: 'prompt', terms: r.terms, hits: r.hits, tokens: r.text ? r.tokens : 0, ms: r.ms });
      if (r.text) emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.text } });
    }
  }

  else if (event === 'post-tool') {
    if (c && conf.enabled && conf.incrementalRefresh) X.recordChange(c, input);
  }

  else if (event === 'pre-agent') {
    const D = await import('./lib/delegation.mjs');
    const delegation = c && fs.existsSync(c.config) ? JSON.parse(fs.readFileSync(c.config, 'utf8')).delegation || {} : {};
    const reason = D.preAgent(input, delegation);
    if (reason) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  }

  else if (event === 'post-agent') {
    const D = await import('./lib/delegation.mjs');
    if (input.hook_event_name === 'PostToolUseFailure') D.clearLock(input.session_id);
    else if (D.isRmcAgent(input.tool_input?.subagent_type)) {
      D.clearLock(input.session_id);
      const f = D.agentFacts(input);
      // Metadata only (agent, models, mode, size): never the prompt or the agent's output.
      if (c) X.logEvent(c, { event: 'delegation', agent: f.agent, requested: f.requested, actual: Object.keys(f.models), shape: f.shape || (f.async ? 'background' : null), tokens: f.tokens, ms: f.durationMs });
      emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: D.postAgentText(f) } });
    }
  }

  else if (event === 'stop') {
    (await import('./lib/delegation.mjs')).clearLock(input.session_id);
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
