// /rmc:run workflows: planning, sequential stages, knowledge packages, gates, recovery, locks, telemetry, write-back.
// Agent runs are stubbed: the real hooks get the events Claude Code documents (PreToolUse, SubagentStart, SubagentStop,
// PostToolUse) with synthetic transcripts. No model is called, no session is started. Everything lives in temp dirs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ok, ROOT, repoTelemetry } from './helpers.mjs';
import { analyze, loadPricing, readJsonl } from '../scripts/lib/efficiency.mjs';

const CLI = path.join(ROOT, 'scripts', 'rmc.mjs');
const HOOK = path.join(ROOT, 'scripts', 'hooks.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-wf-test-'));
const BASE = `wf-${process.pid}`;
const ID = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
let telemetryBefore, n = 0;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => {
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`rmc-session-${BASE}-`) || f.startsWith(`rmc-delegation-${BASE}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry");
});

function project(config) {
  const dir = fixture('node-app');
  for (const f of ['.env', 'keys', 'backups']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  ok(dir, 'init');
  if (config) { const f = path.join(dir, '.rmcontext/config.json'); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...config })); }
  const sid = `${BASE}-${++n}`;
  const main = path.join(TMP, `${sid}.jsonl`);
  fs.writeFileSync(main, '');
  return { dir, sid, main };
}
const cli = (p, args, input) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: p.dir, input: input ?? '', encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: p.sid } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const run = (p, args, input) => { const r = cli(p, args, input); assert.equal(r.code, 0, r.err || r.out); return r.out; };
const refused = (p, args, re, input) => { const r = cli(p, args, input); assert.notEqual(r.code, 0, r.out); assert.match(r.err, re); };
function hook(p, event, x = {}) {
  const r = spawnSync(process.execPath, [HOOK, event], { cwd: p.dir, input: JSON.stringify({ cwd: p.dir, session_id: p.sid, transcript_path: p.main, ...x }), encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: '' } });
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const line = (id, model, u) => JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: new Date().toISOString(),
  message: { id, model, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } }) + '\n';

// One Agent call as Claude Code reports it. Foreground: SubagentStop fires before the tool returns. Background: the tool
// returns at launch (async), SubagentStop comes later; `between` runs while it is still going.
let agentSeq = 0;
function agent(p, role, model, { actual = ID[model], background = false, between, u = [100, 50, 1000] } = {}) {
  const id = `ag${++agentSeq}`, tu = `toolu-${id}`, ti = { subagent_type: `rmc:${role}`, model, prompt: 'the task' };
  const pre = hook(p, 'pre-agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: tu, tool_input: ti })?.hookSpecificOutput;
  if (pre?.permissionDecision === 'deny') return { denied: pre.permissionDecisionReason };
  const context = hook(p, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: id, agent_type: `rmc:${role}` })?.hookSpecificOutput?.additionalContext || null;
  const dir = path.join(p.main.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${id}.jsonl`);
  fs.writeFileSync(file, line(`m-${id}`, actual, u) + line(`m-${id}`, actual, u)); // two content blocks of one API call
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ requestShape: background ? 'background' : 'foreground' }));
  const stop = () => hook(p, 'subagent-stop', { hook_event_name: 'SubagentStop', agent_id: id, agent_type: `rmc:${role}`, agent_transcript_path: file, last_assistant_message: 'PRIVATE AGENT OUTPUT' });
  const post = () => hook(p, 'post-agent', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tu, tool_input: ti, tool_response: background ? { agentId: id, status: 'async_launched' } : { agentId: id, totalDurationMs: 400 } })?.hookSpecificOutput?.additionalContext;
  let note;
  if (background) { note = post(); between?.(); stop(); } else { stop(); note = post(); }
  return { id, tu, context, note };
}
const HANDOFF = (o = {}) => JSON.stringify({ summary: 'Users list endpoint lives in src/routes/users.js; add page and limit parameters.', artifacts: ['src/routes/users.js'],
  decisions: ['page size 20'], assumptions: ['clients send page as a query string'], openQuestions: [], nodes: [], ...o });
