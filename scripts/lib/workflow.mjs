// RM Context workflows (/rmc:run): one task → the smallest sufficient sequence of specialist stages.
//
// Boundary: Claude Code hooks cannot call the Agent tool. The MAIN SESSION executes every stage (Agent tool, explicit model);
// this module is the deterministic state machine around it:
//   rmc workflow plan   → stages, agents and models (existing route() precedence), knowledge per stage
//   rmc workflow start  → next stage: records its route, builds its knowledge package, prints the exact Agent call
//   hooks               → PreToolUse: only the started stage's agent and model · SubagentStart: injects the package into
//                         that agent · PostToolUse/SubagentStop: transcript evidence (actual model, mode, usage), once
//   rmc workflow done   → stage gate: pass needs agent evidence + a structured hand-off (+ criteria for verification);
//                         fail → bounded retry (one escalation) or back to implementation after a failed verification
//   rmc workflow finish → completion only when every required stage passed; knowledge write-back
// No LLM calls, no extra sessions, no processes. Stored: ids, categories, models, metrics, acceptance criteria and
// hand-offs (the existing store); never the task text (only its hash).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, now, fail } from './util.mjs';
import { route, roleName, classifyPrompt, loadModelConfig } from './routing.mjs';
import { readSession, writeSession, updateTurn, isRmcAgent } from './delegation.mjs';

const DEFAULT_LIMITS = { maxAttempts: 2, maxQaLoops: 2 }; // per stage: 1 retry · per workflow: 2 returns to implementation
const RISK_SIGNALS = ['security', 'irreversible', 'architecture'];
const HIGH_RISK = new Set(['security', 'migration', 'complex-feature', 'refactor', 'architecture', 'infra-design']);
const IMPLEMENT = { 'small-feature': 'feature', 'complex-feature': 'feature', 'bug-fix': 'fix', 'small-change': 'fix', debugging: 'fix', refactor: 'fix', migration: 'fix' };
const INVESTIGATE = { search: ['system-analyst', 'system-analysis'], 'system-analysis': ['system-analyst', 'system-analysis'], 'repo-analysis': ['architecture', 'repo-analysis'], impact: ['architecture', 'impact'], architecture: ['architecture', 'architecture'] };
const MAIN_ONLY = new Set(['explain', 'metadata', 'classify']);
// What the task explicitly asks for, independent of its single category: "analyse …, implement …, then verify …" is a
// change workflow even when it mentions documentation. Booleans only; the task text is not stored.
const INTENT = {
  analysis: /\banaly[sz]\w*|\banalis[ia]s?\b|\banalisa\w*|\binvestigat\w*|\binvestigasi\b|\bidentif(?:y|ies|ikasi)\w*/i,
  change: /\bimplement\w*|\bfix(?:es|ed|ing)?\b|\bperbaiki\b|\bmodif(?:y|ies|ikasi)\w*|\bubah\b|\brefactor\w*|\btulis kode|\bwrite (?:the )?code\b/i,
  // Names code (a source file or "code"/"kode"): a documentation task that also touches code needs verification.
  codeRef: /\b(?:code|kode|source code|src\/)|\.(?:m?[jt]sx?|py|php|cs|java|kt|go|rb|rs)\b/i,
  verify: /\bverif\w*|\bvalidat\w*|\bvalidasi\b|\btest(?:s|ing)?\b|\bpengujian\b|\buji\b|\bpastikan\b|\bensure\b|\bQA\b/i,
};
export const intentsOf = (task) => Object.fromEntries(Object.entries(INTENT).map(([k, rx]) => [k, rx.test(String(task || ''))]));
// Engine invariant (not a template choice): a workflow that changes code, states acceptance criteria or was planned with
// a verification stage cannot finish without a passed verification stage (checked in finish, whatever the file holds).
const needsVerification = (w) => Boolean(w.criteria?.length || w.verifyRequired || w.stages.some((s) => s.role === 'implement'));
const checksOf = (w) => w.checks || (w.criteria || []).map((_, i) => ({ id: `C${i + 1}`, status: 'unverified' }));
const GOAL = {
  analysis: 'Analyse the task: affected modules and files, API and data contracts, risks, acceptance criteria to meet, open questions. Do not change source files.',
  implement: 'Implement the change described by the task and the input hand-off. Follow the project conventions, keep unrelated code unchanged, run focused tests.',
  verify: 'Verify the implementation against every acceptance criterion and the input hand-off. Run the relevant tests. Do not modify source. Verdict "pass" only if every criterion is met.',
  document: 'Update the documentation the task needs, from verified facts only.',
  work: 'Do the task for your role.',
};
const SECTIONS = { analysis: ['business', 'impl', 'apis', 'data', 'docs', 'infra', 'notes'], implement: ['impl', 'apis', 'data', 'tests', 'notes'],
  verify: ['tests', 'apis', 'impl', 'business'], document: ['docs', 'business', 'impl', 'apis', 'data', 'notes'], work: null };
