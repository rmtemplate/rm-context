// Project management: plan schema, validation, evidence-based progress, critical path, Gantt.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, writeFile, now, fail, git, esc } from './util.mjs';
import * as G from './graph.mjs';

export const STATUSES = ['Planned', 'In Progress', 'Blocked', 'Completed', 'Cancelled'];
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const EVIDENCE = ['commit', 'file', 'test', 'pr', 'user'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (s) => (DATE.test(s || '') && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) ? Date.parse(s + 'T00:00:00Z') / 86400000 : null);
const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
const today = () => Math.floor(Date.now() / 86400000);

export const loadPlan = (c) => (fs.existsSync(c.plan) ? readJson(c.plan) : fail('No plan yet. Create one with: rmc pm init'));

// Duration in calendar days, inclusive. Milestones are 0.
export function durationOf(t) {
  if (t.milestone) return 0;
  const s = day(t.start), e = day(t.end);
  if (s !== null && e !== null) return e - s + 1;
  return Number.isInteger(t.duration) ? t.duration : null;
}

function leaves(plan) {
  const parents = new Set(plan.tasks.map((t) => t.parent).filter(Boolean));
  return plan.tasks.filter((t) => !parents.has(t.id));
}

export function validatePlan(c, plan) {
  const errors = [], warnings = [];
  if (!plan || !Array.isArray(plan.tasks)) return { errors: ['plan.json must have a tasks array'], warnings };
  const byId = new Map();
  for (const t of plan.tasks) {
    const w = `task ${t.id ?? '(no id)'}`;
    if (!t.id || !/^[A-Za-z][\w.-]*$/.test(t.id)) { errors.push(`${w}: id must start with a letter (e.g. T-001)`); continue; }
    if (byId.has(t.id)) errors.push(`${w}: duplicate id`);
    byId.set(t.id, t);
  }
  const sprints = new Set((plan.sprints || []).map((s) => s.id));
  for (const s of plan.sprints || []) {
    if (s.start !== 'TBD' && day(s.start) === null) errors.push(`sprint ${s.id}: start must be YYYY-MM-DD or TBD`);
    if (s.end !== 'TBD' && day(s.end) === null) errors.push(`sprint ${s.id}: end must be YYYY-MM-DD or TBD`);
  }
  for (const t of byId.values()) {
    const w = `task ${t.id}`;
    if (!t.name) errors.push(`${w}: name is required`);
    if (!STATUSES.includes(t.status)) errors.push(`${w}: status must be one of ${STATUSES.join(', ')}`);
    if (t.priority && !PRIORITIES.includes(t.priority)) errors.push(`${w}: priority must be one of ${PRIORITIES.join(', ')}`);
    for (const k of ['start', 'end']) if (t[k] !== undefined && t[k] !== 'TBD' && day(t[k]) === null) errors.push(`${w}: ${k} must be YYYY-MM-DD or "TBD" (got ${t[k]})`);
    for (const k of ['actualStart', 'actualEnd']) if (t[k] && day(t[k]) === null) errors.push(`${w}: ${k} must be YYYY-MM-DD`);
    const s = day(t.start), e = day(t.end);
    if (s !== null && e !== null && e < s) errors.push(`${w}: end ${t.end} is before start ${t.start}`);
    if (t.milestone && s !== null && e !== null && s !== e) errors.push(`${w}: a milestone has a single date (start = end)`);
    if (!t.milestone && s !== null && e !== null && Number.isInteger(t.duration) && t.duration !== e - s + 1) errors.push(`${w}: duration ${t.duration} ≠ ${e - s + 1} days between start and end (inclusive)`);
    if (t.duration !== undefined && t.duration !== null && !(Number.isInteger(t.duration) && t.duration >= 0)) errors.push(`${w}: duration must be a non-negative integer (days)`);
    if (t.progress !== undefined && !(Number.isInteger(t.progress) && t.progress >= 0 && t.progress <= 100)) errors.push(`${w}: progress must be an integer 0–100`);
    if (t.parent && !byId.has(t.parent)) errors.push(`${w}: parent ${t.parent} does not exist`);
    if (t.sprint && !sprints.has(t.sprint)) errors.push(`${w}: sprint ${t.sprint} is not defined in plan.sprints`);
    for (const d of t.dependencies || []) {
      if (d === t.id) errors.push(`${w}: depends on itself`);
      else if (!byId.has(d)) errors.push(`${w}: dependency ${d} does not exist`);
      else {
        const dep = byId.get(d);
        const de = day(dep.end) ?? day(dep.start);
        if (s !== null && de !== null && (dep.milestone ? s < de : s <= de)) errors.push(`${w}: starts ${t.start} before dependency ${d} finishes (${dep.end || dep.start})`);
        if (t.status === 'Completed' && dep.status !== 'Completed' && dep.status !== 'Cancelled') warnings.push(`${w}: Completed while dependency ${d} is ${dep.status}`);
      }
    }
    for (const [i, x] of (t.evidence || []).entries()) {
      if (!EVIDENCE.includes(x.type)) errors.push(`${w}: evidence[${i}].type must be one of ${EVIDENCE.join(', ')}`);
      if (!x.ref) errors.push(`${w}: evidence[${i}].ref is required (commit sha, file path, test path, PR URL, or who confirmed)`);
    }
    if (t.status === 'Completed') {
      if (!(t.evidence || []).length) errors.push(`${w}: Completed without evidence — add a commit, file, test, PR or user confirmation`);
      if (!t.actualEnd) errors.push(`${w}: Completed tasks need actualEnd`);
      if (t.progress !== undefined && t.progress !== 100) errors.push(`${w}: Completed tasks have progress 100`);
    }
    if (t.status === 'Planned' && t.progress > 0) warnings.push(`${w}: Planned but progress ${t.progress}% — should it be In Progress?`);
    if (t.status === 'Blocked' && !t.blockedBy && !(t.dependencies || []).some((d) => byId.get(d)?.status !== 'Completed')) warnings.push(`${w}: Blocked without blockedBy or an incomplete dependency`);
    if (t.status !== 'Completed' && t.status !== 'Cancelled' && e !== null && e < today()) warnings.push(`${w}: overdue — planned end ${t.end}, status ${t.status}`);
  }
  // Cycles in dependencies and in the parent hierarchy.
  const cycle = (next) => {
    const state = new Map();
    const visit = (id, trail) => {
      if (state.get(id) === 1) return [...trail.slice(trail.indexOf(id)), id];
      if (state.get(id) === 2) return null;
      state.set(id, 1);
      for (const n of next(id)) { const r = byId.has(n) && visit(n, [...trail, id]); if (r) return r; }
      state.set(id, 2);
      return null;
    };
    for (const id of byId.keys()) { const r = visit(id, []); if (r) return r; }
    return null;
  };
  const dc = cycle((id) => byId.get(id).dependencies || []);
  if (dc) errors.push(`dependency cycle: ${dc.join(' → ')}`);
  const pc = cycle((id) => (byId.get(id).parent ? [byId.get(id).parent] : []));
  if (pc) errors.push(`parent cycle: ${pc.join(' → ')}`);
  // Summary tasks should envelope their children.
  for (const t of byId.values()) {
    const kids = plan.tasks.filter((k) => k.parent === t.id);
    const ks = kids.map((k) => day(k.start)).filter((x) => x !== null), ke = kids.map((k) => day(k.end)).filter((x) => x !== null);
    if (ks.length && day(t.start) !== null && Math.min(...ks) < day(t.start)) warnings.push(`task ${t.id}: a child starts before the summary task`);
    if (ke.length && day(t.end) !== null && Math.max(...ke) > day(t.end)) warnings.push(`task ${t.id}: a child ends after the summary task`);
  }
  if (c) {
    const ids = fs.existsSync(c.nodes) ? new Set(G.loadGraph(c).nodes.map((n) => n.id)) : new Set();
    for (const t of byId.values()) for (const n of t.nodes || []) if (!ids.has(n)) warnings.push(`task ${t.id}: linked node ${n} is not in the graph`);
  }
  return { errors, warnings };
}