const plan = (p, task, extra = []) => JSON.parse(run(p, ['workflow', 'plan', '--session-model', 'claude-opus-5-5', '--json', ...extra], task));
const wfile = (p, id) => JSON.parse(fs.readFileSync(path.join(p.dir, '.rmcontext/state/workflows', `${id}.json`), 'utf8'));
const FEATURE = 'Implement a new feature: add pagination to the users API endpoint';

test('a simple task stays in the main session; ordinary prompts keep suggest-first; /rmc:run gets the task knowledge', () => {
  const p = project();
  const w = plan(p, 'what is a REST API');
  assert.deepEqual([w.status, w.stages.length], ['direct', 0]);
  assert.match(run(p, ['workflow', 'status', w.id]), /direct/);
  assert.equal(fs.existsSync(path.join(p.dir, '.rmcontext/state/routing.jsonl')), false, 'planning records no route; a stage records one when it starts');
  const ordinary = hook(p, 'prompt', { prompt: 'Implement pagination for the users API endpoint in this project' }).hookSpecificOutput.additionalContext;
  assert.match(ordinary, /RM Context suggests Senior Engineer \(Sonnet\) for this [^\n]*Simple\? Answer directly\./, 'suggest-first is unchanged');
  const viaRun = hook(p, 'prompt', { prompt: '/rmc:run Implement pagination for the users API endpoint' }).hookSpecificOutput.additionalContext;
  assert.match(viaRun, /\[RM CONTEXT — RELEVANT PROJECT KNOWLEDGE\][\s\S]*src\/routes\/users\.js/);
  assert.doesNotMatch(viaRun, /RM Context suggests/, 'the workflow command is not answered with a suggestion');
});

