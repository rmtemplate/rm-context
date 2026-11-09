// Adaptive main-session model policy. The tests assert the POLICY and its honesty: RM Context recommends, never claims a switch,
// never creates an agent to change models, and never records the desired model as the actual one.
// NOT VERIFIED here: that Claude Code really switches after the user types /model (that is a host feature, not testable offline).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, fixture, ok, rmc, repoTelemetry } from './helpers.mjs';
import { CAPABILITY, CONFIRMATION, desiredMainModel, planMainSession, sessionHint, applyAnswer, questionFor } from '../scripts/lib/session-model.mjs';
import { CLAUDE_SECTION } from '../scripts/lib/project.mjs';
import { classifyPrompt, route } from '../scripts/lib/routing.mjs';
import { ctx } from '../scripts/lib/util.mjs';

let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry"));
const HOOKS = path.join(ROOT, 'scripts', 'hooks.mjs');
const hook = (cwd, event, input) => { const r = spawnSync(process.execPath, [HOOKS, event], { cwd, input: JSON.stringify({ cwd, ...input }), encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: '' } }); assert.equal(r.status, 0, r.stderr); return r.stdout ? JSON.parse(r.stdout) : null; };

test('1-4. init still creates CLAUDE.md; Combine/Replace remain; the section is direct-first and names main-session switching', () => {
  const d = fixture('node-app'); ok(d, 'init');
  const md = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');
  assert.match(md, /BEGIN RM CONTEXT · policy 5/);
  assert.match(md, /\*\*Hooks are binding\.\*\*[^\n]*is an instruction, not background[^\n]*model question[^\n]*delegate or say in one line why not[^\n]*rmc refresh/);
  assert.match(md, /\*\*Direct first\.\*\* Simple questions and small edits: do them directly/);
  assert.match(md, /subtasks are an internal checklist/); assert.match(md, /never merely to get another model/);
  assert.match(md, /\*\*Model\.\*\*[^\n]*Sonnet[^\n]*Opus[^\n]*ask once per task[^\n]*Yes, switch to Sonnet[^\n]*No, continue with Opus[^\n]*\/model sonnet[^\n]*opusplan[^\n]*do not ask again[^\n]*spawn an agent merely to get another model[^\n]*claim a switch you did not observe[^\n]*unknown, do not ask/);
  assert.match(md, /Read the relevant `\.rmcontext\/` knowledge before exploring source/); assert.match(md, /Find the existing component, function, service, DTO, type or utility/);
  // existing manual file: combine keeps the user's lines; replace is refused without confirmation
  const e = fixture('node-app'); fs.writeFileSync(path.join(e, 'CLAUDE.md'), '# Mine\nKeep me.\n'); ok(e, 'init', '--claude-md', 'combine');
  assert.match(fs.readFileSync(path.join(e, 'CLAUDE.md'), 'utf8'), /Keep me\.[\s\S]*Direct first/);
  const f = fixture('node-app'); fs.writeFileSync(path.join(f, 'CLAUDE.md'), '# Mine\nKeep me.\n');
  assert.notEqual(rmc(f, 'init', '--claude-md', 'replace').code, 0, 'destructive replace needs --confirm');
  assert.match(fs.readFileSync(path.join(f, 'CLAUDE.md'), 'utf8'), /Keep me\./);
});
test('5-6. coding tasks target Sonnet (even large ones); architecture, security and ADR reasoning target Opus', () => {
  for (const c of ['bug-fix', 'small-change', 'small-feature', 'complex-feature', 'refactor', 'debugging', 'migration']) assert.equal(desiredMainModel({ category: c, signals: ['cross-module', 'architecture'] }).model, 'sonnet', c);
  for (const c of ['architecture', 'security', 'adr']) assert.equal(desiredMainModel({ category: c }).model, 'opus', c);
  assert.equal(desiredMainModel({ category: 'code-review', signals: ['security'] }).model, 'opus');
  assert.equal(desiredMainModel({ category: 'code-review' }).model, 'sonnet');
  assert.equal(desiredMainModel({ category: 'bug-fix', phase: 'final-architecture-review' }).model, 'opus');
  assert.equal(desiredMainModel({ category: 'search' }).model, 'current');
  assert.equal(classifyPrompt('implement the new CRUD endpoint for invoices in the billing module').decision !== 'direct' && desiredMainModel(classifyPrompt('implement the new CRUD endpoint for invoices in the billing module')).model, 'sonnet');
});
test('7-8. an Opus session with a coding task, or a Sonnet session with an architecture task, never creates an agent', () => {
  const a = planMainSession({ category: 'refactor', activeModel: 'claude-opus-5-5' });
  assert.deepEqual([a.desiredModel, a.action, a.spawnAgent, a.mechanism], ['sonnet', 'recommend-user-switch', false, '/model']);
  const b = planMainSession({ category: 'architecture', activeModel: 'claude-sonnet-5-5' });
  assert.deepEqual([b.desiredModel, b.action, b.spawnAgent], ['opus', 'recommend-user-switch', false]);
  assert.match(sessionHint(a), /Do NOT spawn an agent just to get a different model/);
  assert.equal(planMainSession({ category: 'refactor', activeModel: 'claude-sonnet-5-5' }).action, 'none');
  assert.equal(sessionHint(planMainSession({ category: 'refactor', activeModel: 'claude-sonnet-5-5' })), null);
});
test('9-10. unsupported switching is never claimed; the actual model stays the observed one in plans and telemetry', () => {
  assert.equal(CAPABILITY.automaticSwitchByPlugin, 'UNSUPPORTED'); assert.equal(CAPABILITY.runtimeVerified, false); assert.equal(CAPABILITY.status, 'PARTIALLY SUPPORTED');
  assert.ok(CAPABILITY.mechanisms.every((m) => m.name !== 'Agent') && CAPABILITY.notMechanisms.some((n) => /hooks/.test(n)) && CAPABILITY.notMechanisms.some((n) => /Agent tool model parameter/.test(n)));
  const p = planMainSession({ category: 'refactor', activeModel: 'claude-opus-5-5' });
  assert.equal(p.claimedSwitched, false); assert.equal(p.actualModel, 'opus'); assert.notEqual(p.actualModel, p.desiredModel);
  assert.equal(planMainSession({ category: 'refactor' }).action, 'unknown-active-model', 'unknown active model: no recommendation, no claim');
  const d = fixture('node-app'); ok(d, 'init');
  const sid = 'sm-' + process.pid;
  hook(d, 'session-start', { session_id: sid, model: 'claude-opus-5-5' });
  const out = hook(d, 'prompt', { session_id: sid, prompt: 'refactor the invoice service in this project to remove the duplicated totals logic' });
  const ctxText = out?.hookSpecificOutput?.additionalContext || '';
  assert.match(ctxText, /RM Context main-session model: .*Sonnet is recommended, the active model is Opus/); assert.match(ctxText, /RM Context cannot do it for you/);
  const ev = fs.readFileSync(path.join(d, '.rmcontext/state/autocontext.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.event === 'model-switch');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].initial, ev[0].active, ev[0].desired, ev[0].actual, ev[0].result, ev[0].verified], ['opus', 'opus', 'sonnet', 'opus', 'recommended-not-performed', false]);
  assert.ok(!JSON.stringify(ev[0]).includes('invoice'), 'no prompt text in telemetry');
  // advised once per phase, not on every prompt
  hook(d, 'prompt', { session_id: sid, prompt: 'refactor the payment service in this project to share the rounding helper' });
  assert.equal(fs.readFileSync(path.join(d, '.rmcontext/state/autocontext.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.event === 'model-switch').length, 1);
  for (const f of fs.readdirSync(await_tmp())) if (f.startsWith(`rmc-session-${sid}`)) fs.rmSync(path.join(await_tmp(), f), { force: true });
});
function await_tmp() { return fs.realpathSync(process.env.TMPDIR || '/tmp'); }
test('11. an explicit user model choice is honoured and never argued with', () => {
  const p = planMainSession({ category: 'refactor', activeModel: 'claude-opus-5-5', userModel: 'opus' });
  assert.deepEqual([p.action, p.needsSwitch, p.desiredModel], ['honor-user-choice', false, 'opus']); assert.equal(sessionHint(p), null);
  const r = rmc(fixture('node-app'), 'session-model', '--category', 'refactor', '--session-model', 'claude-opus-5-5', '--user-model', 'opus'); assert.match(r.out, /No switch needed/);
});
test('12. agent model routing is unchanged (role-aware routing still decides subagent models)', () => {
  const d = fixture('node-app'); ok(d, 'init');
  const r = route(ctx(d), { agent: 'senior-engineer', category: 'complex-feature', signals: 'cross-module', record: false });
  assert.equal(r.model, 'sonnet', 'implementation agents stay on Sonnet');
  assert.equal(route(ctx(d), { agent: 'architecture', category: 'architecture', record: false }).model, 'opus');
  assert.match(ok(d, 'route', '--agent', 'qa', '--category', 'qa'), /QA/);
});
test('13-14. direct execution keeps the verification gate wording; the database safety policy is unchanged', () => {
  assert.match(CLAUDE_SECTION, /A stage is done only when its verification gate passes with evidence, never because a tool call succeeded/);
  assert.match(CLAUDE_SECTION, /Discovery is read-only everywhere; never print or store credentials/);
  assert.match(CLAUDE_SECTION, /DEV: migrations in the project's framework, no backup objects/);
  assert.match(CLAUDE_SECTION, /STAGING: prepare migration, rollback and checklist for the user to apply/);
  assert.match(CLAUDE_SECTION, /PRODUCTION: strict, plan only unless the user explicitly asks\. UNKNOWN: change nothing/);
});
test('CLI: session-model --capability reports PARTIALLY SUPPORTED and the real mechanisms', () => {
  const r = rmc(fixture('node-app'), 'session-model', '--capability'); assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PARTIALLY SUPPORTED \(automatic switching by a plugin: UNSUPPORTED; runtime verified: no\)/); assert.match(r.out, /\/model <alias>: manual/); assert.match(r.out, /opusplan: automatic/);
});

// ---- Model confirmation before the task starts ----
const CODING = 'refactor the invoice service in this project to remove the duplicated totals logic';
const asked = (d, sid, prompt) => hook(d, 'prompt', { session_id: sid, prompt })?.hookSpecificOutput?.additionalContext || '';
const cleanup = (sid) => { for (const f of fs.readdirSync(await_tmp())) if (f.startsWith(`rmc-session-${sid}`)) fs.rmSync(path.join(await_tmp(), f), { force: true }); };
test('C1. Opus + coding task: the confirmation question with Yes/No is put to the user before work', () => {
  const d = fixture('node-app'); ok(d, 'init'); const sid = 'cf1-' + process.pid;
  hook(d, 'session-start', { session_id: sid, model: 'claude-opus-5-5' });
  const t = asked(d, sid, CODING);
  assert.ok(t.includes(questionFor(planMainSession({ category: 'refactor', activeModel: 'claude-opus-5-5' })))); assert.match(t, /Task ini terdeteksi sebagai refactor/);
  assert.ok(t.includes('Yes, switch to Sonnet.') && t.includes('No, continue with Opus.'));
  assert.match(t, /BEFORE starting the task, ask the user once/); assert.match(t, /wait for their confirmation before implementing/);
  cleanup(sid);
});
test('C2/C3/C6. Opus + architecture, Sonnet + coding, unknown model: no question', () => {
  const d = fixture('node-app'); ok(d, 'init');
  for (const [model, prompt] of [['claude-opus-5-5', 'design the overall architecture for a new multi-tenant billing system in this project'], ['claude-sonnet-5-5', CODING], [undefined, CODING]]) {
    const sid = 'cf2-' + model + process.pid; hook(d, 'session-start', { session_id: sid, ...(model ? { model } : {}) });
    assert.doesNotMatch(asked(d, sid, prompt), /main-session model/, String(model)); cleanup(sid);
  }
  assert.equal(planMainSession({ category: 'refactor' }).action, 'unknown-active-model'); assert.equal(sessionHint(planMainSession({ category: 'refactor' })), null);
});
test('C4/C5. the answers: No continues on Opus without re-asking; Yes gives /model sonnet, waits, never claims a switch', () => {
  const plan = planMainSession({ category: 'refactor', activeModel: 'claude-opus-5-5' });
  const no = applyAnswer(plan, 'No, continue with Opus.');
  assert.deepEqual([no.proceed, no.wait, no.model, no.claimedSwitched, no.ask], [true, false, 'opus', false, false]);
  const yes = applyAnswer(plan, 'Yes, switch to Sonnet.');
  assert.deepEqual([yes.proceed, yes.wait, yes.instruction, yes.claimedSwitched, yes.model], [false, true, '/model sonnet', false, 'opus']);
  assert.match(sessionHint(plan), /never claim it switched/);
});
test('C7. one task with several subtasks/prompts asks once', () => {
  const d = fixture('node-app'); ok(d, 'init'); const sid = 'cf7-' + process.pid;
  hook(d, 'session-start', { session_id: sid, model: 'claude-opus-5-5' });
  assert.match(asked(d, sid, CODING), /main-session model/);
  for (const p of ['now also refactor the payment service in this project to share the rounding helper', 'then fix the bug in the invoice totals rounding in this project']) assert.doesNotMatch(asked(d, sid, p), /main-session model/);
  cleanup(sid);
});
test('C8. the confirmation never creates or suggests an agent for model routing', () => {
  const plan = planMainSession({ category: 'refactor', activeModel: 'claude-opus-5-5' });
  assert.equal(plan.spawnAgent, false); assert.match(sessionHint(plan), /Do NOT spawn an agent just to get a different model/);
  assert.doesNotMatch(sessionHint(plan), /(use|create|spawn|launch) (a |the )?sonnet (sub)?agent/i);
});

// ---- The question explains itself; Indonesian task phrasing is classified ----
test('D1. the confirmation question names the detected task category as the reason', () => {
  const plan = planMainSession({ category: 'bug-fix', activeModel: 'claude-opus-5-5' });
  assert.equal(plan.category, 'bug-fix');
  assert.match(questionFor(plan), /terdeteksi sebagai bug-fix/); assert.match(sessionHint(plan), /terdeteksi sebagai bug-fix/);
  const other = planMainSession({ category: 'architecture', activeModel: 'claude-sonnet-5-5' });
  assert.match(questionFor({ ...other, category: 'architecture' }), /terdeteksi sebagai architecture/);
});
test('D2. without a category the generic question is kept (no invented reason)', () => {
  const plan = { ...planMainSession({ category: 'bug-fix', activeModel: 'claude-opus-5-5' }), category: null };
  assert.equal(questionFor(plan), CONFIRMATION.question); assert.doesNotMatch(questionFor(plan), /terdeteksi sebagai/);
});
test('D3. Indonesian task phrasing with English code terms is classified', () => {
  const cat = (p) => classifyPrompt(p).category;
  assert.equal(cat('tambahkan unit test untuk UserController'), 'qa');
  assert.equal(cat('buatkan unit test untuk OrderService'), 'qa');
  assert.equal(cat('buatkan endpoint baru untuk export report ke CSV'), 'small-feature');
  assert.equal(cat('tolong fix bug di invoice totals rounding, hasilnya salah di controller'), 'bug-fix');
  assert.equal(cat('buatkan BRD untuk modul payment'), 'brd');
  assert.equal(classifyPrompt('apa itu repository pattern?').decision, 'direct');
});
