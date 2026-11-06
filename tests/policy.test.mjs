// Project policy: the CLAUDE.md managed section written by rmc init, role-aware model routing, and the knowledge-first,
// reuse-first, minimal-code workflow policy. Agent runs are stubbed with synthetic transcripts (as in workflow.test.mjs):
// no model is called and no Claude Code session is started. Everything lives in temp dirs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ok, ROOT, repoTelemetry } from './helpers.mjs';

const CLI = path.join(ROOT, 'scripts', 'rmc.mjs');
const HOOK = path.join(ROOT, 'scripts', 'hooks.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-policy-test-'));
const BASE = `pol-${process.pid}`;
const ID = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const BEGIN = '<!-- BEGIN RM CONTEXT';
const END = '<!-- END RM CONTEXT -->';
let telemetryBefore, n = 0;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => {
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`rmc-session-${BASE}-`) || f.startsWith(`rmc-delegation-${BASE}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry");
});

// A node-app project with extra source written before the first scan, so the knowledge graph knows it.
function project({ files = {}, config, claudeMd } = {}) {
  const dir = fixture('node-app');
  for (const f of ['.env', 'keys', 'backups']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  if (claudeMd != null) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
  ok(dir, 'init');
  if (config) { const f = path.join(dir, '.rmcontext/config.json'); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...config })); }
  const sid = `${BASE}-${++n}`;
  const main = path.join(TMP, `${sid}.jsonl`);
  fs.writeFileSync(main, '');
  return { dir, sid, main };
}
const cli = (p, args, input, env = {}) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: p.dir, input: input ?? '', encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: p.sid, ...env } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const run = (p, args, input, env) => { const r = cli(p, args, input, env); assert.equal(r.code, 0, r.err || r.out); return r.out; };
const refused = (p, args, re, input) => { const r = cli(p, args, input); assert.notEqual(r.code, 0, r.out); assert.match(r.err, re); };
const route = (p, ...a) => JSON.parse(run(p, ['route', ...a, '--json', '--no-record']));
function hook(p, event, x = {}) {
  const r = spawnSync(process.execPath, [HOOK, event], { cwd: p.dir, input: JSON.stringify({ cwd: p.dir, session_id: p.sid, transcript_path: p.main, ...x }), encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: '' } });
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const line = (id, model) => JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: new Date().toISOString(),
  message: { id, model, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } }) + '\n';
let seq = 0;
// One foreground Agent call as Claude Code reports it; `actual` is the model the synthetic transcript says ran.
function agent(p, role, model, { actual = ID[model] } = {}) {
  const id = `pa${++seq}`, tu = `toolu-${id}`, ti = { subagent_type: `rmc:${role}`, model, prompt: 'the task' };
  const pre = hook(p, 'pre-agent', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: tu, tool_input: ti })?.hookSpecificOutput;
  if (pre?.permissionDecision === 'deny') return { denied: pre.permissionDecisionReason };
  const context = hook(p, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: id, agent_type: `rmc:${role}` })?.hookSpecificOutput?.additionalContext || null;
  const dir = path.join(p.main.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${id}.jsonl`);
  fs.writeFileSync(file, line(`m-${id}`, actual));
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ requestShape: 'foreground' }));
  hook(p, 'subagent-stop', { hook_event_name: 'SubagentStop', agent_id: id, agent_type: `rmc:${role}`, agent_transcript_path: file, last_assistant_message: 'x' });
  hook(p, 'post-agent', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tu, tool_input: ti, tool_response: { agentId: id, totalDurationMs: 400 } });
  return { id, context };
}
const HANDOFF = (o = {}) => JSON.stringify({ summary: 'Done.', artifacts: ['src/routes/users.js'], decisions: [], assumptions: [], openQuestions: [], nodes: [], ...o });
const plan = (p, task, extra = []) => JSON.parse(run(p, ['workflow', 'plan', '--session-model', 'claude-opus-5-5', '--json', ...extra], task));
const claudeMd = (p) => fs.readFileSync(path.join(p.dir, 'CLAUDE.md'), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;
// Starts the next stage and runs its agent with the model the stage asks for.
const step = (p, w, role, opts) => { run(p, ['workflow', 'start', w.id]); const s = JSON.parse(fs.readFileSync(path.join(p.dir, '.rmcontext/state/workflows', `${w.id}.json`), 'utf8')).stages.find((x) => x.status === 'running'); return { s, ...agent(p, role, s.model, opts) }; };

const PAGINATE = 'export function paginate(rows, page = 1, limit = 20) {\n  return rows.slice((page - 1) * limit, page * limit);\n}\n';
const USER_DTO = 'export class UserQueryDto {\n  page = 1;\n  limit = 20;\n}\n';
const INVOICE = 'export function computeInvoiceTotal(lines) {\n  return lines.reduce((t, l) => t + l.amount, 0);\n}\n';

// ---------- A. CLAUDE.md managed section ----------

test('rmc init creates CLAUDE.md with the knowledge-first, reuse-first section when it is missing', () => {
  const p = project();
  const md = claudeMd(p);
  assert.equal(count(md, BEGIN), 1);
  assert.equal(count(md, END), 1);
  // Knowledge first, with the fallback order and no needless full scans.
  assert.match(md, /\*\*Knowledge first\.\*\*[^\n]*\.rmcontext\/[^\n]*before exploring source/);
  assert.match(md, /open only the files it does not cover/);
  assert.match(md, /No full scan while it is fresh/);
  assert.match(md, /provenance, confidence[^\n]*lifecycle and freshness/);
  assert.match(md, /Source, schema, config and actual behaviour win/);
  assert.match(md, /Never invent knowledge/);
  // Reuse first and the smallest correct change.
  assert.match(md, /\*\*Reuse first\.\*\*[^\n]*component, function, service, DTO, type/);
  assert.match(md, /\*\*Smallest correct change\.\*\*/);
  assert.match(md, /Never trade away readability, types, error handling, authorization or business rules/);
  // /rmc:run for multi-stage work, but simple work is done directly.
  assert.match(md, /Simple questions and small edits: do them directly/);
  assert.match(md, /Multi-stage work \(analysis → implementation → verification\)[^\n]*\/rmc:run <task>/);
  assert.match(md, /hand-offs between stages/);
  assert.match(md, /never because a tool call succeeded/);
  // Compact: the whole section stays a small, fixed cost per session (≈ 3.5 characters per token).
  const section = md.slice(md.indexOf(BEGIN), md.indexOf(END) + END.length);
  assert.ok(section.length / 3.5 < 650, `section is ${Math.ceil(section.length / 3.5)} estimated tokens`);
  assert.doesNotMatch(section, /[a-z]:\\|\/home\/|\/Users\/|plugins\/cache/i, 'no machine-specific path or plugin version in CLAUDE.md');
});

test('an existing CLAUDE.md keeps every user instruction; repeated init and rmc claude-md are idempotent', () => {
  const user = '# Team rules\r\n\r\nAlways run `npm test` before committing.\r\nNever edit db/schema.sql by hand.\r\n';
  const p = project({ claudeMd: user });
  const first = claudeMd(p);
  assert.ok(first.startsWith(user), 'the user text is kept byte for byte');
  assert.match(first, /\r\n<!-- BEGIN RM CONTEXT[\s\S]*<!-- END RM CONTEXT -->\r\n$/, 'the section follows the file\'s CRLF line endings');
  assert.doesNotMatch(first.replace(/\r\n/g, ''), /\n/, 'no bare LF lines mixed into a CRLF file');
  // Running init again (and the refresh path of /rmc:init) does not change or duplicate anything.
  ok(p.dir, 'init');
  assert.equal(claudeMd(p), first);
  assert.match(run(p, ['claude-md']), /section unchanged/);
  assert.match(run(p, ['claude-md', '--check']), /CLAUDE\.md: current — managed section is current \(policy 2\)/);
  // Edits inside the markers are replaced; text the user adds after the section is kept.
  fs.writeFileSync(path.join(p.dir, 'CLAUDE.md'), first.replace('**Reuse first.**', '**Reuse maybe.**') + '\r\n## Local notes\r\nUse port 3001.\r\n');
  assert.match(run(p, ['claude-md', '--check']), /CLAUDE\.md: modified — managed section \(policy 2\) was edited by hand/);
  assert.match(run(p, ['claude-md']), /section updated/);
  const after = claudeMd(p);
  assert.ok(after.startsWith(user));
  assert.match(after, /\*\*Reuse first\.\*\*/);
  assert.doesNotMatch(after, /Reuse maybe/);
  assert.match(after, /## Local notes\r\nUse port 3001\.\r\n$/);
  assert.equal(count(after, BEGIN), 1);
});

test('duplicate managed sections collapse into one; opting out leaves CLAUDE.md alone; the global CLAUDE.md is never touched', () => {
  const p = project();
  const block = claudeMd(p).trim();
  fs.writeFileSync(path.join(p.dir, 'CLAUDE.md'), `${block}\n\n# Mine\nKeep me.\n\n${block}\n`);
  run(p, ['claude-md']);
  const md = claudeMd(p);
  assert.equal(count(md, BEGIN), 1);
  assert.equal(count(md, END), 1);
  assert.match(md, /# Mine\nKeep me\./);
  // Opt-outs: --no-claude-md, and "claudeMd": false in .rmcontext/config.json.
  const q = fixture('node-app');
  ok(q, 'init', '--no-claude-md');
  assert.equal(fs.existsSync(path.join(q, 'CLAUDE.md')), false);
  const f = path.join(q, '.rmcontext/config.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), claudeMd: false }));
  assert.match(ok(q, 'claude-md'), /disabled/);
  assert.equal(fs.existsSync(path.join(q, 'CLAUDE.md')), false);
  // The user's global ~/.claude/CLAUDE.md is outside the project and is never read or written.
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'global rules\n');
  const before_ = fs.statSync(path.join(home, '.claude', 'CLAUDE.md')).mtimeMs;
  const r = fixture('node-app');
  const out = spawnSync(process.execPath, [CLI, 'init'], { cwd: r, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, RMC_SESSION_ID: '' } });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'global rules\n');
  assert.equal(fs.statSync(path.join(home, '.claude', 'CLAUDE.md')).mtimeMs, before_);
  assert.ok(fs.existsSync(path.join(r, 'CLAUDE.md')));
});

// ---------- B–E. Role-aware model routing ----------

test('an Opus main session does not make every agent Opus: each role keeps its own model', () => {
  const p = project();
  for (const [args, model] of [[['--category', 'bug-fix'], 'sonnet'], [['--category', 'search'], 'haiku'], [['--category', 'fsd'], 'sonnet'], [['--category', 'architecture'], 'opus']]) {
    const r = route(p, ...args, '--session-model', 'claude-opus-5-5');
    assert.equal(r.model, model, args.join(' '));
    assert.equal(r.sessionModel, 'opus', 'the main session model is recorded separately');
    assert.notEqual(r.source, 'user', 'the main session model is not an explicit user override');
  }
  const w = plan(p, 'Implement a new feature: add pagination to the users API endpoint');
  assert.deepEqual(w.stages.map((s) => [s.agent, s.model, s.source]), [['system-analyst', 'sonnet', 'adaptive'], ['senior-engineer', 'sonnet', 'adaptive'], ['quick-qa', 'haiku', 'adaptive']]);
  assert.equal(w.sessionModel, 'claude-opus-5-5');
});

test('Senior Engineer codes on Sonnet at medium and high complexity; Opus only for security-critical or fundamental design analysis', () => {
  const p = project();
  for (const c of ['bug-fix', 'small-change', 'small-feature']) assert.deepEqual([route(p, '--category', c).model, route(p, '--category', c).complexity], ['sonnet', 'medium'], c);
  for (const [c, sig] of [['complex-feature', 'code,modules:3'], ['refactor', 'cross-module'], ['debugging', ''], ['migration', 'irreversible'], ['bug-fix', 'architecture,cross-module']]) {
    const r = route(p, '--category', c, ...(sig ? ['--signals', sig] : []));
    assert.deepEqual([r.agent, r.model, r.complexity], ['senior-engineer', 'sonnet', 'high'], `${c} ${sig}`);
    assert.match(r.basis, /senior-engineer role policy: high → sonnet/);
  }
  // Security: a standard review is Sonnet; auth, payment or sensitive data is security-critical analysis → Opus.
  assert.equal(route(p, '--category', 'security').model, 'sonnet');
  const critical = route(p, '--category', 'security', '--signals', 'sensitive');
  assert.deepEqual([critical.model, critical.basis], ['opus', 'senior-engineer role policy: high + sensitive → opus']);
  assert.equal(route(p, '--category', 'adr', '--signals', 'architecture,ambiguous').model, 'opus', 'a fundamental architecture trade-off');
  // A sensitive implementation still goes to Sonnet: the deep model applies to analysis categories only.
  assert.equal(route(p, '--category', 'bug-fix', '--signals', 'security,sensitive').model, 'sonnet');
});

test('Architecture high can select Opus; System Analyst by ambiguity; Quick QA low is Haiku; complex QA is Sonnet, security-critical QA Opus', () => {
  const p = project();
  assert.equal(route(p, '--category', 'architecture').model, 'opus');
  assert.equal(route(p, '--category', 'repo-analysis').model, 'sonnet', 'standard architecture evaluation');
  assert.equal(route(p, '--category', 'impact', '--signals', 'cross-module').model, 'sonnet', 'high without a deep condition stays Sonnet');
  assert.equal(route(p, '--category', 'impact', '--signals', 'cross-module,ambiguous').model, 'opus');
  assert.equal(route(p, '--category', 'system-analysis').model, 'sonnet');
  assert.equal(route(p, '--category', 'system-analysis', '--signals', 'cross-module').model, 'opus', 'cross-system impact');
  assert.equal(route(p, '--category', 'srs', '--signals', 'ambiguous').model, 'sonnet', 'ambiguity alone is medium');
  const q = route(p, '--category', 'search');
  assert.deepEqual([q.agent, q.model, q.complexity], ['quick-qa', 'haiku', 'low']);
  assert.equal(route(p, '--category', 'verification').model, 'haiku');
  const qa = route(p, '--category', 'qa', '--signals', 'cross-module,code');
  assert.deepEqual([qa.agent, qa.model, qa.complexity], ['qa', 'sonnet', 'high']);
  assert.equal(route(p, '--category', 'qa').model, 'sonnet', 'QA is not lowered to Haiku to save tokens');
  assert.equal(route(p, '--category', 'qa', '--signals', 'security,sensitive').model, 'opus');
  // Documentation, BA and PM: Haiku for simple structured work, Sonnet for analysis and planning.
  assert.equal(route(p, '--category', 'doc-update').model, 'haiku');
  assert.equal(route(p, '--category', 'doc-update', '--signals', 'cross-module').model, 'sonnet', 'a lot of text is not a reason for Opus');
  assert.equal(route(p, '--category', 'fsd').model, 'sonnet');
  assert.equal(route(p, '--category', 'plan').model, 'sonnet');
  assert.equal(route(p, '--category', 'gantt', '--signals', 'trivial').model, 'haiku');
});

test('explicit user models and project overrides are still honoured over the role policy', () => {
  const p = project();
  assert.deepEqual([route(p, '--category', 'bug-fix', '--model', 'opus').model, route(p, '--category', 'bug-fix', '--model', 'opus').source], ['opus', 'user']);
  assert.deepEqual([route(p, '--category', 'architecture', '--model', 'haiku').model, route(p, '--category', 'architecture', '--model', 'haiku').source], ['haiku', 'user']);
  const all = plan(p, 'Implement a new feature: add pagination to the users API endpoint', ['--model', 'opus']);
  assert.deepEqual(all.stages.map((s) => [s.model, s.source]), [['opus', 'user'], ['opus', 'user'], ['opus', 'user']], '"use Opus for every stage"');
  run(p, ['workflow', 'cancel', all.id]);
  const f = path.join(p.dir, '.rmcontext/config.json');
  const set = (patch) => fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }));
  set({ models: { 'senior-engineer': 'opus' } });
  assert.deepEqual([route(p, '--category', 'bug-fix').model, route(p, '--category', 'bug-fix').source], ['opus', 'project']);
  set({ models: {}, roles: { 'senior-engineer': { high: 'opus' } } });
  assert.equal(route(p, '--category', 'refactor').model, 'opus', 'a project role policy override');
  assert.equal(route(p, '--category', 'bug-fix').model, 'sonnet', 'only the overridden tier changes');
  set({ roles: {}, tiers: { medium: 'haiku' } });
  assert.match(route(p, '--category', 'bug-fix').basis, /project tier mapping: medium → haiku/);
  set({ tiers: {}, roles: { 'not-an-agent': { high: 'opus' }, qa: { high: 'gpt-5' } } });
  const v = cli(p, ['validate']);
  assert.match(v.out + v.err, /config\.roles\.not-an-agent: unknown agent/);
  assert.match(v.out + v.err, /config\.roles\.qa\.high must be a model alias/);
});