test('feature: System Analyst → Senior Engineer → Quick QA, each with its model, package and the previous hand-off; QA failure returns to implementation', () => {
  const p = project();
  const w = plan(p, FEATURE, ['--criteria', 'returns 20 users per page; rejects a negative page']);
  assert.deepEqual(w.stages.map((s) => [s.role, s.agent, s.model]), [['analysis', 'system-analyst', 'sonnet'], ['implement', 'senior-engineer', 'sonnet'], ['verify', 'quick-qa', 'haiku']]);
  assert.match(run(p, ['workflow', 'start', w.id]), /Running System Analyst \(Sonnet\) — stage S1\/3[\s\S]*Notice: [\s\S]*subagent_type "rmc:system-analyst", model "sonnet", in the foreground/);
  assert.match(agent(p, 'system-analyst', 'opus').denied, /pass model "sonnet" explicitly/, 'the explicit routed model is enforced');
  assert.match(agent(p, 'senior-engineer', 'sonnet').denied, /stage S1 runs rmc:system-analyst/, 'an unexpected agent is rejected');
  const sa = agent(p, 'system-analyst', 'sonnet');
  assert.match(sa.context, /^\[RM CONTEXT — WORKFLOW STAGE\] W-\w+ · stage S1\/3 · System Analyst \(analysis\)/);
  assert.match(sa.context, /Acceptance criteria: C1\) returns 20 users per page C2\) rejects a negative page/);
  assert.match(sa.context, /src\/routes\/users\.js[\s\S]*\[inferred\][\s\S]*Knowledge policy|Knowledge policy[\s\S]*src\/routes\/users\.js/);
  assert.match(sa.note, /Actual model \(subagent transcript\): claude-sonnet-5-5; requested: sonnet/);
  assert.match(agent(p, 'system-analyst', 'sonnet').denied, /already ran for this attempt/);
  refused(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass'], /needs its structured hand-off/);
  assert.match(run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF()), /Stage S1 passed\. Next: rmc workflow start/);

  run(p, ['workflow', 'start', w.id]);
  const se = agent(p, 'senior-engineer', 'sonnet');
  assert.match(se.context, /Input hand-off H-\w+ from system-analyst: Users list endpoint lives in src\/routes\/users\.js/);
  assert.match(se.context, /Assumptions \(not verified\): clients send page as a query string/);
  run(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], HANDOFF({ summary: 'Added page/limit to GET /users.' }));

  run(p, ['workflow', 'start', w.id]);
  const qa = agent(p, 'quick-qa', 'haiku');
  assert.match(qa.context, /Input hand-off H-\w+ from senior-engineer: Added page\/limit/);
  refused(p, ['workflow', 'done', w.id, 'S3', '--status', 'pass', '--handoff', '-'], /verdict is "fail"/, HANDOFF({ summary: 'Negative page accepted.', verdict: 'fail' }));
  assert.match(run(p, ['workflow', 'done', w.id, 'S3', '--status', 'fail', '--reason', 'negative page accepted', '--handoff', '-'], HANDOFF({ summary: 'Negative page is accepted (criterion 2).', verdict: 'fail', criteria: [{ id: 'C1', status: 'pass', evidence: 'page=1 returns 20 rows' }, { id: 'C2', status: 'fail', evidence: 'page=-1 returns 200' }] })),
    /Stage S3 failed → back to implementation\. Next: rmc workflow start/);
  refused(p, ['workflow', 'finish', w.id], /not complete: S2 Senior Engineer \(pending\), S3 Quick QA \(pending\)/);

  assert.match(run(p, ['workflow', 'start', w.id]), /stage S2\/3 [\s\S]*attempt 2/);
  const fix = agent(p, 'senior-engineer', 'sonnet');
  assert.match(fix.context, /Input hand-off H-\w+ from quick-qa: Negative page is accepted/, 'the implementer gets the failed verification');
  run(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], HANDOFF({ summary: 'Negative pages now return 400.' }));
  run(p, ['workflow', 'start', w.id]);
  agent(p, 'quick-qa', 'haiku');
  const both = [{ id: 'C1', status: 'pass', evidence: 'page=1 returns 20 rows' }, { id: 'C2', status: 'pass', evidence: 'page=-1 returns 400 (test users.page)' }];
  refused(p, ['workflow', 'done', w.id, 'S3', '--status', 'pass', '--handoff', '-'], /C2 not proven/, HANDOFF({ verdict: 'pass', criteria: [both[0]] }));
  refused(p, ['workflow', 'done', w.id, 'S3', '--status', 'pass', '--criteria', '2/3', '--handoff', '-'], /--criteria 2\/3 disagrees/, HANDOFF({ verdict: 'pass', criteria: both }));
  assert.match(run(p, ['workflow', 'done', w.id, 'S3', '--status', 'pass', '--criteria', '2/2', '--handoff', '-'], HANDOFF({ summary: 'Both criteria pass.', verdict: 'pass', criteria: both })), /Next: rmc workflow finish/);

  const fin = run(p, ['workflow', 'finish', w.id]);
  assert.match(fin, /Workflow W-\w+ completed\./);
  assert.match(fin, /\| S1 analysis \| system-analyst \| medium \| sonnet \| claude-sonnet-5-5 \| foreground \| passed \| 1 \| no \|/);
  assert.match(fin, /\| S2 implement \| senior-engineer \| medium \| sonnet \| claude-sonnet-5-5 \| foreground \| passed \| 2 \| no \|/);
  assert.match(fin, /\| S3 verify \| quick-qa \| low \| haiku \| claude-haiku-5-5 \| foreground \| passed \| 2 \| no \|/);
  assert.match(fin, /- S2 Senior Engineer: sonnet — senior-engineer role policy: medium → sonnet/);
  // 5 agent runs × one API call of 1,150 tokens: every call counted once, although each run was seen by PostToolUse and SubagentStop.
  assert.match(fin, /Subagents: 5,750 tokens/);
  const events = readJsonl(path.join(p.dir, '.rmcontext/state/autocontext.jsonl'));
  assert.equal(analyze(events, loadPricing()).subagents.tokens.total, 5750);
  assert.equal(new Set(events.filter((e) => e.event === 'delegation').map((e) => e.delegationId)).size, 5);
  const done = wfile(p, w.id);
  assert.deepEqual([done.status, done.qaLoops, done.stages.map((s) => s.status).join()], ['completed', 1, 'passed,passed,passed']);
  const summary = fs.readFileSync(path.join(p.dir, '.rmcontext/state/handoffs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([summary.from, summary.to, summary.workflow, summary.assumptions], ['orchestrator', 'user', w.id, ['clients send page as a query string']], 'assumptions stay assumptions');
  const stored = fs.readFileSync(path.join(p.dir, '.rmcontext/state/autocontext.jsonl'), 'utf8') + JSON.stringify(done);
  assert.doesNotMatch(stored, /add pagination to the users API endpoint|PRIVATE AGENT OUTPUT/, 'no task text or agent output in telemetry or workflow state');
});

