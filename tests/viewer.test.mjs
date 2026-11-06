import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, ok, ROOT, readJson } from './helpers.mjs';
import * as C from '../scripts/viewer/graph-core.mjs';
import { findChrome, hostPath } from '../scripts/lib/docs.mjs';
import { ctx } from '../scripts/lib/util.mjs';
import * as G from '../scripts/lib/graph.mjs';
import { synthGraph } from './bench/synth.mjs';

const built = (() => {
  let dir = null;
  return () => {
    if (dir) return dir;
    dir = fixture(); ok(dir, 'init');
    fs.writeFileSync(path.join(dir, '.rmcontext/context/business-rules.md'), '# Business rules\n- Orders need a confirmed user\n- staging admin password=SuperSecret123!\n');
    // BOM-prefixed note with a Mermaid flowchart and a table (Windows editors write BOMs).
    fs.writeFileSync(path.join(dir, '.rmcontext/context/architecture.md'), '﻿# Architecture\n\n```mermaid\nflowchart LR\n  Client --> API --> DB[(PostgreSQL)]\n```\n\n| Layer | Folder |\n|---|---|\n| Routes | src/routes |\n');
    ok(dir, 'doc', 'new', 'erd', '--title', 'Data model', '--author', 'system-analyst', '--sources', 'db/schema.sql');
    ok(dir, 'viewer');
    return dir;
  };
})();
const MERMAID_LINE = /const MERMAID_SRC = (.*);\n/;
// Everything except the vendored Mermaid library, which is checked separately.
const html = () => fs.readFileSync(path.join(built(), '.rmcontext/viewer/index.html'), 'utf8').replace(MERMAID_LINE, 'const MERMAID_SRC = "[vendored]";\n');
const data = () => JSON.parse(/const DATA = (.*);\nconst renderGanttSvg/.exec(html())[1]);

