// Routing cost & token efficiency analytics (rmc route stats | usage | cost | report | baseline). Deterministic, no model calls.
// Inputs are metadata-only hook events (autocontext.jsonl: turn-usage, delegation) and user-declared controlled baselines
// (baselines.jsonl). Usage is read by the hooks from Claude Code transcripts (usage.mjs); prices come from
// config/pricing.json at the date of use. Nothing here estimates tokens from text, and savings are only reported
// against a baseline whose method is stated.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, readJson, fail, now } from './util.mjs';
import { TOKEN_FIELDS, totalTokens, sumField } from './usage.mjs';

export const MIN_SAMPLES = 3; // per side and per category/complexity group, for an observational estimate
export const loadPricing = () => readJson(path.join(PLUGIN_ROOT, 'config', 'pricing.json'), { records: [] });
export const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);

// ---------- pricing ----------
// The record for this exact model id (or alias) in force on the date of use: latest effectiveFrom <= date.
export function priceFor(reg, model, at) {
  const day = String(at || '').slice(0, 10);
  const hit = (reg.records || []).filter((r) => (r.model === model || r.aliases?.includes(model)) && (!r.effectiveFrom || !day || r.effectiveFrom <= day));
  return hit.sort((a, b) => String(a.effectiveFrom || '').localeCompare(String(b.effectiveFrom || ''))).pop() || null;
}

// → { usd, version } | { usd: null, reason }
export function groupCost(reg, g, at) {
  const rec = priceFor(reg, g.model, at);
  if (!rec) return { usd: null, reason: `no price for ${g.model}` };
  if (g.tier) return { usd: null, reason: `no ${g.tier} service-tier price for ${g.model}` };
  let rate = rec;
  if (g.speed) rate = g.speed === 'fast' ? rec.fast : null;
  if (!rate) return { usd: null, reason: `no ${g.speed} price for ${g.model}` };
  if (g.long && rec.longPrompt && !g.speed) rate = rec.longPrompt;
  const geo = (reg.inferenceGeoMultiplier || { global: 1 })[g.geo || 'global'];
  if (geo == null) return { usd: null, reason: `no multiplier for inference geo "${g.geo}"` };
  if (g.cacheWriteUnsplit && rate.cacheWrite5m !== rate.cacheWrite1h) return { usd: null, reason: 'cache writes without a 5m/1h split' };
  const usd = ((g.input || 0) * rate.input + (g.output || 0) * rate.output + (g.cacheWrite5m || 0) * rate.cacheWrite5m
    + (g.cacheWrite1h || 0) * rate.cacheWrite1h + (g.cacheWriteUnsplit || 0) * rate.cacheWrite5m + (g.cacheRead || 0) * rate.cacheRead) / 1e6 * geo;
  return { usd, version: rec.pricingVersion };
}

// Sum over usage groups. complete = every token was priced.
export function costOf(reg, groups = [], at) {
  const r = { usd: 0, complete: true, pricedTokens: 0, unpricedTokens: 0, versions: [], missing: [] };
  for (const g of groups) {
    const x = groupCost(reg, g, at);
    const t = totalTokens([g]);
    if (x.usd == null) { r.complete = false; r.unpricedTokens += t; if (!r.missing.includes(x.reason)) r.missing.push(x.reason); continue; }
    r.usd += x.usd; r.pricedTokens += t;
    if (!r.versions.includes(x.version)) r.versions.push(x.version);
  }
  return r;
}
export const addCost = (a, b) => ({ usd: a.usd + b.usd, complete: a.complete && b.complete, pricedTokens: a.pricedTokens + b.pricedTokens, unpricedTokens: a.unpricedTokens + b.unpricedTokens,
  versions: [...new Set([...a.versions, ...b.versions])], missing: [...new Set([...a.missing, ...b.missing])] });
export const NO_COST = { usd: 0, complete: true, pricedTokens: 0, unpricedTokens: 0, versions: [], missing: [] };

