// Adaptive model routing: picks the delegated agent's model from task category + complexity signals.
// Agent selection and model selection are separate decisions; the main session model is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, readJson, fail, now } from './util.mjs';
import { readHandoffs } from './project.mjs';

export const TIERS = ['low', 'medium', 'high'];
// Raise to high: any of these. Raise to at least medium: ambiguous, code, 2 modules. Lower to low: trivial/retrieval with no raise signal.
const HIGH = { security: 'security-sensitive', architecture: 'architectural decisions', irreversible: 'hard to reverse',
  debugging: 'deep debugging', 'cross-module': 'cross-module reasoning' };
const MEDIUM = { ambiguous: 'ambiguous requirement', code: 'modifies source code' };
const LOW = { trivial: 'small, low-risk change', retrieval: 'simple retrieval or transformation' };
export const SIGNALS = [...Object.keys(HIGH), ...Object.keys(MEDIUM), ...Object.keys(LOW), 'context', 'modules:N'];

const metricsFile = (c) => c.p('state', 'routing.jsonl');

export function loadModelConfig(c) {
  const base = readJson(path.join(PLUGIN_ROOT, 'config', 'models.json'));
  const proj = c && fs.existsSync(c.config) ? readJson(c.config) : {};
  return { ...base, routing: { ...base.routing, ...(proj.routing || {}) }, tiers: { ...base.tiers, ...(proj.tiers || {}) },
    project: proj.models || {} };
}

// Turn a configured value into something the Agent tool accepts. Full claude-* ids map to their family alias
// because Claude Code's Agent tool takes aliases; anything unsupported returns null.
function toAgentModel(value, cfg) {
  const v = String(value || '').trim();
  if (cfg.supportedModels.includes(v)) return { model: v };
  const fam = /^claude-(opus|sonnet|haiku)\b/.exec(v);
  if (fam && cfg.supportedModels.includes(fam[1])) return { model: fam[1], note: `"${v}" passed to the Agent tool as the "${fam[1]}" alias (the Agent tool accepts aliases only)` };
  return null;
}

export function parseSignals(s) {
  const out = { flags: new Set(), modules: 0 };
  for (const raw of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^modules:(\d+)$/.exec(raw);
    if (m) out.modules = Number(m[1]);
    else if (SIGNALS.includes(raw)) out.flags.add(raw);
    else fail(`Unknown signal "${raw}". Signals: ${SIGNALS.join(', ')}`);
  }
  return out;
}

export function classify(baseTier, sig) {
  const up = Object.keys(HIGH).filter((k) => sig.flags.has(k)).map((k) => HIGH[k]);
  if (sig.modules >= 3) up.push(`${sig.modules} modules affected`);
  if (up.length) return { tier: 'high', why: up };
  const mid = Object.keys(MEDIUM).filter((k) => sig.flags.has(k)).map((k) => MEDIUM[k]);
  if (sig.modules === 2) mid.push('2 modules affected');
  const down = Object.keys(LOW).filter((k) => sig.flags.has(k)).map((k) => LOW[k]);
  if (down.length && !sig.flags.has('ambiguous')) return { tier: 'low', why: down };
  if (mid.length && baseTier === 'low') return { tier: 'medium', why: mid };
  return { tier: baseTier, why: mid };
}