test('viewer is a single offline file: compiled CSS inlined, no CDN, no network calls', () => {
  const h = html();
  const css = /<style>([\s\S]*?)<\/style>/.exec(h)[1];
  assert.match(css, /--accent:/, 'design tokens are inlined');
  assert.match(css, /\.btn\{/, 'compiled component classes are inlined');
  assert.match(css, /\.b-inferred\{/, 'dynamic provenance classes survive purging');
  assert.doesNotMatch(h, /<script[^>]+src=|<link[^>]+stylesheet|@import|url\(\s*['"]?https?:/i);
  assert.doesNotMatch(h, /cdn\.tailwindcss|unpkg\.com|jsdelivr|cdnjs/);
  assert.doesNotMatch(h, /\bfetch\(|XMLHttpRequest|new WebSocket/);
  const urls = [...h.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]).filter((u) => !/^http:\/\/www\.w3\.org\/|^https:\/\/tailwindcss\.com/.test(u)); // SVG namespace, CSS licence comment
  assert.deepEqual([...new Set(urls)], ['https://rmtemplate.com'], 'only the attribution link');
  assert.ok(fs.statSync(path.join(ROOT, 'scripts/viewer/viewer.css')).size > 5000, 'compiled CSS is committed');
});

test('Mermaid is embedded offline only when a document or note has a diagram', () => {
  const raw = fs.readFileSync(path.join(built(), '.rmcontext/viewer/index.html'), 'utf8');
  const embedded = JSON.parse(MERMAID_LINE.exec(raw)[1]);
  assert.equal(embedded, fs.readFileSync(path.join(ROOT, 'scripts/viewer/vendor/mermaid.min.js'), 'utf8'), 'the unmodified vendored library');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/viewer/vendor/mermaid.LICENSE')));
  assert.equal(raw.match(/<\/script>/g).length, 1);
  const d = data();
  assert.match(d.documents.find((x) => x.id === 'ERD-001').text, /```mermaid\nerDiagram/);
  assert.match(d.notes.find((n) => n.path === 'context/architecture.md').text, /^# Architecture/, 'BOM removed');
  const plain = fixture(); ok(plain, 'init');
  assert.match(fs.readFileSync(path.join(plain, '.rmcontext/viewer/index.html'), 'utf8'), /const MERMAID_SRC = null;/, 'no diagrams → no Mermaid');
});

test('navigation has icons for every section and only shows sections with data', () => {
  const app = fs.readFileSync(path.join(ROOT, 'scripts/viewer/app.js'), 'utf8');
  const nav = /const NAV = \[([\s\S]*?)\n\];/.exec(app)[1];
  for (const g of ['Workspace', 'Code Intelligence', 'Architecture', 'Project Knowledge', 'Utilities']) assert.match(nav, new RegExp(`'${g}'`));
  const icons = [...nav.matchAll(/\['[\w/]+', '[^']+', '(\w+)'/g)].map((m) => m[1]);
  assert.ok(icons.length >= 18);
  for (const i of icons) assert.match(app, new RegExp(`\\b${i}: '<`), `icon ${i} is defined inline`);
  assert.match(app, /it\[3\]\(\) !== 0/, 'empty sections are hidden');
});

test('viewer embeds files, notes, hand-offs and context status, without secrets', () => {
  const d = data();
  const users = d.files.find((f) => f.p === 'src/routes/users.js');
  assert.deepEqual(users.routes.map((r) => `${r.method} ${r.path}`), ['GET /users', 'POST /users']);
  assert.ok(users.imports.length && users.dbUses.length);
  assert.ok(!d.files.some((f) => f.p === '.env' || f.p.endsWith('.pem')), 'secret files are never indexed');
  const note = d.notes.find((n) => n.path === 'context/business-rules.md');
  assert.match(note.text, /Orders need a confirmed user/);
  assert.equal(d.autoContext.config.maxContextTokens, 1200);
  assert.ok(Array.isArray(d.handoffs));
  for (const bad of ['SuperSecret123', 'hunter2', 'tok_live', 'PRIVATE KEY']) assert.ok(!html().includes(bad), bad);
});

// ---------- graph core ----------
const tiny = () => {
  // a - b - c - d, a - e ; edge types for impact
  const ids = ['a', 'b', 'c', 'd', 'e'], src = Int32Array.from([0, 1, 2, 0]), dst = Int32Array.from([1, 2, 3, 4]);
  return { ids, ix: C.buildIndex(5, src, dst), types: ['calls', 'calls', 'depends_on', 'tested_by'] };
};
test('graph core: neighbourhood, shortest path and impact', () => {
  const { ix, types } = tiny();
  assert.deepEqual([...C.neighborhood(ix, 0, 1).keys()].sort(), [0, 1, 4]);
  assert.deepEqual([...C.neighborhood(ix, 0, 2).entries()].sort(), [[0, 0], [1, 1], [2, 2], [4, 1]]);
  assert.deepEqual(C.shortestPath(ix, 4, 3), { nodes: [4, 0, 1, 2, 3], edges: [3, 0, 1, 2] });
  assert.equal(C.shortestPath(C.buildIndex(3, Int32Array.from([0]), Int32Array.from([1])), 0, 2), null);
  // calls propagate backwards (callers are affected), tested_by forwards.
  assert.deepEqual([...C.impactOf(ix, types, G.PROPAGATION, 1).keys()].sort(), [0, 1, 4], 'b <- a (caller) -> e (its test)');
  assert.deepEqual([...C.impactOf(ix, types, G.PROPAGATION, 1, 4, (w) => w === 0).keys()], [1], 'skipped nodes are never entered');
  assert.deepEqual([...C.impactOf(ix, types, G.PROPAGATION, 0).keys()].sort(), [0, 4]);
});

test('graph core: viewer impact matches rmc impact on the fixture', () => {
  const dir = built(), g = G.loadGraph(ctx(dir));
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
  const E = g.edges.filter((e) => idx.has(e.source) && idx.has(e.target));
  const ix = C.buildIndex(g.nodes.length, Int32Array.from(E, (e) => idx.get(e.source)), Int32Array.from(E, (e) => idx.get(e.target)));
  for (const start of ['table:users', 'function:src/db.js#query', 'file:src/services/billing.js']) {
    const viewer = [...C.impactOf(ix, E.map((e) => e.type), G.PROPAGATION, idx.get(start), 4, (w) => g.nodes[w].type === 'project').keys()].map((i) => g.nodes[i].id).sort();
    const r = G.impact(g, [start]), cli = [start, ...r.affected.map((a) => a.node.id)].sort();
    assert.ok(cli.length > 1, start);
    assert.deepEqual(viewer, cli, start);
  }
});

test('graph core: indexed search ranks exact names and requires every word', () => {
  const S = C.buildSearch([{ name: 'chargeOrder', text: 'chargeOrder function:src/billing.js#chargeOrder' }, { name: 'orders', text: 'orders table:orders' }, { name: 'users.js', text: 'src/routes/users.js' }]);
  assert.deepEqual(C.search(S, 'order'), [1, 0]);
  assert.deepEqual(C.search(S, 'orders'), [1], 'a longer word never matches a shorter token');
  assert.deepEqual(C.search(S, 'charge'), [0]);
  assert.deepEqual(C.search(S, 'routes users'), [2]);
  assert.deepEqual(C.search(S, 'routes billing'), []);
  assert.deepEqual(C.tokenize('chargeOrder'), ['chargeorder', 'charge', 'order']);
});

test('graph core: layout is deterministic, finite and fast at 10,000 nodes', () => {
  const g = synthGraph(10000, 7);
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
  const input = { n: g.nodes.length, src: Int32Array.from(g.edges, (e) => idx.get(e.source)), dst: Int32Array.from(g.edges, (e) => idx.get(e.target)), seeds: Float64Array.from(g.nodes, (n) => C.hashStr(n.id)), group: new Int32Array(g.nodes.length).map((_, i) => i % 40), size: new Float32Array(g.nodes.length).fill(5) };
  const t0 = performance.now();
  const a = C.layout(input);
  const ms = performance.now() - t0;
  const b = C.layout(input);
  assert.deepEqual(a.x, b.x); assert.deepEqual(a.y, b.y);
  assert.ok(a.x.every(Number.isFinite) && a.y.every(Number.isFinite));
  assert.ok(ms < 5000, `layout took ${Math.round(ms)} ms`);
  // A warm start keeps known positions close.
  const init = { x: a.x.slice(), y: a.y.slice() }; init.x[0] = NaN;
  const w = C.layout(input, init);
  assert.ok(Math.abs(w.x[5] - a.x[5]) < 200);
});

// ---------- headless browser smoke test (skipped when no Chromium-family browser is installed) ----------
const chrome = findChrome();
test('viewer renders every main route without script errors', { skip: !chrome && 'no Chromium-family browser' }, () => {
  const src = path.join(built(), '.rmcontext/viewer/index.html');
  const page = path.join(path.dirname(src), '_smoke.html');
  fs.writeFileSync(page, fs.readFileSync(src, 'utf8').replace('<head>', '<head><script>window.onerror=(m,s,l,c)=>{document.documentElement.dataset.err=(document.documentElement.dataset.err||"")+m+" @"+l+":"+c+"|"}</script>'));
  // A Windows browser driven from WSL gets a UNC path (\\wsl.localhost\<distro>\…), whose file URL is file://<host>/…, not file:///<host>/….
  const hp = hostPath(chrome, page).replace(/\\/g, '/');
  const url = (r) => (hp.startsWith('//') ? 'file:' + hp : 'file:///' + hp.replace(/^\/+/, '')) + r;
  const routes = ['#/overview', '#/explorer?p=src/routes/users.js', '#/list/apis?n=api:POST%20/users', '#/graph/all', '#/graph/module', '#/graph/all?focus=table:users&impact=1', '#/notes', '#/context', '#/documents?d=ERD-001'];
  for (const r of routes) {
    for (const size of ['1400,900', '390,844']) {
      const dom = execFileSync(chrome, ['--headless=new', '--disable-gpu', `--window-size=${size}`, '--virtual-time-budget=2000', '--dump-dom', url(r)], { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
      assert.doesNotMatch(dom, /data-err=/, `${r} @ ${size}: ${/data-err="([^"]*)"/.exec(dom)?.[1]}`);
      assert.match(dom, /id="nav-items"><(div|a) /, `${r}: navigation rendered`);
    }
  }
  const dump = (r) => execFileSync(chrome, ['--headless=new', '--disable-gpu', '--window-size=1400,900', '--virtual-time-budget=3000', '--dump-dom', url(r)], { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
  const dom = dump('#/explorer?p=src/routes/users.js');
  for (const s of ['Symbols', 'Imports', 'Routes', 'Tables', 'Callers', 'Callees', 'Requirements', 'Evidence']) assert.match(dom, new RegExp(`>${s}(\\s|<)`), `file details show ${s}`);
  assert.match(dom, /b-extracted/); assert.match(dom, /b-inferred/);
  // Mermaid diagrams render to SVG offline, in documents and notes.
  assert.match(dump('#/documents?d=ERD-001'), /<pre class="mermaid[^"]*"[^>]*>(?:(?!<\/pre>)[\s\S])*aria-roledescription="er"/, 'ERD document diagram rendered');
  const note = dump('#/notes?f=context/architecture.md');
  assert.match(note, /aria-roledescription="flowchart-v2"/, 'note flowchart rendered');
  assert.match(note, /<h2[^>]*>Architecture<\/h2>/, 'BOM-prefixed heading rendered');
  assert.match(note, /<th>Layer<\/th>/, 'Markdown table rendered');
});