test('the actual model comes from the transcript and stays separate from the requested model; the report shows tier, basis and escalation', () => {
  const p = project();
  const w = plan(p, 'fix the bug in the users endpoint returning 500');
  const { s } = step(p, w, 'senior-engineer', { actual: ID.haiku });
  assert.equal(s.model, 'sonnet');
  run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF());
  const st = run(p, ['workflow', 'status', w.id]);
  assert.match(st, /\| Stage \| Agent \| Tier \| Requested \| Actual \(transcript\) \| Mode \| Status \| Attempts \| Escalated \|/);
  assert.match(st, /\| S1 implement \| senior-engineer \| medium \| sonnet \| claude-haiku-5-5 \| foreground \| passed \| 1 \| no \|/);
  assert.match(st, /- S1 Senior Engineer: sonnet — senior-engineer role policy: medium → sonnet/);
  assert.match(st, /Est\. cost/);
});

test('escalation: one step to the next stronger model the role allows, with evidence; missing context is fixed with context, not a bigger model', () => {
  const p = project();
  const first = JSON.parse(run(p, ['route', '--category', 'bug-fix', '--json']));
  assert.equal(first.model, 'sonnet');
  fs.writeFileSync(path.join(p.dir, 'h.json'), JSON.stringify({ from: 'senior-engineer', to: 'orchestrator', summary: 'Race between the retry worker and the API', artifacts: ['src/services/billing.js'] }));
  const hid = /H-[a-z0-9]+/.exec(run(p, ['handoff', 'add', 'h.json']))[0];
  refused(p, ['route', '--escalate', first.id, '--reason', 'missing context about the billing schema', '--handoff', hid], /missing context, not a reasoning limit/);
  refused(p, ['route', '--escalate', first.id, '--reason', 'kurang informasi tentang skema', '--handoff', hid], /missing context/);
  const esc = JSON.parse(run(p, ['route', '--escalate', first.id, '--reason', 'two plausible designs; the trade-off spans billing and users', '--handoff', hid, '--json']));
  assert.deepEqual([esc.model, esc.escalations, esc.escalatedFrom, esc.basis], ['opus', 1, first.id, 'escalation: sonnet → opus']);
  refused(p, ['route', '--escalate', esc.id, '--reason', 'still hard', '--handoff', hid], /strongest model|maxEscalations/);
  // Quick QA tops out at Sonnet.
  const qq = JSON.parse(run(p, ['route', '--category', 'search', '--json']));
  const qesc = JSON.parse(run(p, ['route', '--escalate', qq.id, '--reason', 'the lookup needs reasoning across modules', '--handoff', hid, '--json']));
  assert.equal(qesc.model, 'sonnet');
  // In a workflow, --escalate with a missing-context reason retries on the same model with the hand-off as input.
  const w = plan(p, 'fix the bug in the users endpoint returning 500');
  step(p, w, 'senior-engineer');
  const out = run(p, ['workflow', 'done', w.id, 'S1', '--status', 'fail', '--escalate', '--reason', 'missing context: the users schema', '--handoff', '-'], HANDOFF({ summary: 'Need the schema.' }));
  assert.match(out, /not escalated: "missing context: the users schema" is missing context, so the retry keeps sonnet/);
  const again = step(p, w, 'senior-engineer');
  assert.deepEqual([again.s.model, again.s.escalations], ['sonnet', 0]);
});