const POLICY = 'Knowledge policy: unlabelled entries are verified and fresh — use them without reopening the source unless you change that code. [inferred] = heuristic: confirm before relying on it, never present it as verified. [stale] = the file changed since the last scan: re-read it.';
const ACTIVE = new Set(['planned', 'running']);
const tokens = (s) => Math.ceil(String(s || '').length / 3.5);
const cap = (m) => (m === 'inherit' ? 'main session model' : m[0].toUpperCase() + m.slice(1));
const sid = () => process.env.RMC_SESSION_ID || null;
const dir = (c) => c.p('state', 'workflows');
const file = (c, id) => path.join(dir(c), `${String(id).replace(/[^\w-]/g, '')}.json`);
const short = (s, n = 200) => (s == null ? null : String(s).slice(0, n));

export const loadWorkflow = (c, id) => readJson(file(c, id), null) || fail(`Unknown workflow ${id}. See: rmc workflow list`);
function save(c, w) {
  w.updatedAt = now();
  fs.mkdirSync(dir(c), { recursive: true });
  fs.writeFileSync(file(c, w.id), JSON.stringify(w, null, 2));
  return w;
}
async function log(c, rec) { const X = await import('./context.mjs'); X.logEvent(c, rec); }
function limits(c) { return { ...DEFAULT_LIMITS, ...(readJson(c.config, {}).workflow || {}) }; }
function point(c, w) { // the session's active workflow, so hooks can link agent runs to its stages
  const s = sid(); if (!s) return;
  const x = readSession(s);
  if (ACTIVE.has(w.status)) x.workflow = { id: w.id, root: c.root }; else if (x.workflow?.id === w.id) delete x.workflow;
  writeSession(s, x);
  if (ACTIVE.has(w.status)) updateTurn(s, c.root, (t) => { t.workflows = [...new Set([...(t.workflows || []), w.id])]; });
}
export function activeWorkflow(c, sessionId) {
  const p = sessionId ? readSession(sessionId).workflow : null;
  if (!c || !p || p.root !== c.root) return null;
  const w = readJson(file(c, p.id), null);
  return w && ACTIVE.has(w.status) ? w : null;
}

// ---------- planning ----------
// The smallest sufficient workflow for a category: no stage for simple explanations; one specialist for investigations,
// reviews and documents; analysis → implementation → verification for features; implementation → verification for fixes.
export function stagesFor(category, signals, risk, { intents = {}, criteria = 0 } = {}) {
  const st = (role, agent, cat) => ({ role, agent, category: cat });
  const verify = risk === 'high' ? st('verify', 'qa', 'qa') : st('verify', 'quick-qa', 'verification');
  const code = signals.includes('code') || Boolean(intents.change && category !== 'doc-update');
  if (MAIN_ONLY.has(category)) return [];
  let defs;
  // Security-sensitive work (the category, or a change carrying the security signal): analysis → change → QA verification.
  if (category === 'security' || (IMPLEMENT[category] && signals.includes('security'))) defs = code ? [st('analysis', 'senior-engineer', 'security'), st('implement', 'senior-engineer', 'bug-fix'), st('verify', 'qa', 'qa')] : [st('analysis', 'senior-engineer', 'security')];
  // Explicit analysis + change + verification, whatever the category word ("dokumentasi" alone never wins over them).
  else if (intents.analysis && (code || intents.change) && intents.verify) defs = [st('analysis', 'system-analyst', 'system-analysis'), st('implement', 'senior-engineer', IMPLEMENT[category] ? category : 'small-change'), verify];
  else if (IMPLEMENT[category] === 'feature') defs = [st('analysis', 'system-analyst', 'system-analysis'), st('implement', 'senior-engineer', category), verify];
  else if (IMPLEMENT[category]) defs = [st('implement', 'senior-engineer', category), verify];
  else if (INVESTIGATE[category]) defs = [st('analysis', ...INVESTIGATE[category])];
  // Documentation stays one stage unless it changes code or asks for verification.
  else if (category === 'doc-update') defs = code || intents.codeRef || intents.verify ? [st('document', 'documentation', 'doc-update'), verify] : [st('document', 'documentation', 'doc-update')];
  else defs = code ? [st('work', null, category), verify] : [st('work', null, category)];
  // Acceptance criteria are always checked by a verification stage.
  if (criteria && !defs.some((d) => d.role === 'verify')) defs.push(verify);
  return defs;
}

