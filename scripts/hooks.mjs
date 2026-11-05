#!/usr/bin/env node
// Claude Code lifecycle hooks for RM Context. Deterministic and fast: no LLM calls, no full scans, never blocks the session.
//   session-start  → compact project summary (+ exports RMC_CLI for Bash)
//   prompt         → relevant .rmcontext knowledge for the submitted prompt, within the token budget
//   post-tool      → records files changed by Write/Edit/MultiEdit/NotebookEdit, or a possibly-mutating Bash command
//   stop           → one coalesced incremental refresh for everything recorded during the turn
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

  else if (event === 'stop') {
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