test('bounded retry with one escalation, then failure; a failed stage prevents completion', () => {
  const p = project();
  const w = plan(p, 'fix the bug in the users endpoint returning 500');
  assert.deepEqual(w.stages.map((s) => [s.agent, s.model]), [['senior-engineer', 'sonnet'], ['quick-qa', 'haiku']]);
  run(p, ['workflow', 'start', w.id]);
  agent(p, 'senior-engineer', 'sonnet');
  assert.match(run(p, ['workflow', 'done', w.id, 'S1', '--status', 'fail', '--reason', 'root cause spans the db layer', '--escalate', '--handoff', '-'], HANDOFF({ summary: 'Cause is in db.js, not the route.' })), /failed → retry/);
  assert.match(run(p, ['workflow', 'start', w.id]), /Running Senior Engineer \(Opus\)[\s\S]*model "opus"/, 'one escalation through the existing policy');
  assert.match(agent(p, 'senior-engineer', 'sonnet').denied, /pass model "opus"/);
  agent(p, 'senior-engineer', 'opus');
  assert.match(run(p, ['workflow', 'done', w.id, 'S1', '--status', 'fail', '--reason', 'still failing']), /Workflow W-\w+ FAILED: stage S1 failed 2 time\(s\) \(maxAttempts 2\)/);
  refused(p, ['workflow', 'finish', w.id], /is failed; it cannot be completed/);
  refused(p, ['workflow', 'start', w.id], /is failed; nothing to start/);
  assert.deepEqual(wfile(p, w.id).stages.map((s) => s.status), ['failed', 'not run']);
  assert.equal(readJsonl(path.join(p.dir, '.rmcontext/state/routing.jsonl')).filter((r) => r.workflow === w.id && r.escalatedFrom).length, 1);
});

test('verification loops are bounded; a stage cannot pass without its agent run; a failed Agent call is recorded', () => {
  const p = project({ workflow: { maxQaLoops: 1 } });
  const w = plan(p, 'fix the bug in the users endpoint returning 500');
  run(p, ['workflow', 'start', w.id]);
  refused(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], /No agent run is recorded for stage S1/, HANDOFF());
  hook(p, 'post-agent', { hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu-fail', tool_input: { subagent_type: 'rmc:senior-engineer', model: 'sonnet' }, error: 'boom' });
  refused(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], /No agent run is recorded|failed; record --status fail/, HANDOFF());
  assert.equal(wfile(p, w.id).stages[0].runs[0].status, 'failed');
  run(p, ['workflow', 'done', w.id, 'S1', '--status', 'fail', '--reason', 'agent call failed']);
  run(p, ['workflow', 'start', w.id]); agent(p, 'senior-engineer', 'sonnet'); run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF());
  run(p, ['workflow', 'start', w.id]); agent(p, 'quick-qa', 'haiku');
  assert.match(run(p, ['workflow', 'done', w.id, 'S2', '--status', 'fail', '--reason', 'still 500', '--handoff', '-'], HANDOFF({ verdict: 'fail' })), /back to implementation/);
  run(p, ['workflow', 'start', w.id]); agent(p, 'senior-engineer', 'sonnet'); run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF());
  run(p, ['workflow', 'start', w.id]); agent(p, 'quick-qa', 'haiku');
  assert.match(run(p, ['workflow', 'done', w.id, 'S2', '--status', 'fail', '--reason', 'still 500']), /FAILED: verification failed 2 times \(maxQaLoops 1\)/);
});

