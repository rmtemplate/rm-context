// Adaptive MAIN-SESSION model policy. This module only decides what model the main session SHOULD run and reports honestly
// what Claude Code lets a plugin do about it. It never spawns an agent to obtain a model, never claims a switch happened,
// and never records the desired model as the actual one.
//
// Capability audit (Claude Code 2.1.319, docs: code.claude.com/docs/en/model-config):
//   /model <alias>   user-typed, switches the main session            (manual: not callable by the model, hooks or plugins)
//   opusplan         Opus in plan mode, Sonnet in execution mode      (automatic, tied to plan mode, not to task type)
//   --model/--effort launch-time only
//   hooks            PreModelSwitch hooks can only block/ask; no hook output field sets the model
//   Agent `model`    applies to the subagent only, never the main session
// Result: PARTIALLY SUPPORTED. On-demand automatic switching by RM Context is UNSUPPORTED; runtime behaviour NOT VERIFIED here.
import { logEvent } from './context.mjs';

export const CAPABILITY = Object.freeze({
  status: 'PARTIALLY SUPPORTED',
  automaticSwitchByPlugin: 'UNSUPPORTED',
  runtimeVerified: false,
  checkedWith: 'claude 2.1.319 (--help, official model-config docs)',
  mechanisms: [
    { name: '/model <alias>', automatic: false, trigger: 'user', scope: 'main session', note: 'typed by the user; neither the model, a hook nor a plugin can invoke it' },
    { name: 'opusplan', automatic: true, trigger: 'plan mode', scope: 'main session', note: 'Opus while planning, Sonnet while executing; follows the mode, not the task type' },
    { name: '--model / ANTHROPIC_MODEL', automatic: false, trigger: 'launch', scope: 'whole session' },
  ],
  notMechanisms: ['hooks (can only block or ask on a switch)', 'Agent tool model parameter (subagent only)', 'skill/command model frontmatter (does not change the session model)', 'editing settings or the plugin cache'],
});

// Desired MAIN-SESSION model by task category. High complexity alone never means Opus: Sonnet stays the coding default.
const SONNET = new Set(['bug-fix', 'small-change', 'small-feature', 'complex-feature', 'refactor', 'debugging', 'migration', 'ci-cd', 'infra-design', 'doc-update', 'verification', 'qa', 'impact', 'repo-analysis', 'code-review', 'document', 'rtm', 'plan', 'other']);
const OPUS = new Set(['architecture', 'security', 'adr']);
const LIGHT = new Set(['search', 'explain', 'metadata', 'classify']);
const OPUS_SIGNALS = ['architecture', 'security', 'business-critical', 'critical-business-logic'];

export function desiredMainModel({ category, signals = [], phase } = {}) {
  const sig = new Set(signals);
  if (phase === 'final-architecture-review') return { model: 'opus', reason: 'final complex architectural review' };
  if (OPUS.has(category)) return { model: 'opus', reason: `${category} reasoning` };
  if (category === 'code-review' && OPUS_SIGNALS.some((s) => sig.has(s))) return { model: 'opus', reason: 'review with architecture/security/business-critical signals' };
  if (SONNET.has(category)) return { model: 'sonnet', reason: `${category} is implementation work: Sonnet is the coding default regardless of size` };
  if (LIGHT.has(category)) return { model: 'current', reason: 'simple lookup: keep the current model (Haiku only if the host offers it)' };
  return { model: 'current', reason: 'no task category: keep the current model' };
}

export const familyOf = (m) => /(opus|sonnet|haiku)/.exec(String(m || '').toLowerCase())?.[1] || null;

// What to do about it. `userModel` = an explicit model choice by the user; it always wins and is never advised against.
export function planMainSession({ category, signals = [], phase, activeModel, userModel, initialModel } = {}) {
  const want = desiredMainModel({ category, signals, phase });
  const active = familyOf(activeModel);
  const desired = want.model === 'current' ? (active || 'current') : want.model;
  const base = { category: category || null, spawnAgent: false, initialModel: familyOf(initialModel) || active || null, activeModel: active, desiredModel: desired, reason: want.reason, capability: CAPABILITY.status, claimedSwitched: false, actualModel: active };
  if (userModel) return { ...base, desiredModel: familyOf(userModel) || userModel, action: 'honor-user-choice', needsSwitch: false, reason: 'the user chose a model explicitly' };
  if (!active) return { ...base, action: 'unknown-active-model', needsSwitch: false, reason: `${want.reason}; the active main-session model is unknown, so no switch is recommended` };
  if (desired === active || desired === 'current') return { ...base, action: 'none', needsSwitch: false };
  return { ...base, action: 'recommend-user-switch', needsSwitch: true, mechanism: '/model', instruction: `/model ${desired}` };
}