// opts: { agent, category, signals, model, workflow, handoff, contextReuse, escalate, reason, record }
export function route(c, opts = {}) {
  const cfg = loadModelConfig(c);
  const notes = [];
  let prev = null;
  if (opts.escalate) {
    const all = readRoutes(c);
    prev = all.find((r) => r.id === opts.escalate) || fail(`Unknown route ${opts.escalate}. See: rmc route stats`);
    const done = all.find((r) => r.escalatedFrom === prev.id);
    if (done) fail(`Route ${prev.id} was already escalated (${done.id}). Do not escalate again without new evidence; continue with ${done.id}.`);
    if (!cfg.routing.allowEscalation) fail('Escalation is disabled (routing.allowEscalation = false). Report the blocker to the user instead.');
    if (prev.source !== 'adaptive') fail(`Route ${prev.id} used a fixed model (${prev.source}); it is not escalated automatically. Ask the user before changing it.`);
    if (prev.escalations >= cfg.routing.maxEscalations) fail(`Route ${prev.id} already reached maxEscalations (${cfg.routing.maxEscalations}). Report what is blocking to the user.`);
    if (prev.tier === 'high') fail(`Route ${prev.id} is already at the high tier. Report what is blocking to the user.`);
    if (!opts.reason) fail('Escalation needs --reason "<new evidence that the task is harder than classified>".');
    if ((prev.reasons || []).includes(opts.reason)) fail('This reason was already used to escalate. Escalate only on new evidence.');
    opts.handoff = opts.handoff || prev.handoff || fail(`Escalation needs the previous agent's findings: record them with "rmc handoff add", then pass --handoff <id>.`);
    opts.agent = opts.agent || prev.agent;
    opts.category = opts.category || prev.category;
    opts.workflow = opts.workflow || prev.workflow;
  }

  const task = opts.category ? (cfg.tasks[opts.category] || fail(`Unknown category "${opts.category}". Categories: ${Object.keys(cfg.tasks).join(', ')}`)) : null;
  const agent = opts.agent || task?.agent || fail('Give --agent or --category (rmc route categories).');
  const agentDef = cfg.agents[agent] || fail(`Unknown agent ${agent}. Agents: ${Object.keys(cfg.agents).join(', ')}`);
  const sig = parseSignals(opts.signals);

  let tier = null, why = [], source, value;
  const cls = task ? classify(task.tier || cfg.routing.defaultTier, sig) : null;
  if (opts.model) { source = 'user'; value = opts.model; }
  else if (cfg.project[agent]) { source = 'project'; value = cfg.project[agent]; }
  else if (agentDef.override) { source = 'agent override'; value = agentDef.override; }
  else if (cfg.routing.enabled && task) {
    ({ tier, why } = cls);
    if (prev) { tier = TIERS[TIERS.indexOf(prev.tier) + 1]; why = [`escalated from ${prev.tier}: ${opts.reason}`]; }
    source = 'adaptive'; value = cfg.tiers[tier];
  } else { source = 'agent default'; value = agentDef.model; }

  let resolved = toAgentModel(value, cfg);
  if (!resolved) {
    const fb = cfg.tiers[cfg.routing.fallbackTier];
    resolved = toAgentModel(fb, cfg) || { model: 'inherit' };
    notes.push(`"${value}" is not a supported model (${cfg.supportedModels.join(', ')}); falling back to ${resolved.model === 'inherit' ? 'the main session model' : `the ${cfg.routing.fallbackTier} tier (${resolved.model})`}.`);
    source += ' → fallback';
  }
  if (resolved.note) notes.push(resolved.note);
  if (!tier) tier = Object.entries(cfg.tiers).find(([, v]) => toAgentModel(v, cfg)?.model === resolved.model)?.[0] || null;

  const handoff = opts.handoff ? readHandoffs(c).find((h) => h.id === opts.handoff) || fail(`Unknown hand-off ${opts.handoff}. See: rmc handoff list`) : null;
  const r = {
    id: `R-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: now(),
    workflow: opts.workflow || null, category: opts.category || null, agent, tier, complexity: source.startsWith('adaptive') ? tier : cls?.tier ?? null,
    model: resolved.model, source, reason: source.startsWith('user') ? 'Model chosen explicitly by the user' : source.startsWith('project') || source.startsWith('agent override') ? `Fixed by ${source} configuration` : task ? [task.label, ...why].join('; ') : agentDef.reason,
    signals: [...sig.flags, ...(sig.modules ? [`modules:${sig.modules}`] : [])],
    escalations: prev ? prev.escalations + 1 : 0, escalatedFrom: prev?.id || null,
    reasons: [...(prev?.reasons || []), ...(opts.reason ? [opts.reason] : [])],
    handoff: handoff?.id || null, contextReuse: Boolean(handoff || opts.contextReuse || sig.flags.has('context')),
    mainSessionModelChanged: false, notes,
  };
  // What the user is told before the delegation. It names the model being requested for the subagent; whether that model
  // actually ran is reported afterwards from the subagent transcript (post-agent hook), never inferred from this.
  const fam = (m) => /(opus|sonnet|haiku)/.exec(String(m || '').toLowerCase())?.[1] || null;
  r.sessionModel = fam(opts.sessionModel);
  r.notice = notice(roleName(agent), r.model, r.sessionModel, cfg.routing.noticeLanguage);
  if (opts.record !== false && fs.existsSync(c.manifest)) {
    fs.mkdirSync(path.dirname(metricsFile(c)), { recursive: true });
    // Metadata only: no prompts, no source code.
    const { notes: _n, notice: _t, ...meta } = r;
    fs.appendFileSync(metricsFile(c), JSON.stringify(meta) + '\n');
  }
  return { ...r, handoffDetail: handoff };
}

export const roleName = (agent) => agent.replace(/(^|-)(\w)/g, (_, d, ch) => (d ? ' ' : '') + ch.toUpperCase()).replace('Qa', 'QA');
const cap = (m) => m[0].toUpperCase() + m.slice(1);
// noticeLanguage: 'id' (default) or 'en'. A delegation on the main session's own model is not announced as a model switch.
export function notice(role, model, sessionModel, lang = 'id') {
  const en = lang === 'en';
  if (model === 'inherit') return en ? `Delegating to ${role} on the main session model.` : `Delegasi ke ${role} dengan model sesi utama.`;
  if (sessionModel && sessionModel === model) return en ? `Delegating to ${role} on ${cap(model)}, the same model as the main session (no model switch).` : `Delegasi ke ${role} dengan model ${cap(model)}, sama dengan model sesi utama (tidak ada perpindahan model).`;
  return en ? `Switching to model ${cap(model)} to act as ${role}.` : `Perpindahan ke model ${cap(model)}, karena bertugas sebagai ${role}.`;
}

export function formatRoute(r) {
  const name = roleName(r.agent);
  const model = r.model === 'inherit' ? 'main session model (pass your own alias)' : r.model[0].toUpperCase() + r.model.slice(1);
  const lines = r.notice ? [`Notice: ${r.notice}`] : [];
  if (r.tier === 'low' && !r.escalatedFrom && !r.notes.length) {
    lines.push(`RM Context Routing: ${name} · ${model} · low (${r.id})`);
  } else {
    lines.push('RM Context Routing', `- Agent: ${name}`, `- Model: ${model}`, `- Complexity: ${r.complexity ? r.complexity[0].toUpperCase() + r.complexity.slice(1) : 'n/a'} (${r.source})`, `- Reason: ${r.reason}.`);
    if (r.contextReuse) lines.push(`- Context: ${r.handoff ? `hand-off ${r.handoff} reused` : 'existing verified context reused'}.`);
    if (r.escalatedFrom) lines.push(`- Escalation: #${r.escalations}, from ${r.escalatedFrom}.`);
    lines.push(`- Route: ${r.id}`);
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  if (r.handoffDetail) {
    const h = r.handoffDetail;
    lines.push('', `Pass this hand-off to the agent and tell it to continue from these findings, not to repeat the analysis:`,
      `${h.id} ${h.from} → ${h.to}: ${h.summary}`,
      ...(h.artifacts?.length ? [`  artifacts: ${h.artifacts.join(', ')}`] : []),
      ...(h.openQuestions?.length ? [`  open questions: ${h.openQuestions.join(' | ')}`] : []));
  }
  lines.push(`Delegate with model: ${r.model === 'inherit' ? '<your own model alias>' : r.model}, in the foreground (never run_in_background), one agent at a time; wait for its result. The main session model is unchanged.`);
  return lines.join('\n');
}

export function readRoutes(c) {
  if (!fs.existsSync(metricsFile(c))) return [];
  return fs.readFileSync(metricsFile(c), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function routeStats(c) {
  const rs = readRoutes(c);
  const count = (k) => rs.reduce((m, r) => ((m[r[k] ?? 'none'] = (m[r[k] ?? 'none'] || 0) + 1), m), {});
  const wf = {};
  for (const r of rs) if (r.workflow) (wf[r.workflow] ||= new Set()).add(r.agent);
  return { routes: rs.length, byTier: count('tier'), byAgent: count('agent'), byCategory: count('category'),
    escalations: rs.filter((r) => r.escalatedFrom).length, contextReuse: rs.filter((r) => r.contextReuse).length,
    agentsPerWorkflow: Object.fromEntries(Object.entries(wf).map(([k, v]) => [k, v.size])) };
}

export function formatStats(s) {
  const kv = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  return [`Routes: ${s.routes} · escalations: ${s.escalations} · context reused: ${s.contextReuse}`,
    `By tier: ${kv(s.byTier)}`, `By agent: ${kv(s.byAgent)}`, `By category: ${kv(s.byCategory)}`,
    `Agents per workflow: ${kv(s.agentsPerWorkflow)}`].join('\n');
}

export function formatCategories(c) {
  const cfg = loadModelConfig(c);
  return ['| Category | Tier | Model | Default agent | Use for |', '|---|---|---|---|---|',
    ...Object.entries(cfg.tasks).map(([k, t]) => `| ${k} | ${t.tier || cfg.routing.defaultTier} | ${cfg.tiers[t.tier || cfg.routing.defaultTier]} | ${t.agent || "(give --agent)"} | ${t.label} |`), '',
    `Signals: ${SIGNALS.join(', ')}`,
    'high: security, architecture, irreversible, debugging, cross-module, modules:3+ · at least medium: ambiguous, code, modules:2 · low: trivial or retrieval (unless ambiguous or a high signal)'].join('\n');
}
