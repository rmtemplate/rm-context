import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ok, rmc, ROOT } from './helpers.mjs';

const dir = fixture();
ok(dir, 'init');
const route = (...a) => JSON.parse(ok(dir, 'route', ...a, '--json'));
const setConfig = (patch) => {
  const f = path.join(dir, '.rmcontext', 'config.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }, null, 2));
};

test('simple lookup selects Haiku', () => {
  const r = route('--category', 'search');
  assert.equal(r.agent, 'quick-qa');
  assert.equal(r.model, 'haiku');
  assert.equal(r.complexity, 'low');
});

test('FSD and Gantt generation select Sonnet, with agents chosen independently of the model', () => {
  const fsd = route('--category', 'fsd');
  assert.deepEqual([fsd.agent, fsd.model, fsd.complexity], ['business-analyst', 'sonnet', 'medium']);
  const gantt = route('--category', 'gantt');
  assert.deepEqual([gantt.agent, gantt.model], ['project-manager', 'sonnet']);
  // Agent default and role policy are separate: an FSD is routed by the BA role policy, not by the agent default.
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'config/models.json'), 'utf8')).roles['business-analyst'].medium, 'sonnet');
});

test('simple bug fix selects Sonnet; a trivial one may go lower; code alone is not high', () => {
  assert.equal(route('--category', 'bug-fix').model, 'sonnet');
  assert.equal(route('--category', 'bug-fix', '--signals', 'code').model, 'sonnet');
  // Coding stays on Sonnet at every complexity: a trivial change is low, a security-touching one high, both Sonnet.
  const trivial = route('--category', 'small-change', '--signals', 'trivial');
  assert.deepEqual([trivial.model, trivial.complexity], ['sonnet', 'low']);
  const risky = route('--category', 'small-change', '--signals', 'trivial,security');
  assert.deepEqual([risky.model, risky.complexity], ['sonnet', 'high'], 'a high signal beats trivial; high is not Opus by itself');
});

test('complex feature implementation stays on Sonnet; complex architecture analysis selects Opus', () => {
  const f = route('--category', 'complex-feature', '--signals', 'code,modules:3');
  assert.deepEqual([f.agent, f.model, f.complexity], ['senior-engineer', 'sonnet', 'high']);
  assert.match(f.basis, /senior-engineer role policy: high → sonnet/);
  assert.equal(route('--category', 'architecture').model, 'opus');
  // Complexity raises a medium task, but a security-touching small feature is still Sonnet coding.
  assert.deepEqual([route('--category', 'small-feature', '--signals', 'security').model, route('--category', 'small-feature', '--signals', 'security').complexity], ['sonnet', 'high']);
  // A document with architectural implications is high and goes to the System Analyst's deep model.
  assert.equal(route('--category', 'srs', '--signals', 'architecture').model, 'opus');
});

test('explicit user model selection overrides adaptive routing and project overrides', () => {
  setConfig({ models: { 'business-analyst': 'haiku' } });
  const r = route('--category', 'fsd', '--model', 'opus');
  assert.deepEqual([r.model, r.source], ['opus', 'user']);
  setConfig({ models: {} });
});

test('per-project model override is respected', () => {
  setConfig({ models: { 'project-manager': 'opus' } });
  const r = route('--category', 'gantt');
  assert.deepEqual([r.model, r.source], ['opus', 'project']);
  setConfig({ models: {}, tiers: { medium: 'opus' } });
  assert.equal(route('--category', 'fsd').model, 'opus', 'project tier mapping applies');
  setConfig({ tiers: {}, routing: { enabled: false } });
  const off = route('--category', 'fsd');
  assert.deepEqual([off.model, off.source], ['sonnet', 'agent default'], 'routing disabled → agent default');
  setConfig({ routing: {} });
});

