// /rmc command namespace, foreground delegation guard, delegation notices and actual-model reporting.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ok, rmc, ROOT, readJson, repoTelemetry, isolatedCwd } from './helpers.mjs';

const HOOK = path.join(ROOT, 'scripts', 'hooks.mjs');
// Inputs without a cwd fall back to the hook's process cwd: an isolated temp dir, never this repository.
const CWD = isolatedCwd();
const hook = (event, input, env = {}) => {
  const r = spawnSync(process.execPath, [HOOK, event], { cwd: CWD, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, RMC_ALLOW_BACKGROUND: '', RMC_SESSION_ID: '', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const commands = fs.readdirSync(path.join(ROOT, 'commands')).map((f) => f.replace(/\.md$/, ''));
const agents = fs.readdirSync(path.join(ROOT, 'agents')).map((f) => f.replace(/\.md$/, ''));
const skills = fs.readdirSync(path.join(ROOT, 'skills'));
// Document block markers (<!-- rmc:meta:start -->), not plugin components.
const MARKERS = ['meta', 'generated'];
const sid = () => `test-${process.pid}-${Math.random().toString(36).slice(2)}`;
let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => {
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`rmc-delegation-test-${process.pid}-`) || f.startsWith(`rmc-session-test-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  fs.rmSync(CWD, { recursive: true, force: true });
  assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry");
});

// ---------- /rmc namespace ----------
test('the plugin is named rmc, so every command is /rmc:<name>, agents rmc:<agent>, skills rmc:<skill>', () => {
  assert.equal(readJson(path.join(ROOT, '.claude-plugin/plugin.json')).name, 'rmc');
  const market = readJson(path.join(ROOT, '.claude-plugin/marketplace.json'));
  assert.equal(market.name, 'rm-context-marketplace', 'marketplace id unchanged');
  assert.equal(market.plugins[0].name, 'rmc');
  assert.ok(commands.length >= 29);
});
test('no shipped file or doc still uses the old /rm-context: prefix or install id', () => {
  const files = ['README.md', 'hooks/hooks.json', ...['commands', 'agents', 'skills', 'scripts', 'docs/integrations', 'config'].flatMap(walk), 'docs/INTEGRATION_ARCHITECTURE.md']
    .filter((f) => /\.(md|mjs|js|json|html)$/.test(f) && !f.includes('vendor'));
  // Only the documented upgrade path may name the old id (to uninstall it).
  const upgrade = /uninstall rm-context@|Upgrading from/;
  const bad = files.flatMap((f) => read(f).split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => /rm-context:|rm-context@rm-context-marketplace/.test(l) && !upgrade.test(l)).map(([f, n]) => `${f}:${n}`));
  assert.deepEqual(bad, []);
});
test('every /rmc:<command>, rmc:<agent> and rmc:<skill> reference resolves to a real file', () => {
  const files = ['README.md', ...['commands', 'agents', 'skills', 'docs/integrations'].flatMap(walk)].filter((f) => f.endsWith('.md'));
  const missing = [];
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/\/rmc:([a-z-]+)/g)) if (!commands.includes(m[1])) missing.push(`${f}: /rmc:${m[1]}`);
    for (const m of s.matchAll(/(?<![/\w])rmc:([a-z][a-z-]+)(?![\w:-])/g)) if (!agents.includes(m[1]) && !skills.includes(m[1]) && !commands.includes(m[1]) && !MARKERS.includes(m[1])) missing.push(`${f}: rmc:${m[1]}`);
  }
  assert.deepEqual(missing, []);
});
test('help output points at /rmc: commands (session summary without a knowledge base)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-ns-'));
  const out = hook('session-start', { cwd: dir, session_id: sid() });
  assert.match(out.hookSpecificOutput.additionalContext, /\/rmc:init/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /rm-context:/);
});

// ---------- foreground delegation guard ----------
test('hooks.json guards Agent/Task calls before and after they run', () => {
  const h = readJson(path.join(ROOT, 'hooks/hooks.json')).hooks;
  assert.match(h.PreToolUse.find((x) => /Agent/.test(x.matcher)).hooks[0].command, /hooks\.mjs" pre-agent$/);
  assert.match(h.PostToolUse.find((x) => /Agent/.test(x.matcher)).hooks[0].command, /hooks\.mjs" post-agent$/);
  assert.match(h.PostToolUseFailure.find((x) => /Agent/.test(x.matcher)).hooks[0].command, /hooks\.mjs" post-agent$/);
});
test('run_in_background is denied for RM Context agents, other plugins are left alone', () => {
  const s = sid();
  const deny = hook('pre-agent', { session_id: s, tool_use_id: 't1', tool_name: 'Agent', tool_input: { subagent_type: 'rmc:quick-qa', model: 'haiku', run_in_background: true, prompt: 'x' } });
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /foreground/);
  assert.equal(hook('pre-agent', { session_id: s, tool_use_id: 't2', tool_input: { subagent_type: 'general-purpose', run_in_background: true } }), null);
  assert.equal(hook('pre-agent', { session_id: s, tool_use_id: 't3', tool_input: { subagent_type: 'Explore' } }), null);
});
test('one RM Context agent at a time: a concurrent second delegation is denied until the first returns', () => {
  const s = sid();
  assert.equal(hook('pre-agent', { session_id: s, tool_use_id: 'a', tool_input: { subagent_type: 'rmc:business-analyst', model: 'sonnet' } }), null, 'foreground call allowed');
  const second = hook('pre-agent', { session_id: s, tool_use_id: 'b', tool_input: { subagent_type: 'rmc:system-analyst', model: 'sonnet' } });
  assert.equal(second.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(second.hookSpecificOutput.permissionDecisionReason, /one agent at a time/);
  hook('post-agent', { session_id: s, tool_use_id: 'a', tool_input: { subagent_type: 'rmc:business-analyst', model: 'sonnet' }, tool_response: {} });
  assert.equal(hook('pre-agent', { session_id: s, tool_use_id: 'b', tool_input: { subagent_type: 'rmc:system-analyst', model: 'sonnet' } }), null, 'next role after the first returned');
  hook('stop', { session_id: s });
  assert.equal(hook('pre-agent', { session_id: s, tool_use_id: 'c', tool_input: { subagent_type: 'rmc:qa' } }), null, 'Stop clears the lock');
  hook('post-agent', { session_id: s, tool_use_id: 'c', tool_input: { subagent_type: 'rmc:qa' }, tool_response: {} });
});
test('background can be allowed explicitly per project', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const f = path.join(dir, '.rmcontext/config.json');
  fs.writeFileSync(f, JSON.stringify({ ...readJson(f), delegation: { background: 'allow' } }));
  assert.equal(hook('pre-agent', { cwd: dir, session_id: sid(), tool_use_id: 'x', tool_input: { subagent_type: 'rmc:qa', run_in_background: true } }), null);
});

// ---------- actual model, from the subagent transcript ----------
function fakeSession({ shape, models }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-tx-'));
  const transcript = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
  if (shape) fs.writeFileSync(path.join(dir, 'sess', 'subagents', 'agent-ab12.meta.json'), JSON.stringify({ agentType: 'rmc:quick-qa', requestShape: shape, model: 'haiku' }));
  if (models) fs.writeFileSync(path.join(dir, 'sess', 'subagents', 'agent-ab12.jsonl'), models.map((m) => JSON.stringify({ type: 'assistant', message: { model: m, content: [] } })).join('\n') + '\n');
  return transcript;
}
const post = (transcript, extra = {}) => hook('post-agent', { session_id: sid(), transcript_path: transcript, tool_use_id: 'p', tool_name: 'Agent',
  tool_input: { subagent_type: 'rmc:quick-qa', model: 'haiku', prompt: 'find the login handler PASSWORD=hunter2' }, tool_response: { agentId: 'ab12', ...extra } })?.hookSpecificOutput?.additionalContext || '';

test('post-agent reports the model read from the subagent transcript and the foreground mode', () => {
  // requestShape "foreground" is what Claude Code 2.1.319 records for a synchronous Agent call (observed in a live session).
  const t = post(fakeSession({ shape: 'foreground', models: ['claude-haiku-5-5', 'claude-haiku-5-5'] }));
  assert.match(t, /ran in the foreground/);
  assert.match(t, /Actual model \(subagent transcript\): claude-haiku-5-5; requested: haiku/);
  assert.doesNotMatch(t, /differs/);
});
test('post-agent never presents the configured model as fact when the transcript is missing', () => {
  const t = post(fakeSession({}), { resolvedModel: 'claude-haiku-5-5' });
  assert.match(t, /could not be verified/);
  assert.match(t, /do not tell the user the model switch succeeded/);
  assert.match(t, /Status: Delegation started; actual model not yet verified\./);
  assert.doesNotMatch(t, /Actual model/);
});
test('post-agent flags background execution and a model different from the request', () => {
  assert.match(post(fakeSession({ shape: 'background' }), { isAsync: true }), /BACKGROUND/);
  assert.match(post(fakeSession({ shape: 'sync', models: ['claude-sonnet-5-5'] })), /differs from the requested "haiku"/);
});
test('delegation telemetry is metadata only: never the prompt', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  hook('post-agent', { cwd: dir, session_id: sid(), transcript_path: fakeSession({ shape: 'sync', models: ['claude-haiku-5-5'] }), tool_use_id: 'p',
    tool_input: { subagent_type: 'rmc:quick-qa', model: 'haiku', prompt: 'find the login handler PASSWORD=hunter2' }, tool_response: { agentId: 'ab12', totalTokens: 1234 } });
  const log = fs.readFileSync(path.join(dir, '.rmcontext/state/autocontext.jsonl'), 'utf8');
  const rec = log.trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.event === 'delegation');
  assert.deepEqual([rec.agent, rec.requested, rec.actual, rec.shape, rec.tokens], ['rmc:quick-qa', 'haiku', ['claude-haiku-5-5'], 'sync', 1234]);
  assert.doesNotMatch(log, /login handler|hunter2/);
});

// ---------- notices from rmc route ----------
test('notice announces a switch only when the subagent model differs from the main session model', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const notice = (...a) => /^Notice: (.*)$/m.exec(ok(dir, 'route', ...a))[1];
  assert.equal(notice('--agent', 'quick-qa', '--category', 'search', '--session-model', 'claude-opus-5-5'), 'Perpindahan ke model Haiku, karena bertugas sebagai Quick QA.');
  assert.equal(notice('--agent', 'business-analyst', '--category', 'sipoc', '--session-model', 'opus'), 'Perpindahan ke model Sonnet, karena bertugas sebagai Business Analyst.');
  assert.equal(notice('--agent', 'senior-engineer', '--category', 'complex-feature', '--session-model', 'opus'), 'Delegasi ke Senior Engineer dengan model Opus, sama dengan model sesi utama (tidak ada perpindahan model).');
  // The user's explicit model wins over routing, and the notice follows it.
  assert.equal(notice('--agent', 'quick-qa', '--category', 'search', '--model', 'sonnet', '--session-model', 'opus'), 'Perpindahan ke model Sonnet, karena bertugas sebagai Quick QA.');
  const f = path.join(dir, '.rmcontext/config.json');
  fs.writeFileSync(f, JSON.stringify({ ...readJson(f), routing: { noticeLanguage: 'en' } }));
  assert.equal(notice('--agent', 'quick-qa', '--category', 'search', '--session-model', 'opus'), 'Switching to Haiku, acting as Quick QA.');
  assert.equal(notice('--agent', 'senior-engineer', '--category', 'complex-feature', '--session-model', 'claude-opus-5-5'), 'Delegating to Senior Engineer with Opus, same as the main session model.');
  const out = ok(dir, 'route', '--agent', 'qa', '--category', 'qa');
  assert.match(out, /in the foreground \(never run_in_background\), one agent at a time/);
  const logged = fs.readFileSync(path.join(dir, '.rmcontext/state/routing.jsonl'), 'utf8');
  assert.doesNotMatch(logged, /Perpindahan|Switching|notice/, 'routing log holds metadata, not the notice text');
});
test('adaptive routing is unchanged: retrieval → haiku, structured analysis → sonnet, complex → opus', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const model = (...a) => JSON.parse(ok(dir, 'route', ...a, '--json', '--no-record')).model;
  assert.equal(model('--category', 'search'), 'haiku');
  assert.equal(model('--category', 'fsd'), 'sonnet');
  assert.equal(model('--category', 'complex-feature'), 'opus');
  assert.equal(model('--category', 'bug-fix', '--signals', 'security'), 'opus');
});

// ---------- command instructions ----------
test('every delegating command delegates in the foreground, one agent at a time, after showing the notice', () => {
  for (const c of commands) {
    const s = read(`commands/${c}.md`);
    if (!/rmc route (--origin command )?--agent/.test(s)) { assert.doesNotMatch(s, /Notice:/, `${c} does not delegate, so it shows no notice`); continue; }
    assert.match(s, /--session-model <your model id>/, `${c}: session model`);
    assert.match(s, /`Notice:` line exactly as printed/, `${c}: notice`);
    if (/Delegation rules/.test(s)) assert.match(s, /never set `run_in_background`.*one agent at a time/s, `${c}: foreground`);
    assert.doesNotMatch(s, /may run in parallel/, `${c}: no automatic parallel steps`);
  }
  const tw = read('skills/team-workflows/SKILL.md');
  assert.match(tw, /Foreground, one agent at a time/);
  assert.match(tw, /Report the model that ran, not the one requested/);
});
