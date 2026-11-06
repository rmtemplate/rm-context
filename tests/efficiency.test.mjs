// Routing cost & token efficiency: transcript usage parsing, pricing registry, cost, direct vs delegated, CLI, hook correlation.
// Every transcript and project lives in a temp dir; this repository's telemetry must stay untouched.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ok, rmc, ROOT, repoTelemetry, isolatedCwd } from './helpers.mjs';
import { readUsage, totalTokens } from '../scripts/lib/usage.mjs';
import { analyze, costOf, groupCost, priceFor, loadPricing, savings, MIN_SAMPLES } from '../scripts/lib/efficiency.mjs';

const HOOK = path.join(ROOT, 'scripts', 'hooks.mjs');
const CWD = isolatedCwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-eff-'));
const hook = (event, input) => {
  const r = spawnSync(process.execPath, [HOOK, event], { cwd: CWD, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, RMC_ALLOW_BACKGROUND: '', RMC_SESSION_ID: '' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const sid = () => `test-${process.pid}-${Math.random().toString(36).slice(2)}`;
let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => {
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`rmc-delegation-test-${process.pid}-`) || f.startsWith(`rmc-session-test-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  fs.rmSync(CWD, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry");
});

// One assistant API response as Claude Code writes it: one line per content block, each repeating id and usage.
// u = [input, output, cacheWrite5m, cacheWrite1h, cacheRead]
function msg(id, model, u, { blocks = [{ type: 'text', text: 'x' }], at = '2026-11-06T10:00:00.000Z', extra = {}, usage = {} } = {}) {
  const us = { input_tokens: u[0], output_tokens: u[1], cache_creation_input_tokens: u[2] + u[3], cache_read_input_tokens: u[4],
    cache_creation: { ephemeral_5m_input_tokens: u[2], ephemeral_1h_input_tokens: u[3] }, service_tier: 'standard', speed: 'standard', inference_geo: 'global', ...usage };
  return blocks.map((b) => JSON.stringify({ type: 'assistant', timestamp: at, requestId: `req-${id}`, uuid: `${id}-${Math.random()}`, message: { id, model, content: [b], usage: us }, ...extra })).join('\n') + '\n';
}
const write = (name, text) => { const f = path.join(TMP, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const REG = loadPricing();

// ---------- usage parsing ----------
test('usage is counted once per API message, although each content block repeats it on its own line', () => {
  const f = write('dedupe.jsonl', msg('m1', 'claude-sonnet-5-5', [2, 94, 0, 23251, 10574], { blocks: [{ type: 'thinking' }, { type: 'text' }, { type: 'tool_use', name: 'Read' }] })
    + msg('m2', 'claude-sonnet-5-5', [2, 115, 0, 8643, 33825]) + '{"type":"user","message":{"content":"hi"}}\n{"partial');
  const u = readUsage(f);
  assert.equal(u.calls, 2);
  assert.deepEqual(u.groups, [{ model: 'claude-sonnet-5-5', calls: 2, input: 4, output: 209, cacheWrite1h: 31894, cacheRead: 44399 }]);
});
test('main-session usage skips sidechain lines and synthetic messages, so subagent tokens are never counted twice', () => {
  const f = write('side.jsonl', msg('m1', 'claude-opus-5-5', [1, 10, 0, 0, 100]) + msg('s1', 'claude-haiku-5-5', [5, 50, 500, 0, 0], { extra: { isSidechain: true } })
    + msg('x', '<synthetic>', [0, 0, 0, 0, 0]));
  assert.deepEqual(readUsage(f, { skipSidechain: true }).groups.map((g) => g.model), ['claude-opus-5-5']);
  assert.equal(readUsage(f).groups.length, 2, 'a subagent transcript (all sidechain lines) is read without skipping');
});
test('a byte offset limits usage to one prompt; an unreadable transcript is null, not zero', () => {
  const f = write('turns.jsonl', msg('a', 'claude-opus-5-5', [1, 10, 0, 0, 0]));
  const offset = fs.statSync(f).size;
  fs.appendFileSync(f, msg('b', 'claude-opus-5-5', [3, 30, 0, 0, 0]));
  assert.deepEqual([readUsage(f, { from: offset }).calls, readUsage(f, { from: offset }).groups[0].output], [1, 30]);
  assert.equal(readUsage(path.join(TMP, 'missing.jsonl')), null);
});
test('different actual models, speeds, long Haiku prompts and unsplit cache writes are kept in separate groups', () => {
  const f = write('groups.jsonl', msg('h1', 'claude-haiku-5-5', [10, 10, 0, 0, 1000]) + msg('h2', 'claude-haiku-5-5', [10, 10, 0, 0, 150000])
    + msg('o1', 'claude-opus-5-5', [10, 10, 0, 0, 0], { usage: { speed: 'fast' } })
    + JSON.stringify({ type: 'assistant', message: { id: 'old', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 300 } } }) + '\n');
  const g = readUsage(f).groups;
  assert.deepEqual(g.map((x) => [x.model, x.speed || null, x.long || null, x.cacheWriteUnsplit || 0]),
    [['claude-haiku-5-5', null, null, 0], ['claude-haiku-5-5', null, true, 0], ['claude-opus-5-5', 'fast', null, 0], ['claude-sonnet-5-5', null, null, 300]]);
});
test('the main-session calls that issue a delegation (Agent tool, rmc route) are reported as overhead', () => {
  const f = write('overhead.jsonl', msg('r', 'claude-opus-5-5', [1, 5, 0, 0, 0], { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'node "/x/scripts/rmc.mjs" route --suggested' } }] })
    + msg('a', 'claude-opus-5-5', [1, 7, 0, 0, 0], { blocks: [{ type: 'text' }, { type: 'tool_use', name: 'Agent', input: {} }] })
    + msg('w', 'claude-opus-5-5', [1, 100, 0, 0, 0], { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }));
  const u = readUsage(f);
  assert.deepEqual([u.overhead[0].calls, u.overhead[0].output, u.groups[0].output], [2, 12, 112]);
});

// ---------- pricing and cost ----------
test('cost uses the exact model id and its cache rates; Sonnet 5.5 matches the session cost Claude Code recorded', () => {
  // Live Claude Code 2.1.319 session: cost-state modelUsage claude-sonnet-5-5 costUSD 0.1644548, claude-haiku-5-5 0.001793155.
  const sonnet = groupCost(REG, { model: 'claude-sonnet-5-5', input: 10, output: 1262, cacheWrite1h: 33638, cacheRead: 172628 }, '2026-11-06');
  const haiku = groupCost(REG, { model: 'claude-haiku-5-5', input: 4, output: 814, cacheWrite5m: 10485, cacheRead: 7513 }, '2026-11-06');
  assert.ok(Math.abs(sonnet.usd - 0.1644548) < 1e-9, String(sonnet.usd));
  assert.ok(Math.abs(haiku.usd - 0.001793155) < 1e-9, String(haiku.usd));
  assert.equal(sonnet.version, 'anthropic-api-2026-11-06');
  // Same tier name, different price: never priced by tier.
  assert.notEqual(priceFor(REG, 'claude-sonnet-5', '2026-11-06').cacheRead, priceFor(REG, 'claude-sonnet-5-5', '2026-11-06').cacheRead);
  assert.equal(priceFor(REG, 'sonnet', '2026-11-06'), null);
  assert.equal(priceFor(REG, 'claude-haiku-4-5-20251001', '2026-11-06').model, 'claude-haiku-4-5', 'dated snapshot id via alias');
});
test('every pricing record carries provider, prices, currency, effective date, source and version', () => {
  for (const r of REG.records) {
    for (const k of ['provider', 'model', 'input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'currency', 'pricingVersion', 'source']) assert.ok(r[k] != null, `${r.model}: ${k}`);
    assert.ok('effectiveFrom' in r, `${r.model}: effectiveFrom`);
  }
});
test('historical usage is priced with the version in force on its date, not the latest', () => {
  const reg = { inferenceGeoMultiplier: { global: 1 }, records: [
    { model: 'm', input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, effectiveFrom: null, pricingVersion: 'v1' },
    { model: 'm', input: 2, output: 2, cacheWrite5m: 2, cacheWrite1h: 2, cacheRead: 2, effectiveFrom: '2026-10-01', pricingVersion: 'v2' }] };
  const g = { model: 'm', input: 1e6 };
  assert.deepEqual(groupCost(reg, g, '2026-09-30T23:00:00Z'), { usd: 1, version: 'v1' });
  assert.deepEqual(groupCost(reg, g, '2026-10-01T00:00:00Z'), { usd: 2, version: 'v2' });
});
test('Haiku 5.5 long prompts, fast mode and US inference use their own documented rates', () => {
  assert.ok(Math.abs(groupCost(REG, { model: 'claude-haiku-5-5', long: true, input: 1e6 }, '2026-11-06').usd - 0.5) < 1e-12);
  assert.ok(Math.abs(groupCost(REG, { model: 'claude-opus-5-5', speed: 'fast', output: 1e6 }, '2026-11-06').usd - 40) < 1e-12);
  assert.ok(Math.abs(groupCost(REG, { model: 'claude-opus-5-5', geo: 'us', input: 1e6 }, '2026-11-06').usd - 4.4) < 1e-12);
});
test('missing pricing keeps the tokens and reports cost unavailable, never an unlabelled guess', () => {
  for (const g of [{ model: 'claude-sonnet-4-5', input: 10 }, { model: 'us.anthropic.claude-opus-5-5', input: 10 }, { model: 'claude-sonnet-5-5', speed: 'fast', input: 10 },
    { model: 'claude-sonnet-5-5', tier: 'priority', input: 10 }, { model: 'claude-sonnet-5-5', geo: 'eu', input: 10 }, { model: 'claude-sonnet-5-5', cacheWriteUnsplit: 10 }]) {
    assert.equal(groupCost(REG, g, '2026-11-06').usd, null, JSON.stringify(g));
  }
  const k = costOf(REG, [{ model: 'claude-sonnet-5-5', input: 1e6 }, { model: 'claude-unknown-9', input: 5 }], '2026-11-06');
  assert.deepEqual([k.usd, k.complete, k.pricedTokens, k.unpricedTokens, k.missing], [2, false, 1e6, 5, ['no price for claude-unknown-9']]);
});

// ---------- analytics ----------
const G = (model, input, output, cacheRead = 0) => [{ model, calls: 1, input, output, cacheRead }];
const turnEv = (promptId, main, o = {}) => ({ at: '2026-11-06T10:00:00Z', event: 'turn-usage', sid: 's1', promptId, allocation: 'task', calls: 1, mainAt: '2026-11-06T10:00:00Z', main, overhead: [], ms: 1000, ...o });
const delEv = (promptId, groups, o = {}) => ({ at: '2026-11-06T10:00:05Z', event: 'delegation', sid: 's1', promptId, agent: 'rmc:quick-qa', requested: 'haiku', actual: groups ? [...new Set(groups.map((g) => g.model))] : [], shape: 'foreground', usage: groups ? { calls: 1, at: '2026-11-06T10:00:05Z', groups } : null, ...o });

test('main session and subagent usage are reported separately and summed once; models are actual, configured shown apart', () => {
  const e = analyze([turnEv('P1', G('claude-opus-5-5', 1000, 100)), delEv('P1', G('claude-haiku-5-5', 2000, 200)),
    delEv('P1', G('claude-sonnet-5-5', 3000, 300), { agent: 'rmc:business-analyst', requested: 'sonnet' })], REG);
  assert.deepEqual([e.main.tokens.total, e.subagents.tokens.total, e.total.tokens.total], [1100, 5500, 6600]);
  assert.deepEqual(Object.keys(e.main.models), ['claude-opus-5-5']);
  assert.deepEqual(Object.keys(e.subagents.models).sort(), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(e.subagents.configuredVsActual, { 'haiku → claude-haiku-5-5': 1, 'sonnet → claude-sonnet-5-5': 1 });
  assert.equal(e.tasks[0].agentCalls, 2);
  const expect = (1000 * 4 + 100 * 20 + 2000 * 0.1 + 200 * 0.5 + 3000 * 2 + 300 * 10) / 1e6;
  assert.ok(Math.abs(e.total.cost.usd - expect) < 1e-12 && e.total.cost.complete);
});
test('a delegation without usage metadata is counted as unavailable, not as zero tokens', () => {
  const e = analyze([turnEv('P1', G('claude-opus-5-5', 10, 10)), delEv('P1', null), { at: '2026-11-01T00:00:00Z', event: 'delegation', agent: 'rmc:qa', actual: ['claude-sonnet-5-5'], tokens: 11075 }], REG);
  assert.deepEqual([e.coverage.delegations, e.coverage.subagentUsage, e.coverage.verifiedModel, e.subagents.tokens.total], [2, 0, 1, 0]);
  assert.equal(e.tasks[0].complete, false, 'the task cost is incomplete');
  // Historical events: `tokens` (the agent's last-call context size) is never used as usage.
  assert.equal(e.subagents.avgTokens, null);
});
test('session-level records (no per-prompt offset) are never presented as per-task cost, and are not summed twice', () => {
  const e = analyze([turnEv('P1', G('claude-opus-5-5', 100, 10), { allocation: 'session', calls: 1 }), turnEv('P2', G('claude-opus-5-5', 300, 30), { allocation: 'session', calls: 3 })], REG);
  assert.deepEqual([e.main.allocation, e.main.tokens.total, e.tasks.length, e.main.sessionLevelSessions], ['session-level', 330, 0, 1]);
  const t = analyze([turnEv('P1', G('claude-opus-5-5', 100, 10))], REG);
  assert.deepEqual([t.main.allocation, t.tasks.length], ['per-prompt', 1]);
});
test('savings: positive, negative, zero and unknown', () => {
  assert.deepEqual(savings(1, 0.25), { usd: 0.75, pct: 75, interpretation: 'delegated cheaper' });
  assert.equal(savings(1, 1.5).interpretation, 'delegated more expensive');
  assert.ok(savings(1, 1.5).usd < 0 && savings(1, 1.5).pct === -50);
  assert.deepEqual(savings(1, 1), { usd: 0, pct: 0, interpretation: 'equal' });
  assert.equal(savings(null, 1).interpretation, 'unknown');
  assert.equal(savings(0, 1).interpretation, 'unknown');
});
test('observational comparison needs enough comparable prompts per category and complexity, and is labelled an estimate', () => {
  const ev = [];
  const add = (i, delegated, category = 'debugging') => {
    ev.push(turnEv(`P${i}`, G('claude-opus-5-5', delegated ? 2000 : 50000, 1000), { category, decision: 'suggested', outcome: delegated ? 'followed' : 'direct' }));
    if (delegated) ev.push(delEv(`P${i}`, G('claude-haiku-5-5', 40000, 2000)));
  };
  for (let i = 0; i < MIN_SAMPLES; i++) add(i, false);
  for (let i = 0; i < MIN_SAMPLES - 1; i++) add(10 + i, true);
  assert.equal(analyze(ev, REG).comparison.method, 'unavailable', 'too few delegated prompts');
  add(20, true);
  add(30, false, 'search'); // a different category never joins the debugging baseline
  const c = analyze(ev, REG).comparison;
  assert.equal(c.method, 'observational');
  assert.match(c.label, /Observational estimate/);
  assert.deepEqual([c.groups.length, c.direct.tasks, c.delegated.tasks], [1, MIN_SAMPLES, MIN_SAMPLES]);
  assert.equal(c.savings.interpretation, 'delegated cheaper');
  assert.ok(Math.abs(c.direct.avg.usd - (50000 * 4 + 1000 * 20) / 1e6) < 1e-12);
});
test('an incomplete or unpriced task never enters a comparison', () => {
  const ev = [];
  for (let i = 0; i < 3; i++) ev.push(turnEv(`D${i}`, G('claude-opus-5-5', 100, 10), { category: 'qa', decision: 'suggested', outcome: 'direct' }));
  for (let i = 0; i < 3; i++) { ev.push(turnEv(`X${i}`, G('claude-opus-5-5', 10, 1), { category: 'qa', decision: 'suggested', outcome: 'followed' })); ev.push(delEv(`X${i}`, G('claude-unknown-9', 1, 1))); }
  assert.equal(analyze(ev, REG).comparison.method, 'unavailable');
});
// ---------- hooks: correlation, privacy, CLI ----------
function liveTurn(dir, s, { delegate = true, prompt = 'Debug why the users API returns 500 across the order and user modules PASSWORD=hunter2' } = {}) {
  const main = path.join(TMP, `${s}.jsonl`);
  // A session's first prompt arrives before Claude Code creates the transcript (observed live); later prompts find it.
  hook('prompt', { cwd: dir, session_id: s, prompt, transcript_path: main });
  fs.appendFileSync(main, msg(`m-${s}-1`, 'claude-opus-5-5', [5, 300, 0, 2000, 10000], { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'node rmc.mjs route --suggested' } }] }));
  if (delegate) {
    fs.appendFileSync(main, msg(`m-${s}-2`, 'claude-opus-5-5', [5, 200, 0, 500, 12000], { blocks: [{ type: 'tool_use', name: 'Agent', input: {} }] }));
    write(`${s}/subagents/agent-ag1.jsonl`, msg('sa1', 'claude-sonnet-5-5', [3, 400, 6000, 0, 0], { extra: { isSidechain: true } }) + msg('sa2', 'claude-sonnet-5-5', [3, 600, 1000, 0, 6000], { extra: { isSidechain: true } }));
    write(`${s}/subagents/agent-ag1.meta.json`, JSON.stringify({ requestShape: 'foreground' }));
    hook('post-agent', { cwd: dir, session_id: s, transcript_path: main, tool_use_id: 'toolu_1', tool_name: 'Agent',
      tool_input: { subagent_type: 'rmc:senior-engineer', model: 'sonnet', prompt: 'secret task text hunter2' }, tool_response: { agentId: 'ag1', totalTokens: 7603, totalDurationMs: 4000 } });
  }
  fs.appendFileSync(main, msg(`m-${s}-3`, 'claude-opus-5-5', [5, 500, 0, 800, 14000]));
  hook('stop', { cwd: dir, session_id: s, transcript_path: main });
  return main;
}
const events = (dir) => fs.readFileSync(path.join(dir, '.rmcontext/state/autocontext.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('hooks correlate suggestion, delegation, actual model and usage by prompt id, and store no prompt or transcript text', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const s = sid();
  liveTurn(dir, s);
  const ev = events(dir);
  const sug = ev.find((e) => e.event === 'suggestion'), del = ev.find((e) => e.event === 'delegation'), tu = ev.find((e) => e.event === 'turn-usage');
  assert.ok(sug && del && tu, JSON.stringify(ev.map((e) => e.event)));
  assert.equal(del.promptId, sug.promptId);
  assert.equal(tu.promptId, sug.promptId);
  assert.equal(tu.suggestionId, sug.id);
  assert.deepEqual([del.delegationId, del.agentId, del.actual], ['toolu_1', 'ag1', ['claude-sonnet-5-5']]);
  assert.deepEqual(del.usage.groups, [{ model: 'claude-sonnet-5-5', calls: 2, input: 6, output: 1000, cacheWrite5m: 7000, cacheRead: 6000 }]);
  assert.equal(totalTokens(del.usage.groups), 14006, 'cumulative, not the last call (totalTokens 7603)');
  assert.deepEqual([tu.allocation, tu.calls, tu.delegations, totalTokens(tu.main), tu.overhead.reduce((a, g) => a + g.calls, 0)], ['task', 3, 1, 5 + 300 + 2000 + 10000 + 5 + 200 + 500 + 12000 + 5 + 500 + 800 + 14000, 2]);
  const log = fs.readFileSync(path.join(dir, '.rmcontext/state/autocontext.jsonl'), 'utf8');
  assert.doesNotMatch(log, /hunter2|users API|secret task|route --suggested/);
});
test('rmc route usage, cost and report show actual usage and estimated cost; baseline declares an unverifiable pair', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  const s = sid();
  liveTurn(dir, s, { delegate: false }); // transcript file absent at the prompt
  liveTurn(dir, s); // transcript file present: usage starts at its size then
  const e = JSON.parse(ok(dir, 'route', 'usage', '--json'));
  assert.equal(e.tasks.length, 2);
  assert.equal(e.main.allocation, 'per-prompt');
  assert.equal(e.tasks[1].mainTokens.calls, 3, 'the second prompt does not re-count the first prompt\'s calls');
  const [d, x] = e.tasks;
  assert.deepEqual([d.delegated, x.delegated], [false, true]);
  assert.match(ok(dir, 'route', 'usage'), new RegExp(x.promptId));
  const cost = ok(dir, 'route', 'cost');
  assert.match(cost, /Subagent models \(actual, subagent transcripts\):\n\| Model \(actual\) \| Routes \| Delegations/);
  assert.match(cost, /\| claude-sonnet-5-5 \| 0 \| 1 \| 2 \|/, 'no route id in this synthetic turn: 0 routes, 1 delegation, 2 API calls');
  assert.match(cost, /sonnet → claude-sonnet-5-5: 1/);
  assert.match(ok(dir, 'route', 'report'), /Observational estimate: unavailable/);
  assert.match(ok(dir, 'route', 'stats'), /Routing efficiency[^\n]*\n- Main session tokens: [\d,]+ \(per-prompt\)/);
  // A direct turn cannot be declared as the delegated side, and vice versa.
  assert.notEqual(rmc(dir, 'route', 'baseline', '--direct', x.promptId, '--delegated', d.promptId).code, 0);
  assert.notEqual(rmc(dir, 'route', 'baseline', '--direct', d.promptId, '--delegated', 'P-nope').code, 0);
  // rmc route baseline (kept as an alias) now declares a pair: listed, never verified (no fingerprint or snapshot).
  assert.match(ok(dir, 'route', 'baseline', '--direct', d.promptId, '--delegated', x.promptId, '--note', 'same fixture, same commit'), /Declared pair recorded: B-/);
  const r = ok(dir, 'route', 'report');
  assert.match(r, /Pairs: 1 · valid 0 · pending evaluation 0 · invalid 1/);
  assert.match(r, /SAVINGS STATUS: NOT COMPARABLE/);
  assert.doesNotMatch(r, /SAVINGS STATUS: VERIFIED/);
  const st = JSON.parse(ok(dir, 'route', 'stats', '--json'));
  assert.equal(st.efficiency.tasks, undefined, 'stats --json stays compact');
  assert.equal(st.distribution.delegations, 1);
});
test('stats stay compatible without usage telemetry (historical events or none at all)', () => {
  const dir = fixture('node-app'); ok(dir, 'init');
  assert.match(ok(dir, 'route', 'stats'), /Routing efficiency: unavailable \(no hook telemetry/);
  fs.writeFileSync(path.join(dir, '.rmcontext/state/autocontext.jsonl'), JSON.stringify({ at: '2026-11-01T00:00:00Z', event: 'delegation', agent: 'rmc:qa', requested: 'sonnet', actual: ['claude-sonnet-5-5'], shape: 'sync', tokens: 900, ms: 10 }) + '\n');
  const out = ok(dir, 'route', 'stats');
  assert.match(out, /Actual model verified \(subagent transcript\): 1/);
  assert.match(out, /Subagent tokens: unavailable \(1 delegation\(s\), none with recorded usage\)/);
  assert.match(out, /Direct vs delegated: rmc route benchmark report/);
  assert.match(out, /By source: none/);
});
