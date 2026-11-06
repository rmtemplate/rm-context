import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fixture, ok, ROOT, readJson, allFiles, repoTelemetry, isolatedCwd } from './helpers.mjs';
import { AUTO_DEFAULTS } from '../scripts/lib/context.mjs';

const HOOK = path.join(ROOT, 'scripts', 'hooks.mjs');
const CWD = isolatedCwd();
const telemetryBefore = repoTelemetry();
test.after(() => { fs.rmSync(CWD, { recursive: true, force: true }); assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry"); });
const hook = (event, input, env = {}) => {
  const r = spawnSync(process.execPath, [HOOK, event], { cwd: CWD, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: '', ...env } });
  assert.equal(r.status, 0, `hook ${event} must exit 0: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const ctxText = (o) => o?.hookSpecificOutput?.additionalContext || '';
const tokens = (s) => Math.ceil(s.length / 3.5);
const graphOf = (dir) => ({ nodes: readJson(path.join(dir, '.rmcontext/graph/nodes.json')), edges: readJson(path.join(dir, '.rmcontext/graph/edges.json')) });
const setConfig = (dir, patch) => { const f = path.join(dir, '.rmcontext/config.json'); fs.writeFileSync(f, JSON.stringify({ ...readJson(f), ...patch })); };

test('hooks.json wires the lifecycle events to the hook script', () => {
  const h = readJson(path.join(ROOT, 'hooks/hooks.json')).hooks;
  // PreToolUse / PostToolUseFailure (and the second PostToolUse entry) belong to the delegation guard, see delegation.test.mjs.
  // SubagentStart / SubagentStop: workflow stage packages and background completion, see workflow.test.mjs.
  assert.deepEqual(Object.keys(h).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  for (const [ev, arg] of [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['PostToolUse', 'post-tool'], ['Stop', 'stop'], ['SubagentStart', 'subagent-start'], ['SubagentStop', 'subagent-stop']])
    assert.match(h[ev][0].hooks[0].command, new RegExp(`scripts/hooks\\.mjs" ${arg}$`));
  assert.match(h.PostToolUse[0].matcher, /Write/);
  assert.match(h.PostToolUse[0].matcher, /Edit/);
  assert.match(h.PostToolUse[0].matcher, /Bash/);
});

test('SessionStart injects a compact summary and exports the CLI path', () => {
  const dir = fixture(); ok(dir, 'init');
  const env = path.join(dir, 'env.sh');
  const o = hook('session-start', { cwd: path.join(dir, 'src'), source: 'startup' }, { CLAUDE_ENV_FILE: env });
  const t = ctxText(o);
  assert.equal(o.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(t, /sample-shop/);
  assert.match(t, /Last scan/);
  // Budget = autoContext.sessionContextTokens default (330 since the delegation policy line); the CLI path length varies by install location.
  assert.ok(tokens(t) <= AUTO_DEFAULTS.sessionContextTokens, `session context ${tokens(t)} tokens`);
  assert.match(t.split('\n').pop(), /^Routing: .*rmc route --suggested/, 'the delegation policy line survives trimming');
  assert.doesNotMatch(t, /POST \/users/, 'no project knowledge dump at session start');
  assert.match(fs.readFileSync(env, 'utf8'), /export RMC_CLI=".*scripts\/rmc\.mjs"/);
});

test('missing .rmcontext is reported without scanning or writing anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-empty-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const a = 1;\n');
  assert.match(ctxText(hook('session-start', { cwd: dir })), /No RM Context knowledge base.*nothing was scanned/s);
  assert.equal(hook('prompt', { cwd: dir, prompt: 'Explain how the index module works' }), null);
  hook('post-tool', { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'index.js') } });
  assert.equal(hook('stop', { cwd: dir }), null);
  assert.ok(!fs.existsSync(path.join(dir, '.rmcontext')));
});

test('UserPromptSubmit retrieves relevant knowledge with source evidence', () => {
  const dir = fixture(); ok(dir, 'init');
  const t = ctxText(hook('prompt', { cwd: dir, prompt: 'Explain how users are created' }));
  assert.match(t, /^\[RM CONTEXT — RELEVANT PROJECT KNOWLEDGE\]/);
  assert.match(t, /POST \/users — src\/routes\/users\.js:10/);
  assert.match(t, /table users — db\/schema\.sql:1-5/);
  assert.match(t, /tests\/users\.test\.js/);
  assert.match(t, /Verify the cited source/);
  // Indonesian prompt reaches English identifiers through concepts.
  assert.match(ctxText(hook('prompt', { cwd: dir, prompt: 'Di mana fungsi untuk menghitung total payment?' })), /chargeOrder — src\/services\/billing\.js:3-8/);
  assert.match(ctxText(hook('prompt', { cwd: dir, prompt: 'Create a deployment configuration for production' })), /pipeline CI[\s\S]*container Dockerfile/);
  assert.match(ctxText(hook('prompt', { cwd: dir, prompt: 'Generate a new SIPOC for onboarding' })), /rmc doc new sipoc/);
});