test('agent-specific override in config/models.json is respected', () => {
  // Use a copy of the plugin so the real config stays untouched.
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-plugin-'));
  for (const d of ['scripts', 'config', 'templates']) fs.cpSync(path.join(ROOT, d), path.join(plugin, d), { recursive: true });
  const f = path.join(plugin, 'config', 'models.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  cfg.agents['senior-engineer'].override = 'haiku';
  fs.writeFileSync(f, JSON.stringify(cfg));
  const run = spawnSync(process.execPath, [path.join(plugin, 'scripts', 'rmc.mjs'), 'route', '--category', 'complex-feature', '--json', '--no-record'], { cwd: dir, encoding: 'utf8' });
  const r = JSON.parse(run.stdout);
  assert.deepEqual([r.model, r.source], ['haiku', 'agent override']);
});

test('unsupported model falls back to the fallback tier with an explanation', () => {
  setConfig({ tiers: { high: 'gpt-5' } });
  const r = route('--category', 'architecture');
  assert.equal(r.model, 'sonnet');
  assert.match(r.source, /fallback/);
  assert.match(r.notes.join(' '), /not a supported model/);
  setConfig({ tiers: { high: 'claude-opus-5-5' } });
  const full = route('--category', 'architecture');
  assert.equal(full.model, 'opus', 'full ids map to the alias the Agent tool accepts');
  setConfig({ tiers: {} });
  setConfig({ tiers: { bogus: 'opus' } });
  const v = rmc(dir, 'validate');
  assert.match(v.out + v.err, /config\.tiers\.bogus/);
  setConfig({ tiers: {} });
});

test('escalation preserves the previous hand-off and is limited', () => {
  const first = route('--category', 'bug-fix');
  assert.equal(first.model, 'sonnet');
  const noHandoff = rmc(dir, 'route', '--escalate', first.id, '--reason', 'root cause spans worker and API');
  assert.equal(noHandoff.code, 2);
  assert.match(noHandoff.err, /previous agent's findings/);
  fs.writeFileSync(path.join(dir, 'h.json'), JSON.stringify({ from: 'senior-engineer', to: 'orchestrator', summary: 'Race traced to retry worker', artifacts: ['src/services/billing.js'] }));
  const hid = /H-[a-z0-9]+/.exec(ok(dir, 'handoff', 'add', 'h.json'))[0];
  const esc = route('--escalate', first.id, '--reason', 'root cause spans worker and API', '--handoff', hid);
  assert.deepEqual([esc.agent, esc.model, esc.escalations, esc.escalatedFrom, esc.handoff, esc.contextReuse], ['senior-engineer', 'opus', 1, first.id, hid, true]);
  assert.equal(esc.handoffDetail.summary, 'Race traced to retry worker');
  const text = ok(dir, 'route', '--escalate', route('--category', 'bug-fix').id, '--reason', 'other evidence', '--handoff', hid, '--no-record');
  assert.match(text, /continue from these findings, not to repeat the analysis/);
  assert.match(text, /Race traced to retry worker/);
  assert.equal(rmc(dir, 'route', '--escalate', first.id, '--reason', 'new', '--handoff', hid).code, 2, 'a route escalates once');
  assert.equal(rmc(dir, 'route', '--escalate', esc.id, '--reason', 'again', '--handoff', hid).code, 2, 'high cannot escalate');
  const user = route('--category', 'bug-fix', '--model', 'haiku');
  assert.equal(rmc(dir, 'route', '--escalate', user.id, '--reason', 'x', '--handoff', hid).code, 2, 'user choice is not escalated');
});

test('main session model is never reported as changed; metrics hold metadata only', () => {
  for (const a of [['--category', 'search'], ['--category', 'architecture'], ['--category', 'fsd', '--model', 'opus']]) {
    assert.equal(route(...a).mainSessionModelChanged, false);
    const text = ok(dir, 'route', ...a, '--no-record');
    assert.match(text, /main session model is unchanged/i);
    assert.doesNotMatch(text, /(switch|chang)(ed|ing)\s+(the\s+)?main session/i);
  }
  for (const f of ['commands', 'skills', 'agents'].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).filter((x) => x.endsWith('.md')).map((x) => path.join(ROOT, d, x))))
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /(switch(es|ed)?|chang(es|ed)) (to )?the main session('s)? model to/i, f);
  const lines = fs.readFileSync(path.join(dir, '.rmcontext', 'state', 'routing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const keys = new Set(lines.flatMap(Object.keys));
  for (const banned of ['prompt', 'request', 'text', 'code', 'notes']) assert.ok(!keys.has(banned), `metrics must not store ${banned}`);
  const st = JSON.parse(ok(dir, 'route', 'stats', '--json'));
  assert.ok(st.routes > 5 && st.escalations >= 1 && st.byTier.high >= 1);
});

test('every delegating command routes through rmc route', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'commands'))) {
    const s = fs.readFileSync(path.join(ROOT, 'commands', f), 'utf8');
    assert.doesNotMatch(s, /rmc\.mjs" routing --agent/, `${f} still uses static routing`);
    if (/Delegate to the `/.test(s) || /Delegation rules/.test(s)) assert.match(s, /rmc route|rmc workflow start/, `${f} delegates without rmc route`); // workflow start records each stage's route
    for (const m of s.matchAll(/--category ([a-z-]+)/g)) assert.ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'config/models.json'), 'utf8')).tasks[m[1]], `${f}: unknown category ${m[1]}`);
  }
});
