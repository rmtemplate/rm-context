// Targeted retrieval for workflow stage packages: per subtask, criterion and identifier, merged and deduplicated,
// with reuse candidates from the dependency graph and retrieval diagnostics. Deterministic; temp projects only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ok, ROOT, repoTelemetry, readJson } from './helpers.mjs';
import { ctx } from '../scripts/lib/util.mjs';
import { retrieve, retrieveTargeted, identifiersOf, subtasksOf } from '../scripts/lib/context.mjs';

const CLI = path.join(ROOT, 'scripts', 'rmc.mjs');
const BASE = `ret-${process.pid}`;
let telemetryBefore, n = 0;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => {
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`rmc-session-${BASE}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry");
});

const FILES = {
  'src/lib/paginate.js': 'export function paginate(rows, page = 1, limit = 20) {\n  return rows.slice((page - 1) * limit, page * limit);\n}\n',
  'src/lib/money.js': 'export function formatCurrency(amount, currency = "IDR") {\n  return new Intl.NumberFormat("id-ID", { style: "currency", currency }).format(amount);\n}\n',
  'src/services/report.js': "import { paginate } from '../lib/paginate.js';\nexport function monthlyReport(rows, page) {\n  return paginate(rows, page);\n}\n",
  'src/billing/invoice.js': 'export function computeInvoiceTotal(lines) {\n  return lines.reduce((t, l) => t + l.amount, 0);\n}\n',
};
function project() {
  const dir = fixture('node-app');
  for (const f of ['.env', 'keys', 'backups']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  for (const [f, body] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  ok(dir, 'init');
  return { dir, sid: `${BASE}-${++n}`, c: ctx(dir) };
}
const run = (p, args, input = '') => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: p.dir, input, encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: p.sid } }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const plan = (p, task, criteria) => JSON.parse(run(p, ['workflow', 'plan', '--json', ...(criteria ? ['--criteria', criteria.join('; ')] : [])], task));
const pkg = (p, w, s = 'S1') => { run(p, ['workflow', 'start', w.id]); return run(p, ['workflow', 'context', w.id, s]); };
const diag = (p, w, s = 'S1') => JSON.parse(run(p, ['workflow', 'context', w.id, s, '--diagnostics', '--json']));
const IMPL = ['reuse', 'impl', 'apis', 'data', 'tests', 'notes'];

const LONG = 'Fix the bug in the users endpoint where every user is returned at once: analyse how the users list is produced, use the paginate helper so that the list is split into pages, make sure the page and limit query parameters are read correctly, keep the response format unchanged for existing clients, and then verify the result with the existing tests and new ones.';
const CRITERIA = ['GET /users returns at most 20 users per page', 'the page parameter is validated', 'a negative page returns 400', 'existing tests keep passing', 'the response keeps its current fields'];

test('a short prompt finds the existing helper and offers it as a reusable implementation', () => {
  const p = project();
  const w = plan(p, 'fix GET /users to use the paginate helper');
  const text = pkg(p, w);
  assert.match(text, /Reusable implementations:\n- function paginate — src\/lib\/paginate\.js:1-3/);
  assert.ok(diag(p, w).reuse.includes('function:src/lib/paginate.js#paginate'));
});

test('a long prompt with many acceptance criteria still finds the helper; the whole-prompt ranking alone misses it', () => {
  const p = project();
  const mid = 'fix the bug in the users endpoint: use the paginate helper in src/routes/users.js';
  // Before: one ranking over the whole prompt drops the helper below minimumRelevance.
  assert.doesNotMatch(retrieve(p.c, mid, { sections: IMPL, maxContextTokens: 900 }).text, /paginate\.js/);
  // After: the clause and the identifier are ranked on their own.
  assert.match(retrieveTargeted(p.c, mid, { sections: IMPL, maxContextTokens: 900 }).text, /function paginate — src\/lib\/paginate\.js/);
  const w = plan(p, LONG, CRITERIA);
  assert.deepEqual(w.stages.map((s) => s.role), ['analysis', 'implement', 'verify']);
  run(p, ['workflow', 'start', w.id]);
  for (const s of w.stages) assert.match(s.knowledge.text, /function paginate — src\/lib\/paginate\.js/, `${s.id} ${s.role}`);
  const d = w.stages[1].knowledge.diag;
  assert.deepEqual([d.subtasks >= 2, d.criteria], [true, 5]);
  assert.ok(d.identifiers.includes('paginate'));
});

test('an explicit identifier is not drowned by the rest of the prompt', () => {
  const p = project();
  const task = 'Fix the invoice summary page so that every amount shown to the customer in the monthly overview, the yearly overview, the export and the e-mail uses formatCurrency instead of the ad-hoc string concatenation that is spread over several places today';
  assert.ok(identifiersOf(task).includes('formatCurrency'));
  const w = plan(p, task);
  const text = pkg(p, w);
  assert.match(text, /function formatCurrency — src\/lib\/money\.js:1-3 \(matches identifier formatCurrency/);
  assert.ok(diag(p, w).identifiers.includes('formatCurrency'));
});

test('a helper reached through the dependency graph is found as a reuse candidate', () => {
  const p = project();
  const w = plan(p, 'fix the monthlyReport function in src/services/report.js so that page 0 is rejected');
  const text = pkg(p, w);
  assert.match(text, /function paginate — src\/lib\/paginate\.js:1-3 \(imported by report\.js\)/);
  assert.ok(diag(p, w).reuse.includes('function:src/lib/paginate.js#paginate'));
});

test('stale knowledge is labelled for targeted verification; fresh knowledge never triggers a scan', () => {
  const p = project();
  const scan = fs.readFileSync(path.join(p.dir, '.rmcontext/state/scan.json'), 'utf8');
  const manifest = fs.readFileSync(path.join(p.dir, '.rmcontext/manifest.json'), 'utf8');
  const fresh = pkg(p, plan(p, 'fix GET /users to use the paginate helper'));
  assert.doesNotMatch(fresh, /^- .*\[stale\]/m, 'no knowledge entry is marked stale');
  assert.equal(fs.readFileSync(path.join(p.dir, '.rmcontext/state/scan.json'), 'utf8'), scan, 'planning and starting a stage scan nothing');
  assert.equal(fs.readFileSync(path.join(p.dir, '.rmcontext/manifest.json'), 'utf8'), manifest);
  const q = project();
  fs.appendFileSync(path.join(q.dir, 'src/lib/paginate.js'), '// changed after the scan\n');
  const text = pkg(q, plan(q, 'fix GET /users to use the paginate helper'));
  assert.match(text, /function paginate — src\/lib\/paginate\.js:1-3 \[stale\]/);
  assert.match(text, /\[stale\] = the file changed since the last scan: re-read only that file/);
});

test('irrelevant knowledge stays out; results from several subtasks are deduplicated', () => {
  const p = project();
  const task = 'fix GET /users to use the paginate helper. Then make the paginate helper reject a negative page. Also cover paginate in the users tests.';
  const w = plan(p, task, ['paginate returns 20 rows per page', 'paginate rejects page -1']);
  const text = pkg(p, w);
  assert.doesNotMatch(text, /computeInvoiceTotal|invoice\.js|formatCurrency|monthlyReport/, 'unrelated modules are not sent');
  assert.equal(text.split('function paginate —').length - 1, 1, 'one entry, although several subtasks found it');
  const d = diag(p, w);
  assert.ok(d.subtasks >= 3 && d.criteria === 2);
  assert.equal(new Set(d.reuse).size, d.reuse.length);
  assert.ok(d.included > 0 && d.candidates >= d.matched);
});

test('missing knowledge allows targeted exploration, never a full scan', () => {
  const p = project();
  const scan = fs.readFileSync(path.join(p.dir, '.rmcontext/state/scan.json'), 'utf8');
  const w = plan(p, 'fix the bug where zorblaxQuux frobnicates the widgets');
  const text = pkg(p, w);
  assert.match(text, /No recorded knowledge matched this stage: inspect only the files the task or the hand-off names[^\n]*Do not run a full scan for this\. Start from: zorblaxQuux\./);
  assert.equal(fs.readFileSync(path.join(p.dir, '.rmcontext/state/scan.json'), 'utf8'), scan);
});

test('the package stays bounded for a long task with many criteria; diagnostics are metadata only', () => {
  const p = project();
  const many = Array.from({ length: 10 }, (_, i) => `criterion ${i + 1}: GET /users page ${i + 1} returns the right users from the users table`);
  const w = plan(p, `${LONG} ${LONG}`, many);
  for (const s of w.stages) assert.ok(s.knowledge.tokens <= 900, `${s.id} knowledge ${s.knowledge.tokens} tokens`);
  run(p, ['workflow', 'start', w.id]);
  const st = JSON.parse(fs.readFileSync(path.join(p.dir, '.rmcontext/state/workflows', `${w.id}.json`), 'utf8')).stages[0];
  assert.ok(st.package.tokens <= 2200, `stage package ${st.package.tokens} tokens`);
  const text = run(p, ['workflow', 'context', w.id, 'S1', '--diagnostics']);
  for (const re of [/Subtasks: \d+ · acceptance criteria: 10 · query terms: \d+/, /Identifiers: [^\n]*paginate/, /Candidates: \d+ · matched: \d+ · included in the package: \d+/,
    /Eliminated: below relevance \d+ · lifecycle ended \d+ · outside the result limit \d+ · not for this role \d+ · section limit \d+ · over budget \d+/,
    /Reusable implementations detected: [^\n]*paginate/, /Package knowledge: \d+ tokens · whole stage package: \d+ tokens/]) assert.match(text, re);
  // Telemetry keeps counts only: no task text, no query terms.
  const log = fs.readFileSync(path.join(p.dir, '.rmcontext/state/autocontext.jsonl'), 'utf8');
  const ev = log.trim().split('\n').map(JSON.parse).filter((e) => e.event === 'workflow' && e.retrieval);
  assert.ok(ev.length && ev[0].retrieval[0].subtasks >= 1);
  assert.doesNotMatch(log, /every user is returned|response format|paginate helper/);
});

test('subtasks and identifiers are extracted deterministically', () => {
  assert.deepEqual(subtasksOf('analyse the users list. Then use paginate; verify it', ['a', 'b']).map((s) => s.id), ['T1', 'T2', 'T3', 'C1', 'C2']);
  assert.deepEqual(identifiersOf('use `UserQueryDto` and formatCurrency in src/lib/money.js for GET /users/:id and user_id'), ['UserQueryDto', 'formatCurrency', 'user_id', 'src/lib/money.js', '/users/:id']);
});