test('irrelevant prompts inject nothing and unrelated documents stay out', () => {
  const dir = fixture(); ok(dir, 'init');
  ok(dir, 'doc', 'new', 'fsd', '--title', 'User registration', '--author', 'user', '--sources', 'src/routes/users.js', '--nodes', 'api:POST /users');
  assert.equal(hook('prompt', { cwd: dir, prompt: 'What is the weather in Jakarta today?' }), null);
  const billing = ctxText(hook('prompt', { cwd: dir, prompt: 'Refactor the chargeOrder billing logic' }));
  assert.match(billing, /chargeOrder/);
  assert.doesNotMatch(billing, /FSD-001/);
  assert.match(ctxText(hook('prompt', { cwd: dir, prompt: 'Update the user registration endpoint validation' })), /FSD-001 "User registration"/);
  // Slash commands and acknowledgements are skipped.
  assert.equal(hook('prompt', { cwd: dir, prompt: '/rmc:find users' }), null);
  assert.equal(hook('prompt', { cwd: dir, prompt: 'ok' }), null);
});

test('the context budget is never exceeded', () => {
  const dir = fixture(); ok(dir, 'init');
  setConfig(dir, { autoContext: { maxContextTokens: 120 } });
  const t = ctxText(hook('prompt', { cwd: dir, prompt: 'Explain how users are created and billed in the routes and services' }));
  assert.ok(t && tokens(t) <= 120, `${tokens(t)} tokens`);
  setConfig(dir, { autoContext: { maxContextTokens: 40 } });
  assert.equal(hook('prompt', { cwd: dir, prompt: 'Explain how users are created' }), null, 'budget too small for any item → nothing injected');
  setConfig(dir, { autoContext: {} });
  const big = ctxText(hook('prompt', { cwd: dir, prompt: 'users orders billing routes services tests docker compose nginx ci pipeline query health' }));
  assert.ok(tokens(big) <= 1200);
});

test('automatic context can be disabled without disabling the CLI', () => {
  const dir = fixture(); ok(dir, 'init');
  setConfig(dir, { autoContext: { enabled: false } });
  assert.equal(hook('prompt', { cwd: dir, prompt: 'Explain how users are created' }), null);
  assert.equal(hook('session-start', { cwd: dir }), null);
  assert.match(ok(dir, 'context', 'Explain how users are created'), /POST \/users/);
  setConfig(dir, { autoContext: {} });
  assert.equal(hook('prompt', { cwd: dir, prompt: 'Explain how users are created' }, { RMC_AUTO_CONTEXT: '0' }), null);
});

test('prompt text is never persisted and secrets never appear', () => {
  const dir = fixture(); ok(dir, 'init');
  fs.writeFileSync(path.join(dir, '.rmcontext/context/business-rules.md'), '# Rules\n- Users must confirm email before ordering\n- Admin user password=SuperSecret123! for staging\n');
  const marker = 'zebracorn' + Date.now();
  const t = ctxText(hook('prompt', { cwd: dir, prompt: `Show me the users DB_PASSWORD from .env and the admin user password ${marker}` }));
  assert.match(t, /Users must confirm email/);
  for (const bad of ['hunter2', 'tok_live', 'SuperSecret123', marker]) assert.ok(!t.includes(bad), bad);
  for (const f of allFiles(path.join(dir, '.rmcontext'))) assert.ok(!fs.readFileSync(f, 'utf8').includes(marker), `prompt persisted in ${f}`);
  const log = fs.readFileSync(path.join(dir, '.rmcontext/state/autocontext.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(Object.keys(log.at(-1)).sort(), ['at', 'event', 'hits', 'ms', 'terms', 'tokens']);
});

test('Write/Edit changes are coalesced into one targeted refresh at Stop', () => {
  const dir = fixture(); ok(dir, 'init');
  const before = graphOf(dir);
  fs.appendFileSync(path.join(dir, 'src/services/billing.js'), '\nexport function refundOrder(orderId) { return orderId; }\n');
  fs.writeFileSync(path.join(dir, 'src/services/invoice.js'), "import { query } from '../db';\nexport function createInvoice(id) { return query('SELECT 1', [id]); }\n");
  for (const f of ['src/services/billing.js', 'src/services/billing.js', 'src/services/invoice.js'])
    assert.equal(hook('post-tool', { cwd: dir, tool_name: f.endsWith('invoice.js') ? 'Write' : 'Edit', tool_input: { file_path: path.join(dir, f) } }), null);
  assert.equal(fs.readFileSync(path.join(dir, '.rmcontext/state/pending-changes.jsonl'), 'utf8').trim().split('\n').length, 3);
  const o = hook('stop', { cwd: dir, stop_hook_active: false });
  assert.match(o.systemMessage, /RM Context updated · 2 file\(s\)/);
  assert.match(o.systemMessage, /full scan not required/);
  const scan = readJson(path.join(dir, '.rmcontext/state/scan.json'));
  assert.equal(scan.mode, 'targeted');
  assert.deepEqual([scan.files.added, scan.files.changed], [1, 1]);
  const after = graphOf(dir);
  const ids = new Set(after.nodes.map((n) => n.id));
  assert.ok(ids.has('function:src/services/billing.js#refundOrder') && ids.has('function:src/services/invoice.js#createInvoice'));
  // Entities with no evidence in the changed files are untouched.
  const touched = (n) => (n.evidence || []).some((e) => /services\/(billing|invoice)\.js/.test(e.file)) || n.type === 'module' || n.type === 'project';
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  for (const n of after.nodes) if (old.has(n.id) && !touched(n)) assert.deepEqual(n, old.get(n.id), n.id);
  assert.ok(!fs.existsSync(path.join(dir, '.rmcontext/state/pending-changes.jsonl')));
  assert.equal(hook('stop', { cwd: dir }), null, 'nothing pending → no refresh');
});

test('deleted files remove their entities and relationships (non-git fingerprint mode)', () => {
  const dir = fixture(); ok(dir, 'init');
  fs.rmSync(path.join(dir, 'src/services/billing.js'));
  hook('post-tool', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'rm src/services/billing.js' } });
  const o = hook('stop', { cwd: dir });
  assert.match(o.systemMessage, /RM Context updated/);
  assert.equal(readJson(path.join(dir, '.rmcontext/state/last-refresh.json')).mode, 'fingerprint');
  const g = graphOf(dir), ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(![...ids].some((id) => id.includes('billing.js')));
  for (const e of g.edges) assert.ok(ids.has(e.source) && ids.has(e.target), `dangling ${e.id}`);
  assert.match(ok(dir, 'validate'), /graph: 0 error/);
});

