// Adaptive model routing: picks the delegated agent's model from its role, the task category and complexity signals.
// Complexity tier (low/medium/high), model family (haiku/sonnet/opus) and agent role are separate: each role's policy in
// config/models.json "roles" maps a tier to a model, so high complexity is not Opus by itself. The main session model is
// never touched and never used as a subagent model unless the user names it.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, readJson, fail, now, readHandoffs } from './util.mjs';
import { currentTurn, updateTurn } from './delegation.mjs';

export const TIERS = ['low', 'medium', 'high'];
// Raise to high: any of these. Raise to at least medium: ambiguous, code, 2 modules. Lower to low: trivial/retrieval with no raise signal.
const HIGH = { security: 'security-sensitive', architecture: 'architectural decisions', irreversible: 'hard to reverse',
  debugging: 'deep debugging', 'cross-module': 'cross-module reasoning' };
const MEDIUM = { ambiguous: 'ambiguous requirement', code: 'modifies source code', sensitive: 'auth, payment or sensitive data' };
const LOW = { trivial: 'small, low-risk change', retrieval: 'simple retrieval or transformation' };
export const SIGNALS = [...Object.keys(HIGH), ...Object.keys(MEDIUM), ...Object.keys(LOW), 'context', 'modules:N'];

const metricsFile = (c) => c.p('state', 'routing.jsonl');

export function loadModelConfig(c) {
  const base = readJson(path.join(PLUGIN_ROOT, 'config', 'models.json'));
  const proj = c && fs.existsSync(c.config) ? readJson(c.config) : {};
  const roles = { ...(base.roles || {}) };
  for (const [a, r] of Object.entries(proj.roles || {})) roles[a] = { ...(roles[a] || {}), ...r };
  return { ...base, routing: { ...base.routing, ...(proj.routing || {}) }, tiers: { ...base.tiers, ...(proj.tiers || {}) },
    projectTiers: proj.tiers || {}, roles, project: proj.models || {} };
}

// The role policy's model for a complexity tier. A project-wide tier mapping (config.json "tiers") is a project override
// and wins. A role's "deep" model (Opus) applies only at the high tier, when one of its conditions holds ("a+b" = all of
// a, b; the category counts as a condition), and, if the policy lists categories, only for those categories.
export function roleModel(cfg, agent, tier, sig = { flags: new Set(), modules: 0 }, category = null) {
  if (cfg.projectTiers?.[tier]) return { value: cfg.projectTiers[tier], basis: `project tier mapping: ${tier} → ${cfg.projectTiers[tier]}`, deep: false };
  const pol = cfg.roles?.[agent];
  if (!pol?.[tier]) return { value: cfg.tiers[tier], basis: `tier mapping: ${tier} → ${cfg.tiers[tier]}`, deep: false };
  const d = pol.deep;
  if (tier === 'high' && d?.model && (!d.categories || d.categories.includes(category))) {
    const have = new Set([...sig.flags, ...(sig.modules >= 3 ? ['cross-module'] : []), ...(category ? [category] : [])]);
    const hit = (d.when || []).find((w) => w.split('+').every((t) => have.has(t)));
    if (hit) return { value: d.model, basis: `${agent} role policy: high + ${hit} → ${d.model}`, deep: true };
  }
  return { value: pol[tier], basis: `${agent} role policy: ${tier} → ${pol[tier]}`, deep: false };
}
const RANK = { haiku: 1, sonnet: 2, opus: 3 };
// The next stronger model this role allows (its tier models, then its deep model); null when it already runs the strongest.
function strongerModel(cfg, agent, current) {
  const pol = cfg.roles?.[agent];
  const ladder = pol ? [...TIERS.map((t) => cfg.projectTiers?.[t] || pol[t]), pol.deep?.model] : TIERS.map((t) => cfg.tiers[t]);
  return ladder.filter(Boolean).map((v) => toAgentModel(v, cfg)?.model).find((m) => (RANK[m] || 0) > (RANK[current] || 0)) || null;
}
// A failure caused by missing information is fixed with context, not a bigger model.
const CONTEXT_GAP = /\b(?:missing|lack(?:s|ed|ing)?|no|not enough|insufficient|without)\b.{0,30}\b(?:context|information|info|knowledge|details?|access|hand-?off)\b|\bcontext gap\b|\bkurang (?:konteks|informasi|context|info)\b|\btidak ada (?:konteks|informasi)\b|\bbelum ada (?:konteks|informasi)\b/i;
export const isContextGap = (reason) => CONTEXT_GAP.test(String(reason || ''));

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

