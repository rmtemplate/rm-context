// CLAUDE.md strategies (combine / replace) and the policy update of an already-initialized project: no scan, no
// knowledge or telemetry change, overrides kept, idempotent, `rmc claude-md --check` read-only. Temp dirs only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fixture, ok, rmc, repoTelemetry, readJson } from './helpers.mjs';

let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry"));

const MANUAL = '# Team rules\n\nAlways run `npm test` before committing.\nNever edit db/schema.sql by hand.\n';
// The managed section as the first release wrote it (no policy version in the marker): policy 1.
const LEGACY = '<!-- BEGIN RM CONTEXT — managed by `rmc init`; edits between these markers are replaced -->\n## RM Context\n\nOld policy text.\n<!-- END RM CONTEXT -->';
const md = (d) => fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const check = (d) => JSON.parse(ok(d, 'claude-md', '--check', '--json'));
const fail_ = (d, ...a) => { const r = rmc(d, ...a); assert.notEqual(r.code, 0, r.out); return r.err; };
const backups = (d) => (fs.existsSync(path.join(d, '.rmcontext/backups')) ? fs.readdirSync(path.join(d, '.rmcontext/backups')) : []);

// A project initialized before the CLAUDE.md policy existed, with knowledge, documents, hand-offs, telemetry and a
// workflow, so a policy update can be checked against all of them.
function existing({ claudeMd = null, config } = {}) {
  const d = fixture('node-app');
  for (const f of ['.env', 'keys', 'backups']) fs.rmSync(path.join(d, f), { recursive: true, force: true });
  ok(d, 'init', '--no-claude-md');
  ok(d, 'doc', 'new', 'technical-design', '--title', 'Users API', '--author', 'senior-engineer');
  fs.writeFileSync(path.join(d, 'h.json'), JSON.stringify({ from: 'system-analyst', to: 'senior-engineer', summary: 'Users list lives in src/routes/users.js' }));
  ok(d, 'handoff', 'add', 'h.json');
  fs.rmSync(path.join(d, 'h.json'));
  ok(d, 'route', '--category', 'bug-fix');
  fs.mkdirSync(path.join(d, '.rmcontext/state/workflows'), { recursive: true });
  fs.writeFileSync(path.join(d, '.rmcontext/state/workflows/W-old.json'), JSON.stringify({ id: 'W-old', status: 'completed', stages: [], criteria: [] }));
  fs.writeFileSync(path.join(d, '.rmcontext/state/autocontext.jsonl'), JSON.stringify({ at: '2026-11-01T00:00:00Z', event: 'prompt', tokens: 120 }) + '\n');
  if (config) { const f = path.join(d, '.rmcontext/config.json'); fs.writeFileSync(f, JSON.stringify({ ...readJson(f), ...config })); }
  if (claudeMd != null) fs.writeFileSync(path.join(d, 'CLAUDE.md'), claudeMd);
  return d;
}
// Every .rmcontext file except the scan state a CLAUDE.md index touches and the config (which may remember the choice).
function snapshot(d) {
  const base = path.join(d, '.rmcontext');
  const out = {};
  for (const f of fs.readdirSync(base, { recursive: true })) {
    const abs = path.join(base, f);
    if (!fs.statSync(abs).isFile() || /^(state[\\/](files|scan|last-refresh)\.json|manifest\.json|config\.json|graph[\\/](nodes|edges)\.json|INDEX\.md|viewer[\\/])/.test(f.split(path.sep).join('/'))) continue;
    out[f] = hash(abs);
  }
  return out;
}
const nodesExceptClaude = (d) => readJson(path.join(d, '.rmcontext/graph/nodes.json')).filter((n) => !JSON.stringify(n).includes('CLAUDE.md'));
const filesExceptClaude = (d) => { const f = readJson(path.join(d, '.rmcontext/state/files.json')).files; delete f['CLAUDE.md']; return f; };

test('new project: CLAUDE.md missing → created; existing manual CLAUDE.md without a choice → combine (non-interactive default)', () => {
  const a = fixture('node-app');
  assert.match(ok(a, 'claude-md', '--check'), /CLAUDE\.md: missing/, '--check works before init');
  assert.match(ok(a, 'init'), /CLAUDE\.md: RM Context section created/);
  const b = fixture('node-app');
  fs.writeFileSync(path.join(b, 'CLAUDE.md'), MANUAL);
  const st = check(b);
  assert.deepEqual([st.state, st.needsChoice, st.userLines], ['unmanaged', true, 3], '/rmc:init asks combine or replace');
  assert.equal(md(b), MANUAL, '--check never writes');
  assert.match(ok(b, 'init'), /CLAUDE\.md: RM Context section updated/);
  assert.ok(md(b).startsWith(MANUAL), 'combine keeps the manual instructions');
  assert.equal(readJson(path.join(b, '.rmcontext/config.json')).claudeMdStrategy, undefined, 'a default is not remembered as the user\'s choice');
});

