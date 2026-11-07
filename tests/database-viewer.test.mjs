// The viewer shows Database Intelligence and Mobile knowledge (structure and metadata only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ok } from './helpers.mjs';
import { project, CONFIG_FIXTURES as F, FakeServer, CANARY } from './db-helpers.mjs';
import { discoverCatalog } from '../scripts/lib/database/adapters.mjs';
import { applyModel } from '../scripts/lib/database/store.mjs';
import { detectDatabaseConfig } from '../scripts/lib/database/config.mjs';

const data = (dir) => { const h = fs.readFileSync(path.join(dir, '.rmcontext/viewer/index.html'), 'utf8'); return { html: h, json: JSON.parse(/const DATA = (\{[\s\S]*?\});\s*\n/.exec(h)?.[1] ?? 'null') }; };

test('viewer embeds database knowledge: tables, columns, procedures, parameters, dependencies, limitations — no definitions or secrets', async () => {
  const dir = project({ ...F.mssqlWebConfig });
  applyModel(dir, { target: detectDatabaseConfig(dir)[0], model: await discoverCatalog('mssql', new FakeServer('mssql').read), source: 'catalog' });
  ok(dir, 'viewer', '--no-open');
  const { html } = data(dir);
  assert.ok(!html.includes(CANARY));
  assert.ok(!html.includes('JOIN dbo.Orders o ON o.MemberId'), 'procedure bodies stay in the knowledge store');
  for (const t of ['"dbIntel"', 'sp_MembershipReport', 'IX_Orders_MemberId', '"@Year"', 'Total']) assert.ok(html.includes(t), t);
});
test('app wires the pages: Database Intelligence and Mobile routes, nav entries, path links', () => {
  const app = fs.readFileSync(path.join(ROOT, 'scripts/viewer/app.js'), 'utf8');
  assert.match(app, /\['dbintel', 'Database Intelligence'/); assert.match(app, /\['mobile', 'Mobile'/);
  assert.match(app, /PAGES = \{ dbintel: drawDbIntel, mobile: drawMobile/);
  assert.match(app, /Run <code>rmc database discover<\/code>/);
});
test('without database knowledge the viewer still builds and the page explains how to discover', () => {
  const dir = project({ 'a.txt': 'x' });
  ok(dir, 'viewer', '--no-open');
  assert.match(fs.readFileSync(path.join(dir, '.rmcontext/viewer/index.html'), 'utf8'), /"dbIntel":\{"targets":\[\],"mobile":null,"changes":\[\]\}/);
});