// Check evidence against the repository: files must exist, commits must be in git.
export function verifyEvidence(c, t) {
  return (t.evidence || []).map((x) => {
    let ok = null;
    if ((x.type === 'file' || x.type === 'test')) ok = fs.existsSync(path.join(c.root, x.file || x.ref));
    else if (x.type === 'commit') { const r = git(c.root, ['cat-file', '-t', x.ref]); ok = r === null ? null : r === 'commit'; }
    else if (x.type === 'user') ok = !!x.ref;
    return { ...x, verified: ok };
  });
}

export function progress(c, plan) {
  const ls = leaves(plan).filter((t) => t.status !== 'Cancelled');
  const durs = ls.map(durationOf);
  const weighted = ls.length > 0 && durs.every((d) => d !== null);
  const weight = (t, i) => (weighted ? Math.max(durs[i], t.milestone ? 0 : 1) : t.milestone ? 0 : 1);
  const total = ls.reduce((a, t, i) => a + weight(t, i), 0) || 1;
  let verified = 0, reported = 0, planned = 0, plannedKnown = 0;
  const unverified = [], tbd = [];
  const td = today();
  ls.forEach((t, i) => {
    const w = weight(t, i);
    const ev = verifyEvidence(c, t);
    const evOk = ev.length > 0 && ev.every((x) => x.verified !== false) && ev.some((x) => x.verified === true);
    if (t.status === 'Completed') { reported += w; if (evOk) verified += w; else unverified.push(t.id); }
    else if (t.status === 'In Progress' || t.status === 'Blocked') reported += (w * (t.progress || 0)) / 100;
    const s = day(t.start), e = day(t.end);
    if (s === null || e === null) { tbd.push(t.id); return; }
    plannedKnown += w;
    planned += w * Math.min(1, Math.max(0, (td - s + 1) / (e - s + 1)));
  });
  const count = (st) => ls.filter((t) => t.status === st).length;
  return {
    basis: weighted ? 'duration-weighted leaf tasks' : 'task count (some durations unknown)',
    tasks: { total: ls.length, planned: count('Planned'), inProgress: count('In Progress'), blocked: count('Blocked'), completed: count('Completed') },
    verifiedPercent: Math.round((verified / total) * 100),
    reportedPercent: Math.round((reported / total) * 100),
    plannedPercent: plannedKnown ? Math.round((planned / plannedKnown) * 100) : null,
    completedWithoutVerifiedEvidence: unverified, tbdDates: tbd, asOf: iso(td),
  };
}