export const tokenSummary = (groups) => ({ input: sumField(groups, 'input'), output: sumField(groups, 'output'),
  cacheWrite: sumField(groups, 'cacheWrite5m') + sumField(groups, 'cacheWrite1h') + sumField(groups, 'cacheWriteUnsplit'),
  cacheRead: sumField(groups, 'cacheRead'), total: totalTokens(groups), calls: sumField(groups, 'calls') });

// ---------- one task = one prompt (turn) ----------
// Main-session usage is per turn when the prompt hook recorded the transcript offset ("task" allocation); subagent usage
// joins by prompt id. Subagent tokens live in their own transcripts and never in the main slice, so nothing is counted twice.
export function snapshot(turn, dels) {
  return { promptId: turn.promptId, sid: turn.sid || null, category: turn.category || null, decision: turn.decision || null, outcome: turn.outcome || null,
    at: turn.mainAt || turn.at, ms: turn.ms ?? null, main: turn.main || [], overhead: turn.overhead || [],
    subagents: dels.map((d) => ({ delegationId: d.delegationId || null, routeId: d.routeId || null, agent: d.agent, requested: d.requested || null, actual: d.actual || [],
      shape: d.shape || null, status: d.status || null, at: d.usage?.at || d.at, groups: d.usage?.groups || null, ms: d.ms ?? null })) };
}