export async function plan(c, o = {}) {
  const cfg = loadModelConfig(c);
  const task = typeof o.task === 'string' ? o.task.trim() : '';
  if (!task && !o.category) fail('Usage: rmc workflow plan --task "<the user\'s task>" [--category c] [--signals s,s] [--model m] [--criteria "a; b"] [--session-model id] (or the task on stdin)');
  if (o.category && !cfg.tasks[o.category]) fail(`Unknown category "${o.category}". See: rmc route categories`);
  // One workflow at a time per session: a running one must finish or be cancelled; an unstarted plan is superseded.
  const prev = activeWorkflow(c, sid());
  if (prev?.status === 'running') fail(`Workflow ${prev.id} is still running. Finish it (rmc workflow finish ${prev.id}) or cancel it (rmc workflow cancel ${prev.id}) first.`);
  if (prev) { for (const s of prev.stages) s.status = 'cancelled'; Object.assign(prev, { status: 'cancelled', failure: 'superseded by a new plan before it started' }); save(c, prev); }
  const k = o.category ? { decision: 'suggest', category: o.category, signals: [] } : classifyPrompt(task, { projectName: readJson(c.manifest, {}).project?.name });
  const signals = [...new Set([...(k.signals || []), ...String(o.signals || '').split(',').map((x) => x.trim()).filter(Boolean)])];
  const intents = intentsOf(task);
  if (k.category && (IMPLEMENT[k.category] || (intents.change && k.category !== 'doc-update')) && !signals.includes('code')) signals.push('code');
  const risk = k.category && (HIGH_RISK.has(k.category) || signals.some((x) => RISK_SIGNALS.includes(x))) ? 'high' : 'normal';
  const criteria = String(o.criteria || '').split(/;|\n/).map((x) => x.trim()).filter(Boolean);
  const w = { id: `W-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: now(), status: 'planned', session: sid(),
    fingerprint: task ? 'sha256:' + crypto.createHash('sha256').update(task).digest('hex') : null, category: k.category || null, signals, risk,
    reason: k.decision === 'direct' ? k.why : null, model: o.model || null, sessionModel: o.sessionModel || null, intents, criteria,
    checks: criteria.map((_, i) => ({ id: `C${i + 1}`, status: 'unverified' })), limits: limits(c), qaLoops: 0, stages: [] };
  const defs = k.decision === 'direct' || !k.category ? [] : stagesFor(k.category, signals, risk, { intents, criteria: criteria.length });
  w.verifyRequired = defs.some((d) => d.role === 'verify');
  let changed = null, knowledge = {};
  if (defs.length && task) {
    try { changed = new Set((await import('./project.mjs')).changedSinceScan(c)); } catch { changed = null; }
    const X = await import('./context.mjs');
    for (const role of new Set(defs.map((d) => d.role))) {
      const r = X.retrieve(c, task, { sections: SECTIONS[role], changed, maxContextTokens: 900 });
      knowledge[role] = { text: r.text, tokens: r.tokens, hits: r.hits, stale: r.stale || 0 };
    }
  }
  w.stages = defs.map((d, i) => {
    const sig = d.role === 'verify' ? signals.filter((x) => RISK_SIGNALS.includes(x)) : signals;
    const r = route(c, { agent: d.agent || undefined, category: d.category, signals: sig.join(','), model: o.model, sessionModel: o.sessionModel, record: false });
    return { id: `S${i + 1}`, ...d, agent: r.agent, signals: sig, model: r.model, tier: r.tier, source: r.source, required: true, status: 'pending',
      attempts: 0, tries: 0, escalations: 0, routeId: null, input: null, handoff: null, runs: [], knowledge: knowledge[d.role] || { text: '', tokens: 0, hits: 0, stale: 0 } };
  });
  w.complexity = w.stages.reduce((t, s) => (['low', 'medium', 'high'].indexOf(s.tier) > ['low', 'medium', 'high'].indexOf(t) ? s.tier : t), 'low');
  if (!w.stages.length) w.status = 'direct';
  save(c, w);
  point(c, w);
  await log(c, { event: 'workflow', id: w.id, status: w.status, category: w.category, complexity: w.complexity, risk, stages: w.stages.map((s) => `${s.agent}:${s.model}`) });
  return w;
}

// ---------- stage execution ----------
function inputHandoff(c, w, s) {
  const id = s.input || [...w.stages].slice(0, w.stages.indexOf(s)).reverse().find((x) => x.status === 'passed' && x.handoff)?.handoff;
  if (!id) return null;
  return readHandoffsSafe(c).find((h) => h.id === id) || null;
}
function readHandoffsSafe(c) { try { return fs.readFileSync(c.handoffs, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
const list = (a) => (a?.length ? a.map((x) => short(x, 160)).join(' | ') : null);

// The compact package one stage's agent receives (SubagentStart): its goal, the criteria, the previous hand-off and the
// knowledge for its role — never the conversation or the whole knowledge base.
export function stagePackage(c, w, s) {
  const m = readJson(c.manifest, {});
  const st = m.stack || {};
  const h = inputHandoff(c, w, s);
  const lines = [`[RM CONTEXT — WORKFLOW STAGE] ${w.id} · stage ${s.id}/${w.stages.length} · ${roleName(s.agent)} (${s.role}) · attempt ${s.attempts}`,
    `Project: ${m.project?.name || path.basename(c.root)} · knowledge in .rmcontext/ · stack: ${[...Object.keys(st.languages || {}).slice(0, 3), ...(st.frameworks || []).slice(0, 3)].join(', ') || 'unknown'}`,
    `Goal of this stage: ${GOAL[s.role]}`];
  if (w.criteria.length) lines.push(`Acceptance criteria: ${w.criteria.map((x, i) => `C${i + 1}) ${x}`).join(' ')}`);
  if (h) {
    lines.push(`Input hand-off ${h.id} from ${h.from}: ${short(h.summary, 600)}`);
    for (const [k, label] of [['decisions', 'Decisions'], ['artifacts', 'Artifacts'], ['assumptions', 'Assumptions (not verified)'], ['openQuestions', 'Open questions']]) if (list(h[k])) lines.push(`${label}: ${list(h[k])}`);
  }
  lines.push(POLICY);
  if (s.knowledge?.text) lines.push(s.knowledge.text);
  lines.push('Return: end your reply with a fenced json hand-off {"summary": "…", "artifacts": [], "decisions": [], "assumptions": [], "openQuestions": [], "nodes": []'
    + (s.role === 'verify' ? `, "verdict": "pass|fail"${w.criteria.length ? ', "criteria": [{"id": "C1", "status": "pass|fail", "evidence": "file:line, test name or command output that proves it"}] — one entry per criterion; a criterion without evidence counts as not proven' : ''}` : '')
    + '}. Do not start other agents.');
  return lines.join('\n');
}

export async function start(c, id) {
  const w = loadWorkflow(c, id);
  if (!ACTIVE.has(w.status)) fail(`Workflow ${w.id} is ${w.status}; nothing to start.`);
  const busy = w.stages.find((s) => s.status === 'running' || s.status === 'returned');
  if (busy) fail(`Stage ${busy.id} (${roleName(busy.agent)}) is ${busy.status === 'running' ? 'still running' : 'waiting for its result'}: record it with rmc workflow done ${w.id} ${busy.id} --status pass|fail.`);
  const s = w.stages.find((x) => x.status === 'pending') || fail(`No pending stage. Next: rmc workflow finish ${w.id}`);
  let r;
  if (s.escalate) {
    try { r = route(c, { escalate: s.routeId, reason: s.escalate.reason, handoff: s.escalate.handoff, sessionModel: w.sessionModel }); s.escalations++; }
    catch (e) { r = null; s.notes = [...(s.notes || []), `not escalated: ${short(e.message)}`]; }
    delete s.escalate;
  }
  r ||= route(c, { agent: s.agent, category: s.category, signals: s.signals.join(','), model: w.model || undefined, sessionModel: w.sessionModel, workflow: w.id });
  Object.assign(s, { routeId: r.id, model: r.model, tier: r.tier, source: r.source, status: 'running', startedAt: now() });
  s.attempts++; // identifies this run (monotonic)
  s.tries = (s.tries || 0) + 1; // bounded by maxAttempts; reset when a failed verification returns work to this stage
  s.package = { text: stagePackage(c, w, s), injected: false };
  s.package.tokens = tokens(s.package.text);
  w.status = 'running';
  save(c, w);
  point(c, w);
  await log(c, { event: 'workflow-stage', workflow: w.id, stage: s.id, phase: 'start', agent: s.agent, requested: s.model, attempt: s.attempts, routeId: r.id, packageTokens: s.package.tokens, hits: s.knowledge.hits, stale: s.knowledge.stale });
  return { w, s, route: r };
}

// ---------- hooks ----------
// PreToolUse: while a workflow is active, an RM Context agent may run only as the started stage, with its model, once.
export function guard(c, input) {
  const ti = input.tool_input || {};
  if (!isRmcAgent(ti.subagent_type) || input.agent_id) return null;
  const w = activeWorkflow(c, input.session_id);
  if (!w) return null;
  const s = w.stages.find((x) => x.status === 'running' || x.status === 'returned');
  if (!s) return { kind: 'workflow', reason: `RM Context workflow ${w.id} is active but no stage is started. Run rmc workflow start ${w.id} first, then call the agent it names (or rmc workflow cancel ${w.id}).` };
  const role = String(ti.subagent_type).replace(/^(rmc|rm-context):/, '');
  if (role !== s.agent) return { kind: 'workflow', reason: `Workflow ${w.id} stage ${s.id} runs rmc:${s.agent}, not ${ti.subagent_type}.` };
  if (s.model !== 'inherit' && ti.model !== s.model) return { kind: 'workflow', reason: `Workflow ${w.id} stage ${s.id}: pass model "${s.model}" explicitly to the Agent tool.` };
  if (s.runs.some((x) => x.attempt === s.attempts)) return { kind: 'workflow', reason: `Stage ${s.id} already ran for this attempt. Record its result: rmc workflow done ${w.id} ${s.id} --status pass|fail.` };
  return null;
}

// SubagentStart: the started stage's knowledge package goes straight into that agent's context.
export function subagentStart(c, input) {
  const w = activeWorkflow(c, input.session_id);
  const s = w?.stages.find((x) => x.status === 'running');
  if (!s || String(input.agent_type).replace(/^(rmc|rm-context):/, '') !== s.agent || !s.package) return null;
  Object.assign(s.package, { injected: true, agentId: input.agent_id || null, at: now() });
  save(c, w);
  return s.package.text;
}

// PostToolUse / SubagentStop: transcript evidence for the running stage, merged by agent id (never counted twice).
export function recordRun(c, sessionId, f) {
  const w = activeWorkflow(c, sessionId);
  const s = w?.stages.find((x) => x.status === 'running' || x.status === 'returned');
  if (!s || String(f.agent).replace(/^(rmc|rm-context):/, '') !== s.agent) return null;
  let run = s.runs.find((x) => (f.agentId && x.agentId === f.agentId) || (f.delegationId && x.delegationId === f.delegationId));
  if (!run) s.runs.push(run = { attempt: s.attempts, startedAt: s.startedAt });
  for (const [k, v] of Object.entries({ agentId: f.agentId, delegationId: f.delegationId, requested: f.requested, mode: f.mode, status: f.status, failure: f.failure, ms: f.ms }))
    if (v != null) run[k] = v;
  if (f.actual?.length) run.actual = f.actual;
  if (f.usage && (!run.usage || !f.usage.partial || run.usage.partial)) run.usage = f.usage;
  if (f.status === 'completed' || f.status === 'failed') { run.endedAt = now(); if (s.status === 'running') s.status = 'returned'; }
  save(c, w);
  return { w, s, run };
}

// Stop: a workflow that is not finished is reported as such (never as successful).
export function stopCheck(c, sessionId, agentRunning) {
  const w = activeWorkflow(c, sessionId);
  if (!w || agentRunning) return null;
  const next = w.stages.find((s) => s.status !== 'passed');
  return { w, text: `RM Context workflow ${w.id} is not complete${next ? ` (stage ${next.id} ${roleName(next.agent)}: ${next.status})` : ''}; it is not marked successful. Continue with rmc workflow ${next?.status === 'pending' ? 'start' : 'done'} ${w.id}${next && next.status !== 'pending' ? ` ${next.id} --status pass|fail` : ''}, or rmc workflow cancel ${w.id}.` };
}

// ---------- gates ----------
async function storeHandoff(c, w, s, h) {
  if (!h || typeof h !== 'object' || !h.summary) fail('The stage hand-off needs at least a "summary" (JSON on stdin with --handoff -, or an existing --handoff H-id).');
  const P = await import('./project.mjs');
  const keep = ['summary', 'artifacts', 'decisions', 'assumptions', 'openQuestions', 'nodes', 'verdict', 'criteria']; // QA: per-criterion results and evidence
  const rec = Object.fromEntries(keep.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));
  const next = w.stages[w.stages.indexOf(s) + 1];
  const msg = P.addHandoff(c, { ...rec, from: s.agent, to: next?.agent || 'orchestrator', workflow: w.id, stage: s.id });
  return /H-\w+/.exec(msg)[0];
}

export async function done(c, id, stageId, o = {}) {
  const w = loadWorkflow(c, id);
  if (!ACTIVE.has(w.status)) fail(`Workflow ${w.id} is ${w.status}.`);
  const s = w.stages.find((x) => x.id === stageId) || fail(`Unknown stage ${stageId} in ${w.id}.`);
  if (!['running', 'returned'].includes(s.status)) fail(`Stage ${s.id} is ${s.status}, not started. Next: rmc workflow start ${w.id}`);
  if (!['pass', 'fail'].includes(o.status)) fail('--status pass|fail is required.');
  const run = s.runs.find((x) => x.attempt === s.attempts && x.agentId);
  let h = null;
  if (o.handoff && o.handoff !== true) {
    h = o.handoffJson ? { id: await storeHandoff(c, w, s, o.handoffJson) } : readHandoffsSafe(c).find((x) => x.id === o.handoff) || fail(`Unknown hand-off ${o.handoff}.`);
    if (o.handoffJson?.verdict && o.handoffJson.verdict !== o.status) fail(`The hand-off verdict is "${o.handoffJson.verdict}" but --status is ${o.status}.`);
  }
  const L = w.limits;
  let next;
  if (o.status === 'pass') {
    // Evidence that the stage's agent actually ran (SubagentStop/PostToolUse, from its transcript); a stage done by the
    // main session itself, or not run at all, cannot pass.
    if (!run) fail(`No agent run is recorded for stage ${s.id} (rmc:${s.agent}). Run the agent with the Agent tool first; a stage cannot pass without it.`);
    if (run.status === 'failed') fail(`The agent run for stage ${s.id} failed; record --status fail.`);
    if (!h) fail(`Stage ${s.id} needs its structured hand-off: --handoff - (JSON on stdin) or --handoff <H-id>.`);
    if (s.role === 'verify' && w.criteria.length) {
      // Criteria are verified only by the QA hand-off's own per-criterion results with evidence; a successful run or a
      // "pass" verdict proves nothing by itself.
      const res = results(c, h, o);
      const unproven = checksOf(w).filter((x) => !proven(res[x.id]));
      if (unproven.length) fail(`${unproven.map((x) => x.id).join(', ')} not proven: the QA hand-off needs "criteria": [{"id", "status": "pass", "evidence"}] for every criterion. If one failed, record --status fail.`);
      if (o.criteria) { const [p, t] = String(o.criteria).split('/').map(Number); if (p !== w.criteria.length || t !== w.criteria.length) fail(`--criteria ${o.criteria} disagrees with the hand-off: ${w.criteria.length}/${w.criteria.length} proven.`); }
      w.checks = checksOf(w).map((x) => ({ ...x, status: 'verified', evidence: short(res[x.id].evidence, 300), stage: s.id, agent: s.agent, attempt: s.attempts, handoff: h.id, at: now() }));
      s.criteriaPassed = w.criteria.length;
    }
    Object.assign(s, { status: 'passed', handoff: h.id, endedAt: now() });
    next = w.stages.find((x) => x.status === 'pending') ? `rmc workflow start ${w.id}` : `rmc workflow finish ${w.id}`;
  } else {
    s.failures = [...(s.failures || []), { attempt: s.attempts, reason: short(o.reason) || 'not given', at: now() }];
    if (s.role === 'verify' && w.criteria.length) {
      // Keep what QA found for each criterion; nothing is marked verified by a failed verification.
      const res = h ? results(c, h, o) : {};
      w.checks = checksOf(w).map((x) => ({ ...x, status: res[x.id] && !proven(res[x.id]) ? 'failed' : x.status === 'verified' ? 'unverified' : x.status,
        last: res[x.id] ? { status: proven(res[x.id]) ? 'passed' : 'failed', evidence: short(res[x.id].evidence, 300), stage: s.id, attempt: s.attempts } : x.last }));
    }
    const impl = [...w.stages].slice(0, w.stages.indexOf(s)).reverse().find((x) => x.role === 'implement');
    if (s.role === 'verify' && impl) {
      // A failed verification returns to implementation, bounded by maxQaLoops; the QA hand-off is the implementer's input.
      if (w.qaLoops >= L.maxQaLoops) { s.status = 'failed'; w.status = 'failed'; w.failure = `verification failed ${w.qaLoops + 1} times (maxQaLoops ${L.maxQaLoops})`; }
      else {
        w.qaLoops++;
        for (const x of w.stages.slice(w.stages.indexOf(impl), w.stages.indexOf(s) + 1)) Object.assign(x, { status: 'pending', handoff: null, tries: 0 });
        // The code changes again: every criterion has to be verified again.
        if (w.checks) w.checks = w.checks.map((x) => ({ ...x, status: 'unverified' }));
        impl.input = h?.id || null;
        next = `rmc workflow start ${w.id}`;
      }
    } else if (s.tries < L.maxAttempts) {
      s.status = 'pending';
      // One justified escalation per stage, through the existing escalation policy (adaptive models only).
      if (h && s.escalations < 1 && s.source === 'adaptive' && o.escalate) s.escalate = { reason: short(o.reason) || 'stage failed', handoff: h.id };
      if (h) s.input = h.id;
      next = `rmc workflow start ${w.id}`;
    } else { s.status = 'failed'; w.status = 'failed'; w.failure = `stage ${s.id} failed ${s.tries} time(s) (maxAttempts ${L.maxAttempts})`; }
  }
  if (w.status === 'failed') for (const x of w.stages) if (x.status === 'pending') x.status = 'not run';
  save(c, w);
  point(c, w);
  await log(c, { event: 'workflow-stage', workflow: w.id, stage: s.id, phase: 'done', agent: s.agent, status: o.status, attempt: s.attempts, escalations: s.escalations,
    requested: s.model, actual: run?.actual || [], mode: run?.mode || null, delegationId: run?.delegationId || null, handoff: h?.id || null,
    handoffTokens: h ? tokens(JSON.stringify(readHandoffsSafe(c).find((x) => x.id === h.id) || {})) : 0, failure: o.status === 'fail' ? short(o.reason) || 'not given' : null });
  if (w.status === 'failed') await log(c, { event: 'workflow', id: w.id, status: 'failed', failure: w.failure });
  return { w, s, next: w.status === 'failed' ? null : next };
}

export async function finish(c, id) {
  const w = loadWorkflow(c, id);
  if (w.status === 'completed') return { w, already: true };
  if (!ACTIVE.has(w.status)) fail(`Workflow ${w.id} is ${w.status}; it cannot be completed.`);
  const missing = w.stages.filter((s) => s.required && (s.status !== 'passed' || !s.runs.some((r) => r.agentId && r.status !== 'failed')));
  if (missing.length) fail(`Workflow ${w.id} is not complete: ${missing.map((s) => `${s.id} ${roleName(s.agent)} (${s.status})`).join(', ')}.`);
  // Engine invariants, checked here whatever the plan contained: verification happened, and every criterion is proven.
  const checks = checksOf(w);
  const list_ = checks.map((x) => `${x.id} ${x.status}`).join(', ');
  if (needsVerification(w) && !w.stages.some((s) => s.role === 'verify' && s.status === 'passed'))
    fail(`Workflow ${w.id} cannot finish: no verification stage passed${checks.length ? ` (acceptance criteria: ${list_})` : ''}. It changes code, states acceptance criteria or asks for verification.`);
  const open = checks.filter((x) => x.status !== 'verified');
  if (open.length) fail(`Workflow ${w.id} cannot finish: acceptance criteria not verified: ${open.map((x) => `${x.id} ${x.status}`).join(', ')}.`);
  // Write-back: changed files are re-scanned incrementally (stale knowledge invalidated), and one summary hand-off links
  // the stage hand-offs. Assumptions stay assumptions; only the agents' own graph writes add verified facts.
  const X = await import('./context.mjs');
  let refresh = null;
  try { refresh = await X.applyPending(c); } catch (e) { refresh = { error: short(e.message) }; }
  const hs = readHandoffsSafe(c).filter((h) => w.stages.some((s) => s.handoff === h.id));
  const merge = (k) => [...new Set(hs.flatMap((h) => h[k] || []))];
  const P = await import('./project.mjs');
  const msg = P.addHandoff(c, { from: 'orchestrator', to: 'user', workflow: w.id, summary: `Workflow ${w.id} completed: ${w.stages.map((s) => `${roleName(s.agent)} ${s.status}`).join(' → ')}. Stage hand-offs: ${hs.map((h) => h.id).join(', ')}.`,
    artifacts: merge('artifacts'), decisions: merge('decisions'), assumptions: merge('assumptions'), openQuestions: merge('openQuestions'), nodes: merge('nodes') });
  Object.assign(w, { status: 'completed', completedAt: now(), knowledge: { handoff: /H-\w+/.exec(msg)[0], refreshed: refresh?.changedFiles?.length ?? 0, refreshMode: refresh?.mode || (refresh?.error ? 'error' : 'none') } });
  save(c, w);
  point(c, w);
  await log(c, { event: 'workflow', id: w.id, status: 'completed', stages: w.stages.length, qaLoops: w.qaLoops });
  return { w, hs };
}

export async function cancel(c, id, reason) {
  const w = loadWorkflow(c, id);
  if (!ACTIVE.has(w.status)) fail(`Workflow ${w.id} is ${w.status}.`);
  for (const s of w.stages) if (s.status !== 'passed') s.status = 'cancelled';
  Object.assign(w, { status: 'cancelled', failure: short(reason) || 'cancelled by the user' });
  save(c, w);
  point(c, w);
  await log(c, { event: 'workflow', id: w.id, status: 'cancelled' });
  return w;
}

const proven = (r) => r && r.status === 'pass' && String(r.evidence || '').trim().length > 0;
function results(c, h, o) {
  const src = o.handoffJson || readHandoffsSafe(c).find((x) => x.id === h.id) || {};
  return Object.fromEntries((Array.isArray(src.criteria) ? src.criteria : []).filter((x) => x && x.id).map((x) => [String(x.id), x]));
}

// ---------- reporting ----------
export async function summary(c, w) {
  const E = await import('./efficiency.mjs');
  const reg = E.loadPricing();
  const runs = w.stages.flatMap((s) => s.runs.map((r) => ({ s, r })));
  const sub = runs.flatMap(({ r }) => r.usage?.groups || []);
  const events = E.dedupe(E.readJsonl(c.p('state', 'autocontext.jsonl')));
  const main = events.filter((e) => e.event === 'turn-usage' && (e.workflows || []).includes(w.id)).flatMap((e) => e.main || []);
  const at = w.at;
  return { main: { tokens: E.tokenSummary(main), cost: E.costOf(reg, main, at) }, subagents: { tokens: E.tokenSummary(sub), cost: E.costOf(reg, sub, at) },
    total: { tokens: E.tokenSummary([...main, ...sub]), cost: E.costOf(reg, [...main, ...sub], at) },
    stages: w.stages.map((s) => ({ s, cost: E.costOf(reg, s.runs.flatMap((r) => r.usage?.groups || []), at), tokens: E.tokenSummary(s.runs.flatMap((r) => r.usage?.groups || [])) })), E };
}

export function formatPlan(w) {
  if (w.status === 'direct') return `Workflow ${w.id}: main session only (${w.reason || 'no specialist stage needed'}). Answer the task directly; no agent runs.`;
  return [`Workflow ${w.id} · ${w.category} · complexity ${w.complexity} · risk ${w.risk}${w.criteria.length ? ` · ${w.criteria.length} acceptance criteria` : ''}`,
    ...w.stages.map((s) => `- ${s.id} ${roleName(s.agent)} (${cap(s.model)}, ${s.source}) — ${s.role}${s.knowledge.hits ? ` · ${s.knowledge.hits} knowledge hits${s.knowledge.stale ? `, ${s.knowledge.stale} stale` : ''}` : ''}`),
    `Next: rmc workflow start ${w.id}`].join('\n');
}

export async function formatStatus(c, w) {
  const x = await summary(c, w);
  const { E } = x;
  const lines = [`Workflow ${w.id} · ${w.status}${w.failure ? ` (${w.failure})` : ''} · ${w.category || 'no category'} · risk ${w.risk} · returns to implementation ${w.qaLoops}/${w.limits?.maxQaLoops ?? '?'}`,
    '| Stage | Agent | Requested | Actual (transcript) | Mode | Status | Attempts | Tokens | Est. cost | Package | Knowledge |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const { s, cost, tokens: t } of x.stages) {
    const r = s.runs.at(-1);
    lines.push(`| ${s.id} ${s.role} | ${s.agent} | ${s.model} | ${r?.actual?.join(', ') || (r ? 'unverified' : '—')} | ${r?.mode || '—'} | ${s.status} | ${s.attempts}${s.escalations ? ` (+${s.escalations} escalation)` : ''} | ${t.total ? t.total.toLocaleString('en-US') : '—'} | ${t.total ? E.costText(cost) : '—'} | ${s.package ? `${s.package.tokens} tokens${s.package.injected ? '' : ' (not injected)'}` : '—'} | ${s.knowledge.hits} hits${s.knowledge.stale ? `, ${s.knowledge.stale} stale` : ''} |`);
  }
  lines.push(`Main session: ${E.tok(x.main.tokens)} · ${E.costText(x.main.cost)}`, `Subagents: ${E.tok(x.subagents.tokens)} · ${E.costText(x.subagents.cost)}`,
    `Total: ${E.tok(x.total.tokens)} · ${E.costText(x.total.cost)} (estimated at API list prices; each API call counted once)`);
  const checks = checksOf(w);
  if (checks.length) {
    lines.push(`Acceptance criteria: ${checks.filter((x) => x.status === 'verified').length}/${checks.length} verified`);
    for (const x of checks) lines.push(x.status === 'verified' ? `- ${x.id} verified by ${x.stage} (${x.agent}): ${x.evidence}` : `- ${x.id} ${x.status}${x.last ? ` (last check ${x.last.stage}: ${x.last.status}${x.last.evidence ? ` — ${x.last.evidence}` : ''})` : ''}`);
  }
  if (w.knowledge) lines.push(`Knowledge write-back: hand-off ${w.knowledge.handoff}; ${w.knowledge.refreshed} changed file(s) re-scanned (${w.knowledge.refreshMode}).`);
  return lines.join('\n');
}

export function listWorkflows(c) {
  let fs_ = [];
  try { fs_ = fs.readdirSync(dir(c)).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  return fs_.map((f) => readJson(path.join(dir(c), f), null)).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// ---------- CLI ----------
export async function cli(c, sub, rest, args) {
  const json = args.json === true;
  const need = (x, u) => x || fail(`Usage: rmc workflow ${u}`);
  switch (sub) {
    case 'plan': {
      let task = typeof args.task === 'string' ? args.task : '';
      if (!task && !args.category && !process.stdin.isTTY) { try { task = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
      const w = await plan(c, { task, category: args.category, signals: args.signals, model: typeof args.model === 'string' ? args.model : undefined,
        criteria: args.criteria, sessionModel: typeof args['session-model'] === 'string' ? args['session-model'] : undefined });
      return json ? w : formatPlan(w);
    }
    case 'start': {
      const { w, s, route: r } = await start(c, need(rest[0], 'start <W-id>'));
      if (json) return { workflow: w.id, stage: s.id, agent: `rmc:${s.agent}`, model: s.model, routeId: r.id, notice: r.notice, packageTokens: s.package.tokens };
      return [`Running ${roleName(s.agent)} (${cap(s.model)}) — stage ${s.id}/${w.stages.length} of ${w.id} (${s.role}, attempt ${s.attempts})`, `Notice: ${r.notice}`,
        `Agent call: subagent_type "rmc:${s.agent}"${s.model === 'inherit' ? ' (no model parameter: it inherits the main session model)' : `, model "${s.model}"`}, in the foreground; wait for its result.`,
        `Delegation message: the user's task verbatim, then "RM Context workflow ${w.id}, stage ${s.id} (${s.role}). Your stage package (goal, criteria, input hand-off, project knowledge) is added to your context automatically; if it is missing, run: rmc workflow context ${w.id} ${s.id}".`,
        `Then: rmc workflow done ${w.id} ${s.id} --status pass|fail --handoff - (the agent's json hand-off on stdin${s.role === 'verify' && w.criteria.length ? `, with "criteria": [{"id", "status", "evidence"}] for ${checksOf(w).map((x) => x.id).join(', ')}` : ''}) [--reason "…"]`].join('\n');
    }
    case 'done': {
      const [id, st] = [need(rest[0], 'done <W-id> <S-id> --status pass|fail …'), need(rest[1], 'done <W-id> <S-id> --status pass|fail …')];
      let handoffJson = null;
      if (args.handoff === '-') { try { handoffJson = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { fail('--handoff - expects the hand-off as JSON on stdin.'); } }
      const r = await done(c, id, st, { status: args.status, handoff: args.handoff, handoffJson, reason: args.reason, criteria: args.criteria, escalate: args.escalate === true });
      if (json) return { workflow: r.w.id, status: r.w.status, stage: r.s.id, stageStatus: r.s.status, next: r.next };
      return r.w.status === 'failed' ? `Stage ${r.s.id} failed. Workflow ${r.w.id} FAILED: ${r.w.failure}. Report this to the user; do not present the task as done.`
        : `Stage ${r.s.id} ${r.s.status === 'passed' ? 'passed' : `failed → ${r.s.role === 'verify' ? 'back to implementation' : 'retry'}`}. Next: ${r.next}`;
    }
    case 'finish': {
      const r = await finish(c, need(rest[0], 'finish <W-id>'));
      return json ? r.w : `Workflow ${r.w.id} completed.\n${await formatStatus(c, r.w)}`;
    }
    case 'cancel': { const w = await cancel(c, need(rest[0], 'cancel <W-id>'), args.reason); return `Workflow ${w.id} cancelled; later stages will not run.`; }
    case 'context': {
      const w = loadWorkflow(c, need(rest[0], 'context <W-id> <S-id>'));
      const s = w.stages.find((x) => x.id === rest[1]) || fail(`Unknown stage ${rest[1]}.`);
      return s.package?.text || stagePackage(c, w, s);
    }
    case 'status': {
      const ws = listWorkflows(c);
      const w = rest[0] ? loadWorkflow(c, rest[0]) : ws.at(-1) || fail('No workflows yet. Start one with /rmc:run <task>.');
      return json ? w : formatStatus(c, w);
    }
    case undefined: case 'list': {
      const ws = listWorkflows(c);
      if (json) return ws.map(({ id, at, status, category, risk, stages }) => ({ id, at, status, category, risk, stages: stages.map((s) => ({ id: s.id, agent: s.agent, model: s.model, status: s.status })) }));
      return ws.length ? ws.slice(-20).map((w) => `${w.id} ${String(w.at).slice(0, 16)} ${w.status} · ${w.category || '—'} · ${w.stages.map((s) => `${s.agent}:${s.status}`).join(' → ') || 'main session only'}`).join('\n') : 'No workflows yet. Start one with /rmc:run <task>.';
    }
    default: fail('Usage: rmc workflow plan | start | done | finish | cancel | context | status | list');
  }
}
