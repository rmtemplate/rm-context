// Controlled routing benchmark: the same task run directly (main session only) and delegated (RM Context agent), each in
// its own headless Claude Code session on a fresh copy of the same committed source snapshot. A run is billed, so it only
// starts with --approve after the user agrees; stats and reports never start one. Quality is evaluated manually against the
// task's acceptance criteria (no LLM evaluator). Usage, cost and model facts reuse usage.mjs / efficiency.mjs, so a benchmark
// is measured exactly like any other prompt. Stored as metadata in .rmcontext/state/benchmarks.jsonl (append-only): task
// fingerprint, snapshot commit, run ids, usage groups, evaluation scores; never the task text, prompts or outputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { PLUGIN_ROOT, readJson, fail, now, git } from './util.mjs';
import { loadPricing, measure, snapshot, mainModelOf, readJsonl, dedupe, savings, usd, secs } from './efficiency.mjs';

const CLI = path.join(PLUGIN_ROOT, 'scripts', 'rmc.mjs');
const COMPLEXITY = ['low', 'medium', 'high'];
export const loadBenchConfig = () => ({ minPairs: 3, recommendedPairs: 5, timeoutSeconds: 900, allowedTools: [], modes: {}, ...readJson(path.join(PLUGIN_ROOT, 'config', 'benchmark.json'), {}) });
const storeFile = (c) => c.p('state', 'benchmarks.jsonl');
const append = (c, rec) => { fs.mkdirSync(path.dirname(storeFile(c)), { recursive: true }); fs.appendFileSync(storeFile(c), JSON.stringify(rec) + '\n'); };
const newId = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const role = (a) => String(a || '').replace(/^(rmc|rm-context):/, '');
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// ---------- task ----------
export function loadTask(file, categories) {
  const t = (file && readJson(path.resolve(String(file)), null)) || fail(`Cannot read the benchmark task file "${file}". It is JSON: { id, category, complexity, objective, acceptanceCriteria[], deliverable?, agent? }`);
  for (const k of ['id', 'category', 'complexity', 'objective']) if (!t[k] || typeof t[k] !== 'string') fail(`Benchmark task: "${k}" is required.`);
  if (!Array.isArray(t.acceptanceCriteria) || !t.acceptanceCriteria.length) fail('Benchmark task: "acceptanceCriteria" needs at least one criterion (both runs are evaluated against it).');
  if (!COMPLEXITY.includes(t.complexity)) fail(`Benchmark task: complexity must be one of ${COMPLEXITY.join(', ')}.`);
  if (categories && !categories.includes(t.category)) fail(`Benchmark task: unknown category "${t.category}" (see: rmc route categories).`);
  return t;
}
// Same objective, criteria, deliverable, category, complexity and agent → same fingerprint. The text itself is never stored.
export const taskFingerprint = (t) => `sha256:${crypto.createHash('sha256').update(JSON.stringify({ objective: t.objective.trim(), criteria: t.acceptanceCriteria.map((x) => String(x).trim()),
  deliverable: String(t.deliverable || '').trim(), category: t.category, complexity: t.complexity, agent: t.agent || null })).digest('hex')}`;

export function instruction(t, mode, cfg) {
  const route = t.agent ? `rmc route --agent ${role(t.agent)} --category ${t.category} --session-model <your model id>` : 'rmc route --suggested --session-model <your model id>';
  return [t.objective.trim(), '', 'Acceptance criteria:', ...t.acceptanceCriteria.map((x) => `- ${x}`), ...(t.deliverable ? ['', `Expected deliverable: ${t.deliverable}`] : []), '',
    String(cfg.modes[mode] || '').replace('{route}', route)].join('\n');
}