// The main model of a run: the model with the most main-session API calls (null when no usage).
export const mainModelOf = (groups = []) => Object.entries(groups.reduce((m, g) => ((m[g.model] = (m[g.model] || 0) + (g.calls || 0)), m), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

// One record per correlation id: a hook firing twice (or two copies of the plugin) never doubles a route, delegation or turn.
const EVENT_KEY = { delegation: (e) => e.delegationId, 'turn-usage': (e) => e.promptId && `${e.sid}|${e.promptId}`, suggestion: (e) => e.id, 'suggestion-outcome': (e) => e.suggestionId, 'delegation-denied': () => null };
export function dedupe(events = []) {
  const seen = new Set();
  return events.filter((e) => {
    const k = EVENT_KEY[e.event]?.(e);
    if (!k) return true;
    const key = `${e.event}|${k}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function measure(reg, s) {
  const subGroups = s.subagents.flatMap((x) => x.groups || []);
  const main = costOf(reg, s.main, s.at);
  const sub = s.subagents.reduce((a, x) => addCost(a, x.groups ? costOf(reg, x.groups, x.at) : { ...NO_COST, complete: false, missing: ['subagent usage unavailable'] }), NO_COST);
  const usageComplete = s.subagents.every((x) => x.groups);
  const all = [...s.main, ...subGroups];
  return { ...s, delegated: s.subagents.length > 0, agentCalls: s.subagents.length, mainTokens: tokenSummary(s.main), subagentTokens: tokenSummary(subGroups),
    tokens: tokenSummary(all), mainCost: main, subagentCost: sub, cost: addCost(main, sub), complete: usageComplete && main.complete && sub.complete };
}

// ---------- comparison ----------
function sideOf(tasks) {
  const n = tasks.length, avg = (f) => (n ? tasks.reduce((a, t) => a + f(t), 0) / n : null);
  const ms = tasks.filter((t) => t.ms != null);
  return { tasks: n, avg: { input: avg((t) => t.tokens.input), output: avg((t) => t.tokens.output), cache: avg((t) => t.tokens.cacheRead + t.tokens.cacheWrite),
    total: avg((t) => t.tokens.total), usd: avg((t) => t.cost.usd), agentCalls: avg((t) => t.agentCalls),
    ms: ms.length ? ms.reduce((a, t) => a + t.ms, 0) / ms.length : null } };
}
export function savings(directUsd, delegatedUsd) {
  if (directUsd == null || delegatedUsd == null || !(directUsd > 0)) return { usd: null, pct: null, interpretation: 'unknown' };
  const usd = directUsd - delegatedUsd;
  const eq = Math.abs(usd) < 1e-9;
  return { usd: eq ? 0 : usd, pct: eq ? 0 : (usd / directUsd) * 100, interpretation: eq ? 'equal' : usd > 0 ? 'delegated cheaper' : 'delegated more expensive' };
}

export const side = (tasks) => sideOf(tasks);
// Observational estimate from ordinary prompts, by category + complexity (controlled pairs are benchmarks: benchmark.mjs).
// Never used for a recommendation, and always labelled as an estimate.
export function compare(reg, tasks) {
  const usable = tasks.filter((t) => t.category && t.complete && (t.delegated ? ['followed', 'other-agent'].includes(t.outcome) : t.outcome === 'direct'));
  const byKey = new Map();
  for (const t of usable) { const k = `${t.category}|${t.decision}`; (byKey.get(k) || byKey.set(k, { direct: [], delegated: [] }).get(k))[t.delegated ? 'delegated' : 'direct'].push(t); }
  const groups = [...byKey].filter(([, v]) => v.direct.length >= MIN_SAMPLES && v.delegated.length >= MIN_SAMPLES)
    .map(([k, v]) => { const [category, decision] = k.split('|'); const d = side(v.direct), x = side(v.delegated); return { category, decision, direct: d, delegated: x, savings: savings(d.avg.usd, x.avg.usd) }; });
  if (!groups.length) {
    return { method: 'unavailable', label: 'Unavailable', direct: null, delegated: null, savings: savings(null, null), groups: [],
      reason: `no category/complexity group with at least ${MIN_SAMPLES} comparable direct and ${MIN_SAMPLES} delegated prompts that have complete usage and pricing` };
  }
  // Weighted by delegated prompts per group, so the direct baseline is a like-for-like mix of categories.
  const w = groups.reduce((a, g) => a + g.delegated.tasks, 0);
  const mix = (f) => groups.reduce((a, g) => a + g.delegated.tasks * f(g), 0) / w;
  const directUsd = mix((g) => g.direct.avg.usd), delegatedUsd = mix((g) => g.delegated.avg.usd);
  const agg = (k) => ({ tasks: groups.reduce((a, g) => a + g[k].tasks, 0), avg: Object.fromEntries(Object.keys(groups[0][k].avg).map((f) => [f, groups.every((g) => g[k].avg[f] != null) ? mix((g) => g[k].avg[f]) : null])) });
  return { method: 'observational', label: 'Observational estimate (similar prompts by category and complexity, not the same task)', direct: agg('direct'), delegated: agg('delegated'),
    savings: savings(directUsd, delegatedUsd), groups };
}

// ---------- full analysis (pure: events + registry) ----------
export function analyze(rawEvents, reg = loadPricing()) {
  if (!rawEvents) return null;
  const events = dedupe(rawEvents);
  const turns = events.filter((e) => e.event === 'turn-usage');
  const dels = events.filter((e) => e.event === 'delegation');
  const delsBy = new Map();
  for (const d of dels) if (d.promptId) (delsBy.get(d.promptId) || delsBy.set(d.promptId, []).get(d.promptId)).push(d);

  // Main-session totals: per-turn records, except sessions that only have whole-session records (no turn offset):
  // there the latest record is the session's usage so far ("session-level", never presented as per-task cost).
  const sessionLevel = new Map();
  for (const t of turns) if (t.allocation === 'session' && (!sessionLevel.has(t.sid) || t.calls >= sessionLevel.get(t.sid).calls)) sessionLevel.set(t.sid, t);
  const taskTurns = turns.filter((t) => t.allocation === 'task' && !sessionLevel.has(t.sid));
  const tasks = taskTurns.map((t) => measure(reg, snapshot(t, delsBy.get(t.promptId) || []))).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const sessionRecs = [...sessionLevel.values()];
  const mainGroups = [...taskTurns.flatMap((t) => t.main || []), ...sessionRecs.flatMap((t) => t.main || [])];
  const mainCost = [...taskTurns.map((t) => costOf(reg, t.main, t.mainAt || t.at)), ...sessionRecs.map((t) => costOf(reg, t.main, t.mainAt || t.at))].reduce(addCost, NO_COST);
  const overheadGroups = taskTurns.flatMap((t) => t.overhead || []);
  const overheadCost = taskTurns.map((t) => costOf(reg, t.overhead || [], t.mainAt || t.at)).reduce(addCost, NO_COST);

  const withUsage = dels.filter((d) => d.usage?.groups);
  const subGroups = withUsage.flatMap((d) => d.usage.groups);
  const subCost = withUsage.map((d) => costOf(reg, d.usage.groups, d.usage.at || d.at)).reduce(addCost, NO_COST);

  const byModel = (recs, groupsOf, atOf) => {
    const m = {};
    for (const r of recs) for (const g of groupsOf(r)) {
      const x = (m[g.model] ||= { delegations: 0, calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: { ...NO_COST } });
      const t = tokenSummary([g]);
      x.calls += t.calls; x.input += t.input; x.output += t.output; x.cacheWrite += t.cacheWrite; x.cacheRead += t.cacheRead; x.total += t.total;
      x.cost = addCost(x.cost, costOf(reg, [g], atOf(r)));
    }
    for (const r of recs) for (const model of new Set(groupsOf(r).map((g) => g.model))) m[model].delegations++;
    return m;
  };
  const subModels = byModel(withUsage, (d) => d.usage.groups, (d) => d.usage.at || d.at);
  // Route count per actual model: routes whose delegation ran (linked by route id), counted once per route.
  for (const [model, x] of Object.entries(subModels)) x.routes = new Set(withUsage.filter((d) => d.routeId && d.usage.groups.some((g) => g.model === model)).map((d) => d.routeId)).size;
  const sum = (key, recs, groupsOf, atOf) => {
    const m = {};
    for (const r of recs) { const k = key(r); const x = (m[k] ||= { groups: [], cost: { ...NO_COST }, records: 0 }); x.records++; x.groups.push(...groupsOf(r)); x.cost = addCost(x.cost, costOf(reg, groupsOf(r), atOf(r))); }
    return Object.fromEntries(Object.entries(m).map(([k, x]) => [k, { records: x.records, tokens: tokenSummary(x.groups), cost: x.cost }]));
  };
  const role = (d) => String(d.agent).replace(/^(rmc|rm-context):/, '');
  const bySession = sum((r) => r.sid || 'unknown', [...taskTurns, ...sessionRecs, ...withUsage], (r) => (r.event === 'delegation' ? r.usage.groups : r.main || []), (r) => r.usage?.at || r.mainAt || r.at);
  const configured = {};
  for (const d of dels) { const k = `${d.requested || 'inherited'} → ${d.actual?.length ? d.actual.join('+') : 'unverified'}`; configured[k] = (configured[k] || 0) + 1; }
  const total = addCost(mainCost, subCost);
  return {
    currency: 'USD', basis: 'Anthropic API list prices (config/pricing.json); a Claude subscription plan is billed differently',
    main: { tokens: tokenSummary(mainGroups), cost: mainCost, prompts: taskTurns.length, sessionLevelSessions: sessionRecs.length,
      allocation: sessionRecs.length ? (taskTurns.length ? 'mixed' : 'session-level') : taskTurns.length ? 'per-prompt' : 'unavailable',
      models: byModel([...taskTurns, ...sessionRecs], (t) => t.main || [], (t) => t.mainAt || t.at) },
    overhead: { tokens: tokenSummary(overheadGroups), cost: overheadCost },
    subagents: { delegations: dels.length, withUsage: withUsage.length, tokens: tokenSummary(subGroups), cost: subCost,
      avgTokens: withUsage.length ? Math.round(totalTokens(subGroups) / withUsage.length) : null,
      models: subModels, configuredVsActual: configured,
      byRole: sum(role, withUsage, (d) => d.usage.groups, (d) => d.usage.at || d.at),
      byRoute: sum((d) => d.routeId, withUsage.filter((d) => d.routeId), (d) => d.usage.groups, (d) => d.usage.at || d.at),
      status: dels.reduce((m, d) => ((m[d.status || 'unknown (legacy)'] = (m[d.status || 'unknown (legacy)'] || 0) + 1), m), {}),
      byAgent: withUsage.reduce((m, d) => { const a = String(d.agent).replace(/^(rmc|rm-context):/, ''); (m[a] ||= {}); for (const x of d.actual || []) m[a][x] = (m[a][x] || 0) + 1; return m; }, {}) },
    total: { tokens: tokenSummary([...mainGroups, ...subGroups]), cost: total },
    delegatedTasks: tasks.filter((t) => t.delegated).length,
    coverage: { delegations: dels.length, verifiedModel: dels.filter((d) => d.actual?.length).length, subagentUsage: withUsage.length,
      prompts: turns.length, pricedTokens: total.pricedTokens, unpricedTokens: total.unpricedTokens, missingPrices: total.missing },
    bySession,
    comparison: compare(reg, tasks),
    tasks,
  };
}

export function routeEfficiency(c, events) {
  return analyze(events, loadPricing());
}

// ---------- routing distribution (route records + hook events) ----------
// A route is one `rmc route` call that was recorded (routing.jsonl, unique id); a suggestion is advice; a delegation is one
// Agent call (unique delegationId), however many API calls it made; a direct response is a prompt with no delegation.
const role = (a) => String(a || 'unknown').replace(/^(rmc|rm-context):/, '');
const countBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
export function distribution(routes = [], rawEvents = []) {
  const ev = dedupe(rawEvents || []);
  const rs = [...new Map(routes.map((r) => [r.id, r])).values()];
  const of = (name) => ev.filter((e) => e.event === name);
  const dels = of('delegation'), sug = of('suggestion'), turns = of('turn-usage'), denied = of('delegation-denied');
  const fg = (d) => d.shape === 'foreground' || d.shape === 'sync';
  return {
    routes: rs.length, byOrigin: countBy(rs, (r) => r.origin || 'unknown (before origin was recorded)'), byAgent: countBy(rs, (r) => r.agent),
    byTier: countBy(rs, (r) => r.tier || 'none'), resolvedModel: countBy(rs, (r) => r.model), requestedByUser: countBy(rs.filter((r) => r.requested), (r) => r.requested),
    escalations: rs.filter((r) => r.escalatedFrom).length,
    suggestions: sug.length, suggestedAgent: countBy(sug, (s) => s.agent), suggestedModel: countBy(sug, (s) => s.model),
    prompts: turns.length, directResponses: turns.filter((t) => !t.delegations).length, delegatedPrompts: turns.filter((t) => t.delegations > 0).length,
    mainModel: countBy(turns, (t) => mainModelOf(t.main) || 'unknown'),
    delegations: dels.length, delegationsByAgent: countBy(dels, (d) => role(d.agent)), requestedSubagentModel: countBy(dels, (d) => d.requested || 'inherited'),
    actualModel: countBy(dels, (d) => (d.actual?.length ? d.actual.join('+') : 'unverified')), unverified: dels.filter((d) => !d.actual?.length).length,
    status: countBy(dels, (d) => d.status || 'unknown (before status was recorded)'),
    execution: { foreground: dels.filter(fg).length, background: dels.filter((d) => d.shape === 'background').length, unknown: dels.filter((d) => !d.shape).length,
      backgroundRejected: denied.filter((e) => e.kind === 'background').length, concurrentRejected: denied.filter((e) => e.kind === 'concurrent').length },
  };
}

// ---------- formatting ----------
const n = (x) => (x == null ? 'unavailable' : Math.round(x).toLocaleString('en-US'));
export const usd = (x) => (x == null ? 'unavailable' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(Math.abs(x) < 1 ? 4 : 2)}`);
export const costText = (k) => (k.pricedTokens + k.unpricedTokens === 0 ? 'unavailable (no usage)' : k.complete ? usd(k.usd) : k.pricedTokens ? `${usd(k.usd)} for priced usage only (cost unavailable for ${n(k.unpricedTokens)} tokens: ${k.missing.join('; ')})` : `unavailable (${k.missing.join('; ')})`);
export const tok = (t) => (t.total ? `${n(t.total)} tokens (input ${n(t.input)} · output ${n(t.output)} · cache write ${n(t.cacheWrite)} · cache read ${n(t.cacheRead)}; ${n(t.calls)} API calls)` : 'unavailable');
const overheadText = (e) => (e.overhead.tokens.total ? tok(e.overhead.tokens) : e.main.prompts ? 'none recorded' : 'unavailable');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'unavailable (no usage)');
export const secs = (x) => (x == null ? 'unavailable' : `${(x / 1000).toFixed(1)} s`);
const kv = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
const sideText = (s) => `${usd(s.avg.usd)} per prompt · ${n(s.avg.total)} tokens (input ${n(s.avg.input)} · output ${n(s.avg.output)} · cache ${n(s.avg.cache)}) · ${secs(s.avg.ms)} · ${s.avg.agentCalls?.toFixed(1)} agent calls · n=${s.tasks}`;

function comparisonLines(cmp) {
  if (cmp.method === 'unavailable') return [`- Observational estimate: unavailable — ${cmp.reason}.`];
  const s = cmp.savings;
  return [`- ${cmp.label}`, `- Direct prompts: ${sideText(cmp.direct)}`, `- Delegated prompts: ${sideText(cmp.delegated)}`,
    `- Estimated difference: ${s.usd == null ? 'unknown' : `${usd(s.usd)} per prompt (${s.pct.toFixed(1)}%) — ${s.interpretation}`} [observational estimate, not verified savings; not used for recommendations]`,
    ...cmp.groups.map((g) => `  · ${g.category} (${g.decision}): direct ${usd(g.direct.avg.usd)} (n=${g.direct.tasks}) vs delegated ${usd(g.delegated.avg.usd)} (n=${g.delegated.tasks})`)];
}

function modelTable(models, count = 'Delegations', routes = false) {
  const rows = Object.entries(models);
  if (!rows.length) return ['(no verified usage)'];
  return [`| Model (actual) |${routes ? ' Routes |' : ''} ${count} | API calls | Input | Output | Cache write | Cache read | Estimated cost |`, `|---|${routes ? '---:|' : ''}---:|---:|---:|---:|---:|---:|---:|`,
    ...rows.map(([m, x]) => `| ${m} |${routes ? ` ${x.routes} |` : ''} ${x.delegations} | ${n(x.calls)} | ${n(x.input)} | ${n(x.output)} | ${n(x.cacheWrite)} | ${n(x.cacheRead)} | ${x.cost.complete ? usd(x.cost.usd) : 'unavailable'} |`)];
}
const usageTable = (title, rows) => (rows.length ? [title, `| Key | Records | Tokens | Input | Output | Cache write | Cache read | Est. cost |`, '|---|---:|---:|---:|---:|---:|---:|---:|',
  ...rows.map(([k, x]) => `| ${k} | ${x.records} | ${n(x.tokens.total)} | ${n(x.tokens.input)} | ${n(x.tokens.output)} | ${n(x.tokens.cacheWrite)} | ${n(x.tokens.cacheRead)} | ${x.cost.complete ? usd(x.cost.usd) : 'unavailable'} |`), ''] : []);

function coverageLines(e) {
  const v = e.coverage;
  return [`- Actual model verified: ${v.verifiedModel}/${v.delegations} delegations`,
    `- Token usage available: subagents ${v.subagentUsage}/${v.delegations} delegations · main session ${e.main.prompts} prompt(s) with per-prompt usage${e.main.sessionLevelSessions ? ` + ${e.main.sessionLevelSessions} session(s) session-level only` : ''}`,
    `- Pricing available: ${pct(v.pricedTokens, v.pricedTokens + v.unpricedTokens)} of tokens${v.missingPrices.length ? ` (missing: ${v.missingPrices.join('; ')})` : ''}`];
}

export function formatDistribution(d) {
  return ['Routing distribution:',
    `- Route executions (rmc route, recorded): ${d.routes} · escalations ${d.escalations}`,
    `- By source: ${kv(d.byOrigin)}`, `- By agent: ${kv(d.byAgent)}`, `- By tier: ${kv(d.byTier)}`,
    `- Resolved model (route): ${kv(d.resolvedModel)} · requested by the user: ${kv(d.requestedByUser)}`,
    `- Suggestions: ${d.suggestions} (not routes) · suggested agent: ${kv(d.suggestedAgent)}`,
    `- Prompts with usage: ${d.prompts} · direct responses: ${d.directResponses} · delegated: ${d.delegatedPrompts} · main session model (actual): ${kv(d.mainModel)}`,
    `- Delegations: ${d.delegations} (one per Agent call) · by agent: ${kv(d.delegationsByAgent)}`,
    `- Requested subagent model: ${kv(d.requestedSubagentModel)} · actual model (transcript): ${kv(d.actualModel)}`,
    `- Execution: foreground ${d.execution.foreground} · background ${d.execution.background} · mode unknown ${d.execution.unknown} · background rejected ${d.execution.backgroundRejected} · concurrent rejected ${d.execution.concurrentRejected}`,
    `- Status: ${kv(d.status)} · unverified actual model: ${d.unverified}`].join('\n');
}

// Compact block for rmc route stats.
export function formatEfficiencyBlock(e) {
  if (!e) return 'Routing efficiency: unavailable (no hook telemetry recorded in this project yet).';
  return ['Routing efficiency (actual usage from Claude Code transcripts; cost estimated at API list prices):',
    `- Main session tokens: ${e.main.allocation === 'unavailable' ? 'unavailable' : `${n(e.main.tokens.total)} (${e.main.allocation})`}`,
    `- Subagent tokens: ${e.subagents.withUsage ? `${n(e.subagents.tokens.total)} over ${e.subagents.withUsage} delegation(s) with usage · average ${n(e.subagents.avgTokens)}` : `unavailable (${e.subagents.delegations} delegation(s), none with recorded usage)`}`,
    `- Delegated prompts: ${e.delegatedTasks}`,
    `- Verified subagent models: ${Object.entries(e.subagents.models).map(([m, x]) => `${m} ×${x.delegations}`).join(' · ') || 'none'}`,
    `- Estimated total cost: ${costText(e.total.cost)}`,
    `- Cost data coverage: ${e.coverage.pricedTokens + e.coverage.unpricedTokens ? `${pct(e.coverage.pricedTokens, e.coverage.pricedTokens + e.coverage.unpricedTokens)} of tokens priced` : 'unavailable (no usage)'}`,
    'Direct vs delegated: rmc route benchmark report · rmc route efficiency', 'Details: rmc route usage · rmc route cost · rmc route report'].join('\n');
}

export function formatUsage(e, { limit = 20 } = {}) {
  if (!e) return 'Token usage: unavailable (no hook telemetry recorded in this project yet).';
  const rows = e.tasks.slice(-limit);
  const top = (o) => Object.entries(o).sort((a, b) => b[1].tokens.total - a[1].tokens.total).slice(0, limit);
  return ['Token usage (actual, from Claude Code transcripts; prompt text is never stored):',
    `Main session: ${tok(e.main.tokens)} · allocation ${e.main.allocation}`,
    `  of which delegation-issuing calls (Agent tool, rmc route): ${overheadText(e)} — already included in the main session`,
    `Subagents: ${tok(e.subagents.tokens)}`, `Total: ${tok(e.total.tokens)}`, '',
    ...usageTable('By session (main session + subagents):', top(e.bySession)),
    ...usageTable('By agent (subagent usage):', top(e.subagents.byRole)),
    ...usageTable('By route (subagent usage of delegations linked to an rmc route id):', top(e.subagents.byRoute)),
    'Subagent usage by actual model: rmc route cost', '',
    rows.length ? `Last ${rows.length} prompt(s):` : 'No per-prompt usage recorded yet.',
    ...(rows.length ? ['| Prompt | At | Category | Outcome | Main tokens | Subagent tokens | Agents | Duration | Est. cost |', '|---|---|---|---|---:|---:|---:|---:|---:|',
      ...rows.map((t) => `| ${t.promptId} | ${String(t.at).slice(0, 16).replace('T', ' ')} | ${t.category || '—'} | ${t.outcome || '—'} | ${n(t.mainTokens.total)} | ${t.delegated ? (t.subagents.every((s) => s.groups) ? n(t.subagentTokens.total) : `${n(t.subagentTokens.total)} (partial)`) : '0'} | ${t.agentCalls} | ${secs(t.ms)} | ${t.complete ? usd(t.cost.usd) : 'unavailable'} |`)] : [])].join('\n');
}

export function formatCost(e) {
  if (!e) return 'Cost: unavailable (no hook telemetry recorded in this project yet).';
  return [`Estimated cost (${e.currency}, ${e.basis}):`,
    `- Main session: ${costText(e.main.cost)}${e.main.allocation === 'session-level' ? ' [session-level, not per task]' : ''}`,
    `  of which delegation-issuing calls: ${costText(e.overhead.cost)} (included above)`,
    `- Subagents: ${costText(e.subagents.cost)}`, `- Total estimated cost: ${costText(e.total.cost)}`,
    `- Pricing coverage: ${pct(e.coverage.pricedTokens, e.coverage.pricedTokens + e.coverage.unpricedTokens)} of tokens priced${e.coverage.missingPrices.length ? ` (missing: ${e.coverage.missingPrices.join('; ')})` : ''} · pricing versions: ${[...new Set([...e.total.cost.versions])].join(', ') || 'none'}`, '',
    'Main session models (actual):', ...modelTable(e.main.models, 'Prompts'), '',
    'Subagent models (actual, subagent transcripts):', ...modelTable(e.subagents.models, 'Delegations', true), '',
    'Requested → actual model, per delegation:', ...(Object.entries(e.subagents.configuredVsActual).map(([k, v]) => `- ${k}: ${v}`).concat(Object.keys(e.subagents.configuredVsActual).length ? [] : ['- none']))].join('\n');
}

// extra: sections appended by the caller (routing distribution, benchmark, recommendation).
export function formatReport(e, { before = [], after = [] } = {}) {
  if (!e) return ['RM Context Routing Efficiency: unavailable (no hook telemetry recorded in this project yet).', ...before, ...after].join('\n\n');
  const agents = Object.entries(e.subagents.byAgent);
  return ['RM Context Routing Efficiency', `All token counts are actual (Claude Code transcripts). Every cost is an estimate: ${e.basis}.`, '',
    ...before.flatMap((b) => [b, '']),
    'Main session:', `- Model (actual): ${Object.keys(e.main.models).join(', ') || 'unavailable'}`, `- Usage: ${tok(e.main.tokens)} · allocation ${e.main.allocation}`, '',
    'Delegations (actual model):', ...(agents.length ? agents.map(([a, m]) => `- ${a}: ${Object.entries(m).map(([k, v]) => `${k} ×${v}`).join(', ') || 'unverified'}`) : ['- none with usage']), '',
    'Usage:', `- Main session: ${tok(e.main.tokens)}`, `- Subagents: ${tok(e.subagents.tokens)}`, `- Total: ${tok(e.total.tokens)}`,
    `- Delegation-issuing main-session calls (overhead, included in main session): ${overheadText(e)}`, '',
    'Cost:', `- Main session: ${costText(e.main.cost)}`, `- Subagents: ${costText(e.subagents.cost)}`, `- Total estimated cost: ${costText(e.total.cost)}`, '',
    'Model distribution (subagents, actual):', ...modelTable(e.subagents.models, 'Delegations', true), '',
    'Ordinary prompts, direct vs delegated:', ...comparisonLines(e.comparison), '',
    ...after.flatMap((b) => [b, '']),
    'Data coverage:', ...coverageLines(e)].join('\n');
}