test('an explicit user model is used for every stage; high-risk work is verified by QA with a risk-appropriate model', () => {
  const p = project();
  const w = plan(p, FEATURE, ['--model', 'opus']);
  assert.deepEqual(w.stages.map((s) => [s.model, s.source]), [['opus', 'user'], ['opus', 'user'], ['opus', 'user']]);
  run(p, ['workflow', 'start', w.id]);
  assert.match(agent(p, 'system-analyst', 'sonnet').denied, /pass model "opus"/);
  run(p, ['workflow', 'cancel', w.id]);
  const s = plan(p, 'fix the security vulnerability in the users endpoint authentication');
  // Security-critical (authentication): analysis and verification on Opus; the implementation goes back to Sonnet.
  assert.deepEqual(s.stages.map((x) => [x.role, x.agent, x.model]), [['analysis', 'senior-engineer', 'opus'], ['implement', 'senior-engineer', 'sonnet'], ['verify', 'qa', 'opus']]);
  assert.equal(s.risk, 'high');
});

test('nested agents are denied inside RM Context agents only; other agents are untouched', () => {
  const p = project();
  const nested = hook(p, 'pre-agent', { tool_name: 'Agent', tool_use_id: 't1', agent_id: 'ag-parent', agent_type: 'rmc:senior-engineer', tool_input: { subagent_type: 'Explore' } }).hookSpecificOutput;
  assert.deepEqual([nested.permissionDecision, /do not start other agents/.test(nested.permissionDecisionReason)], ['deny', true]);
  assert.equal(hook(p, 'pre-agent', { tool_name: 'Agent', tool_use_id: 't2', agent_id: 'ag-x', agent_type: 'Explore', tool_input: { subagent_type: 'Explore' } }), null);
});

test('the one-agent lock holds until the background agent finishes; background runs are reported as background and counted once', () => {
  const p = project();
  let during = null;
  const bg = agent(p, 'qa', 'sonnet', { background: true, between: () => {
    hook(p, 'stop', {});
    during = agent(p, 'quick-qa', 'haiku');
  } });
  assert.match(bg.note, /BACKGROUND/);
  assert.match(during.denied, /one agent at a time: rmc:qa is still running/, 'PostToolUse returning at launch and Stop do not release the lock');
  assert.equal(agent(p, 'quick-qa', 'haiku').denied, undefined, 'SubagentStop released it');
  const events = readJsonl(path.join(p.dir, '.rmcontext/state/autocontext.jsonl')).filter((e) => e.event === 'delegation' && e.delegationId === bg.tu);
  assert.deepEqual(events.map((e) => e.status), ['started', 'completed']);
  assert.equal(events[1].shape, 'background');
  assert.equal(analyze(readJsonl(path.join(p.dir, '.rmcontext/state/autocontext.jsonl')), loadPricing()).subagents.tokens.total, 2300, 'started + completed = one delegation');

  const w = plan(p, 'investigate how the users module works');
  run(p, ['workflow', 'start', w.id]);
  agent(p, 'system-analyst', 'sonnet', { background: true });
  run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF());
  assert.match(run(p, ['workflow', 'finish', w.id]), /\| S1 analysis \| system-analyst \| medium \| sonnet \| claude-sonnet-5-5 \| background \| passed \|/);
});