export function criticalPath(plan) {
  const all = leaves(plan).filter((t) => t.status !== 'Cancelled');
  const allIds = new Set(all.map((t) => t.id));
  const expand = (d) => (allIds.has(d) ? [d] : plan.tasks.filter((t) => t.parent === d).flatMap((k) => expand(k.id)));
  const hasSucc = new Set(all.flatMap((t) => (t.dependencies || []).flatMap(expand)));
  const unknown = all.filter((t) => durationOf(t) === null);
  // An unscheduled task in the middle of the network makes the path unknowable; an unscheduled leaf can be set aside.
  const blocking = unknown.filter((t) => hasSucc.has(t.id)).map((t) => t.id);
  if (blocking.length) return { ok: false, reason: `durations unknown for ${blocking.join(', ')}, which other tasks depend on`, path: [] };
  const ls = all.filter((t) => durationOf(t) !== null);
  const ids = new Set(ls.map((t) => t.id));
  const preds = new Map(ls.map((t) => [t.id, [...new Set((t.dependencies || []).flatMap(expand))].filter((d) => ids.has(d))]));
  const excluded = unknown.map((t) => t.id);
  if (!ls.some((t) => (preds.get(t.id) || []).length)) return { ok: false, reason: 'no dependencies recorded', path: [] };
  const order = [], seen = new Set();
  const visit = (id) => { if (seen.has(id)) return; seen.add(id); for (const p of preds.get(id) || []) visit(p); order.push(id); };
  ls.forEach((t) => visit(t.id));
  const dur = new Map(ls.map((t) => [t.id, durationOf(t)]));
  const ES = new Map(), EF = new Map();
  for (const id of order) { const es = Math.max(0, ...(preds.get(id) || []).map((p) => EF.get(p))); ES.set(id, es); EF.set(id, es + dur.get(id)); }
  const end = Math.max(...EF.values());
  const succ = new Map(order.map((id) => [id, []]));
  for (const [id, ps] of preds) for (const p of ps) succ.get(p).push(id);
  const LF = new Map(), LS = new Map();
  for (const id of [...order].reverse()) { const lf = Math.min(end, ...succ.get(id).map((s) => LS.get(s))); LF.set(id, lf); LS.set(id, lf - dur.get(id)); }
  const crit = order.filter((id) => LS.get(id) - ES.get(id) === 0);
  return { ok: true, path: crit, lengthDays: end, excluded, slack: Object.fromEntries(order.map((id) => [id, LS.get(id) - ES.get(id)])) };
}