// The confirmation the main session must put to the user BEFORE starting (null when nothing to ask). Honest wording: a question and a
// recommendation, never "switched". Asked once per task: the hook records it in the session, and a No (or an ignored question) is final.
export const cap = (m) => m[0].toUpperCase() + m.slice(1);
export const CONFIRMATION = Object.freeze({
  options: ['Yes, switch to Sonnet.', 'No, continue with Opus.'],
  question: 'Main session saat ini menggunakan Opus. Task ini termasuk pekerjaan yang direkomendasikan menggunakan Sonnet agar lebih efisien. Apakah Anda ingin mengganti model ke Sonnet terlebih dahulu?',
});
// The question names the detected task category as the reason, so the suggestion explains itself. Without a category it keeps the
// generic wording (never an invented reason).
export function questionFor(plan) {
  const to = cap(plan.desiredModel), from = cap(plan.activeModel), cat = plan.category;
  if (plan.activeModel === 'opus' && plan.desiredModel === 'sonnet')
    return cat ? CONFIRMATION.question.replace('Task ini termasuk', `Task ini terdeteksi sebagai ${cat}, termasuk`) : CONFIRMATION.question;
  return `Main session saat ini menggunakan ${from}. Task ini ${cat ? `terdeteksi sebagai ${cat} dan ` : ''}direkomendasikan menggunakan ${to}. Apakah Anda ingin mengganti model ke ${to} terlebih dahulu?`;
}
export function sessionHint(plan) {
  if (!plan || plan.action !== 'recommend-user-switch') return null;
  const to = cap(plan.desiredModel), from = cap(plan.activeModel);
  const q = questionFor(plan);
  const opts = plan.activeModel === 'opus' && plan.desiredModel === 'sonnet' ? CONFIRMATION.options : [`Yes, switch to ${to}.`, `No, continue with ${from}.`];
  return `RM Context main-session model: this is ${plan.reason}; ${to} is recommended, the active model is ${from}. BEFORE starting the task, ask the user once (AskUserQuestion, two options "${opts[0]}" / "${opts[1]}"): "${q}" On Yes: tell the user to type /model ${plan.desiredModel} (RM Context cannot do it for you; never claim it switched), then wait for their confirmation before implementing. On No: continue on ${from} and do not ask again for this task or its subtasks. Do NOT spawn an agent just to get a different model.`;
}
// What happens after the user answers. Neither answer switches anything by itself.
export function applyAnswer(plan, answer) {
  const yes = /^(y|yes|ya)\b/i.test(String(answer || '').trim());
  if (!plan || plan.action !== 'recommend-user-switch') return { proceed: true, wait: false, claimedSwitched: false, ask: false, model: plan?.activeModel || null };
  if (!yes) return { proceed: true, wait: false, claimedSwitched: false, ask: false, model: plan.activeModel, note: `continuing on ${cap(plan.activeModel)}` };
  return { proceed: false, wait: true, claimedSwitched: false, ask: false, model: plan.activeModel, instruction: `/model ${plan.desiredModel}`, note: 'RM Context cannot switch the model; type the command, then confirm so the work can continue' };
}

// Telemetry: metadata only. `actual` is what was observed (the active model), never the desired one; a switch is recorded as
// 'recommended' (not performed) unless a later observation shows a different active family (then 'observed').
export function recordSession(c, plan, { phase = null, agentCalls = null } = {}) {
  logEvent(c, { event: 'model-switch', initial: plan.initialModel, active: plan.activeModel, desired: plan.desiredModel, actual: plan.actualModel, reason: plan.reason, result: plan.action === 'recommend-user-switch' ? 'recommended-not-performed' : plan.action, phase, agentCalls, verified: false });
}
export function observeSwitch(c, prev, nowActive) {
  const a = familyOf(prev?.activeModel), b = familyOf(nowActive);
  if (a && b && a !== b) logEvent(c, { event: 'model-switch', initial: prev.initialModel, active: a, desired: prev.desiredModel, actual: b, result: b === prev.desiredModel ? 'observed-switched-to-desired' : 'observed-switched-other', verified: true });
  return a && b && a !== b;
}