test('replace: refused without explicit confirmation (nothing written), then backs up and replaces; cancel leaves CLAUDE.md alone', () => {
  // New project: a refused replace stops before anything is created.
  const n = fixture('node-app');
  fs.writeFileSync(path.join(n, 'CLAUDE.md'), MANUAL);
  assert.match(fail_(n, 'init', '--claude-md', 'replace'), /Replace Entire File would replace 3 line\(s\) of existing instructions[\s\S]*--confirm/);
  assert.equal(fs.existsSync(path.join(n, '.rmcontext')), false);
  assert.equal(md(n), MANUAL);
  // Cancellation: skip leaves CLAUDE.md untouched, the project is still initialized.
  assert.match(ok(n, 'init', '--claude-md', 'skip'), /CLAUDE\.md: RM Context section skipped/);
  assert.equal(md(n), MANUAL);
  // Existing project: confirmation → backup first, then the generated file only.
  const d = existing({ claudeMd: MANUAL });
  assert.match(fail_(d, 'claude-md', '--strategy', 'replace'), /Nothing was changed/);
  assert.deepEqual([md(d), backups(d)], [MANUAL, []]);
  const out = ok(d, 'claude-md', '--strategy', 'replace', '--confirm');
  assert.match(out, /section replaced \(backup: \.rmcontext\/backups\/CLAUDE\.md\.[\w-]+\.bak\)/);
  const [bak] = backups(d);
  assert.equal(fs.readFileSync(path.join(d, '.rmcontext/backups', bak), 'utf8'), MANUAL, 'the backup is the old file, byte for byte');
  assert.ok(md(d).startsWith('<!-- BEGIN RM CONTEXT · policy 5'));
  assert.doesNotMatch(md(d), /Team rules/);
  assert.equal(readJson(path.join(d, '.rmcontext/config.json')).claudeMdStrategy, 'replace');
  // Idempotent, and a remembered "replace" never replaces again: text added later is kept.
  assert.match(ok(d, 'init'), /section unchanged/);
  fs.appendFileSync(path.join(d, 'CLAUDE.md'), '\n## Added later\nKeep me.\n');
  ok(d, 'init');
  assert.match(md(d), /## Added later\nKeep me\./);
  assert.equal(backups(d).length, 1, 'no second backup, no second replace');
  assert.equal(check(d).needsChoice, false);
});

test('existing project: a manual CLAUDE.md is combined; an old managed section is upgraded in place; a missing one is created', () => {
  const m = existing({ claudeMd: MANUAL });
  const out = ok(m, 'init', '--claude-md', 'combine');
  assert.match(out, /Policy update for an initialized project \(no scan/);
  assert.match(out, /CLAUDE\.md: RM Context section updated · index: CLAUDE\.md only/);
  assert.ok(md(m).startsWith(MANUAL));
  assert.equal(readJson(path.join(m, '.rmcontext/config.json')).claudeMdStrategy, 'combine', 'an explicit choice is remembered');
  assert.equal(check(m).state, 'current');
  // Managed section from the first release (policy 1) between user text: upgraded, still one section, user text kept.
  const l = existing({ claudeMd: `# Mine\n\n${LEGACY}\n\n## After\nStay.\n` });
  const st = check(l);
  assert.deepEqual([st.state, st.policy, st.generator], ['outdated', 1, 5]);
  assert.match(ok(l, 'claude-md', '--check'), /outdated — managed section uses policy 1; the active generator writes policy 5/);
  ok(l, 'init');
  const up = md(l);
  assert.match(up, /^# Mine\n\n<!-- BEGIN RM CONTEXT · policy 5[\s\S]*<!-- END RM CONTEXT -->\n\n## After\nStay\.\n$/);
  assert.doesNotMatch(up, /Old policy text/);
  assert.equal(up.split('<!-- BEGIN RM CONTEXT').length - 1, 1);
  assert.match(up, /\*\*Reuse first\.\*\*/);
  // No CLAUDE.md at all: created, no question needed.
  const x = existing();
  assert.equal(check(x).state, 'missing');
  assert.match(ok(x, 'init'), /section created/);
  assert.equal(check(x).state, 'current');
});

test('policy update keeps knowledge, documents, hand-offs, telemetry and workflows; it runs no full scan and indexes CLAUDE.md only', () => {
  const d = existing({ claudeMd: MANUAL });
  const before_ = snapshot(d), nodes = nodesExceptClaude(d), files = filesExceptClaude(d);
  const scanBefore = readJson(path.join(d, '.rmcontext/state/scan.json'));
  ok(d, 'init');
  assert.deepEqual(snapshot(d), before_, 'documents, hand-offs, routing and auto-context telemetry, workflows: byte-identical');
  assert.deepEqual(nodesExceptClaude(d), nodes, 'no other graph node changed');
  assert.deepEqual(filesExceptClaude(d), files, 'no other file was re-read');
  const scan = readJson(path.join(d, '.rmcontext/state/scan.json'));
  assert.equal(scan.mode, 'targeted');
  assert.equal(scan.files.changed + scan.files.added, 1, 'only CLAUDE.md');
  assert.equal(scanBefore.mode, 'full');
  // Repeated policy updates are idempotent: no write, no index.
  const once = md(d), cfg = readJson(path.join(d, '.rmcontext/config.json'));
  for (let i = 0; i < 3; i++) assert.match(ok(d, 'init'), /section unchanged · index: not needed/);
  assert.equal(md(d), once);
  assert.deepEqual(readJson(path.join(d, '.rmcontext/config.json')), cfg);
  assert.deepEqual(readJson(path.join(d, '.rmcontext/state/scan.json')), scan, 'nothing scanned on a no-op update');
  // An explicit --full is still a full rescan.
  ok(d, 'init', '--full');
  assert.equal(readJson(path.join(d, '.rmcontext/state/scan.json')).mode, 'full');
});

test('stale knowledge stays stale and is reported; model overrides are kept and reported; agents and policy come from the active plugin', () => {
  const d = existing({ config: { models: { 'senior-engineer': 'opus' }, tiers: { low: 'sonnet' } } });
  fs.appendFileSync(path.join(d, 'src/routes/users.js'), '\n// edited after the scan\n');
  const usersNodes = JSON.stringify(readJson(path.join(d, '.rmcontext/graph/nodes.json')).filter((n) => JSON.stringify(n).includes('src/routes/users.js')));
  const out = ok(d, 'init');
  assert.match(out, /Knowledge: 1 file\(s\) changed since the last scan \(marked \[stale\] in packages\); not re-read now/);
  assert.match(out, /Model override kept: models\.senior-engineer = opus \(project setting; without it the senior-engineer role policy applies: sonnet\/sonnet\/sonnet\)/);
  assert.match(out, /Tier override kept: tiers = \{"low":"sonnet"\}/);
  assert.match(out, /Agents, skills, commands and the model policy are read from the active plugin \(rm-context@[\d.]+\); nothing is copied into the project/);
  assert.equal(JSON.stringify(readJson(path.join(d, '.rmcontext/graph/nodes.json')).filter((n) => JSON.stringify(n).includes('src/routes/users.js'))), usersNodes, 'stale knowledge is not refreshed implicitly');
  const r = JSON.parse(ok(d, 'route', '--category', 'bug-fix', '--json', '--no-record'));
  assert.deepEqual([r.model, r.source], ['opus', 'project']);
  assert.deepEqual(readJson(path.join(d, '.rmcontext/config.json')).models, { 'senior-engineer': 'opus' });
  // Nothing from the plugin was copied into the project.
  for (const f of ['agents', 'skills', 'commands', 'models.json']) assert.equal(fs.existsSync(path.join(d, '.rmcontext', f)), false, f);
  // An initialized project keeps its opt-out.
  const o = existing({ claudeMd: MANUAL, config: { claudeMd: false } });
  assert.match(ok(o, 'init'), /CLAUDE\.md: RM Context section disabled/);
  assert.equal(md(o), MANUAL);
});

test('rmc claude-md --check never changes a file, in every state', () => {
  const d = existing();
  const states = [];
  for (const body of [null, MANUAL, `${MANUAL}\n${LEGACY}\n`, `${LEGACY}\n\n${LEGACY}\n`]) {
    if (body == null) fs.rmSync(path.join(d, 'CLAUDE.md'), { force: true }); else fs.writeFileSync(path.join(d, 'CLAUDE.md'), body);
    const snap = body == null ? null : [hash(path.join(d, 'CLAUDE.md')), fs.statSync(path.join(d, 'CLAUDE.md')).mtimeMs];
    const cfg = hash(path.join(d, '.rmcontext/config.json'));
    states.push(check(d).state);
    ok(d, 'claude-md', '--check');
    if (body == null) assert.equal(fs.existsSync(path.join(d, 'CLAUDE.md')), false);
    else assert.deepEqual([hash(path.join(d, 'CLAUDE.md')), fs.statSync(path.join(d, 'CLAUDE.md')).mtimeMs], snap);
    assert.equal(hash(path.join(d, '.rmcontext/config.json')), cfg);
  }
  assert.deepEqual(states, ['missing', 'unmanaged', 'outdated', 'duplicate']);
  ok(d, 'claude-md');
  assert.equal(check(d).state, 'current');
});
