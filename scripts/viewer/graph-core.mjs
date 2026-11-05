// Pure graph functions shared by the viewer page, its layout Web Worker and the Node tests.
// No DOM, no imports: buildViewer inlines this file (with "export" stripped) into the single-file viewer.

// FNV-1a → [0, 1). Deterministic seed for layout positions.
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// Adjacency by node index. edges: [{ s, t }] with integer endpoints.
export function buildIndex(n, src, dst) {
  const deg = new Int32Array(n);
  for (let i = 0; i < src.length; i++) { deg[src[i]]++; deg[dst[i]]++; }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const fill = start.slice(0, n), adj = new Int32Array(start[n]), adjEdge = new Int32Array(start[n]);
  for (let i = 0; i < src.length; i++) {
    adj[fill[src[i]]] = dst[i]; adjEdge[fill[src[i]]++] = i;
    adj[fill[dst[i]]] = src[i]; adjEdge[fill[dst[i]]++] = i;
  }
  return { n, src, dst, deg, start, adj, adjEdge };
}

// Undirected neighbourhood up to `depth` hops. Returns Map(index → hop).
export function neighborhood(ix, from, depth = 1) {
  const seen = new Map([[from, 0]]);
  let frontier = [from];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const v of frontier) for (let k = ix.start[v]; k < ix.start[v + 1]; k++) { const w = ix.adj[k]; if (!seen.has(w)) { seen.set(w, d); next.push(w); } }
    frontier = next;
  }
  return seen;
}

// Shortest undirected path (BFS). Returns { nodes: [indices], edges: [edge indices] } or null.
export function shortestPath(ix, a, b) {
  if (a === b) return { nodes: [a], edges: [] };
  const prev = new Int32Array(ix.n).fill(-1), via = new Int32Array(ix.n).fill(-1);
  prev[a] = a;
  const q = [a];
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    for (let k = ix.start[v]; k < ix.start[v + 1]; k++) {
      const w = ix.adj[k];
      if (prev[w] !== -1) continue;
      prev[w] = v; via[w] = ix.adjEdge[k];
      if (w === b) {
        const nodes = [b], edges = [];
        for (let x = b; x !== a; x = prev[x]) { edges.push(via[x]); nodes.push(prev[x]); }
        return { nodes: nodes.reverse(), edges: edges.reverse() };
      }
      q.push(w);
    }
  }
  return null;
}

// Change impact with the same propagation rules as `rmc impact` (directed, per edge type).
// skip(i): nodes never entered (the project root contains everything, so reaching it says nothing about impact).
export function impactOf(ix, types, propagation, from, maxDepth = 4, skip = null) {
  const seen = new Map([[from, 0]]), q = [from];
  for (let h = 0; h < q.length; h++) {
    const v = q[h], d = seen.get(v);
    if (d >= maxDepth) continue;
    for (let k = ix.start[v]; k < ix.start[v + 1]; k++) {
      const e = ix.adjEdge[k], w = ix.adj[k], p = propagation[types[e]] || {};
      const fwd = ix.src[e] === v;
      const rule = fwd ? p.fwd : p.back;
      if ((rule === true || (rule === 'start' && d === 0)) && !seen.has(w) && !(skip && skip(w))) { seen.set(w, d + 1); q.push(w); }
    }
  }
  return seen;
}