// ---------- source snapshot ----------
export function sourceSnapshot(root) {
  const commit = git(root, ['rev-parse', 'HEAD']);
  if (!commit) fail('A benchmark needs a git repository with at least one commit: the commit is the source snapshot both runs start from.');
  if (git(root, ['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).rmcontext'])) fail('Tracked files have uncommitted changes. Commit or stash them first: both runs must start from the same committed source snapshot.');
  return { commit, tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}
function extract(root, commit, dir) {
  const tar = `${dir}.tar`;
  try {
    execFileSync('git', ['archive', '--format=tar', '-o', tar, commit], { cwd: root, stdio: 'ignore' });
    execFileSync('tar', ['-xf', tar, '-C', dir], { stdio: 'ignore' });
  } finally { fs.rmSync(tar, { force: true }); }
  fs.rmSync(path.join(dir, '.rmcontext'), { recursive: true, force: true }); // both runs get the same fresh context: rmc init below
}

// Our per-model totals must equal Claude Code's own modelUsage for the session, or some usage was missed.
export function usageCheck(turn, dels, modelUsage) {
  if (!turn || !modelUsage) return 'unavailable';
  const ours = {};
  for (const g of [...(turn.main || []), ...dels.flatMap((d) => d.usage?.groups || [])]) {
    const x = (ours[g.model] ||= { i: 0, o: 0, r: 0, w: 0 });
    x.i += g.input || 0; x.o += g.output || 0; x.r += g.cacheRead || 0; x.w += (g.cacheWrite5m || 0) + (g.cacheWrite1h || 0) + (g.cacheWriteUnsplit || 0);
  }
  const theirs = Object.entries(modelUsage);
  const same = theirs.length === Object.keys(ours).length && theirs.every(([m, u]) => ours[m] && ours[m].i === u.inputTokens && ours[m].o === u.outputTokens
    && ours[m].r === u.cacheReadInputTokens && ours[m].w === u.cacheCreationInputTokens);
  return same ? 'match' : 'mismatch';
}

function runOne(c, b, mode, task, opts, cfg) {
  const runId = newId('BR');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-bench-run-'));
  try {
    extract(c.root, b.snapshot.commit, dir);
    if (spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8' }).status !== 0) return { runId, mode, status: 'failed', error: 'rmc init failed on the snapshot' };
    const startedAt = now(), t0 = Date.now();
    // A new headless session per run: nothing from the other run or an earlier attempt is reused.
    // RMC_CLAUDE may point at a .mjs/.js stand-in (tests): run it with this Node, on every platform.
    const [bin, ...pre] = /\.(mjs|js)$/.test(opts.claude) ? [process.execPath, opts.claude] : [opts.claude];
    const r = spawnSync(bin, [...pre, '-p', instruction(task, mode, cfg), '--model', opts.mainModel, '--plugin-dir', PLUGIN_ROOT, '--output-format', 'json', '--allowedTools', ...cfg.allowedTools],
      { cwd: dir, encoding: 'utf8', timeout: cfg.timeoutSeconds * 1000, maxBuffer: 64 << 20, env: { ...process.env, RMC_SESSION_ID: '' } });
    let out = {};
    try { out = JSON.parse(r.stdout || '{}'); } catch { /* not JSON: the run failed */ }
    const ev = dedupe(readJsonl(path.join(dir, '.rmcontext', 'state', 'autocontext.jsonl')));
    const turns = ev.filter((e) => e.event === 'turn-usage' && e.allocation === 'task' && (!out.session_id || e.sid === out.session_id));
    const turn = turns.length === 1 ? turns[0] : null; // claude -p: exactly one prompt
    const dels = turn ? ev.filter((e) => e.event === 'delegation' && e.promptId === turn.promptId) : [];
    const routes = readJsonl(path.join(dir, '.rmcontext', 'state', 'routing.jsonl')).map((x) => ({ id: x.id, agent: x.agent, model: x.model, tier: x.tier, origin: x.origin || null, category: x.category }));
    // The result text stays out of telemetry: a temp file for the manual quality evaluation.
    const outDir = path.join(os.tmpdir(), `rmc-benchmark-${b.id}`);
    fs.mkdirSync(outDir, { recursive: true });
    const output = path.join(outDir, `${mode}.md`);
    fs.writeFileSync(output, String(out.result ?? ''));
    return { runId, mode, sessionId: out.session_id || null, startedAt, ms: out.duration_ms ?? Date.now() - t0,
      status: r.error?.code === 'ETIMEDOUT' ? 'timeout' : r.status === 0 && out.is_error === false ? 'completed' : 'failed',
      turns: turns.length, turn: turn ? snapshot(turn, dels) : null, routes, usageCheck: usageCheck(turn, dels, out.modelUsage), output };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Without approve: the plan only (nothing billed). Order alternates per task fingerprint unless given, to reduce order bias.
export function runBenchmark(c, { task: file, mainModel, order, approve, claude, categories }) {
  const cfg = loadBenchConfig();
  const task = loadTask(file, categories);
  if (!mainModel || mainModel === true) fail('--main-model <model id> is required: both runs use the same main session model (e.g. claude-opus-5-5).');
  const snap = sourceSnapshot(c.root);
  const fingerprint = taskFingerprint(task);
  const prior = readBenchmarks(c).benchmarks.filter((b) => b.fingerprint === fingerprint).length;
  const seq = order === 'delegated-first' ? ['delegated', 'direct'] : order === 'direct-first' ? ['direct', 'delegated'] : prior % 2 ? ['delegated', 'direct'] : ['direct', 'delegated'];
  const plan = { taskId: task.id, category: task.category, complexity: task.complexity, fingerprint, snapshot: snap, mainModel, order: seq, agent: task.agent || 'suggested', priorRuns: prior,
    sessions: 2, billed: true };
  if (!approve) return { approved: false, plan };
  const b = { type: 'benchmark', id: newId('B'), at: now(), origin: 'run', taskId: task.id, category: task.category, complexity: task.complexity, fingerprint,
    criteria: task.acceptanceCriteria.length, fixtureId: task.fixture || path.basename(c.root), snapshot: snap, mainModel, agent: task.agent ? role(task.agent) : null, order: seq,
    context: 'fresh rmc init on the snapshot, for both runs', runs: {} };
  const bin = claude || process.env.RMC_CLAUDE || 'claude';
  for (const mode of seq) b.runs[mode] = runOne(c, b, mode, task, { mainModel, claude: bin }, cfg);
  append(c, b);
  return { approved: true, benchmark: b };
}

// A pair declared from two ordinary prompts (rmc route benchmark add / rmc route baseline). Kept, but it can never be
// verified: no task fingerprint or source snapshot was recorded for it.
export function addDeclared(c, events, { direct, delegated, note }) {
  if (!direct || !delegated || direct === true || delegated === true) fail('Usage: rmc route benchmark add --direct <P-id> --delegated <P-id> [--note "…"]  (prompt ids: rmc route usage)');
  const ev = dedupe(events || []);
  const turn = (id) => ev.find((e) => e.event === 'turn-usage' && e.promptId === id && e.allocation === 'task')
    || fail(`No per-prompt usage recorded for ${id} (unknown id, session-level only, or trimmed from telemetry). See: rmc route usage`);
  const dels = (id) => ev.filter((e) => e.event === 'delegation' && e.promptId === id);
  const d = snapshot(turn(direct), dels(direct)), x = snapshot(turn(delegated), dels(delegated));
  if (d.subagents.length) fail(`${direct} delegated to ${d.subagents.length} agent(s): a direct run must not use RM Context agents.`);
  if (!x.subagents.length) fail(`${delegated} has no RM Context delegation: nothing to compare.`);
  if (d.category && x.category && d.category !== x.category) fail(`Not comparable: ${direct} is "${d.category}", ${delegated} is "${x.category}".`);
  const b = { type: 'benchmark', id: newId('B'), at: now(), origin: 'declared', note: typeof note === 'string' ? note.slice(0, 200) : null, category: d.category || x.category || null, complexity: null,
    fingerprint: null, snapshot: null, runs: { direct: { runId: direct, sessionId: d.sid, ms: d.ms, turn: d }, delegated: { runId: delegated, sessionId: x.sid, ms: x.ms, turn: x } } };
  append(c, b);
  return b;
}

// ---------- manual quality evaluation ----------
export function evaluate(c, benchId, a) {
  const b = readBenchmarks(c).benchmarks.find((x) => x.id === benchId) || fail(`Unknown benchmark ${benchId}. See: rmc route benchmark`);
  if (!['direct', 'delegated'].includes(a.side)) fail('--side direct|delegated is required.');
  const yn = (k, required) => {
    const v = a[k];
    if (v == null || v === true) return required ? fail(`--${k} yes|no is required.`) : null;
    return v === 'yes' ? true : v === 'no' ? false : fail(`--${k} takes yes or no.`);
  };
  const count = (k) => (a[k] == null ? null : /^\d+$/.test(String(a[k])) ? Number(a[k]) : fail(`--${k} takes a number.`));
  const m = /^(\d+)\/(\d+)$/.exec(String(a.criteria || '')) || fail('--criteria <passed>/<total> is required, e.g. 3/4 (acceptance criteria met).');
  const [passed, total] = [Number(m[1]), Number(m[2])];
  if (!total || passed > total) fail('--criteria: passed must be between 0 and total, and total above 0.');
  if (b.criteria && total !== b.criteria) fail(`--criteria: this task has ${b.criteria} acceptance criteria.`);
  const rec = { type: 'evaluation', benchmarkId: b.id, side: a.side, at: now(), evaluator: 'manual', completed: yn('completed', true), criteriaPassed: passed, criteriaTotal: total,
    correct: yn('correct'), missingFindings: count('missing'), falsePositives: count('false-positives'), rework: yn('rework'), accepted: yn('accepted') };
  append(c, rec);
  return rec;
}

// Equal quality = both completed, the same share of acceptance criteria, and no difference in any other recorded measure.
// Output length is never a measure.
export function quality(evals = []) {
  const last = (s) => evals.filter((e) => e.side === s).at(-1) || null;
  const d = last('direct'), x = last('delegated');
  if (!d || !x) return { status: 'pending', direct: d, delegated: x, differences: [] };
  const diff = [];
  if (!d.completed || !x.completed) diff.push(`task completed: direct ${d.completed ? 'yes' : 'no'}, delegated ${x.completed ? 'yes' : 'no'}`);
  if (d.criteriaPassed / d.criteriaTotal !== x.criteriaPassed / x.criteriaTotal) diff.push(`acceptance criteria: direct ${d.criteriaPassed}/${d.criteriaTotal}, delegated ${x.criteriaPassed}/${x.criteriaTotal}`);
  for (const [k, label] of [['correct', 'correct'], ['missingFindings', 'missing findings'], ['falsePositives', 'false positives'], ['rework', 'rework needed'], ['accepted', 'accepted by a human']]) {
    if (d[k] != null && x[k] != null && d[k] !== x[k]) diff.push(`${label}: direct ${d[k]}, delegated ${x[k]}`);
  }
  return { status: diff.length ? 'not comparable' : 'comparable', direct: d, delegated: x, differences: diff };
}

// ---------- store ----------
export function readBenchmarks(c) {
  const recs = readJsonl(storeFile(c));
  const byId = new Map();
  for (const r of recs) if (r.type === 'benchmark' && r.id && !byId.has(r.id)) byId.set(r.id, r);
  // Pairs declared with rmc route baseline before benchmarks existed.
  for (const [i, r] of readJsonl(c.p('state', 'baselines.jsonl')).entries()) {
    if (r.method !== 'controlled' || !r.direct || !r.delegated) continue;
    const id = `B-legacy-${i + 1}`;
    if (!byId.has(id)) byId.set(id, { type: 'benchmark', id, at: r.at, origin: 'declared', note: r.note || null, category: r.direct.category || r.delegated.category || null, complexity: null,
      fingerprint: null, snapshot: null, runs: { direct: { runId: r.direct.promptId, sessionId: r.direct.sid || null, ms: r.direct.ms, turn: r.direct }, delegated: { runId: r.delegated.promptId, sessionId: r.delegated.sid || null, ms: r.delegated.ms, turn: r.delegated } } });
  }
  return { benchmarks: [...byId.values()], evaluations: recs.filter((r) => r.type === 'evaluation') };
}

// ---------- validity ----------
export function assess(reg, b, evaluations = []) {
  const reasons = [];
  const D = b.runs?.direct, X = b.runs?.delegated;
  if (b.origin !== 'run') reasons.push('declared pair: no task fingerprint or source snapshot was recorded, so equal tasks cannot be verified');
  else if (!b.fingerprint || !b.snapshot?.commit) reasons.push('task fingerprint or source snapshot missing');
  for (const [k, r] of [['direct', D], ['delegated', X]]) {
    if (!r) { reasons.push(`${k} run missing`); continue; }
    if (b.origin === 'run' && r.status !== 'completed') reasons.push(`${k} run ${r.status || 'status unknown'}`);
    if (!r.turn) reasons.push(`${k} run: per-prompt usage unavailable${r.turns > 1 ? ' (more than one prompt)' : ''}`);
    if (r.usageCheck === 'mismatch') reasons.push(`${k} run: recorded usage differs from Claude Code's own session totals`);
  }
  const md = D?.turn ? measure(reg, D.turn) : null, mx = X?.turn ? measure(reg, X.turn) : null;
  if (md?.delegated) reasons.push('the direct run delegated to an RM Context agent');
  if (mx && !mx.delegated) reasons.push('the delegated run made no RM Context delegation');
  if (mx?.subagents.some((s) => !s.actual?.length)) reasons.push('actual subagent model unverified');
  if ((md && !md.complete) || (mx && !mx.complete)) reasons.push('usage or pricing unavailable for part of a run');
  const mainD = md ? mainModelOf(md.main) : null, mainX = mx ? mainModelOf(mx.main) : null;
  if (md && mx && mainD !== mainX) reasons.push(`different main session models (${mainD} vs ${mainX})`);
  if (D?.sessionId && D.sessionId === X?.sessionId) reasons.push('both runs ran in the same session');
  const q = quality(evaluations.filter((e) => e.benchmarkId === b.id));
  if (q.status === 'not comparable') reasons.push(`quality not comparable (${q.differences.join('; ')})`);
  const subs = mx?.subagents || [];
  return { id: b.id, at: b.at, origin: b.origin, taskId: b.taskId || null, note: b.note || null, category: b.category || md?.category || mx?.category || null, complexity: b.complexity || null,
    fingerprint: b.fingerprint || null, snapshot: b.snapshot || null, order: b.order || null, mainModel: mainD || mainX || b.mainModel || null,
    agent: b.agent || uniq(subs.map((s) => role(s.agent))).join('+') || null, requestedSubModel: uniq(subs.map((s) => s.requested || 'inherited')).join('+') || null,
    subModel: subs.length ? uniq(subs.flatMap((s) => s.actual || [])).join('+') || 'unverified' : null,
    status: reasons.length ? 'invalid' : q.status === 'comparable' ? 'valid' : 'pending-evaluation', reasons, quality: q, direct: md, delegated: mx,
    ms: { direct: D?.ms ?? md?.ms ?? null, delegated: X?.ms ?? mx?.ms ?? null }, outputs: { direct: D?.output || null, delegated: X?.output || null } };
}

// ---------- historical efficiency profiles ----------
// One profile per category + complexity + main model + delegated agent + actual subagent model. Only valid pairs feed the
// averages; nothing is borrowed from another category or complexity.
export function profiles(reg, data, cfg = loadBenchConfig()) {
  const pairs = data.benchmarks.map((b) => assess(reg, b, data.evaluations));
  const groups = new Map();
  for (const p of pairs) { const k = [p.category, p.complexity, p.mainModel, p.agent, p.subModel].join('|'); (groups.get(k) || groups.set(k, []).get(k)).push(p); }
  const out = [...groups.values()].map((ps) => {
    const valid = ps.filter((p) => p.status === 'valid');
    const avg = (f) => (valid.length ? valid.reduce((a, p) => a + f(p), 0) / valid.length : null);
    const success = (s) => { const e = ps.map((p) => p.quality[s]).filter(Boolean); return e.length ? { rate: e.filter((x) => x.completed).length / e.length, evaluated: e.length } : null; };
    const cache = (t) => t.cacheRead + t.cacheWrite;
    const direct = { runs: ps.filter((p) => p.direct).length, validRuns: valid.length, usd: avg((p) => p.direct.cost.usd), tokens: avg((p) => p.direct.tokens.total),
      input: avg((p) => p.direct.tokens.input), output: avg((p) => p.direct.tokens.output), cache: avg((p) => cache(p.direct.tokens)), calls: avg((p) => p.direct.tokens.calls), ms: avg((p) => p.ms.direct ?? 0), success: success('direct') };
    const delegated = { runs: ps.filter((p) => p.delegated).length, validRuns: valid.length, usd: avg((p) => p.delegated.cost.usd), mainUsd: avg((p) => p.delegated.mainCost.usd), subagentUsd: avg((p) => p.delegated.subagentCost.usd),
      tokens: avg((p) => p.delegated.tokens.total), mainTokens: avg((p) => p.delegated.mainTokens.total), subagentTokens: avg((p) => p.delegated.subagentTokens.total),
      overheadTokens: avg((p) => p.delegated.overhead.reduce((a, g) => a + (g.input || 0) + (g.output || 0) + (g.cacheRead || 0) + (g.cacheWrite5m || 0) + (g.cacheWrite1h || 0) + (g.cacheWriteUnsplit || 0), 0)),
      input: avg((p) => p.delegated.tokens.input), output: avg((p) => p.delegated.tokens.output), cache: avg((p) => cache(p.delegated.tokens)), calls: avg((p) => p.delegated.tokens.calls),
      agentCalls: avg((p) => p.delegated.agentCalls), ms: avg((p) => p.ms.delegated ?? 0), success: success('delegated') };
    const pending = ps.filter((p) => p.status === 'pending-evaluation').length, invalid = ps.filter((p) => p.status === 'invalid').length;
    const status = valid.length >= cfg.minPairs ? 'VERIFIED' : !valid.length && !pending && invalid ? 'NOT COMPARABLE' : 'INSUFFICIENT DATA';
    const p0 = ps[0];
    const prof = { category: p0.category, complexity: p0.complexity, mainModel: p0.mainModel, agent: p0.agent, subModel: p0.subModel, requestedSubModel: p0.requestedSubModel,
      pairs: ps.length, validPairs: valid.length, pendingPairs: pending, invalidPairs: invalid, status, minPairs: cfg.minPairs,
      confidence: valid.length >= cfg.recommendedPairs ? 'good' : valid.length >= cfg.minPairs ? 'minimum' : 'insufficient', direct, delegated,
      // Reported apart: fewer tokens is not lower cost when the models' prices differ.
      tokenDifference: valid.length ? direct.tokens - delegated.tokens : null, costDifference: valid.length ? direct.usd - delegated.usd : null,
      durationDifference: valid.length ? direct.ms - delegated.ms : null, savings: status === 'VERIFIED' ? savings(direct.usd, delegated.usd) : savings(null, null), pairList: ps };
    prof.recommendation = recommend(prof);
    return prof;
  });
  return out.sort((a, b) => b.validPairs - a.validPairs || b.pairs - a.pairs);
}

const INSUFFICIENT = { decision: 'insufficient', text: 'Insufficient historical benchmark data. Using existing adaptive routing policy.', reason: null };
// Advisory only: it never changes a route. The user's model, project and agent overrides and the adaptive tier still decide.
export function recommend(p) {
  if (p.status !== 'VERIFIED') return INSUFFICIENT;
  const s = p.savings;
  if (s.usd > 0) return { decision: 'delegated', text: `Delegated ${p.agent} (${p.subModel})`, reason: 'Historical delegated execution is cheaper with comparable task quality.' };
  return { decision: 'direct', text: `Direct (${p.mainModel})`, reason: s.usd < 0 ? 'Historical direct execution is cheaper with comparable task quality.' : 'Equal historical cost; direct execution avoids the delegation overhead.' };
}

// The recommendation for one task: exact category + complexity + main model only. Several verified agents → the cheapest.
export function recommendFor(profs, { category, complexity, mainModel }) {
  const hits = profs.filter((p) => p.status === 'VERIFIED' && p.category === category && p.complexity === complexity && (!mainModel || p.mainModel === mainModel));
  if (!hits.length) return { ...INSUFFICIENT, profile: null };
  const best = hits.sort((a, b) => a.delegated.usd - b.delegated.usd)[0];
  return { ...best.recommendation, profile: best };
}

// ---------- formatting ----------
const n = (x) => (x == null ? 'unavailable' : Math.round(x).toLocaleString('en-US'));
const signed = (x, f) => (x == null ? 'unavailable' : `${x > 0 ? '+' : ''}${f(x)}`);
const rate = (s) => (s ? `${Math.round(s.rate * 100)}% (${s.evaluated} evaluated)` : 'not evaluated');
const head = (p) => `${p.category || 'unknown category'} · complexity ${p.complexity || 'unknown'} · main ${p.mainModel || 'unknown'} · delegated ${p.agent || '—'} (${p.subModel || '—'})`;

export function formatPlan(plan) {
  return ['Benchmark plan (NOT RUN — it would start 2 billed headless Claude Code sessions):',
    `- Task: ${plan.taskId} · ${plan.category} · complexity ${plan.complexity} · fingerprint ${plan.fingerprint.slice(0, 19)}…`,
    `- Source snapshot: commit ${plan.snapshot.commit} (each run gets its own fresh copy and rmc init)`,
    `- Main session model: ${plan.mainModel} · delegated agent: ${plan.agent} · order: ${plan.order.join(' → ')}${plan.priorRuns ? ` (alternated: ${plan.priorRuns} earlier run(s) of this task)` : ''}`,
    'Run it only after the user explicitly agrees to the cost: add --approve.'].join('\n');
}

export function formatBenchmarks(pairs) {
  if (!pairs.length) return 'No benchmarks yet. Create one: rmc route benchmark run --task <task.json> --main-model <id> (billed; needs --approve).';
  return ['| Benchmark | At | Origin | Task | Category | Complexity | Main model | Agent → actual model | Status |', '|---|---|---|---|---|---|---|---|---|',
    ...pairs.map((p) => `| ${p.id} | ${String(p.at).slice(0, 16).replace('T', ' ')} | ${p.origin} | ${p.taskId || '—'} | ${p.category || '—'} | ${p.complexity || '—'} | ${p.mainModel || '—'} | ${p.agent || '—'} → ${p.subModel || '—'} | ${p.status} |`),
    '', ...pairs.filter((p) => p.status !== 'valid').map((p) => `- ${p.id}: ${p.status === 'pending-evaluation' ? `evaluate both runs against the acceptance criteria: rmc route benchmark evaluate ${p.id} --side direct|delegated --completed yes|no --criteria <passed>/<total>${p.outputs.direct ? ` (outputs: ${p.outputs.direct}, ${p.outputs.delegated})` : ''}` : p.reasons.join('; ')}`)].join('\n');
}

export function formatBenchmarkReport(profs) {
  if (!profs.length) return 'BENCHMARK\nNo benchmarks yet.\n\nSAVINGS STATUS: INSUFFICIENT DATA';
  return profs.map((p) => {
    const d = p.direct, x = p.delegated;
    const lines = [`BENCHMARK — ${head(p)}`, `Pairs: ${p.pairs} · valid ${p.validPairs} · pending evaluation ${p.pendingPairs} · invalid ${p.invalidPairs} (minimum ${p.minPairs} valid pairs)`];
    if (p.validPairs) {
      lines.push(`Direct (n=${d.validRuns}): average ${usd(d.usd)} · ${n(d.tokens)} tokens (input ${n(d.input)} · output ${n(d.output)} · cache ${n(d.cache)}) · ${n(d.calls)} API calls · ${secs(d.ms)}`,
        `Delegated (n=${x.validRuns}): average ${usd(x.usd)} (main ${usd(x.mainUsd)} + subagents ${usd(x.subagentUsd)}) · ${n(x.tokens)} tokens (main ${n(x.mainTokens)} incl. overhead ${n(x.overheadTokens)} · subagents ${n(x.subagentTokens)}) · ${n(x.calls)} API calls · ${x.agentCalls?.toFixed(1)} agent calls · ${secs(x.ms)}`,
        `Cost difference (direct − delegated): ${signed(p.costDifference, usd)} · token difference: ${signed(p.tokenDifference, n)} · duration difference: ${signed(p.durationDifference, secs)}`);
    }
    lines.push(`Quality: direct success ${rate(d.success)} · delegated success ${rate(x.success)}${p.invalidPairs ? ` · ${p.pairList.filter((q) => q.quality.status === 'not comparable').length} pair(s) with unequal quality` : ''}`,
      p.status === 'VERIFIED' ? `SAVINGS STATUS: VERIFIED — ${usd(p.savings.usd)} per task (${p.savings.pct.toFixed(1)}%), ${p.savings.interpretation} · confidence ${p.confidence}`
        : `SAVINGS STATUS: ${p.status}${p.status === 'INSUFFICIENT DATA' ? ` (${p.validPairs}/${p.minPairs} valid pairs; no savings conclusion)` : ' (no pair is valid; see rmc route benchmark)'}`);
    return lines.join('\n');
  }).join('\n\n');
}

export function formatEfficiency(profs, rec, query = {}) {
  const lines = ['RM Context Efficiency Recommendation (advisory: it never changes routing; your model choice, project and agent overrides and the adaptive tier still apply)', ''];
  if (query.category) lines.push(`Task: ${query.category} · complexity ${query.complexity || 'any'}${query.mainModel ? ` · main ${query.mainModel}` : ''}`);
  if (rec) {
    if (rec.profile) {
      const p = rec.profile;
      lines.push('Historical data:', `- Direct ${p.mainModel}: average ${usd(p.direct.usd)} · ${n(p.direct.tokens)} tokens · success ${rate(p.direct.success)}`,
        `- Delegated ${p.agent} (${p.subModel}): average ${usd(p.delegated.usd)} · ${n(p.delegated.tokens)} tokens · success ${rate(p.delegated.success)}`,
        `- Comparable pairs: ${p.validPairs} (confidence ${p.confidence}) · quality: comparable`, '', `Recommendation: ${rec.text}`, `Reason: ${rec.reason}`);
    } else lines.push(rec.text);
    lines.push('');
  }
  lines.push('Historical efficiency profiles:');
  if (!profs.length) lines.push('- none (no benchmarks yet)');
  for (const p of profs) {
    lines.push(`- ${head(p)}`, `  Direct: average ${usd(p.direct.usd)} · ${n(p.direct.tokens)} tokens · ${secs(p.direct.ms)} · success ${rate(p.direct.success)}`,
      `  Delegated: average ${usd(p.delegated.usd)} · ${n(p.delegated.tokens)} tokens · ${secs(p.delegated.ms)} · success ${rate(p.delegated.success)}`,
      `  Sample size: direct ${p.direct.validRuns} · delegated ${p.delegated.validRuns} · valid pairs ${p.validPairs}/${p.pairs} → ${p.status}`,
      `  Recommendation: ${p.recommendation.decision === 'insufficient' ? 'Insufficient data' : `${p.recommendation.text} — ${p.recommendation.reason}`}`);
  }
  return lines.join('\n');
}

export const benchmarkData = (c) => { const reg = loadPricing(); const data = readBenchmarks(c); return { reg, data, pairs: data.benchmarks.map((b) => assess(reg, b, data.evaluations)), profs: profiles(reg, data) }; };