// opts: { agent, category, signals, model, sessionModel, workflow, handoff, contextReuse, escalate, reason, record, suggested, origin }
export function route(c, opts = {}) {
  const cfg = loadModelConfig(c);
  const notes = [];
  let prev = null;
  // The current prompt's turn (RMC_SESSION_ID is exported to Bash by the SessionStart hook). Read only for real routes.
  const sid = process.env.RMC_SESSION_ID;
  const turn = sid && (opts.record !== false || opts.suggested) ? currentTurn(sid, c.root) : null;
  if (opts.suggested) {
    // Reuse the classification the prompt hook already made for this session and prompt; never an older prompt's.
    const s = turn?.suggestion || fail('No current RM Context suggestion for this session and prompt (suggestions expire with their prompt and are never reused across sessions). Classify explicitly: rmc route --category <c> [--signals …]');
    opts.category = opts.category || s.category;
    opts.signals = opts.signals || s.signals.join(',');
  }
  if (opts.escalate) {
    const all = readRoutes(c);
    prev = all.find((r) => r.id === opts.escalate) || fail(`Unknown route ${opts.escalate}. See: rmc route stats`);
    const done = all.find((r) => r.escalatedFrom === prev.id);
    if (done) fail(`Route ${prev.id} was already escalated (${done.id}). Do not escalate again without new evidence; continue with ${done.id}.`);
    if (!cfg.routing.allowEscalation) fail('Escalation is disabled (routing.allowEscalation = false). Report the blocker to the user instead.');
    if (prev.source !== 'adaptive') fail(`Route ${prev.id} used a fixed model (${prev.source}); it is not escalated automatically. Ask the user before changing it.`);
    if (prev.escalations >= cfg.routing.maxEscalations) fail(`Route ${prev.id} already reached maxEscalations (${cfg.routing.maxEscalations}). Report what is blocking to the user.`);
    if (!opts.reason) fail('Escalation needs --reason "<new evidence that the task is harder than classified>".');
    if (isContextGap(opts.reason)) fail(`"${opts.reason}" is missing context, not a reasoning limit. Retry on ${prev.model} with the missing context (rmc find …, the previous hand-off) instead of escalating.`);
    if (!strongerModel(cfg, prev.agent, prev.model)) fail(`Route ${prev.id} already runs ${prev.model}, the strongest model the ${roleName(prev.agent)} role allows. Report what is blocking to the user.`);
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

  // Precedence: explicit user model → project override → agent override → role policy (complexity tier + signals) →
  // agent default. The main session model is not in this list: it is only used for the notice and the 'inherit' fallback.
  let tier = null, why = [], source, value, basis;
  const cls = task ? classify(task.tier || cfg.routing.defaultTier, sig) : null;
  if (opts.model) { source = 'user'; value = opts.model; basis = 'explicit user model'; }
  else if (cfg.project[agent]) { source = 'project'; value = cfg.project[agent]; basis = `project override (config.json models.${agent})`; }
  else if (agentDef.override) { source = 'agent override'; value = agentDef.override; basis = 'agent override (config/models.json)'; }
  else if (cfg.routing.enabled && task) {
    ({ tier, why } = cls);
    if (prev) {
      tier = TIERS[Math.min(TIERS.indexOf(prev.tier) + 1, TIERS.length - 1)] || 'high';
      value = strongerModel(cfg, agent, prev.model);
      why = [`escalated from ${prev.model}: ${opts.reason}`]; basis = `escalation: ${prev.model} → ${value}`;
    } else ({ value, basis } = roleModel(cfg, agent, tier, sig, opts.category));
    source = 'adaptive';
  } else { source = 'agent default'; value = agentDef.model; basis = `${agent} default model`; }

  let resolved = toAgentModel(value, cfg);
  if (!resolved) {
    const fb = cfg.tiers[cfg.routing.fallbackTier];
    resolved = toAgentModel(fb, cfg) || { model: 'inherit' };
    notes.push(`"${value}" is not a supported model (${cfg.supportedModels.join(', ')}); falling back to ${resolved.model === 'inherit' ? 'the main session model' : `the ${cfg.routing.fallbackTier} tier (${resolved.model})`}.`);
    source += ' → fallback';
  }
  if (resolved.note) notes.push(resolved.note);
  if (!tier) tier = cls?.tier ?? null; // complexity tier only; never derived from the model

  const handoff = opts.handoff ? readHandoffs(c).find((h) => h.id === opts.handoff) || fail(`Unknown hand-off ${opts.handoff}. See: rmc handoff list`) : null;
  const r = {
    id: `R-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: now(),
    workflow: opts.workflow || null, category: opts.category || null, agent, tier, complexity: source.startsWith('adaptive') ? tier : cls?.tier ?? null,
    model: resolved.model, source, basis, reason: source.startsWith('user') ? 'Model chosen explicitly by the user' : source.startsWith('project') || source.startsWith('agent override') ? `Fixed by ${source} configuration` : task ? [task.label, ...why, basis].join('; ') : agentDef.reason,
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
  // Where the route came from (telemetry only; it never changes the model): suggested routing, a workflow step, a slash
  // command (commands pass --origin command), or manual. An escalation keeps the origin of the route it escalates.
  r.origin = prev?.origin || (opts.suggested ? 'suggested' : opts.workflow ? 'workflow' : opts.origin === 'command' ? 'command' : 'manual');
  r.requested = opts.model || null; // the model the user asked for explicitly; r.model is the resolved one
  r.promptId = turn?.id || null;
  r.suggestionId = turn?.suggestion?.id || null;
  r.followsSuggestion = turn?.suggestion ? turn.suggestion.agent === agent : null;
  if (opts.record !== false && fs.existsSync(c.manifest)) {
    fs.mkdirSync(path.dirname(metricsFile(c)), { recursive: true });
    // Metadata only: no prompts, no source code.
    const { notes: _n, notice: _t, ...meta } = r;
    fs.appendFileSync(metricsFile(c), JSON.stringify(meta) + '\n');
    if (turn) updateTurn(sid, c.root, (t) => { t.route = { id: r.id, agent }; });
  }
  return { ...r, handoffDetail: handoff };
}

// ---------- automatic suggestion for ordinary prompts ----------
// Deterministic keyword rules (English + Indonesian) turn a prompt into a task category and complexity signals; the
// existing route() then picks agent and model with the usual precedence. No model calls, no scanning, prompt never stored.
// Rule order breaks ties; otherwise the intent that appears first in the prompt wins (usually its main verb). The generic
// investigation rule (last) applies only when no specific intent matched.
const RX = {
  architecture: /\barchitect(?:ure|ural)?\b|arsitektur|system design|desain sistem/i,
  security: /\bsecurity\b|vulnerab|keamanan|\b(?:xss|csrf|sql injection|privilege escalation)\b/i,
  debugging: /\bdebug|root cause|akar masalah|stack ?trace|race condition|memory leak|deadlock|intermittent|\b(?:why|kenapa|mengapa)\b.{0,80}\b(?:fails?|failing|errors?|crash\w*|broken|gagal|rusak|lambat|slow)\b/i,
};
const RULES = [
  ['architecture', RX.architecture],
  ['security', RX.security],
  ['refactor', /\brefactor|restructur|\bre-?architect|rewrite the\b/i],
  ['migration', /\bmigrat(?:e|ion)|\bmigrasi/i],
  ['debugging', RX.debugging],
  ['impact', /\bimpact\b|\bdampak|blast radius|what (?:would|will) break|terpengaruh/i],
  ['code-review', /\breview\b|\baudit\b|code quality|kualitas kode|periksa implementasi/i],
  ['infra-design', /infra(?:structure)? (?:architecture|design)|arsitektur infra/i],
  ['ci-cd', /\bdocker|ci\/cd|\bpipeline\b|\bdeploy|kubernetes|\bk8s\b|\bhelm\b|\bnginx\b/i],
  ['brd', /\bbrd\b/i], ['fsd', /\bfsd\b/i], ['sipoc', /\bsipoc\b/i], ['srs', /\bsrs\b/i], ['erd', /\berd\b/i], ['uml', /\buml\b|sequence diagram/i],
  ['adr', /\badr\b|decision record/i], ['rtm', /\brtm\b|traceability/i], ['gantt', /\bgantt\b/i], ['wbs', /\bwbs\b/i], ['roadmap', /\broadmap\b/i],
  ['business-analysis', /business (?:flow|process|rule|logic)|alur bisnis|proses bisnis|aturan bisnis|logika bisnis|\brequirements?\b|kebutuhan bisnis|user stor/i],
  ['doc-update', /\bdocumentation\b|\bdokumentasi\b|^document (?:the|this|our)\b|^dokumentasikan\b/i],
  ['system-analysis', /\bapis?\b|\bendpoints?\b|\bdatabase\b|\bschema\b|\btables?\b|\btabel\b|\bintegrat|\bintegrasi|data model|data flow|alur data/i],
  ['qa', /test cases?|test plan|acceptance criteria|\bverif(?:y|ikasi)\b|regression|\bunit tests?\b|\btes unit\b|\bbuat(?:kan)? (?:\w+ )?(?:test|tes)\b|\btambah(?:kan)? (?:\w+ )?(?:test|tes)\b/i],
  ['plan', /\bsprint\b|\btimeline\b|\bmilestone|project plan|rencana proyek/i],
  ['small-feature', /\bimplement|add (?:a |the )?feature|new feature|\btambah(?:kan)? fitur|fitur baru|\bbuild (?:a|the)\b|\b(?:buat(?:kan)?|tambah(?:kan)?) (?:\w+ )?(?:endpoint|api|fitur|halaman|fungsi|method|kolom|field|controller|service)\b/i],
  ['bug-fix', /\bbug\b|\bfix\b|\bperbaiki|\bbenerin/i],
  ['search', /\binvestigat|\binvestigasi|\btelusuri|\btrace (?:the|how)\b|\bhow does\b.{0,60}\b(?:work|flow)|bagaimana\b.{0,60}\b(?:bekerja|berjalan|alur|mengalir)|\bwhere\b.{0,60}\b(?:used|called)\b|(?:dipakai|digunakan|dipanggil) di ?mana|\banaly[sz]|\banalis[ia]s?\b|\banalisa\b|\balur\b|\bflow\b/i],
];
const SIGNAL_RX = {
  'cross-module': /cross[- ](?:module|service|cutting)|lintas (?:modul|service|layanan|domain)|\bacross\b.{0,40}\b(?:modules|services|domains|layers|system|codebase)\b|\b(?:between|antara)\b.{0,40}\b(?:modules|services|modul|layanan)\b|\b(?:multiple|several|many|beberapa|banyak) (?:modules|services|domains|modul|service|layanan|domain)\b|microservices|end[- ]to[- ]end|seluruh (?:sistem|modul|codebase)/i,
  architecture: RX.architecture, security: RX.security, debugging: RX.debugging,
  irreversible: /\b(?:drop|truncate) (?:table|column|database)|data loss|production data|data produksi|irreversible/i,
  code: /\bimplement|\brefactor|\bmodify\b|\bfix\b|\bperbaiki|ubah kode|tulis kode/i,
  sensitive: /\bauth(?:entication|orization|n|z)?\b|\blogin\b|\bpasswords?\b|\bpayments?\b|pembayaran|\bpii\b|personal data|data pribadi|sensitive data|data sensitif|\bcredentials?\b|kredensial|threat model|\boauth|\bjwt\b|\brbac\b|hak akses|otorisasi|autentikasi/i,
};
const GREETING = /^(?:hi|hello|hey|halo|hai|thanks|thank you|terima kasih|makasih|ok(?:ay)?|sip|good (?:morning|afternoon|evening|night)|selamat (?:pagi|siang|sore|malam))\b/i;
const GENERAL = /^(?:what (?:is|are)|apa (?:itu|arti|bedanya)|define|definisi|explain what|jelaskan apa itu)\b/i;
const SIMPLE_LOOKUP = /^(?:where (?:is|are)|where's|di ?mana(?:kah)?|which file|file mana|show me|tampilkan|find|cari(?:kan)?|open|buka)\b/i;
const PROJECT_REF = /\b(?:this|our|the) (?:project|repo|repository|codebase|system|app|application|service|module)s?\b|\b(?:project|proyek|repo|codebase|sistem|aplikasi|modul) (?:ini|kita)\b|\bdi (?:project|proyek|repo|codebase|sini)\b|\b(?:modules?|modul|controllers?|services?|repositor(?:y|ies)|endpoints?|handlers?|migrations?|middleware)\b/i;
const IDENT = /\b[a-z]+[A-Z]\w*|\b[A-Z][a-z]+[A-Z]\w*|\b[a-z]+_[a-z_]+\b|\b[\w-]+\/[\w./-]+|\.(?:m?[jt]sx?|php|py|cs|java|kt|go|rb|rs|sql|vue|json|ya?ml)\b/;

// Returns { decision: 'direct' | 'suggest' | 'complex', category, signals, confidence, why }. hits = retrieval hits for the prompt.
export function classifyPrompt(prompt, { hits = 0, projectName } = {}) {
  const p = String(prompt || '').trim();
  const words = p.split(/\s+/).filter(Boolean).length;
  const direct = (why) => ({ decision: 'direct', category: null, signals: [], confidence: 0, why });
  if (!p || p.startsWith('/') || words < 4) return direct('too short or a command');
  if (GREETING.test(p) && words < 12) return direct('greeting or small talk');
  const name = String(projectName || '').trim().toLowerCase();
  const ref = PROJECT_REF.test(p) || IDENT.test(p) || (name.length >= 3 && p.toLowerCase().includes(name));
  if (GENERAL.test(p) && !ref) return direct('general knowledge question');
  let best = null;
  const pick = (rules) => { for (const [category, rx] of rules) { const m = rx.exec(p); if (m && (!best || m.index < best.index)) best = { category, index: m.index }; } };
  pick(RULES.slice(0, -1));
  if (!best) pick(RULES.slice(-1));
  if (!best) return direct('no project-task intent');
  const signals = Object.keys(SIGNAL_RX).filter((k) => SIGNAL_RX[k].test(p));
  let { category } = best;
  if (SIMPLE_LOOKUP.test(p) && words <= 12 && category === 'search' && !signals.length) return direct('simple lookup');
  // An investigation or feature that spans modules or the architecture is the complex variant of that task.
  if (['search', 'system-analysis'].includes(category) && (signals.includes('cross-module') || signals.includes('architecture'))) category = 'architecture';
  if (category === 'small-feature' && (signals.includes('cross-module') || signals.includes('architecture'))) category = 'complex-feature';
  if (category === 'search' && signals.includes('debugging')) category = 'debugging';
  const confidence = Math.round((0.5 + (ref ? 0.3 : 0) + Math.min(0.2, 0.1 * hits)) * 100) / 100;
  return { decision: 'suggest', category, signals: signals.filter((s) => s !== category), confidence, why: `intent "${best.category}"${ref ? ', project reference' : ''}${hits ? `, ${hits} knowledge hit(s)` : ''}` };
}

// The short context line injected for one prompt, or null. Never forces a delegation; Claude may answer directly.
export function suggestForPrompt(c, prompt, { sessionModel, hits = 0 } = {}) {
  const cfg = loadModelConfig(c);
  if (!cfg.routing.enabled || cfg.routing.autoSuggest === false) return null;
  const k = classifyPrompt(prompt, { hits, projectName: readJson(c.manifest, {}).project?.name });
  if (k.decision === 'direct' || k.confidence < (cfg.routing.suggestMinConfidence ?? 0.7)) return null;
  let r;
  try { r = route(c, { category: k.category, signals: k.signals.join(','), sessionModel, record: false }); } catch { return null; }
  const decision = r.tier === 'high' ? 'complex' : 'suggest';
  const fam = /(opus|sonnet|haiku)/.exec(String(sessionModel || '').toLowerCase())?.[1];
  const model = r.model === 'inherit' ? 'main session model' : cap(r.model) + (fam === r.model ? ', same as the main session' : '');
  const label = (cfg.tasks[k.category]?.label || k.category).replace(/^./, (x) => x.toLowerCase());
  const text = `RM Context suggests ${roleName(r.agent)} (${model}) for this ${label}. To delegate: rmc route --suggested --session-model <id>, show its Notice, run it in the foreground. Simple? Answer directly.`;
  return { id: `S-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, decision, category: k.category, signals: k.signals,
    confidence: k.confidence, agent: r.agent, model: r.model, tier: r.tier, text };
}

export const roleName = (agent) => agent.replace(/(^|-)(\w)/g, (_, d, ch) => (d ? ' ' : '') + ch.toUpperCase()).replace('Qa', 'QA');
const cap = (m) => m[0].toUpperCase() + m.slice(1);
// noticeLanguage: 'id' (default) or 'en'. A delegation on the main session's own model is not announced as a model switch.
export function notice(role, model, sessionModel, lang = 'id') {
  const en = lang === 'en';
  if (model === 'inherit') return en ? `Delegating to ${role} on the main session model.` : `Delegasi ke ${role} dengan model sesi utama.`;
  if (sessionModel && sessionModel === model) return en ? `Delegating to ${role} with ${cap(model)}, same as the main session model.` : `Delegasi ke ${role} dengan model ${cap(model)}, sama dengan model sesi utama (tidak ada perpindahan model).`;
  return en ? `Switching to ${cap(model)}, acting as ${role}.` : `Perpindahan ke model ${cap(model)}, karena bertugas sebagai ${role}.`;
}

export function formatRoute(r) {
  const name = roleName(r.agent);
  const model = r.model === 'inherit' ? 'main session model (pass your own alias)' : r.model[0].toUpperCase() + r.model.slice(1);
  const lines = r.notice ? [`Notice: ${r.notice}`] : [];
  if (r.tier === 'low' && !r.escalatedFrom && !r.notes.length) {
    lines.push(`RM Context Routing: ${name} · ${model} · low (${r.id})`);
  } else {
    lines.push('RM Context Routing', `- Agent: ${name}`, `- Model: ${model}${r.basis ? ` (${r.basis})` : ''}`, `- Complexity: ${r.complexity ? r.complexity[0].toUpperCase() + r.complexity.slice(1) : 'n/a'} (${r.source})`, `- Reason: ${r.reason}.`);
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

// Hook events (autocontext.jsonl): suggestion, suggestion-outcome, delegation, delegation-denied, turn-usage. null when never recorded.
export function hookEvents(c) {
  const f = c.p('state', 'autocontext.jsonl');
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function routeStats(c) {
  const rs = readRoutes(c);
  const count = (k) => rs.reduce((m, r) => ((m[r[k] ?? 'none'] = (m[r[k] ?? 'none'] || 0) + 1), m), {});
  const wf = {};
  for (const r of rs) if (r.workflow) (wf[r.workflow] ||= new Set()).add(r.agent);
  const base = { routes: rs.length, byTier: count('tier'), byAgent: count('agent'), byCategory: count('category'),
    escalations: rs.filter((r) => r.escalatedFrom).length, contextReuse: rs.filter((r) => r.contextReuse).length,
    agentsPerWorkflow: Object.fromEntries(Object.entries(wf).map(([k, v]) => [k, v.size])) };
  const ev = hookEvents(c);
  if (!ev) return { ...base, suggestions: null, delegations: null };
  const of = (name) => ev.filter((e) => e.event === name);
  const sug = of('suggestion'), out = of('suggestion-outcome'), del = of('delegation'), denied = of('delegation-denied');
  const outcome = (o) => out.filter((e) => e.outcome === o).length;
  const resolved = new Set(out.map((e) => e.suggestionId));
  return { ...base,
    // A suggestion counts as followed only when the suggested agent actually ran during the same prompt (session + prompt id).
    suggestions: { generated: sug.length, complex: sug.filter((e) => e.decision === 'complex').length, followed: outcome('followed'),
      direct: outcome('direct'), otherAgent: outcome('other-agent'), unresolved: sug.filter((e) => !resolved.has(e.id)).length },
    delegations: { total: del.length, viaRoute: del.filter((e) => e.routeId).length, direct: del.filter((e) => !e.routeId).length,
      verified: del.filter((e) => e.actual?.length).length, unverified: del.filter((e) => !e.actual?.length).length,
      foreground: del.filter((e) => e.shape === 'foreground' || e.shape === 'sync').length, background: del.filter((e) => e.shape === 'background').length,
      modeUnknown: del.filter((e) => !e.shape).length, backgroundRejected: denied.filter((e) => e.kind === 'background').length,
      concurrentRejected: denied.filter((e) => e.kind === 'concurrent').length } };
}

export function formatStats(s) {
  const kv = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  const lines = [`Routes: ${s.routes} · escalations: ${s.escalations} · context reused: ${s.contextReuse}`,
    `By tier: ${kv(s.byTier)}`, `By agent: ${kv(s.byAgent)}`, `By category: ${kv(s.byCategory)}`,
    `Agents per workflow: ${kv(s.agentsPerWorkflow)}`, ''];
  const g = s.suggestions, d = s.delegations;
  if (!g) return [...lines, 'Suggestions and delegations: unavailable (no hook telemetry recorded in this project yet).'].join('\n');
  return [...lines, 'Suggestions and delegations:',
    `- Suggestions generated: ${g.generated} (complex: ${g.complex})`,
    `- Followed (suggested agent ran): ${g.followed}`,
    `- Ignored (direct response): ${g.direct}`,
    `- Different agent delegated: ${g.otherAgent}`,
    `- Outcome unknown (turn not finished yet or interrupted): ${g.unresolved}`,
    `- Delegations through rmc route: ${d.viaRoute}`,
    `- Direct agent delegations (no rmc route): ${d.direct}`,
    `- Actual model verified (subagent transcript): ${d.verified}`,
    `- Actual model unavailable: ${d.unverified}`,
    `- Foreground: ${d.foreground} · background detected: ${d.background} · mode unknown: ${d.modeUnknown}`,
    `- Background rejected: ${d.backgroundRejected} · concurrent agent rejected: ${d.concurrentRejected}`].join('\n');
}

export function formatCategories(c) {
  const cfg = loadModelConfig(c);
  const m = (k, t) => { const tier = t.tier || cfg.routing.defaultTier; return t.agent ? roleModel(cfg, t.agent, tier, undefined, k).value : cfg.tiers[tier]; };
  return ['| Category | Tier | Model (role policy, no signals) | Default agent | Use for |', '|---|---|---|---|---|',
    ...Object.entries(cfg.tasks).map(([k, t]) => `| ${k} | ${t.tier || cfg.routing.defaultTier} | ${m(k, t)} | ${t.agent || "(give --agent)"} | ${t.label} |`), '',
    `Signals: ${SIGNALS.join(', ')}`,
    'high: security, architecture, irreversible, debugging, cross-module, modules:3+ · at least medium: ambiguous, code, sensitive, modules:2 · low: trivial or retrieval (unless ambiguous or a high signal)',
    'The tier is complexity, not a model: each role maps it to a model (rmc routing). Opus is a role\'s "deep" model, used at high only under that role\'s conditions.'].join('\n');
}