// Split identifiers and paths into lowercase search tokens: "chargeOrder" → ["charge", "order", "chargeorder"].
export function tokenize(s) {
  const out = new Set();
  for (const part of String(s || '').split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    out.add(part.toLowerCase());
    for (const w of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ')) if (w.length > 1) out.add(w.toLowerCase());
  }
  return [...out];
}

// Sorted token index: prefix lookups by binary search instead of scanning every node per keystroke.
export function buildSearch(items) {
  const pairs = [];
  items.forEach((it, i) => { for (const t of tokenize(it.text)) pairs.push([t, i]); });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return { tokens: pairs.map((p) => p[0]), ids: Int32Array.from(pairs.map((p) => p[1])), items };
}
function lowerBound(arr, key) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < key) lo = m + 1; else hi = m; } return lo; }
export function search(S, query, limit = 50) {
  const terms = tokenize(query).filter((t) => !/^\d$/.test(t));
  const raw = String(query || '').trim().toLowerCase();
  if (!terms.length) return [];
  let acc = null;
  for (const t of terms.sort((a, b) => b.length - a.length).slice(0, 4)) {
    const hit = new Map();
    for (let k = lowerBound(S.tokens, t); k < S.tokens.length && S.tokens[k].startsWith(t); k++) {
      const i = S.ids[k], exact = S.tokens[k] === t ? 2 : 1;
      if (!hit.has(i) || hit.get(i) < exact) hit.set(i, exact);
    }
    if (acc === null) acc = hit;
    else { for (const [i, v] of acc) { if (!hit.has(i)) acc.delete(i); else acc.set(i, v + hit.get(i)); } }
    if (!acc.size) return [];
  }
  const scored = [];
  for (const [i, v] of acc) {
    const it = S.items[i], name = String(it.name || '').toLowerCase();
    scored.push([i, v + (name === raw ? 6 : name.startsWith(raw) ? 3 : name.includes(raw) ? 1.5 : 0) + Math.min(1, (it.weight || 0) / 20)]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return scored.slice(0, limit).map((s) => s[0]);
}

// Deterministic force layout on typed arrays with a uniform-grid repulsion (O(n) per iteration).
// g: { n, src, dst, seeds (Float64Array of hash values), group (Int32Array, -1 = none), size (Float32Array radii) }
// init: optional { x, y } (NaN entries are placed fresh). Same input → same output.
export function layout(g, init = null, opts = {}) {
  const N = g.n, x = new Float32Array(N), y = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
  if (!N) return { x, y, iterations: 0 };
  const size = g.size || new Float32Array(N).fill(5);
  // Groups placed on a golden-angle spiral (largest first), members on a spiral inside their group.
  let groupCount = 0;
  if (g.group) for (let i = 0; i < N; i++) if (g.group[i] + 1 > groupCount) groupCount = g.group[i] + 1;
  const gSize = new Int32Array(groupCount + 1);
  for (let i = 0; i < N; i++) gSize[g.group && g.group[i] >= 0 ? g.group[i] : groupCount]++;
  const order = [...gSize.keys()].filter((k) => gSize[k]).sort((a, b) => gSize[b] - gSize[a] || a - b);
  const gx = new Float32Array(groupCount + 1), gy = new Float32Array(groupCount + 1), gR = new Float32Array(groupCount + 1);
  const GOLD = Math.PI * (3 - Math.sqrt(5));
  let ring = 0;
  order.forEach((k, j) => {
    gR[k] = 18 * Math.sqrt(gSize[k]) + 20;
    if (j === 0) { gx[k] = 0; gy[k] = 0; ring = gR[k]; return; }
    const r = ring + gR[k] * 1.2 + 26 * Math.sqrt(j);
    gx[k] = Math.cos(j * GOLD) * r; gy[k] = Math.sin(j * GOLD) * r;
  });
  const slot = new Int32Array(groupCount + 1);
  for (let i = 0; i < N; i++) {
    if (init && Number.isFinite(init.x[i])) { x[i] = init.x[i]; y[i] = init.y[i]; continue; }
    const k = g.group && g.group[i] >= 0 ? g.group[i] : groupCount;
    const j = slot[k]++ + g.seeds[i];
    const r = 16 * Math.sqrt(j + 0.5);
    x[i] = gx[k] + Math.cos(j * GOLD) * r; y[i] = gy[k] + Math.sin(j * GOLD) * r;
  }
  const iterations = opts.iterations ?? (N > 6000 ? 60 : N > 2000 ? 90 : N > 300 ? 140 : 220);
  const warm = init ? 0.35 : 1;
  const E = g.src.length, REST = 34, CELL = 60, REP = 600;
  const next = new Int32Array(N);
  for (let it = 0; it < iterations; it++) {
    const alpha = warm * (1 - it / iterations) ** 1.5 + 0.01;
    // Grid repulsion.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) { if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i]; if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i]; }
    let cell = CELL;
    const span = Math.max(maxX - minX, maxY - minY);
    if (span / cell > 1024) cell = span / 1024;
    const cols = Math.floor((maxX - minX) / cell) + 1, rows = Math.floor((maxY - minY) / cell) + 1;
    const head = new Int32Array(cols * rows).fill(-1);
    for (let i = 0; i < N; i++) { const c = Math.floor((x[i] - minX) / cell) + Math.floor((y[i] - minY) / cell) * cols; next[i] = head[c]; head[c] = i; }
    const r2max = cell * cell;
    for (let i = 0; i < N; i++) {
      const cx = Math.floor((x[i] - minX) / cell), cy = Math.floor((y[i] - minY) / cell);
      for (let oy = -1; oy <= 1; oy++) {
        const yy = cy + oy; if (yy < 0 || yy >= rows) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = cx + ox; if (xx < 0 || xx >= cols) continue;
          for (let j = head[xx + yy * cols]; j !== -1; j = next[j]) {
            if (j <= i) continue;
            let dx = x[i] - x[j], dy = y[i] - y[j], d2 = dx * dx + dy * dy;
            if (d2 > r2max) continue;
            if (d2 < 0.01) { dx = g.seeds[i] - g.seeds[j] || 0.1; dy = 0.1; d2 = dx * dx + dy * dy; }
            const minD = size[i] + size[j] + 6;
            const f = (REP * (d2 < minD * minD ? 3 : 1) / d2) * alpha;
            vx[i] += dx * f; vy[i] += dy * f; vx[j] -= dx * f; vy[j] -= dy * f;
          }
        }
      }
    }
    // Springs.
    for (let e = 0; e < E; e++) {
      const a = g.src[e], b = g.dst[e];
      const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - REST - size[a] - size[b]) / d) * 0.06 * alpha;
      vx[a] += dx * f; vy[a] += dy * f; vx[b] -= dx * f; vy[b] -= dy * f;
    }
    // Group cohesion and weak centring.
    for (let i = 0; i < N; i++) {
      const k = g.group && g.group[i] >= 0 ? g.group[i] : -1;
      if (k >= 0) { vx[i] += (gx[k] - x[i]) * 0.012 * alpha; vy[i] += (gy[k] - y[i]) * 0.012 * alpha; }
      vx[i] -= x[i] * 0.0008 * alpha; vy[i] -= y[i] * 0.0008 * alpha;
      vx[i] *= 0.55; vy[i] *= 0.55;
      x[i] += Math.max(-40, Math.min(40, vx[i])); y[i] += Math.max(-40, Math.min(40, vy[i]));
    }
    if (opts.onProgress && it % 10 === 9) opts.onProgress((it + 1) / iterations);
  }
  return { x, y, iterations };
}