test('older workflow files without tier basis, intents or checks still report and are not broken', () => {
  const p = project();
  const dir = path.join(p.dir, '.rmcontext/state/workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'W-legacy1.json'), JSON.stringify({ id: 'W-legacy1', at: '2026-11-01T00:00:00Z', status: 'completed', category: 'bug-fix', signals: ['code'], risk: 'normal', criteria: [],
    limits: { maxAttempts: 2, maxQaLoops: 2 }, qaLoops: 0, stages: [{ id: 'S1', role: 'implement', agent: 'senior-engineer', category: 'bug-fix', model: 'opus', tier: 'medium', source: 'adaptive', status: 'passed', attempts: 1, escalations: 0, runs: [], knowledge: { hits: 0 } }] }));
  const st = run(p, ['workflow', 'status', 'W-legacy1']);
  assert.match(st, /\| S1 implement \| senior-engineer \| medium \| opus \|/);
  assert.match(st, /- S1 Senior Engineer: opus — adaptive/);
  assert.match(run(p, ['workflow', 'list']), /W-legacy1/);
});

// ---------- Knowledge-first, reuse-first, minimal code ----------

test('stage packages carry the relevant knowledge and the knowledge-first policy; missing knowledge allows targeted exploration only', () => {
  const p = project({ files: { 'src/lib/paginate.js': PAGINATE, 'src/billing/invoice.js': INVOICE } });
  const w = plan(p, 'fix GET /users to use the paginate helper');
  const { context } = step(p, w, 'senior-engineer');
  assert.match(context, /Knowledge policy: knowledge first — start from the input hand-off and the entries below; do not repeat an earlier stage's analysis or scan the repository/);
  assert.match(context, /src\/routes\/users\.js/, 'the relevant module is in the package');
  assert.match(context, /paginate[^\n]*src\/lib\/paginate\.js/, 'the existing helper is found through the knowledge');
  assert.doesNotMatch(context, /computeInvoiceTotal|src\/billing\/invoice\.js/, 'unrelated knowledge is not sent');
  assert.ok(w.stages[0].knowledge.tokens <= 900, 'the knowledge part is capped');
  assert.match(context, /smallest correct change[\s\S]*reuse or extend the existing component, function, service, DTO, type or utility/);
  assert.match(context, /"reused": \[[^\]]*\], "created": \[[^\]]*\], "inspected": \[/);
  run(p, ['workflow', 'cancel', w.id]);
  // No matching knowledge: the agent may inspect, but only what the task needs.
  const q = project();
  const none = plan(q, 'fix the bug where zorblax quux frobnicates');
  const c2 = step(q, none, 'senior-engineer').context;
  assert.match(c2, /No recorded knowledge matched this stage: inspect only the files the task or the hand-off names/);
});