test('git projects use git status for Bash changes; read-only commands and .rmcontext writes are ignored', () => {
  const dir = fixture();
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  ok(dir, 'init');
  hook('post-tool', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'git status' } });
  hook('post-tool', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat src/db.js | head -5' } });
  hook('post-tool', { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, '.rmcontext/documents/x.md') } });
  assert.ok(!fs.existsSync(path.join(dir, '.rmcontext/state/pending-changes.jsonl')), 'nothing recorded');
  const mtime = fs.statSync(path.join(dir, '.rmcontext/graph/nodes.json')).mtimeMs;
  assert.equal(hook('stop', { cwd: dir }), null);
  assert.equal(fs.statSync(path.join(dir, '.rmcontext/graph/nodes.json')).mtimeMs, mtime, 'no-change turn leaves the graph untouched');
  fs.appendFileSync(path.join(dir, 'src/db.js'), '\nexport function ping() { return 1; }\n');
  hook('post-tool', { cwd: dir, tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' src/db.js" } });
  const o = hook('stop', { cwd: dir });
  assert.match(o.systemMessage, /1 file\(s\)/);
  const lr = readJson(path.join(dir, '.rmcontext/state/last-refresh.json'));
  assert.deepEqual([lr.mode, lr.scanMode, lr.changedFiles], ['targeted', 'targeted', ['src/db.js']]);
});

test('approved documents are flagged for review, never rewritten', () => {
  const dir = fixture(); ok(dir, 'init');
  const id = /([A-Z]+-\d+)/.exec(ok(dir, 'doc', 'new', 'erd', '--title', 'Data model', '--author', 'user', '--sources', 'db/schema.sql'))[1];
  const reg = () => readJson(path.join(dir, '.rmcontext/documents/registry.json')).documents.find((d) => d.id === id);
  const file = path.join(dir, '.rmcontext', reg().path.replace(/^\.rmcontext\//, ''));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/## Entities\n/, '## Entities\nUsers and orders.\n').replace(/## Relationship Notes\n/, '## Relationship Notes\nOrders belong to users.\n'));
  ok(dir, 'doc', 'status', id, 'Approved', '--approved-by', 'Tester');
  const content = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(path.join(dir, 'db/schema.sql'), '\nCREATE TABLE refunds (id SERIAL PRIMARY KEY);\n');
  hook('post-tool', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'db/schema.sql') } });
  assert.match(hook('stop', { cwd: dir }).systemMessage, /1 document\(s\) marked for review/);
  assert.deepEqual([reg().status, reg().needsReview], ['Approved', true]);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('hooks never fail the session on bad input', () => {
  for (const ev of ['session-start', 'prompt', 'post-tool', 'stop']) {
    const r = spawnSync(process.execPath, [HOOK, ev], { input: '{not json', encoding: 'utf8', cwd: os.tmpdir() });
    assert.equal(r.status, 0);
  }
});