// Self-contained: serialised with toString() into HTML, so it must not reference anything outside itself.
export function renderGanttSvg(plan, opts = {}) {
  const DAY = 86400000;
  const d = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? Date.parse(s + 'T00:00:00Z') / DAY : null);
  const e = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const show = opts.statuses ? new Set(opts.statuses) : null;
  const crit = new Set(opts.critical || []);
  const todayN = opts.today != null ? opts.today : Math.floor(Date.now() / DAY);
  const COLORS = { Planned: '#8b8b98', 'In Progress': '#5b4cf0', Blocked: '#d64545', Completed: '#2f9e6b', Cancelled: '#c4c4cc' };
  const kids = new Map();
  for (const t of plan.tasks) { const p = t.parent || ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(t); }
  const rows = [];
  const walk = (p, depth) => { for (const t of kids.get(p) || []) { if (!show || show.has(t.status) || (kids.get(t.id) || []).length) rows.push({ t, depth, summary: (kids.get(t.id) || []).length > 0 }); walk(t.id, depth + 1); } };
  walk('', 0);
  const dates = plan.tasks.flatMap((t) => [d(t.start), d(t.end), d(t.actualStart), d(t.actualEnd)]).filter((x) => x !== null);
  const LABEL = 260, ROW = 26, TOP = 46;
  if (!dates.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${TOP + rows.length * ROW + 20}" font-family="Inter,Segoe UI,sans-serif" font-size="12"><text x="12" y="24" fill="#5b5b66">No task has known dates yet — all schedule dates are TBD.</text>${rows.map((r, i) => `<text x="${12 + r.depth * 14}" y="${TOP + i * ROW + 17}" fill="#16161d">${e(r.t.id)} ${e(r.t.name)} — TBD</text>`).join('')}</svg>`;
  }
  const min = Math.min(...dates, todayN) - 2, max = Math.max(...dates, todayN) + 3;
  const span = max - min;
  const px = Math.max(4, Math.min(36, Math.floor(1000 / span)));
  const W = LABEL + span * px + 20, H = TOP + rows.length * ROW + 24;
  const x = (n) => LABEL + (n - min) * px;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter,Segoe UI,system-ui,sans-serif" font-size="12" role="img" aria-label="Gantt chart">`,
    `<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#9a9aa6"/></marker>`,
    `<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="currentColor" opacity=".35"/></pattern></defs>`,
    `<rect width="${W}" height="${H}" fill="var(--gantt-bg, #ffffff)"/>`];
  // Timeline: month labels and weekly ticks.
  for (let n = min; n <= max; n++) {
    const dt = new Date(n * DAY);
    if (dt.getUTCDate() === 1 || n === min) out.push(`<text x="${x(n) + 3}" y="16" fill="#5b5b66" font-weight="600">${dt.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${dt.getUTCFullYear()}</text>`);
    if (dt.getUTCDay() === 1) out.push(`<line x1="${x(n)}" y1="24" x2="${x(n)}" y2="${H - 20}" stroke="#ececf1"/><text x="${x(n) + 2}" y="36" fill="#9a9aa6" font-size="10">${dt.getUTCDate()}</text>`);
  }
  const pos = new Map();
  rows.forEach((r, i) => {
    const y = TOP + i * ROW, t = r.t;
    const s = d(t.start), en = d(t.end) ?? s;
    const col = COLORS[t.status] || '#8b8b98';
    out.push(`<g class="row" data-id="${e(t.id)}" data-status="${e(t.status)}">`);
    if (i % 2) out.push(`<rect x="0" y="${y}" width="${W}" height="${ROW}" fill="#f7f7fa" opacity=".6"/>`);
    out.push(`<text x="${10 + r.depth * 14}" y="${y + 17}" fill="#16161d"${r.summary ? ' font-weight="600"' : ''}>${e(t.id)} ${e(String(t.name).slice(0, 30 - r.depth * 2))}</text>`);
    out.push(`<title>${e(`${t.id} ${t.name}\n${t.status}${t.owner ? ' · ' + t.owner : ''}\nPlanned: ${t.start || 'TBD'} → ${t.end || 'TBD'}${t.actualEnd ? '\nActual end: ' + t.actualEnd : ''}${t.progress != null ? '\nProgress: ' + t.progress + '%' : ''}`)}</title>`);
    if (s === null) { out.push(`<text x="${LABEL + 6}" y="${y + 17}" fill="#9a9aa6" font-style="italic">dates TBD</text></g>`); return; }
    const cx = crit.has(t.id) ? ' stroke="#16161d" stroke-width="1.5" stroke-opacity="1"' : '';
    if (t.milestone) {
      const mx = x(s) + px / 2;
      out.push(`<path d="M${mx},${y + 5} l8,8 l-8,8 l-8,-8 z" fill="${col}"${cx}/>`);
      pos.set(t.id, { x1: mx - 8, x2: mx + 8, y: y + 13 });
    } else {
      const bw = Math.max(px, (en - s + 1) * px);
      const h = r.summary ? 8 : 14, by = y + (ROW - h) / 2 - 3;
      out.push(`<rect x="${x(s)}" y="${by}" width="${bw}" height="${h}" rx="3" fill="${col}" opacity="${r.summary ? 0.85 : 0.22}"${cx}/>`);
      if (!r.summary) {
        const p = t.status === 'Completed' ? 100 : t.progress || 0;
        if (p) out.push(`<rect x="${x(s)}" y="${by}" width="${(bw * p) / 100}" height="${h}" rx="3" fill="${col}"/>`);
        const as = d(t.actualStart) ?? (t.actualEnd ? s : null), ae = d(t.actualEnd) ?? (t.status === 'In Progress' && as !== null ? todayN : null);
        if (as !== null && ae !== null) out.push(`<rect x="${x(as)}" y="${by + h + 2}" width="${Math.max(2, (ae - as + 1) * px)}" height="3" fill="#16161d" opacity=".55"><title>Actual</title></rect>`);
      }
      pos.set(t.id, { x1: x(s), x2: x(s) + bw, y: by + h / 2 });
    }
    out.push('</g>');
  });
  for (const r of rows) for (const dep of r.t.dependencies || []) {
    const a = pos.get(dep), b = pos.get(r.t.id);
    if (!a || !b) continue;
    const mx = Math.max(a.x2 + 6, b.x1 - 8);
    out.push(`<path d="M${a.x2},${a.y} H${mx} V${b.y} H${b.x1 - 1}" fill="none" stroke="#9a9aa6" stroke-width="1.2" marker-end="url(#arr)"/>`);
  }
  out.push(`<line x1="${x(todayN) + px / 2}" y1="22" x2="${x(todayN) + px / 2}" y2="${H - 18}" stroke="#d64545" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${x(todayN) + px / 2 + 4}" y="${H - 6}" fill="#d64545" font-size="11">today</text>`);
  out.push('</svg>');
  return out.join('');
}