test('stale knowledge is marked for a targeted re-read of that file only', () => {
  const p = project();
  fs.appendFileSync(path.join(p.dir, 'src/routes/users.js'), '\n// changed after the scan\n');
  const w = plan(p, 'fix the bug in GET /users in src/routes/users.js');
  const { context } = step(p, w, 'senior-engineer');
  assert.match(context, /\[stale\]/);
  assert.match(context, /\[stale\] = the file changed since the last scan: re-read only that file/);
  assert.match(context, /Source, schema and config win on conflict/);
});

test('a re-defined DTO or helper that already exists is flagged to QA and in the report; QA checks duplication and the criteria gate still holds', () => {
  const p = project({ files: { 'src/lib/paginate.js': PAGINATE, 'src/dto/user-query.js': USER_DTO } });
  const w = plan(p, 'fix the bug in the users endpoint so GET /users paginates', ['--criteria', 'GET /users returns at most 20 users']);
  assert.deepEqual(w.stages.map((s) => s.role), ['implement', 'verify']);
  step(p, w, 'senior-engineer');
  run(p, ['workflow', 'done', w.id, 'S1', '--status', 'pass', '--handoff', '-'], HANDOFF({ summary: 'Paginated GET /users.',
    reused: ['query from src/db.js'], created: ['UserQueryDto in src/routes/users.js', 'paginate() in src/routes/users.js'], inspected: ['src/routes/users.js', 'src/db.js'], explorationReason: '' }));
  refused(p, ['workflow', 'finish', w.id], /not complete|no verification stage passed/);
  const { context } = step(p, w, 'quick-qa');
  assert.match(context, /Reuse check: the implementation reports creating UserQueryDto \(an existing class UserQueryDto is recorded at src\/dto\/user-query\.js:\d+\)/);
  assert.match(context, /paginate \(an existing function paginate is recorded at src\/lib\/paginate\.js:\d+\)/);
  assert.match(context, /check for needless duplication: a re-defined DTO\/type\/interface, logic copied instead of reused/);
  assert.match(context, /do not ask for cosmetic refactoring/);
  assert.match(context, /C1\) GET \/users returns at most 20 users/);
  refused(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], /C1 not proven/, HANDOFF({ verdict: 'pass' }));
  run(p, ['workflow', 'done', w.id, 'S2', '--status', 'pass', '--handoff', '-'], HANDOFF({ verdict: 'pass', criteria: [{ id: 'C1', status: 'pass', evidence: 'tests/users.test.js: 20 rows' }] }));
  const fin = run(p, ['workflow', 'finish', w.id]);
  assert.match(fin, /Reuse: existing reused: query from src\/db\.js/);
  assert.match(fin, /Reuse: new created: UserQueryDto in src\/routes\/users\.js; paginate\(\) in src\/routes\/users\.js/);
  assert.match(fin, /Source files inspected: src\/routes\/users\.js; src\/db\.js/);
  assert.match(fin, /Possible duplicates \(name already in the knowledge graph\): UserQueryDto ↔ class UserQueryDto at src\/dto\/user-query\.js:\d+; paginate ↔ function paginate at src\/lib\/paginate\.js:\d+/);
  assert.match(fin, /Acceptance criteria: 1\/1 verified/);
  // A created item with no existing counterpart is not flagged.
  assert.doesNotMatch(fin, /Possible duplicates[^\n]*query from/);
});

