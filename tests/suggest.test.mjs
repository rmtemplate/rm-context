// Suggest-first automatic routing: deterministic prompt classification, the injected suggestion, reuse by rmc route,
// suggestion/delegation statistics, the SessionStart policy and long-prompt retrieval.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ok, ROOT, CLI, readJson, repoTelemetry, isolatedCwd } from './helpers.mjs';
import { classifyPrompt } from '../scripts/lib/routing.mjs';
import { rankNodes, queryTerms } from '../scripts/lib/context.mjs';
import { ctx } from '../scripts/lib/util.mjs';
import * as G from '../scripts/lib/graph.mjs';

const HOOK = path.join(ROOT, 'scripts', 'hooks.mjs');
const CWD = isolatedCwd();
const hook = (event, input, env = {}) => {
  const r = spawnSync(process.execPath, [HOOK, event], { cwd: CWD, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: '', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const ctxText = (o) => o?.hookSpecificOutput?.additionalContext || '';
const sid = () => `test-${process.pid}-${Math.random().toString(36).slice(2)}`;
const route = (dir, s, ...args) => spawnSync(process.execPath, [CLI, 'route', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: s } });
const events = (dir) => fs.readFileSync(path.join(dir, '.rmcontext/state/autocontext.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const setRouting = (dir, routing) => { const f = path.join(dir, '.rmcontext/config.json'); fs.writeFileSync(f, JSON.stringify({ ...readJson(f), routing })); };
let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => {
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`rmc-session-test-${process.pid}-`) || f.startsWith(`rmc-delegation-test-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  fs.rmSync(CWD, { recursive: true, force: true });
  assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry");
});

// ---------- classifier ----------
test('direct-response prompts get no suggestion: greetings, general knowledge, simple lookups, non-project tasks', () => {
  for (const p of ['halo, apa kabar?', 'thanks, that works great', 'What is a REST API?', 'Apa itu dependency injection?', 'What is the capital of France?',
    'Write a haiku about autumn leaves', 'Where is chargeOrder defined?', 'di mana fungsi login?', 'Explain the difference between a controller and a service in MVC', '/rmc:find users'])
    assert.equal(classifyPrompt(p).decision, 'direct', p);
  // An intent without any project anchor stays below the default 0.7 confidence.
  assert.ok(classifyPrompt('How does JWT authentication work in general?').confidence < 0.7);
});
test('project investigation and analysis prompts map to the matching category', () => {
  const cat = (p, hits = 0) => classifyPrompt(p, { hits }).category;
  assert.equal(cat('Investigate how the billing flow works in this project'), 'search');
  assert.equal(cat('Analyze the impact of renaming the users table'), 'impact');
  assert.equal(cat('Review the implementation of src/services/billing.js'), 'code-review');
  assert.equal(cat('Jelaskan alur bisnis registrasi user di aplikasi ini'), 'business-analysis');
  assert.equal(cat('Telusuri alur pembayaran di project ini dari endpoint sampai database'), 'system-analysis');
  assert.equal(cat('Fix the bug in createUser where emails are not validated'), 'bug-fix');
  assert.equal(cat('Implement a feature to export invoices as PDF in this app'), 'small-feature');
  assert.ok(classifyPrompt('Lakukan audit routing pada RM Context', { projectName: 'RM Context' }).confidence >= 0.8, 'the project name is a project reference');
});
test('complex prompts: cross-module, architecture, refactor and cross-service debugging', () => {
  const k = (p) => classifyPrompt(p);
  assert.deepEqual([k('Investigate how billing works across the order and user modules in this project').category, k('Investigate how billing works across the order and user modules in this project').signals], ['architecture', ['cross-module']]);
  assert.equal(k('Analyze the architecture across all modules of this codebase').category, 'architecture');
  assert.equal(k('Implement order export that spans multiple services in this project').category, 'complex-feature');
  assert.equal(k('Refactor the auth module and the billing service together').category, 'refactor');
  const d = k('Why does checkout fail intermittently across services?');
  assert.equal(d.category, 'debugging');
  assert.ok(d.signals.includes('cross-module'));
});

// ---------- UserPromptSubmit suggestion ----------
test('the prompt hook injects a short suggestion for project work, resolved by the existing router', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const s = sid();
  const text = ctxText(hook('prompt', { cwd: dir, session_id: s, prompt: 'Investigate how the billing flow works in this project' }));
  const line = text.split('\n').pop();
  assert.equal(line, 'RM Context suggests Quick QA (Haiku) for this codebase search and retrieval. To delegate: rmc route --suggested --session-model <id>, show its Notice, run it in the foreground. Simple? Answer directly.');
  assert.ok(Math.ceil(line.length / 3.5) <= 60, `suggestion is ${Math.ceil(line.length / 3.5)} tokens`);
  const complex = ctxText(hook('prompt', { cwd: dir, session_id: s, prompt: 'Analyze the architecture across all modules of this codebase' })).split('\n').pop();
  assert.match(complex, /^RM Context suggests Architecture \(Opus\) for this architecture design or deep analysis\./);
  // The longest task label still fits the budget.
  const labels = Object.values(readJson(path.join(ROOT, 'config/models.json')).tasks).map((t) => t.label);
  const longest = labels.sort((a, b) => b.length - a.length)[0];
  assert.ok(Math.ceil(line.replace('codebase search and retrieval', longest).replace('Quick QA', 'Business Analyst').length / 3.5) <= 70);
  // Same-model note when the session model is known (SessionStart input.model).
  hook('session-start', { cwd: dir, session_id: s, model: 'claude-opus-5-5' });
  assert.match(ctxText(hook('prompt', { cwd: dir, session_id: s, prompt: 'Analyze the architecture across all modules of this codebase' })), /Architecture \(Opus, same as the main session\)/);
});
test('no suggestion for general prompts, uninitialized projects, or when routing.autoSuggest is off', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  for (const p of ['What is the capital of France today?', 'Write a haiku about autumn leaves please', 'thanks, that works great'])
    assert.doesNotMatch(ctxText(hook('prompt', { cwd: dir, session_id: sid(), prompt: p })), /RM Context suggests/, p);
  setRouting(dir, { autoSuggest: false });
  assert.doesNotMatch(ctxText(hook('prompt', { cwd: dir, session_id: sid(), prompt: 'Investigate how the billing flow works in this project' })), /RM Context suggests/);
  assert.doesNotMatch(ctxText(hook('session-start', { cwd: dir, session_id: sid() })), /RM Context suggests/, 'policy line off too');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-bare-'));
  assert.equal(hook('prompt', { cwd: bare, session_id: sid(), prompt: 'Investigate how the billing flow works in this project' }), null);
});
test('the hook only adds context: it never calls the Agent tool, blocks the prompt or changes the model', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const o = hook('prompt', { cwd: dir, session_id: sid(), prompt: 'Analyze the architecture across all modules of this codebase' });
  assert.deepEqual(Object.keys(o), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(o.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(o.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});
test('SessionStart adds a short delegation policy and exports RMC_SESSION_ID for rmc route', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const env = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-env-')), 'env');
  const s = sid();
  const t = ctxText(hook('session-start', { cwd: dir, session_id: s }, { CLAUDE_ENV_FILE: env }));
  const policy = t.split('\n').pop();
  assert.match(policy, /advice/);
  assert.match(policy, /never simple lookups/);
  assert.match(policy, /rmc route --suggested --session-model/);
  assert.match(policy, /one foreground agent at a time/);
  assert.match(policy, /Claim no delegation/);
  assert.ok(Math.ceil(policy.length / 3.5) <= 85, 'policy stays short');
  assert.match(t, /RM Context CLI \(rmc\): node "/);
  assert.match(fs.readFileSync(env, 'utf8'), new RegExp(`export RMC_SESSION_ID="${s}"`));
});

// ---------- reuse by rmc route ----------
test('rmc route --suggested reuses the current prompt classification: same session and prompt only', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const s = sid();
  hook('prompt', { cwd: dir, session_id: s, prompt: 'Analyze the architecture across all modules of this codebase' });
  const r = route(dir, s, '--suggested', '--session-model', 'claude-sonnet-5-5', '--json');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.agent, j.model, j.category, j.followsSuggestion], ['architecture', 'opus', 'architecture', true]);
  assert.match(j.suggestionId, /^S-/);
  assert.match(j.notice, /Perpindahan ke model Opus, karena bertugas sebagai Architecture\./);
  // Another session never sees it.
  assert.match(route(dir, sid(), '--suggested').stderr, /No current RM Context suggestion/);
  // The next prompt (no suggestion) ends the turn: the earlier classification is not reused.
  hook('prompt', { cwd: dir, session_id: s, prompt: 'thanks, that works great' });
  assert.match(route(dir, s, '--suggested').stderr, /No current RM Context suggestion/);
  // Stop ends it too.
  hook('prompt', { cwd: dir, session_id: s, prompt: 'Investigate how the billing flow works in this project' });
  hook('stop', { cwd: dir, session_id: s });
  assert.match(route(dir, s, '--suggested').stderr, /No current RM Context suggestion/);
  // Explicit categories keep working without any suggestion.
  assert.equal(route(dir, s, '--category', 'search', '--no-record').status, 0);
});
test('a suggestion from another project is not reused', () => {
  const a = fixture('node-app'); ok(a, 'init');
  const b = fixture('node-app'); ok(b, 'init');
  const s = sid();
  hook('prompt', { cwd: a, session_id: s, prompt: 'Investigate how the billing flow works in this project' });
  assert.match(route(b, s, '--suggested').stderr, /No current RM Context suggestion/);
});

// ---------- statistics ----------
test('route stats separate suggestions, followed/ignored outcomes, route vs direct delegations and verified models', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const s = sid();
  const tx = (() => { // a subagent transcript recorded by Claude Code
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-tx-'));
    fs.writeFileSync(path.join(d, 'sess.jsonl'), '');
    fs.mkdirSync(path.join(d, 'sess', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'sess', 'subagents', 'agent-q1.meta.json'), JSON.stringify({ requestShape: 'foreground' }));
    fs.writeFileSync(path.join(d, 'sess', 'subagents', 'agent-q1.jsonl'), JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5' } }) + '\n');
    return path.join(d, 'sess.jsonl');
  })();
  const agent = (role, extra = {}) => hook('post-agent', { cwd: dir, session_id: s, tool_use_id: Math.random().toString(36), transcript_path: tx,
    tool_input: { subagent_type: `rmc:${role}`, model: 'haiku', prompt: 'SECRET-PROMPT-TEXT' }, tool_response: { agentId: 'q1', ...extra } });
  // 1. suggested quick-qa, followed through rmc route
  hook('prompt', { cwd: dir, session_id: s, prompt: 'Investigate how the billing flow works in this project SECRET-PROMPT-TEXT' });
  assert.equal(route(dir, s, '--suggested').status, 0);
  agent('quick-qa');
  hook('stop', { cwd: dir, session_id: s });
  // 2. suggested, answered directly
  hook('prompt', { cwd: dir, session_id: s, prompt: 'Review the implementation of src/services/billing.js' });
  hook('stop', { cwd: dir, session_id: s });
  // 3. no suggestion, direct delegation without rmc route; transcript unavailable
  hook('prompt', { cwd: dir, session_id: s, prompt: 'thanks, that works great' });
  hook('post-agent', { cwd: dir, session_id: s, tool_use_id: 'z', tool_input: { subagent_type: 'rmc:qa' }, tool_response: {} });
  hook('stop', { cwd: dir, session_id: s });
  // 4. background rejected
  hook('pre-agent', { cwd: dir, session_id: s, tool_use_id: 'bg', tool_input: { subagent_type: 'rmc:qa', run_in_background: true } });
  // 5. suggested, still open (outcome unknown)
  hook('prompt', { cwd: dir, session_id: s, prompt: 'Analyze the architecture across all modules of this codebase' });

  const st = JSON.parse(ok(dir, 'route', 'stats', '--json'));
  assert.deepEqual(st.suggestions, { generated: 3, complex: 1, followed: 1, direct: 1, otherAgent: 0, unresolved: 1 });
  assert.deepEqual(st.delegations, { total: 2, viaRoute: 1, direct: 1, verified: 1, unverified: 1, foreground: 1, background: 0, modeUnknown: 1, backgroundRejected: 1, concurrentRejected: 0 });
  const text = ok(dir, 'route', 'stats');
  assert.match(text, /Suggestions generated: 3/);
  assert.match(text, /Followed \(suggested agent ran\): 1/);
  assert.match(text, /Ignored \(direct response\): 1/);
  assert.match(text, /Delegations through rmc route: 1/);
  assert.match(text, /Direct agent delegations \(no rmc route\): 1/);
  assert.match(text, /Background rejected: 1/);
  const raw = fs.readFileSync(path.join(dir, '.rmcontext/state/autocontext.jsonl'), 'utf8') + fs.readFileSync(path.join(dir, '.rmcontext/state/routing.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /SECRET-PROMPT-TEXT|billing flow|architecture across/, 'telemetry never holds prompt text');
  // A delegation is linked to its prompt by session + prompt id, not counted as followed merely because an agent ran.
  const del = events(dir).filter((e) => e.event === 'delegation');
  assert.deepEqual(del.map((e) => [e.agent, e.followed, Boolean(e.routeId), Boolean(e.promptId)]), [['rmc:quick-qa', true, true, true], ['rmc:qa', null, false, true]]);
});
test('route stats say unavailable when no hook telemetry exists', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  fs.rmSync(path.join(dir, '.rmcontext/state/autocontext.jsonl'), { force: true });
  assert.match(ok(dir, 'route', 'stats'), /Suggestions and delegations: unavailable/);
  assert.equal(JSON.parse(ok(dir, 'route', 'stats', '--json')).suggestions, null);
});

// ---------- long-prompt retrieval ----------
test('retrieval fixtures: long prompts keep their relevant context without false positives', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const g = G.loadGraph(ctx(dir));
  const F = readJson(path.join(ROOT, 'tests/fixtures/prompts/retrieval.json'));
  for (const [name, { prompt, expect }] of Object.entries(F)) {
    if (name.startsWith('_')) continue;
    const scored = rankNodes(g, queryTerms(prompt).terms).ranked.filter((r) => r.score >= 0.45).map((r) => r.n.name);
    if (expect) assert.equal(scored[0], expect, `${name}: ${scored.join(', ')}`);
    else assert.deepEqual(scored, [], `${name}: no scored hit expected`);
  }
  // Exact identifiers still match exactly.
  assert.ok(rankNodes(g, queryTerms(F.identifiers.prompt).terms).ranked.some((r) => r.n.name === 'src/routes/users.js' && r.score >= 0.45));
  // The hook injects the long relevant prompt's context.
  assert.match(ctxText(hook('prompt', { cwd: dir, session_id: sid(), prompt: F.longRelevant.prompt })), /chargeOrder — src\/services\/billing\.js/);
});
