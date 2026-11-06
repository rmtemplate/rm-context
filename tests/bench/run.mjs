// Viewer benchmark: node tests/bench/run.mjs <label> [sizes...]
// Builds a viewer per graph size, opens it headless with #bench, and records the page's own timings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeSynthProject } from './synth.mjs';
import { ctx } from '../../scripts/lib/util.mjs';
import { buildViewer } from '../../scripts/lib/viewer.mjs';
import { findChrome, hostPath } from '../../scripts/lib/docs.mjs';

const OLD_BENCH = `
if (window.__RMC_BENCH) try {
  const R = {}, T = () => performance.now();
  R.bootMs = T();
  let t = T(); show('graph'); R.showGraphMs = T() - t; R.visibleNodes = visible.length; R.visibleEdges = visEdges.length;
  t = T(); let it = 0; alpha = 1; while (alpha > 0.02) { simulate(); alpha *= 0.965; it++; } R.layoutMs = T() - t; R.layoutIterations = it;
  t = T(); resize(); fit(); R.firstDrawMs = T() - t;
  t = T(); draw(); R.redrawMs = T() - t;
  t = T(); q.value = 'fn1'; q.dispatchEvent(new Event('input')); R.searchMs = T() - t; R.searchHits = hits.length;
  t = T(); select(nodes[Math.floor(nodes.length / 2)].id); R.selectMs = T() - t;
  R.heapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
  R.domElements = document.getElementsByTagName('*').length;
  document.body.dataset.bench = JSON.stringify(R);
} catch (err) { document.body.dataset.bench = JSON.stringify({ error: String(err && err.stack || err) }); }
`;

export function runBench(label, sizes, { inject = null } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chromium-family browser found');
  const rows = [];
  for (const size of sizes) {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.out', `${label}-${size}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const info = size === 'repo' ? null : writeSynthProject(dir, size);
    const root = size === 'repo' ? process.env.RMC_BENCH_REPO : dir;
    const c = ctx(root);
    const t0 = Date.now(); buildViewer(c); const buildMs = Date.now() - t0;
    let html = fs.readFileSync(c.viewer, 'utf8');
    if (inject) html = html.replace('<head>', '<head><script>window.__RMC_BENCH = location.hash === "#bench";</script>').replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, `${inject}\n})();\n</script>\n</body>`);
    fs.writeFileSync(c.viewer, html);
    const url = 'file:///' + hostPath(chrome, c.viewer).replace(/\\/g, '/').replace(/^\/+/, '') + '#bench';
    const out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--window-size=1400,900', '--enable-precise-memory-info', '--dump-dom', url], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 300000 });
    const m = /data-bench="([^"]*)"/.exec(out);
    const r = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : { error: 'no bench result' };
    rows.push({ label, size, nodes: info?.nodes, edges: info?.edges, htmlKB: Math.round(html.length / 1024), buildMs, ...r });
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [label = 'run', ...sizes] = process.argv.slice(2);
  const rows = runBench(label, (sizes.length ? sizes : ['500', '2000', '10000']).map((s) => (s === 'repo' ? s : Number(s))), { inject: label === 'baseline' ? OLD_BENCH : null });
  console.log(JSON.stringify(rows, null, 1));
}