test('agent instructions carry the knowledge-first, reuse-first and minimal-code policy', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const se = read('agents/senior-engineer.md');
  assert.match(se, /\*\*Knowledge first\.\*\*[^\n]*Do not redo an analysis/);
  assert.match(se, /\*\*Reuse first\.\*\*[^\n]*check its consumers/);
  assert.match(se, /\*\*Smallest correct change\.\*\*/);
  assert.match(se, /Report what you reused[^\n]*`reused`, `created`, `inspected`/);
  assert.match(read('agents/system-analyst.md'), /Do not repeat a discovery that is already recorded/);
  assert.match(read('agents/qa.md'), /needless duplication: a re-defined DTO, type or interface[^\n]*Do not ask for cosmetic refactoring/);
  assert.match(read('agents/quick-qa.md'), /flag a re-defined DTO, type or function/);
  const sk = read('skills/software-engineering/SKILL.md');
  assert.match(sk, /## Reuse first, smallest correct change/);
  assert.match(sk, /BaseDataTable/);
  assert.match(read('skills/team-workflows/SKILL.md'), /\.rmcontext\/` knowledge → targeted source inspection → broader exploration only when necessary/);
  for (const a of ['senior-engineer', 'system-analyst', 'business-analyst']) assert.match(read(`agents/${a}.md`), /^model: sonnet$/m, a);
});
