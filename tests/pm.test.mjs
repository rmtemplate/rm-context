import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePlan, progress, criticalPath, renderGanttSvg, durationOf } from '../scripts/lib/pm.mjs';
import { fixture, ok, rmc } from './helpers.mjs';

const T = (id, extra = {}) => ({ id, name: id, status: 'Planned', ...extra });
const errs = (plan) => validatePlan(null, plan).errors;

test('plan validation catches scheduling and evidence errors', () => {
  const has = (plan, re) => assert.ok(errs(plan).some((e) => re.test(e)), `${re}\n${errs(plan).join('\n')}`);
  has({ tasks: [T('A', { dependencies: ['B'] }), T('B', { dependencies: ['A'] })] }, /dependency cycle: (A → B → A|B → A → B)/);
  has({ tasks: [T('A', { start: '2026-01-01', end: '2026-01-05' }), T('B', { start: '2026-01-03', end: '2026-01-09', dependencies: ['A'] })] }, /starts 2026-01-03 before dependency A finishes/);
  has({ tasks: [T('A', { status: 'Completed', actualEnd: '2026-01-02', progress: 100 })] }, /Completed without evidence/);
  has({ tasks: [T('A', { start: '2026-01-01', end: '2026-01-05', duration: 3 })] }, /duration 3 ≠ 5/);
  has({ tasks: [T('A', { start: '2026-01-05', end: '2026-01-01' })] }, /before start/);
  has({ tasks: [T('M', { milestone: true, start: '2026-01-01', end: '2026-01-02' })] }, /milestone has a single date/);
  has({ tasks: [T('A', { start: 'next week' })] }, /YYYY-MM-DD or "TBD"/);
  has({ tasks: [T('A', { dependencies: ['Z'] })] }, /dependency Z does not exist/);
  has({ tasks: [T('A', { parent: 'B' }), T('B', { parent: 'A' })] }, /parent cycle/);
  has({ tasks: [T('A', { status: 'Done' })] }, /status must be one of/);
  assert.deepEqual(errs({ tasks: [T('A', { start: 'TBD', end: 'TBD' }), T('M', { milestone: true, start: '2026-01-01', end: '2026-01-01' }), T('B', { start: '2026-01-01', end: '2026-01-02', dependencies: ['M'] })] }), []);
  assert.equal(durationOf(T('A', { start: '2026-01-01', end: '2026-01-10' })), 10);
});

test('critical path via CPM, with unscheduled leaves set aside', () => {
  const plan = { tasks: [
    T('A', { duration: 3 }), T('B', { duration: 5, dependencies: ['A'] }), T('C', { duration: 1, dependencies: ['A'] }),
    T('D', { duration: 2, dependencies: ['B', 'C'] }), T('X', { start: 'TBD', end: 'TBD', dependencies: ['A'] })] };
  const cp = criticalPath(plan);
  assert.ok(cp.ok);
  assert.deepEqual(cp.path, ['A', 'B', 'D']);
  assert.equal(cp.lengthDays, 10);
  assert.equal(cp.slack.C, 4);
  assert.deepEqual(cp.excluded, ['X']);
  plan.tasks[1].dependencies = ['X'];
  assert.match(criticalPath(plan).reason, /X, which other tasks depend on/);
});

test('progress separates verified evidence from reported and planned figures', () => {
  const dir = fixture();
  ok(dir, 'init');
  const plan = { tasks: [
    T('A', { status: 'Completed', start: '2020-01-01', end: '2020-01-02', actualEnd: '2020-01-02', progress: 100, evidence: [{ type: 'file', ref: 'src/db.js' }] }),
    T('B', { status: 'Completed', start: '2020-01-03', end: '2020-01-04', actualEnd: '2020-01-04', progress: 100, evidence: [{ type: 'file', ref: 'src/missing.js' }] }),
    T('C', { status: 'In Progress', start: '2020-01-05', end: '2020-01-06', progress: 50 }),
    T('D', { start: '2099-01-01', end: '2099-01-02' }) ] };
  const p = progress({ root: dir }, plan);
  assert.equal(p.verifiedPercent, 25);
  assert.equal(p.reportedPercent, 63);
  assert.equal(p.plannedPercent, 75);
  assert.deepEqual(p.completedWithoutVerifiedEvidence, ['B']);
});

test('gantt SVG renders bars, milestones, dependencies, today line and TBD rows', () => {
  const plan = { tasks: [T('P', {}), T('A', { parent: 'P', start: '2026-01-01', end: '2026-01-05', status: 'Completed', actualEnd: '2026-01-06' }),
    T('M', { parent: 'P', milestone: true, start: '2026-01-06', end: '2026-01-06', dependencies: ['A'] }), T('Z', { start: 'TBD', end: 'TBD' })] };
  const svg = renderGanttSvg(plan, { critical: ['A', 'M'], today: Date.parse('2026-01-03T00:00:00Z') / 86400000 });
  assert.match(svg, /^<svg/);
  assert.match(svg, /data-id="A"/);
  assert.match(svg, /M\d+(\.\d+)?,\d+ l8,8/);
  assert.match(svg, /marker-end="url\(#arr\)"/);
  assert.match(svg, />today</);
  assert.match(svg, /dates TBD/);
  assert.doesNotMatch(renderGanttSvg(plan, { statuses: ['Completed'] }), /data-id="Z"/);
  // renderer must be self-contained so the viewer can inline it
  const fn = new Function(`return (${renderGanttSvg.toString()})`)();
  assert.match(fn(plan, {}), /<svg/);
});

test('pm CLI: init, validate, gantt, health', () => {
  const dir = fixture();
  ok(dir, 'init');
  ok(dir, 'pm', 'init');
  assert.match(rmc(dir, 'pm', 'init').err, /already exists/);
  const f = path.join(dir, '.rmcontext/project-management/plan.json');
  const plan = JSON.parse(fs.readFileSync(f, 'utf8'));
  plan.tasks = [T('T-1', { start: '2026-01-01', end: '2026-01-02', status: 'Completed', actualEnd: '2026-01-02', progress: 100, evidence: [{ type: 'file', ref: 'src/db.js' }] }),
    T('M-1', { milestone: true, start: '2026-01-05', end: '2026-01-05', dependencies: ['T-1'] })];
  fs.writeFileSync(f, JSON.stringify(plan));
  assert.match(ok(dir, 'pm', 'validate'), /plan valid/);
  assert.match(ok(dir, 'pm', 'gantt'), /Critical path: T-1 → M-1/);
  assert.ok(fs.existsSync(path.join(dir, '.rmcontext/project-management/gantt.svg')));
  assert.match(fs.readFileSync(path.join(dir, '.rmcontext/project-management/gantt.html'), 'utf8'), /renderGanttSvg/);
  assert.match(ok(dir, 'pm', 'health'), /Overall: \*\*(Red|Amber|Green)\*\*/);
  plan.tasks[0].dependencies = ['M-1'];
  fs.writeFileSync(f, JSON.stringify(plan));
  assert.equal(rmc(dir, 'pm', 'gantt').code, 2);
});
