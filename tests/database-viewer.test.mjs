// The viewer shows Database Intelligence and Mobile knowledge (structure and metadata only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, ok } from './helpers.mjs';
import { findChrome, hostPath } from '../scripts/lib/docs.mjs';
import { project, CONFIG_FIXTURES as F, FakeServer, CANARY } from './db-helpers.mjs';
import { discoverCatalog } from '../scripts/lib/database/adapters.mjs';
import { applyModel } from '../scripts/lib/database/store.mjs';
import { detectDatabaseConfig } from '../scripts/lib/database/config.mjs';

const data = (dir) => { const h = fs.readFileSync(path.join(dir, '.rmcontext/viewer/index.html'), 'utf8'); return { html: h, json: JSON.parse(/const DATA = (\{[\s\S]*?\});\s*\n/.exec(h)?.[1] ?? 'null') }; };

test('viewer embeds database knowledge: tables, columns, procedures, parameters, dependencies, limitations — definitions included, secrets never', async () => {
  const dir = project({ ...F.mssqlWebConfig });
  applyModel(dir, { target: detectDatabaseConfig(dir)[0], model: await discoverCatalog('mssql', new FakeServer('mssql').read), source: 'catalog' });
  ok(dir, 'viewer', '--no-open');
  const { html } = data(dir);
  assert.ok(!html.includes(CANARY));
  const { json } = data(dir);
  const objs = json.dbIntel.targets[0].objects;
  const proc = objs.find((o) => o.name === 'sp_MembershipReport');
  assert.ok(proc?.definition?.includes('JOIN dbo.Orders o ON o.MemberId'), 'the stored query is shown');
  assert.ok(objs.some((o) => o.kind === 'table') && objs.some((o) => o.kind === 'procedure'), 'kinds are separable into tabs');
  for (const o of objs.filter((o) => o.encrypted || o.review)) assert.ok(!o.definition, o.name + ' has no definition');
  for (const t of ['"dbIntel"', 'sp_MembershipReport', 'IX_Orders_MemberId', '"@Year"', 'Total']) assert.ok(html.includes(t), t);
});
test('app wires the pages: Database Intelligence and Mobile routes, nav entries, path links', () => {
  const app = fs.readFileSync(path.join(ROOT, 'scripts/viewer/app.js'), 'utf8');
  assert.match(app, /\['dbintel', 'Database Intelligence'/); assert.match(app, /\['mobile', 'Mobile'/);
  assert.match(app, /PAGES = \{ dbintel: drawDbIntel, mobile: drawMobile/);
  assert.match(app, /data-tab=/); assert.match(app, /data-obj=/); assert.match(app, /Query \(stored definition\)/);
  assert.match(app, /Run <code>rmc database discover<\/code>/);
});
test('without database knowledge the viewer still builds and the page explains how to discover', () => {
  const dir = project({ 'a.txt': 'x' });
  ok(dir, 'viewer', '--no-open');
  assert.match(fs.readFileSync(path.join(dir, '.rmcontext/viewer/index.html'), 'utf8'), /"dbIntel":\{"targets":\[\],"mobile":null,"changes":\[\]\}/);
});
const chrome = findChrome();
test('headless: tabs per kind render, an object is selected and its query is shown', { skip: !chrome && 'no Chromium-family browser' }, async () => {
  const dir = project({ ...F.mssqlWebConfig });
  applyModel(dir, { target: detectDatabaseConfig(dir)[0], model: await discoverCatalog('mssql', new FakeServer('mssql').read), source: 'catalog' });
  ok(dir, 'viewer', '--no-open');
  const src = path.join(dir, '.rmcontext/viewer/index.html');
  const page = path.join(path.dirname(src), '_dbsmoke.html');
  fs.writeFileSync(page, fs.readFileSync(src, 'utf8').replace('<head>', '<head><script>window.onerror=(m,s,l,c)=>{document.documentElement.dataset.err=(document.documentElement.dataset.err||"")+m+" @"+l+":"+c+"|"}</script>'));
  const hp = hostPath(chrome, page).replace(/\\/g, '/');
  const url = (r) => (hp.startsWith('//') ? 'file:' + hp : 'file:///' + hp.replace(/^\/+/, '')) + r;
  const dump = (r) => execFileSync(chrome, ['--headless=new', '--disable-gpu', '--window-size=1400,900', '--virtual-time-budget=3000', '--dump-dom', url(r)], { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
  const proc = dump('#/dbintel?k=procedure&o=' + encodeURIComponent('procedure:dbo.sp_MembershipReport'));
  assert.ok(!/data-err=/.test(proc.slice(0, 400)), 'no script error');
  assert.match(proc, /data-tab="table"/); assert.match(proc, /data-tab="procedure"/);
  assert.match(proc, /Query \(stored definition\)/); assert.match(proc, /JOIN dbo\.Orders o ON o\.MemberId/);
  const tbl = dump('#/dbintel?k=table');
  assert.match(tbl, /Columns/); assert.match(tbl, /DDL \(generated from the recorded metadata\)|DDL \(from the source\)/); assert.match(tbl, /CREATE TABLE/);
  fs.rmSync(page, { force: true });
});