export function ganttHtml(plan, crit) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gantt — ${esc(plan.project?.name || 'Project')}</title>
<style>body{margin:0;font:14px Inter,"Segoe UI",system-ui,sans-serif;color:#16161d;background:#fff}header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #e4e4ea}
h1{font-size:16px;margin:0 12px 0 0}label{display:inline-flex;gap:4px;align-items:center;font-size:13px}.wrap{overflow:auto;padding:8px 0}.legend span{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:-1px}
button{font:inherit;border:1px solid #d4d4dc;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer}</style></head><body>
<header><h1>${esc(plan.project?.name || 'Project')} — schedule</h1><div id="filters"></div>
<span class="legend"><span style="background:#8b8b98"></span>Planned<span style="background:#5b4cf0"></span>In progress<span style="background:#d64545"></span>Blocked<span style="background:#2f9e6b"></span>Completed · bold outline = critical path · thin black bar = actual</span>
<button id="dl">Download SVG</button></header><div class="wrap" id="chart"></div>
<script>
const plan = ${JSON.stringify(plan).replace(/</g, '\\u003c')};
const critical = ${JSON.stringify(crit)};
const renderGanttSvg = ${renderGanttSvg.toString()};
const STATUSES = ${JSON.stringify(STATUSES)};
const on = new Set(STATUSES);
const f = document.getElementById('filters');
for (const s of STATUSES) { const l = document.createElement('label'); l.innerHTML = '<input type="checkbox" checked> ' + s; l.firstChild.onchange = (ev) => { ev.target.checked ? on.add(s) : on.delete(s); draw(); }; f.appendChild(l); }
function draw() { document.getElementById('chart').innerHTML = renderGanttSvg(plan, { statuses: [...on], critical }); }
document.getElementById('dl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([renderGanttSvg(plan, { statuses: [...on], critical })], { type: 'image/svg+xml' })); a.download = 'gantt.svg'; a.click(); };
draw();
</script></body></html>`;
}

export function mermaidGantt(c) {
  if (!fs.existsSync(c.plan)) return '_No plan.json yet (rmc pm init)._';
  const plan = loadPlan(c);
  const mid = (id) => id.replace(/[^A-Za-z0-9_]/g, '_');
  const tag = (t) => ({ Completed: 'done, ', 'In Progress': 'active, ', Blocked: 'crit, ' }[t.status] || '') + (t.milestone ? 'milestone, ' : '');
  const lines = ['```mermaid', 'gantt', `  title ${(plan.project?.name || 'Project').replace(/[:#]/g, '')}`, '  dateFormat YYYY-MM-DD', '  todayMarker on'];
  const tbd = [];
  const tops = plan.tasks.filter((t) => !t.parent);
  const kidsOf = (id) => plan.tasks.filter((t) => t.parent === id);
  const emit = (t) => {
    const s = day(t.start);
    if (s === null) { tbd.push(t.id); return; }
    const dur = t.milestone ? '0d' : `${durationOf(t) ?? 1}d`;
    lines.push(`  ${t.name.replace(/[:#]/g, ' ')} :${tag(t)}${mid(t.id)}, ${t.start}, ${dur}`);
  };
  for (const top of tops) {
    const kids = kidsOf(top.id);
    if (kids.length) { lines.push(`  section ${top.name.replace(/[:#]/g, ' ')}`); const all = (id) => kidsOf(id).flatMap((k) => [k, ...all(k.id)]); all(top.id).filter((k) => !kidsOf(k.id).length).forEach(emit); }
    else { lines.push(`  section ${top.id}`); emit(top); }
  }
  lines.push('```');
  return lines.join('\n') + (tbd.length ? `\n\nNot scheduled (dates TBD): ${tbd.join(', ')}` : '');
}

export function criticalPathMarkdown(c) {
  if (!fs.existsSync(c.plan)) return '';
  const cp = criticalPath(loadPlan(c));
  return cp.ok ? `**Critical path** (${cp.lengthDays} days): ${cp.path.join(' → ')}${cp.excluded.length ? ` — excludes unscheduled ${cp.excluded.join(', ')}` : ''}` : `**Critical path:** not computed — ${cp.reason}.`;
}

export function wbsMarkdown(c) {
  if (!fs.existsSync(c.plan)) return '_No plan.json yet (rmc pm init)._';
  const plan = loadPlan(c);
  const out = [];
  const walk = (p, prefix, depth) => plan.tasks.filter((t) => (t.parent || null) === p).forEach((t, i) => {
    const code = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
    out.push(`${'  '.repeat(depth)}- **${code}** ${t.id} ${t.name} — ${t.owner || 'owner TBD'} · ${t.status}${t.milestone ? ' · milestone' : ''}`);
    walk(t.id, code, depth + 1);
  });
  walk(null, '', 0);
  return out.join('\n') || '_Plan has no tasks._';
}

export function roadmapMarkdown(c) {
  if (!fs.existsSync(c.plan)) return '_No plan.json yet (rmc pm init)._';
  const plan = loadPlan(c);
  const ms = plan.tasks.filter((t) => t.milestone);
  if (!ms.length) return '_No milestones defined in plan.json._';
  return ['| Milestone | Target date | Status | Depends on | Evidence |', '|---|---|---|---|---|',
    ...ms.sort((a, b) => (day(a.start) ?? 1e9) - (day(b.start) ?? 1e9)).map((m) => `| ${m.id} ${m.name} | ${m.start || 'TBD'} | ${m.status} | ${(m.dependencies || []).join(', ') || '—'} | ${(m.evidence || []).map((x) => `${x.type}: ${x.ref}`).join('; ') || '—'} |`)].join('\n');
}

export function healthReport(c) {
  const plan = fs.existsSync(c.plan) ? loadPlan(c) : null;
  const v = plan ? validatePlan(c, plan) : null;
  const p = plan ? progress(c, plan) : null;
  const cp = plan ? criticalPath(plan) : null;
  const g = G.loadGraph(c);
  const s = G.stats(g);
  const reg = readJson(c.registry, { documents: [] });
  const rtm = G.rtm(g);
  const td = today();
  const overdue = plan ? plan.tasks.filter((t) => !['Completed', 'Cancelled'].includes(t.status) && day(t.end) !== null && day(t.end) < td) : [];
  const overdueMs = overdue.filter((t) => t.milestone);
  const blockedCrit = plan && cp?.ok ? plan.tasks.filter((t) => t.status === 'Blocked' && cp.path.includes(t.id)) : [];
  const files = s.byType.file || 0, tests = s.byType.test || 0;
  const signals = [];
  const red = [], amber = [];
  if (v?.errors.length) red.push(`plan has ${v.errors.length} validation error(s)`);
  if (overdueMs.length) red.push(`overdue milestone(s): ${overdueMs.map((t) => t.id).join(', ')}`);
  if (blockedCrit.length) red.push(`blocked critical-path task(s): ${blockedCrit.map((t) => t.id).join(', ')}`);
  if (overdue.length > overdueMs.length) amber.push(`${overdue.length - overdueMs.length} overdue task(s)`);
  if (p && p.plannedPercent !== null && p.plannedPercent - p.verifiedPercent > 15) amber.push(`verified progress ${p.verifiedPercent}% trails the planned ${p.plannedPercent}% by more than 15 points`);
  if (p?.completedWithoutVerifiedEvidence.length) amber.push(`completed without verifiable evidence: ${p.completedWithoutVerifiedEvidence.join(', ')}`);
  if (s.stale) amber.push(`${s.stale} stale knowledge item(s)`);
  if (files && !tests) amber.push('no test files detected');
  const rag = red.length ? 'Red' : amber.length ? 'Amber' : plan ? 'Green' : 'Not assessable (no plan)';
  signals.push(...red.map((x) => `- 🔴 ${x}`), ...amber.map((x) => `- 🟠 ${x}`));
  const cov = rtm.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  return `# Project Health Report

Generated ${now()} from repository evidence and plan.json. Overall: **${rag}**

RAG rules: Red = plan invalid, overdue milestone, or blocked critical-path task. Amber = overdue tasks, verified progress more than 15 points behind plan, unverifiable completions, stale knowledge, or no tests. Green = none of these.

## Signals
${signals.join('\n') || '- No negative signals.'}

## Delivery
${p ? `- Verified progress: **${p.verifiedPercent}%** (completed tasks with evidence found in the repo)
- Reported progress: ${p.reportedPercent}% (includes self-reported in-progress percentages)
- Planned by today: ${p.plannedPercent === null ? 'n/a (dates TBD)' : p.plannedPercent + '%'} (schedule baseline, not actual)
- Tasks: ${p.tasks.completed} completed, ${p.tasks.inProgress} in progress, ${p.tasks.blocked} blocked, ${p.tasks.planned} planned (basis: ${p.basis})
- ${cp.ok ? `Critical path (${cp.lengthDays} d): ${cp.path.join(' → ')}` : `Critical path not computed: ${cp.reason}`}${p.tbdDates.length ? `\n- Tasks with TBD dates: ${p.tbdDates.join(', ')}` : ''}` : '- No plan.json. The Project Manager creates one with `rmc pm init`.'}

## Requirements traceability
- ${rtm.length} requirement(s): ${Object.entries(cov).map(([k, n]) => `${n} ${k}`).join(', ') || 'none recorded'}

## Codebase
- ${files} source files, ${tests} test files, ${s.byType.api || 0} APIs, ${s.byType.table || 0} tables, ${s.byType.pipeline || 0} CI pipelines
- Graph edges: ${Object.entries(s.edgeConfidence).map(([k, n]) => `${n} ${k}`).join(', ')}

## Documentation
- ${reg.documents.length} document(s): ${['Draft', 'Under Review', 'Approved'].map((st) => `${reg.documents.filter((d) => d.status === st).length} ${st}`).join(', ')}${reg.documents.some((d) => d.needsReview) ? `\n- Needs review: ${reg.documents.filter((d) => d.needsReview).map((d) => d.id).join(', ')}` : ''}

## Limits of this report
- Progress counts only what plan.json records. Work outside the plan is invisible here.
- Evidence verification checks that referenced files and commits exist, not that they implement the task correctly. QA review does that.
`;
}

export async function cli(c, sub, rest, args) {
  switch (sub) {
    case 'init': {
      if (fs.existsSync(c.plan)) fail('plan.json already exists; refusing to overwrite');
      const m = readJson(c.manifest);
      writeJson(c.plan, { schemaVersion: 2, project: { name: m.project.name, start: 'TBD' }, sprints: [], tasks: [] });
      return 'Created .rmcontext/project-management/plan.json';
    }
    case 'validate': {
      const r = validatePlan(c, loadPlan(c));
      if (r.errors.length) process.exitCode = 1;
      return [r.errors.length ? `✘ ${r.errors.length} error(s)` : '✔ plan valid', ...r.errors.map((e) => `  error: ${e}`), ...r.warnings.map((w) => `  warn:  ${w}`)].join('\n');
    }
    case 'progress': {
      const p = progress(c, loadPlan(c));
      if (args.json) return p;
      return `As of ${p.asOf} (${p.basis}):
  Verified  ${p.verifiedPercent}%  — completed tasks whose evidence exists in the repo
  Reported  ${p.reportedPercent}%  — adds self-reported progress of in-progress/blocked tasks
  Planned   ${p.plannedPercent === null ? 'n/a' : p.plannedPercent + '%'}  — where the schedule says we should be (baseline only)
Tasks: ${p.tasks.completed} completed · ${p.tasks.inProgress} in progress · ${p.tasks.blocked} blocked · ${p.tasks.planned} planned (of ${p.tasks.total})` +
        (p.completedWithoutVerifiedEvidence.length ? `\nCompleted but evidence not verifiable: ${p.completedWithoutVerifiedEvidence.join(', ')}` : '') + (p.tbdDates.length ? `\nDates TBD: ${p.tbdDates.join(', ')}` : '');
    }
    case 'gantt': {
      const plan = loadPlan(c);
      const v = validatePlan(c, plan);
      if (v.errors.length) fail(`Fix plan errors first:\n  ${v.errors.join('\n  ')}`);
      const cp = criticalPath(plan);
      const dir = path.resolve(c.root, args.out || '.rmcontext/project-management');
      writeFile(path.join(dir, 'gantt.svg'), renderGanttSvg(plan, { critical: cp.path }));
      writeFile(path.join(dir, 'gantt.html'), ganttHtml(plan, cp.path));
      return `Wrote ${path.relative(c.root, path.join(dir, 'gantt.svg'))} and gantt.html. ${cp.ok ? `Critical path: ${cp.path.join(' → ')} (${cp.lengthDays} days)` : `Critical path not computed: ${cp.reason}`}`;
    }
    case 'mermaid': return mermaidGantt(c);
    case 'health': {
      const md = healthReport(c);
      if (args.out) { writeFile(path.resolve(c.root, args.out), md); return `Wrote ${args.out}`; }
      return md;
    }
    default: fail(`Unknown pm subcommand: ${sub}`);
  }
}
