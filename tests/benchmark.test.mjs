// Routing benchmark & efficiency intelligence: route distribution, dedupe, pair validity, quality, profiles, advisory
// recommendation, CLI. Billed sessions are never started: `benchmark run` is driven by a stand-in for `claude` (RMC_CLAUDE)
// that plays a headless session through the real hooks. Everything lives in temp dirs; repository telemetry is untouched.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fixture, ok, rmc, ROOT, repoTelemetry, isolatedCwd } from './helpers.mjs';
import { distribution, dedupe, analyze, loadPricing } from '../scripts/lib/efficiency.mjs';
import { assess, quality, profiles, recommend, recommendFor, taskFingerprint, usageCheck } from '../scripts/lib/benchmark.mjs';

const REG = loadPricing();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-bench-test-'));
const CWD = isolatedCwd();
let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => {
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(`rmc-session-bench-${process.pid}-`) || f.startsWith(`rmc-delegation-bench-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    if (f.startsWith('rmc-benchmark-B-') && fs.statSync(path.join(os.tmpdir(), f)).mtimeMs > START) fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true });
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(CWD, { recursive: true, force: true });
  assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry");
});
const START = Date.now();

// ---------- synthetic records ----------
const G = (model, input, output, cacheRead = 0, calls = 1) => [{ model, calls, input, output, cacheRead }];
const turn = (promptId, main, o = {}) => ({ promptId, sid: o.sid || `s-${promptId}`, category: 'debugging', decision: 'suggest', outcome: o.outcome || 'direct', at: '2026-11-06T10:00:00Z', ms: 1000, main, overhead: o.overhead || [], subagents: o.subagents || [] });
const sub = (groups, o = {}) => ({ delegationId: o.id || 'toolu_x', routeId: o.routeId || null, agent: o.agent || 'rmc:quick-qa', requested: o.requested || 'haiku', actual: o.actual ?? [...new Set((groups || []).map((g) => g.model))], shape: 'foreground', status: 'completed', at: '2026-11-06T10:00:01Z', groups, ms: 500 });
let seq = 0;
function pair({ direct = G('claude-opus-5-5', 50000, 2000), delegatedMain = G('claude-opus-5-5', 5000, 300), subGroups = G('claude-haiku-5-5', 60000, 3000), o = {} } = {}) {
  seq++;
  return { type: 'benchmark', id: `B-t${seq}`, at: '2026-11-06T10:00:00Z', origin: o.origin || 'run', taskId: 'T1', category: o.category || 'debugging', complexity: o.complexity || 'medium',
    fingerprint: 'sha256:abc', snapshot: { commit: 'c0ffee' }, mainModel: 'claude-opus-5-5', criteria: 3,
    runs: { direct: { runId: `BR-d${seq}`, sessionId: `sd${seq}`, status: o.directStatus || 'completed', ms: 40000, turn: turn(`Pd${seq}`, direct, { subagents: o.directSubs || [] }), usageCheck: 'match' },
      delegated: { runId: `BR-x${seq}`, sessionId: o.sameSession ? `sd${seq}` : `sx${seq}`, status: 'completed', ms: 60000, usageCheck: o.mismatch ? 'mismatch' : 'match',
        turn: turn(`Px${seq}`, delegatedMain, { outcome: 'followed', subagents: o.noSub ? [] : [sub(subGroups, { actual: o.unverified ? [] : undefined })] }) } } };
}
const ev = (b, side, o = {}) => ({ type: 'evaluation', benchmarkId: b.id, side, completed: true, criteriaPassed: 3, criteriaTotal: 3, ...o });
const evalBoth = (b, d = {}, x = {}) => [ev(b, 'direct', d), ev(b, 'delegated', x)];

// ---------- routing distribution ----------
test('routes, suggestions, delegations and direct responses are counted separately, once per correlation id', () => {
  const routes = [{ id: 'R1', agent: 'quick-qa', model: 'haiku', tier: 'low', origin: 'suggested' }, { id: 'R1', agent: 'quick-qa', model: 'haiku', tier: 'low', origin: 'suggested' },
    { id: 'R2', agent: 'senior-engineer', model: 'sonnet', tier: 'medium', origin: 'command', requested: 'sonnet' }, { id: 'R3', agent: 'architecture', model: 'opus', tier: 'high' }];
  const events = [
    { event: 'suggestion', id: 'S1', agent: 'quick-qa', model: 'haiku' }, { event: 'suggestion', id: 'S1', agent: 'quick-qa', model: 'haiku' }, { event: 'suggestion', id: 'S2', agent: 'qa', model: 'sonnet' },
    { event: 'delegation', delegationId: 'tu1', routeId: 'R1', agent: 'rmc:quick-qa', requested: 'haiku', actual: ['claude-haiku-5-5'], shape: 'foreground', status: 'completed' },
    { event: 'delegation', delegationId: 'tu1', routeId: 'R1', agent: 'rmc:quick-qa', requested: 'haiku', actual: ['claude-haiku-5-5'], shape: 'foreground', status: 'completed' },
    { event: 'delegation', delegationId: 'tu2', agent: 'rmc:senior-engineer', requested: 'sonnet', actual: [], shape: 'foreground', status: 'completed' },
    { event: 'delegation', agent: 'rmc:qa', requested: 'sonnet', actual: ['claude-sonnet-5-5'], shape: 'sync', tokens: 9 }, // legacy: no id, no status
    { event: 'delegation-denied', kind: 'background' },
    { event: 'turn-usage', sid: 's', promptId: 'P1', delegations: 0, main: G('claude-opus-5-5', 1, 1) }, { event: 'turn-usage', sid: 's', promptId: 'P1', delegations: 0, main: G('claude-opus-5-5', 1, 1) },
    { event: 'turn-usage', sid: 's', promptId: 'P2', delegations: 2, main: G('claude-opus-5-5', 1, 1) }];
  const d = distribution(routes, events);
  assert.equal(d.routes, 3, 'a route id is one route however many times it is recorded');
  assert.deepEqual(d.byOrigin, { suggested: 1, command: 1, 'unknown (before origin was recorded)': 1 });
  assert.deepEqual(d.byAgent, { 'quick-qa': 1, 'senior-engineer': 1, architecture: 1 });
  assert.deepEqual([d.suggestions, d.delegations, d.prompts, d.directResponses, d.delegatedPrompts], [2, 3, 2, 1, 1]);
  assert.deepEqual(d.delegationsByAgent, { 'quick-qa': 1, 'senior-engineer': 1, qa: 1 });
  assert.deepEqual(d.requestedByUser, { sonnet: 1 }, 'a resolved model is not a user request');
  assert.deepEqual(d.requestedSubagentModel, { haiku: 1, sonnet: 2 });
  assert.deepEqual(d.actualModel, { 'claude-haiku-5-5': 1, unverified: 1, 'claude-sonnet-5-5': 1 }, 'never inferred from the requested model');
  assert.deepEqual([d.unverified, d.execution.foreground, d.execution.backgroundRejected], [1, 3, 1]);
  assert.deepEqual(d.status, { completed: 2, 'unknown (before status was recorded)': 1 });
  assert.deepEqual(d.mainModel, { 'claude-opus-5-5': 2 });
});
test('one delegation with many API calls and several models is one delegation; duplicates never add usage', () => {
  const groups = [...G('claude-haiku-5-5', 10, 10, 0, 7), ...G('claude-sonnet-5-5', 20, 20, 0, 2)];
  const d = { event: 'delegation', delegationId: 'tu1', promptId: 'P1', routeId: 'R1', agent: 'rmc:qa', actual: ['claude-haiku-5-5', 'claude-sonnet-5-5'], usage: { calls: 9, at: '2026-11-06', groups } };
  const e = analyze([{ event: 'turn-usage', sid: 's', promptId: 'P1', allocation: 'task', calls: 1, main: G('claude-opus-5-5', 1, 1) }, d, d,
    { event: 'delegation', delegationId: 'tu2', promptId: 'P1', agent: 'rmc:quick-qa', actual: ['claude-haiku-5-5'], usage: { calls: 1, at: '2026-11-06', groups: G('claude-haiku-5-5', 5, 5) } }], REG);
  assert.deepEqual([e.coverage.delegations, e.subagents.tokens.calls, e.subagents.tokens.total], [2, 10, 70]);
  assert.deepEqual([e.subagents.models['claude-haiku-5-5'].delegations, e.subagents.models['claude-sonnet-5-5'].delegations, e.subagents.models['claude-haiku-5-5'].routes], [2, 1, 1]);
  assert.deepEqual(Object.keys(e.subagents.byRole).sort(), ['qa', 'quick-qa']);
  assert.equal(e.tasks[0].agentCalls, 2);
  assert.equal(dedupe([{ event: 'refresh' }, { event: 'refresh' }]).length, 2, 'events without a correlation id are kept');
});

// ---------- pair validity ----------
test('a valid pair separates main, overhead and subagent usage and adds main + subagent cost once', () => {
  const b = pair({ delegatedMain: [{ model: 'claude-opus-5-5', calls: 3, input: 5000, output: 300 }] });
  b.runs.delegated.turn.overhead = [{ model: 'claude-opus-5-5', calls: 1, input: 1000, output: 50 }];
  const p = assess(REG, b, evalBoth(b));
  assert.equal(p.status, 'valid', p.reasons.join('; '));
  assert.deepEqual([p.mainModel, p.agent, p.requestedSubModel, p.subModel], ['claude-opus-5-5', 'quick-qa', 'haiku', 'claude-haiku-5-5']);
  const main = (5000 * 4 + 300 * 20) / 1e6, subCost = (60000 * 0.1 + 3000 * 0.5) / 1e6;
  assert.ok(Math.abs(p.delegated.cost.usd - (main + subCost)) < 1e-12, 'overhead is inside the main-session cost, not added again');
  assert.deepEqual([p.delegated.mainTokens.total, p.delegated.subagentTokens.total, p.delegated.tokens.total], [5300, 63000, 68300]);
});
test('invalid pairs: each rule names its reason', () => {
  const cases = [
    [pair({ o: { directSubs: [sub(G('claude-haiku-5-5', 1, 1))] } }), /direct run delegated/],
    [pair({ o: { noSub: true } }), /made no RM Context delegation/],
    [pair({ o: { unverified: true } }), /actual subagent model unverified/],
    [pair({ delegatedMain: G('claude-sonnet-5-5', 10, 10) }), /different main session models/],
    [pair({ o: { sameSession: true } }), /same session/],
    [pair({ o: { mismatch: true } }), /differs from Claude Code's own session totals/],
    [pair({ o: { directStatus: 'timeout' } }), /direct run timeout/],
    [pair({ subGroups: G('claude-unknown-9', 10, 10) }), /pricing unavailable/],
    [pair({ o: { origin: 'declared' } }), /declared pair/]];
  for (const [b, re] of cases) { const p = assess(REG, b, evalBoth(b)); assert.equal(p.status, 'invalid'); assert.match(p.reasons.join('; '), re); }
  const b = pair();
  b.runs.direct.turn = null;
  assert.match(assess(REG, b, evalBoth(b)).reasons.join('; '), /per-prompt usage unavailable/);
});
test('quality: comparable only on equal completion, criteria and recorded measures; length is never a measure', () => {
  const b = pair();
  assert.equal(assess(REG, b, []).status, 'pending-evaluation', 'unevaluated pairs never count');
  assert.equal(quality(evalBoth(b)).status, 'comparable');
  for (const [d, x] of [[{}, { criteriaPassed: 2 }], [{}, { completed: false }], [{ falsePositives: 0 }, { falsePositives: 2 }], [{ rework: false }, { rework: true }], [{ accepted: true }, { accepted: false }]]) {
    const q = quality(evalBoth(b, d, x));
    assert.equal(q.status, 'not comparable', JSON.stringify(x));
    assert.equal(assess(REG, b, evalBoth(b, d, x)).status, 'invalid');
  }
  assert.equal(quality([...evalBoth(b, {}, { criteriaPassed: 1 }), ev(b, 'delegated')]).status, 'comparable', 'the latest evaluation of a side wins');
});

// ---------- profiles, savings, recommendation ----------
const evalAll = (bs) => bs.flatMap((b) => evalBoth(b));
test('fewer than the minimum valid pairs is INSUFFICIENT DATA, with no savings conclusion; three is VERIFIED', () => {
  const two = [pair(), pair()];
  const p2 = profiles(REG, { benchmarks: two, evaluations: evalAll(two) })[0];
  assert.deepEqual([p2.status, p2.validPairs, p2.savings.usd, p2.recommendation.decision], ['INSUFFICIENT DATA', 2, null, 'insufficient']);
  assert.ok(p2.costDifference != null, 'averages are still shown, labelled with the sample size');
  const three = [...two, pair()];
  const p3 = profiles(REG, { benchmarks: three, evaluations: evalAll(three) })[0];
  assert.deepEqual([p3.status, p3.confidence, p3.direct.validRuns, p3.delegated.validRuns], ['VERIFIED', 'minimum', 3, 3]);
});
test('token and cost savings are reported apart: a cheaper model can use more tokens', () => {
  // Direct Opus 52,000 tokens vs delegated Opus 5,300 + Haiku 63,000 = 68,300 tokens, yet delegated is cheaper.
  const bs = [pair(), pair(), pair()];
  const p = profiles(REG, { benchmarks: bs, evaluations: evalAll(bs) })[0];
  assert.ok(p.tokenDifference < 0, 'delegated used more tokens');
  assert.ok(p.costDifference > 0 && p.savings.interpretation === 'delegated cheaper');
  assert.deepEqual([p.recommendation.decision, p.recommendation.text], ['delegated', 'Delegated quick-qa (claude-haiku-5-5)']);
  // Negative savings → direct: direct $0.24 vs delegated $0.026 main + Sonnet $0.34.
  const costly = [1, 2, 3].map(() => pair({ subGroups: G('claude-sonnet-5-5', 120000, 10000) }));
  const q = profiles(REG, { benchmarks: costly, evaluations: evalAll(costly) })[0];
  assert.deepEqual([q.status, q.savings.interpretation, q.recommendation.decision], ['VERIFIED', 'delegated more expensive', 'direct']);
  assert.equal(recommend({ status: 'VERIFIED', savings: { usd: 0 }, mainModel: 'm' }).decision, 'direct');
});
test('profiles never mix categories, complexity or main models; quality mismatches make a group NOT COMPARABLE', () => {
  const bs = [pair(), pair(), pair(), pair({ o: { complexity: 'high' } }), pair({ o: { category: 'qa' } })];
  const profs = profiles(REG, { benchmarks: bs, evaluations: evalAll(bs) });
  assert.equal(profs.length, 3);
  assert.equal(recommendFor(profs, { category: 'debugging', complexity: 'medium', mainModel: 'claude-opus-5-5' }).decision, 'delegated');
  assert.equal(recommendFor(profs, { category: 'debugging', complexity: 'high', mainModel: 'claude-opus-5-5' }).decision, 'insufficient');
  assert.equal(recommendFor(profs, { category: 'debugging', complexity: 'medium', mainModel: 'claude-sonnet-5-5' }).decision, 'insufficient');
  const bad = [pair(), pair(), pair()];
  const nc = profiles(REG, { benchmarks: bad, evaluations: bad.flatMap((b) => evalBoth(b, {}, { criteriaPassed: 1 })) })[0];
  assert.equal(nc.status, 'NOT COMPARABLE');
});
test('our usage totals are checked against the totals Claude Code reports for the session', () => {
  const t = { main: [{ model: 'claude-opus-5-5', input: 10, output: 20, cacheRead: 30, cacheWrite1h: 40 }] };
  const mu = { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 } };
  assert.equal(usageCheck(t, [], mu), 'match');
  assert.equal(usageCheck(t, [], { ...mu, 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }), 'mismatch');
  assert.equal(usageCheck(t, [], null), 'unavailable');
  assert.equal(taskFingerprint({ objective: ' a ', acceptanceCriteria: ['x'], category: 'qa', complexity: 'low' }), taskFingerprint({ objective: 'a', acceptanceCriteria: [' x'], category: 'qa', complexity: 'low' }));
  assert.notEqual(taskFingerprint({ objective: 'a', acceptanceCriteria: ['x'], category: 'qa', complexity: 'low' }), taskFingerprint({ objective: 'a', acceptanceCriteria: ['y'], category: 'qa', complexity: 'low' }));
});

// ---------- CLI with a stand-in for claude ----------
const msgLine = (id, model, u, blocks = [{ type: 'text' }], extra = {}) => blocks.map((b) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), ...extra,
  message: { id, model, content: [b], usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } })).join('\n') + '\n';
const STUB = path.join(TMP, 'fake-claude.mjs');
fs.writeFileSync(STUB, `// Plays one headless Claude Code session through the real RM Context hooks (no model call).
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const HOOK = ${JSON.stringify(path.join(ROOT, 'scripts', 'hooks.mjs'))};
const a = process.argv.slice(2), prompt = a[a.indexOf('-p') + 1], model = a[a.indexOf('--model') + 1];
const sid = 'bench-${process.pid}-' + Math.random().toString(36).slice(2), main = path.join(${JSON.stringify(TMP)}, sid + '.jsonl');
const hook = (e, x) => spawnSync(process.execPath, [HOOK, e], { cwd: process.cwd(), input: JSON.stringify({ cwd: process.cwd(), session_id: sid, transcript_path: main, ...x }), encoding: 'utf8' });
const line = ${msgLine.toString()};
hook('prompt', { prompt });
const delegated = !/Do not delegate/.test(prompt);
const usage = { [model]: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
const add = (m, u) => { const x = (usage[m] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }); x.inputTokens += u[0]; x.outputTokens += u[1]; x.cacheReadInputTokens += u[2]; };
const u1 = delegated ? [100, 50, 4000] : [500, 400, 40000];
fs.appendFileSync(main, line('m1-' + sid, model, u1, delegated ? [{ type: 'tool_use', name: 'Agent', input: {} }] : undefined)); add(model, u1);
if (delegated) {
  const dir = path.join(main.replace(/\\.jsonl$/, ''), 'subagents'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-ag1.jsonl'), line('s1-' + sid, 'claude-haiku-5-5', [200, 300, 30000], undefined, { isSidechain: true }));
  fs.writeFileSync(path.join(dir, 'agent-ag1.meta.json'), JSON.stringify({ requestShape: 'foreground' }));
  add('claude-haiku-5-5', [200, 300, 30000]);
  hook('post-agent', { tool_use_id: 'toolu-' + sid, tool_name: 'Agent', tool_input: { subagent_type: 'rmc:quick-qa', model: 'haiku', prompt: 'x' }, tool_response: { agentId: 'ag1', totalDurationMs: 900 } });
}
hook('stop', {});
if (process.env.STUB_MISMATCH) usage[model].outputTokens += 1;
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: sid, duration_ms: delegated ? 3000 : 2000, result: 'findings for ' + (delegated ? 'delegated' : 'direct'), modelUsage: usage }));
`);
const TASK = path.join(TMP, 'task.json');
fs.writeFileSync(TASK, JSON.stringify({ id: 'users-500', category: 'debugging', complexity: 'medium', objective: 'Find why POST /users returns 500 and name the cause.', acceptanceCriteria: ['Names the failing line', 'Explains the cause', 'Suggests a fix'], deliverable: 'A short finding' }));
const env = { ...process.env, RMC_CLAUDE: STUB, RMC_SESSION_ID: '' };
const cli = (dir, ...a) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'rmc.mjs'), ...a], { cwd: dir, encoding: 'utf8', env }); return { code: r.status, out: r.stdout, err: r.stderr }; };
function gitProject() {
  const dir = fixture('node-app');
  for (const f of ['.env', 'keys', 'backups']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  ok(dir, 'init');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, stdio: 'ignore' });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'snapshot');
  return dir;
}

test('benchmark run without --approve prints the plan, records nothing and exits non-zero', () => {
  const dir = gitProject();
  const r = cli(dir, 'route', 'benchmark', 'run', '--task', TASK, '--main-model', 'claude-opus-5-5');
  assert.equal(r.code, 2);
  assert.match(r.out, /NOT RUN — it would start 2 billed headless Claude Code sessions/);
  assert.match(r.out, /Run it only after the user explicitly agrees to the cost: add --approve/);
  assert.equal(fs.existsSync(path.join(dir, '.rmcontext/state/benchmarks.jsonl')), false);
  assert.notEqual(cli(dir, 'route', 'benchmark', 'run', '--task', TASK, '--approve').code, 0, '--main-model is required');
  fs.appendFileSync(path.join(dir, 'src', 'server.js'), '\n// edit\n');
  assert.match(cli(dir, 'route', 'benchmark', 'run', '--task', TASK, '--main-model', 'claude-opus-5-5').err, /uncommitted changes/, 'a different source snapshot is refused');
});
test('benchmark run, evaluate, report, efficiency and the route advisory, end to end (stand-in claude)', () => {
  const dir = gitProject();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = cli(dir, 'route', 'benchmark', 'run', '--task', TASK, '--main-model', 'claude-opus-5-5', '--approve', '--json');
    assert.equal(r.code, 0, r.err);
    const b = JSON.parse(r.out);
    assert.deepEqual(b.order, i % 2 ? ['delegated', 'direct'] : ['direct', 'delegated'], 'run order alternates');
    assert.equal(b.snapshot.commit, head);
    assert.notEqual(b.runs.direct.sessionId, b.runs.delegated.sessionId);
    assert.deepEqual([b.runs.direct.status, b.runs.direct.usageCheck, b.runs.delegated.usageCheck], ['completed', 'match', 'match']);
    assert.deepEqual(b.runs.delegated.turn.subagents.map((s) => [s.agent, s.requested, s.actual[0]]), [['rmc:quick-qa', 'haiku', 'claude-haiku-5-5']]);
    assert.equal(b.runs.direct.turn.subagents.length, 0);
    assert.ok(fs.existsSync(b.runs.direct.output), 'the result is kept outside telemetry for the evaluator');
    ids.push(b.id);
  }
  const store = fs.readFileSync(path.join(dir, '.rmcontext/state/benchmarks.jsonl'), 'utf8');
  assert.doesNotMatch(store, /POST \/users returns 500|Names the failing line|findings for/, 'no task text or output in the store');
  assert.match(cli(dir, 'route', 'benchmark').out, /pending-evaluation/);
  assert.match(cli(dir, 'route', 'benchmark', 'report').out, /SAVINGS STATUS: INSUFFICIENT DATA \(0\/3 valid pairs/);
  assert.notEqual(cli(dir, 'route', 'benchmark', 'evaluate', ids[0], '--side', 'direct', '--completed', 'yes', '--criteria', '3/4').code, 0, 'criteria total must match the task');
  for (const id of ids) for (const side of ['direct', 'delegated']) ok2(dir, 'route', 'benchmark', 'evaluate', id, '--side', side, '--completed', 'yes', '--criteria', '3/3', '--rework', 'no');
  const report = cli(dir, 'route', 'benchmark', 'report').out;
  assert.match(report, /Pairs: 3 · valid 3/);
  assert.match(report, /SAVINGS STATUS: VERIFIED — \$[\d.]+ per task \([\d.]+%\), delegated cheaper/);
  assert.match(report, /token difference: [+-][\d,]+/);
  const eff = cli(dir, 'route', 'efficiency', '--category', 'debugging', '--complexity', 'medium', '--main-model', 'claude-opus-5-5').out;
  assert.match(eff, /Recommendation: Delegated quick-qa \(claude-haiku-5-5\)\nReason: Historical delegated execution is cheaper with comparable task quality\./);
  // Advisory on rmc route: the routed model is unchanged.
  const plain = JSON.parse(cli(dir, 'route', '--agent', 'senior-engineer', '--category', 'debugging', '--json', '--no-record').out);
  assert.equal(plain.model, 'opus', 'adaptive routing is unchanged by benchmarks');
  const routed = cli(dir, 'route', '--agent', 'senior-engineer', '--category', 'debugging', '--session-model', 'claude-opus-5-5', '--no-record');
  assert.match(routed.out, /- Model: Opus[\s\S]*Efficiency \(advisory, routing unchanged\): Insufficient historical benchmark data\. Using existing adaptive routing policy\./, 'no profile for the high tier');
  const user = JSON.parse(cli(dir, 'route', '--agent', 'senior-engineer', '--category', 'debugging', '--model', 'sonnet', '--session-model', 'claude-opus-5-5', '--json', '--no-record').out);
  assert.deepEqual([user.model, user.source, user.efficiency.text], ['sonnet', 'user', 'Delegated quick-qa (claude-haiku-5-5)'], 'the user model stands; the recommendation is advice only');
  const full = cli(dir, 'route', 'report').out;
  assert.match(full, /Routing distribution:/);
  assert.match(full, /SAVINGS STATUS: VERIFIED/);
  // A quality mismatch later invalidates a pair and drops the group below the minimum.
  ok2(dir, 'route', 'benchmark', 'evaluate', ids[0], '--side', 'delegated', '--completed', 'yes', '--criteria', '2/3');
  assert.match(cli(dir, 'route', 'benchmark', 'report').out, /SAVINGS STATUS: INSUFFICIENT DATA \(2\/3 valid pairs/);
  assert.match(cli(dir, 'route', 'benchmark').out, /quality not comparable \(acceptance criteria: direct 3\/3, delegated 2\/3\)/);
});
test('a run whose usage differs from what Claude Code reports is invalid', () => {
  const dir = gitProject();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'rmc.mjs'), 'route', 'benchmark', 'run', '--task', TASK, '--main-model', 'claude-opus-5-5', '--approve'], { cwd: dir, encoding: 'utf8', env: { ...env, STUB_MISMATCH: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recorded usage differs from Claude Code's own session totals/);
});
test('slash commands mark their routes; legacy route records and baselines stay readable', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  ok(dir, 'route', '--origin', 'command', '--agent', 'qa', '--category', 'qa');
  ok(dir, 'route', '--agent', 'qa', '--category', 'qa', '--workflow', 'feature');
  ok(dir, 'route', '--agent', 'qa', '--category', 'qa');
  fs.appendFileSync(path.join(dir, '.rmcontext/state/routing.jsonl'), JSON.stringify({ id: 'R-old', at: '2026-11-01T00:00:00Z', agent: 'qa', model: 'sonnet', tier: 'medium', category: 'qa' }) + '\n');
  assert.match(ok(dir, 'route', 'stats'), /By source: (command 1 · workflow 1 · manual 1|[^\n]*command 1[^\n]*)[^\n]*unknown \(before origin was recorded\) 1/);
  fs.writeFileSync(path.join(dir, '.rmcontext/state/baselines.jsonl'), JSON.stringify({ method: 'controlled', at: '2026-11-06', direct: turn('P1', G('claude-opus-5-5', 1, 1)), delegated: turn('P2', G('claude-opus-5-5', 1, 1), { subagents: [sub(G('claude-haiku-5-5', 1, 1))] }) }) + '\n');
  assert.match(ok(dir, 'route', 'benchmark'), /B-legacy-1 [^\n]*declared[^\n]*invalid/);
  const commands = fs.readdirSync(path.join(ROOT, 'commands')).map((f) => fs.readFileSync(path.join(ROOT, 'commands', f), 'utf8')).join('\n');
  assert.doesNotMatch(commands, /rmc route --(agent|category)/, 'every slash command routes with --origin command');
});
function ok2(dir, ...a) { const r = cli(dir, ...a); assert.equal(r.code, 0, r.err || r.out); return r.out; }