test('cancellation stops later stages; an unfinished workflow is reported at Stop, never as successful', () => {
  const p = project();
  const w = plan(p, FEATURE);
  run(p, ['workflow', 'start', w.id]);
  agent(p, 'system-analyst', 'sonnet');
  const stop = hook(p, 'stop', {});
  assert.match(stop.systemMessage, new RegExp(`RM Context workflow ${w.id} is not complete \\(stage S1 System Analyst: returned\\); it is not marked successful`));
  refused(p, ['workflow', 'plan', '--task', 'another feature to implement in the users endpoint'], /still running/);
  assert.match(run(p, ['workflow', 'cancel', w.id]), /cancelled; later stages will not run/);
  refused(p, ['workflow', 'start', w.id], /is cancelled; nothing to start/);
  assert.deepEqual(wfile(p, w.id).stages.map((s) => s.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(hook(p, 'pre-agent', { tool_name: 'Agent', tool_use_id: 'free', tool_input: { subagent_type: 'rmc:qa', model: 'sonnet' } }), null, 'no workflow guard after cancel');
  assert.equal(hook(p, 'stop', {})?.systemMessage, undefined);
});

test('stale knowledge is labelled in the stage package; finishing writes knowledge back', () => {
  const p = project();
  fs.appendFileSync(path.join(p.dir, 'src/routes/users.js'), '\n// changed after the scan\n');
  hook(p, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: path.join(p.dir, 'src/routes/users.js') } });
  const w = plan(p, 'investigate how the users module works');
  assert.ok(w.stages[0].knowledge.stale > 0);
  assert.match(w.stages[0].knowledge.text, /src\/routes\/users\.js[^\n]*\[stale\]/);
  run(p, ['workflow', 'start', w.id]);
  agent(p, 'system-analyst', 'sonnet');
  run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF());
  const fin = run(p, ['workflow', 'finish', w.id]);
  assert.match(fin, /Knowledge write-back: hand-off H-\w+; 1 changed file\(s\) re-scanned/);
  const hs = fs.readFileSync(path.join(p.dir, '.rmcontext/state/handoffs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(hs.some((h) => h.workflow === w.id && h.stage === 'S1' && h.from === 'system-analyst'), 'the stage hand-off is stored with its provenance');
});

test('no LLM calls, processes or extra sessions in hooks and workflow code; the command never uses Fork or headless sessions', () => {
  for (const f of ['scripts/hooks.mjs', 'scripts/lib/workflow.mjs', 'scripts/lib/delegation.mjs', 'scripts/lib/usage.mjs', 'scripts/lib/efficiency.mjs']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(s, /child_process|\bfetch\(|anthropic\.com|@anthropic-ai|claude -p/, f);
  }
  const cmd = fs.readFileSync(path.join(ROOT, 'commands/run.md'), 'utf8');
  assert.doesNotMatch(cmd, /claude -p|subagent_type "fork"|context: fork|run_in_background: true/);
  assert.match(cmd, /never set `run_in_background`[\s\S]*one agent at a time/);
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
  assert.deepEqual([hooks.SubagentStart[0].matcher, hooks.SubagentStop[0].matcher], ['^(rmc|rm-context):', '^(rmc|rm-context):']);
  assert.ok(Object.values(hooks).flat().flatMap((h) => h.hooks).every((h) => h.type === 'command'), 'command hooks only: no prompt or agent hooks');
});

// ---------- regression: planner classification and the verification invariant (smoke test W-mw5509w45u2) ----------
const stagesOf = (w) => w.stages.map((s) => `${s.role}:${s.agent}`);
const QA_OK = (ids, o = {}) => HANDOFF({ summary: 'Verified.', verdict: 'pass', criteria: ids.map((id) => ({ id, status: 'pass', evidence: `${id}: checked src/routes/users.js:6 and the test output` })), ...o });
// The smoke-test task, pointed at a module the fixture has (this repository has no authentication module).
const SMOKE = 'Analisis struktur modul users di src/routes, identifikasi satu perbaikan dokumentasi kecil yang memang diperlukan, implementasikan perbaikan tersebut, lalu verifikasi hasilnya.';

test('regression: analysis + implementation + documentation + verification plans Analyst → Engineer → QA', () => {
  const p = project();
  for (const task of [SMOKE, 'Analyse the users module, implement the documentation fix it needs, then verify the result.']) {
    const w = plan(p, task);
    assert.deepEqual(stagesOf(w), ['analysis:system-analyst', 'implement:senior-engineer', 'verify:quick-qa'], task);
    run(p, ['workflow', 'cancel', w.id]);
  }
});

test('regression: documentation workflows stay small unless code changes or criteria need verification', () => {
  const p = project();
  const cases = [
    ['update the documentation for the users API', [], ['document:documentation']],
    ['update the documentation for the users API and fix the code example in src/routes/users.js', [], ['document:documentation', 'verify:quick-qa']],
    ['update the documentation for the users API', ['--criteria', 'documents the page parameter'], ['document:documentation', 'verify:quick-qa']],
    ['fix the bug in the users endpoint returning 500', ['--criteria', 'GET /users returns 200'], ['implement:senior-engineer', 'verify:quick-qa']],
    [FEATURE, ['--criteria', 'returns 20 users per page'], ['analysis:system-analyst', 'implement:senior-engineer', 'verify:quick-qa']],
    ['investigate how the users module works', [], ['analysis:system-analyst']],
    ['review src/server.js for security vulnerabilities', ['--criteria', 'every finding cites a line'], ['work:senior-engineer', 'verify:qa']],
  ];
  for (const [task, extra, want] of cases) {
    const w = plan(p, task, extra);
    assert.deepEqual(stagesOf(w), want, `${task} ${extra.join(' ')}`);
    run(p, ['workflow', 'cancel', w.id]);
  }
});

test('regression: finish is refused without a passed verification stage, whatever the template planned', () => {
  const p = project();
  const w = plan(p, 'update the documentation for the users API', ['--criteria', 'documents the page parameter']);
  // The plan W-mw5509w45u2 had: criteria, but only a documentation stage. Rebuild that state and check the engine refuses it.
  const f = path.join(p.dir, '.rmcontext/state/workflows', `${w.id}.json`);
  const state = JSON.parse(fs.readFileSync(f, 'utf8'));
  state.stages = state.stages.filter((s) => s.role !== 'verify');
  fs.writeFileSync(f, JSON.stringify(state));
  run(p, ['workflow', 'start', w.id]);
  agent(p, 'documentation', w.stages[0].model);
  run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF());
  refused(p, ['workflow', 'finish', w.id], /no verification stage passed[\s\S]*C1 unverified/);
});

test('regression: QA must prove every criterion with evidence; a failed criterion returns to implementation; all verified → finish', () => {
  const p = project();
  const w = plan(p, 'fix the bug in the users endpoint returning 500', ['--criteria', 'GET /users returns 200; the error is logged']);
  run(p, ['workflow', 'start', w.id]); agent(p, 'senior-engineer', 'sonnet');
  run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF());
  run(p, ['workflow', 'start', w.id]);
  const qa = agent(p, 'quick-qa', 'haiku');
  assert.match(qa.context, /C1\) GET \/users returns 200 C2\) the error is logged/);
  assert.match(qa.context, /"criteria": \[\{"id": "C1", "status": "pass\|fail", "evidence"/);
  // A passing verdict does not verify criteria by itself.
  refused(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], /C1, C2 not proven/, HANDOFF({ verdict: 'pass' }));
  refused(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], /C2 not proven/, QA_OK(['C1']));
  refused(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], /C2 not proven/,
    QA_OK(['C1'], { criteria: [{ id: 'C1', status: 'pass', evidence: 'curl returned 200' }, { id: 'C2', status: 'pass', evidence: '' }] }));
  refused(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], /C2 not proven/,
    QA_OK(['C1'], { criteria: [{ id: 'C1', status: 'pass', evidence: 'curl returned 200' }, { id: 'C2', status: 'fail', evidence: 'no log line' }] }));
  refused(p, ['workflow', 'finish', w.id], /not complete/);
  assert.match(run(p, ['workflow', 'done', w.id, 'S2', '--status', 'fail', '--reason', 'error not logged', '--handoff', '-'],
    HANDOFF({ verdict: 'fail', criteria: [{ id: 'C1', status: 'pass', evidence: 'curl returned 200' }, { id: 'C2', status: 'fail', evidence: 'no log line in output' }] })), /back to implementation/);
  const mid = wfile(p, w.id);
  assert.deepEqual(mid.checks.map((x) => x.status), ['unverified', 'unverified'], 'after a return to implementation every criterion needs verifying again');
  assert.equal(mid.checks[1].last.status, 'failed');
  run(p, ['workflow', 'start', w.id]); agent(p, 'senior-engineer', 'sonnet');
  run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF({ summary: 'Errors are logged now.' }));
  run(p, ['workflow', 'start', w.id]); agent(p, 'quick-qa', 'haiku');
  assert.match(run(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], QA_OK(['C1', 'C2'])), /Next: rmc workflow finish/);
  const fin = run(p, ['workflow', 'finish', w.id]);
  assert.match(fin, /Acceptance criteria: 2\/2 verified/);
  assert.match(fin, /C2 verified by S2 \(quick-qa\): C2: checked src\/routes\/users\.js:6/);
  const qaHandoff = fs.readFileSync(path.join(p.dir, '.rmcontext/state/handoffs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((h) => h.from === 'quick-qa').at(-1);
  assert.deepEqual(qaHandoff.criteria.map((x) => [x.id, x.status]), [['C1', 'pass'], ['C2', 'pass']], 'the QA hand-off keeps the per-criterion results and evidence');
});
