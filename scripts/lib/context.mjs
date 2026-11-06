// Automatic context: compact session summary, deterministic prompt retrieval within a token budget,
// and coalesced incremental refresh of files changed during a turn. No LLM calls; prompts are never stored.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ctx, readJson, writeJson, now, toPosix } from './util.mjs';
import { loadModelConfig } from './routing.mjs';
import { findSecrets } from './ignore.mjs';
import * as G from './graph.mjs';

export const AUTO_DEFAULTS = {
  enabled: true, sessionStart: true, promptRetrieval: true, incrementalRefresh: true,
  maxContextTokens: 1200, sessionContextTokens: 330, maxResults: 8, minimumRelevance: 0.45, verifySource: true,
};

// Walk up from cwd to the nearest initialized project.
export function findProject(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.rmcontext', 'manifest.json'))) return ctx(dir);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function autoConfig(c) {
  const conf = { ...AUTO_DEFAULTS, ...(c && fs.existsSync(c.config) ? readJson(c.config, {}).autoContext || {} : {}) };
  if (process.env.RMC_AUTO_CONTEXT === '0') conf.enabled = false;
  return conf;
}

export const tokens = (s) => Math.ceil(String(s).length / 3.5);
const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- session start ----------
export function sessionSummary(c, cli) {
  if (!c) return '[RM CONTEXT] No RM Context knowledge base in this project. Run /rmc:init to create one (a deterministic scan; nothing was scanned automatically).';
  const conf = autoConfig(c);
  if (!conf.enabled || !conf.sessionStart) return '';
  const m = readJson(c.manifest, {});
  const st = m.stack || {};
  const stack = [...Object.keys(st.languages || {}).slice(0, 3), ...(st.frameworks || []).slice(0, 3), ...(st.datastores || []).slice(0, 2)].join(', ');
  const scan = readJson(c.scan, {});
  const g = scan.graph || {};
  const lr = readJson(c.p('state', 'last-refresh.json'), null);
  const pending = fs.existsSync(pendingFile(c));
  const lines = [
    `[RM CONTEXT] Project intelligence for "${m.project?.name || path.basename(c.root)}" is in .rmcontext/${stack ? ` (stack: ${stack})` : ''}.`,
    `Last scan ${String(m.scan?.timestamp || 'unknown').slice(0, 16).replace('T', ' ')} UTC (${m.scan?.mode || '?'})${g.nodes ? `, graph ${g.nodes} nodes / ${g.edges} edges` : ''}${lr ? `; last auto-refresh ${lr.at.slice(0, 16).replace('T', ' ')}` : ''}${pending ? '; changes pending refresh' : ''}.`,
    conf.promptRetrieval ? 'Relevant knowledge is added to your prompts automatically when it matches; it is derived from source, so verify the cited files before relying on it.' : '',
    `RM Context CLI (rmc): node "${cli}" — find <terms> · impact <file|id> · status. Read .rmcontext/INDEX.md only if broader orientation is needed.`,
  ].filter(Boolean);
  // Delegation policy (routing.autoSuggest): suggestions are advice; delegation stays Claude's decision.
  const policy = suggestionsOn(c) ? 'Routing: "RM Context suggests <agent> (<model>)" lines are advice. Delegate only investigation or cross-module work, never simple lookups: rmc route --suggested --session-model <your model id>, show its Notice, one foreground agent at a time. Answered directly? Claim no delegation.' : '';
  let out = [...lines, policy].filter(Boolean).join('\n');
  // Over budget: drop the optional middle lines first, keeping the header, the CLI line and the policy.
  while (tokens(out) > conf.sessionContextTokens && lines.length > 2) { lines.splice(lines.length - 2, 1); out = [...lines, policy].filter(Boolean).join('\n'); }
  return out;
}

function suggestionsOn(c) {
  const r = loadModelConfig(c).routing;
  return r.enabled !== false && r.autoSuggest !== false;
}

// ---------- prompt retrieval ----------
const STOP = new Set(`a an the and or but if then else of to in on at by for with from into onto as is are was were be been being do does did done have has had
this that these those it its it's i me my we our you your he she they them their what which who whom whose where when why how can could should would will shall may might must
please pls just also not no yes ok okay thanks thank hi hello there here about any some all more most very much many each every new add adding create make making build
implement implementing fix fixing update change changes explain show tell find give get use using need needs want like work works working code file files function functions
project feature features let lets help write generate run check look see
yang dan di ke dari untuk pada dengan ini itu ada adalah akan bisa dapat jadi juga atau tapi tetapi karena agar supaya saya aku kamu kita kami anda tolong mohon
buat buatkan bikin tambah tambahkan tambahin ubah ubahkan perbaiki benerin jelaskan tunjukkan cari carikan gimana bagaimana apa apakah mana dimana kenapa mengapa
fitur fungsi kode file berkas sudah belum masih lagi saja aja dong deh nya sih kok semua setiap baru yg dgn utk tdk ga gak nggak tidak bukan seperti cara langsung`.split(/\s+/));
// Small Indonesian → English vocabulary so local-language prompts can reach English identifiers.
const SYN = { pengguna: 'user', pelanggan: 'customer', pesanan: 'order', pembayaran: 'payment', bayar: 'payment', tagihan: 'invoice', faktur: 'invoice',
  harga: 'price', produk: 'product', barang: 'product', keranjang: 'cart', masuk: 'login', keluar: 'logout', daftar: 'register', pendaftaran: 'register',
  sandi: 'password', kata_sandi: 'password', hitung: 'calculate', menghitung: 'calculate', perhitungan: 'calculate', jumlah: 'total', batal: 'cancel',
  pembatalan: 'cancel', membatalkan: 'cancel', pemesanan: 'booking', pesan: 'booking', jadwal: 'schedule', laporan: 'report', notifikasi: 'notification',
  pengiriman: 'shipping', kirim: 'send', simpan: 'save', hapus: 'delete', ubah: 'update', stok: 'stock', gudang: 'warehouse', karyawan: 'employee',
  dokter: 'doctor', pasien: 'patient', klinik: 'clinic', akun: 'account', peran: 'role', izin: 'permission', berkas: 'file', unggah: 'upload', unduh: 'download' };
// Related concepts in code vocabulary (weight 0.7): lets "payment" reach billing/charge code, "login" reach auth, etc.
const CONCEPTS = { payment: ['pay', 'billing', 'charge', 'invoice', 'checkout', 'stripe'], billing: ['payment', 'charge', 'invoice'], login: ['auth', 'signin', 'session', 'token'],
  auth: ['login', 'session', 'token', 'jwt'], register: ['signup', 'registration'], user: ['account', 'member'], account: ['user'], delete: ['remove', 'destroy'],
  booking: ['reservation', 'appointment'], reservation: ['booking'], cancel: ['cancellation', 'refund'], order: ['purchase', 'checkout'], product: ['item', 'catalog'],
  notification: ['email', 'mail', 'notify'], email: ['mail', 'notification'], report: ['export', 'analytics'], search: ['filter', 'query'], upload: ['file', 'storage'] };
const DOC_WORDS = ['brd', 'fsd', 'sipoc', 'srs', 'erd', 'uml', 'adr', 'rtm', 'wbs', 'gantt', 'roadmap', 'runbook', 'raci', 'raid'];
const INFRA_WORDS = new Set(['deploy', 'deployment', 'docker', 'dockerfile', 'compose', 'kubernetes', 'k8s', 'helm', 'pipeline', 'ci', 'cd', 'cicd', 'nginx', 'server', 'terraform', 'infra', 'infrastructure', 'environment', 'staging', 'production']);

function split(text) {
  return String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
}

export function queryTerms(prompt) {
  const raw = split(prompt).filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
  const terms = new Map();
  const add = (t, w) => terms.set(t, Math.max(terms.get(t) || 0, w));
  // Term frequency: a word the prompt repeats is its topic (1 + ln tf); a word used once keeps weight 1, so short prompts are unchanged.
  const tf = new Map();
  for (const t of raw) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, n] of tf) { const w = 1 + Math.log(n); add(t, w); if (SYN[t]) add(SYN[t], 0.9 * w); }
  for (const [t, w] of [...terms]) for (const r of CONCEPTS[t] || []) add(r, 0.7 * w);
  const words = new Set(split(prompt));
  return { terms, docTypes: DOC_WORDS.filter((d) => words.has(d)), infra: [...words].some((w) => INFRA_WORDS.has(w)) };
}

const PRIORITY = { function: 1, class: 1, component: 1, api: 1.1, table: 1.05, entity: 1, file: 0.95, test: 0.8, module: 0.9, business_rule: 1.1, business_requirement: 1.05,
  requirement: 1.05, use_case: 1, user_story: 1, feature: 1.05, integration: 1, service: 1, container: 0.9, pipeline: 0.9, dependency: 0.5, project: 0, document: 0.9 };

function nodeTokens(n) {
  const ev = (n.evidence || []).map((e) => e.file).filter(Boolean).join(' ');
  return new Set(split(`${n.name} ${n.id} ${ev} ${n.attrs?.path || ''} ${n.description || ''} ${(n.tags || []).join(' ')}`));
}

// Score every node: idf-weighted share of the query's known terms it contains. Unknown terms (new concepts) do not dilute the score.
// The share is taken over the TOP_TERMS most discriminative known terms only, so a long prompt (many known words) is not
// diluted: a node must still match several of the prompt's strongest terms to pass minimumRelevance. Short prompts
// (≤ TOP_TERMS known terms) score exactly as before.
export const TOP_TERMS = 6;
export function rankNodes(g, terms) {
  const toks = g.nodes.map(nodeTokens);
  const N = g.nodes.length || 1;
  const vocab = new Map();
  for (const ts of toks) for (const t of ts) vocab.set(t, (vocab.get(t) || 0) + 1);
  const known = [];
  for (const [q, w] of terms) {
    let df = vocab.get(q) || 0, exact = df > 0;
    if (!exact && q.length >= 4) for (const [t, d] of vocab) if (t.length >= 4 && (t.startsWith(q) || q.startsWith(t))) df = Math.max(df, d);
    if (!df || df / N > 0.25) continue; // unknown here, or too common to discriminate
    known.push({ q, w: w * Math.log(1 + N / df) });
  }
  const total = [...known].sort((a, b) => b.w - a.w).slice(0, TOP_TERMS).reduce((a, k) => a + k.w, 0);
  if (!total) return { known: [], ranked: [], total: 0 };
  const ranked = [];
  g.nodes.forEach((n, i) => {
    const pr = PRIORITY[n.type] ?? 0.9;
    if (!pr) return;
    let hit = 0;
    for (const { q, w } of known) {
      if (toks[i].has(q)) hit += w;
      else if (q.length >= 4) for (const t of toks[i]) if (t.length >= 4 && (t.startsWith(q) || q.startsWith(t))) { hit += w * 0.75; break; }
    }
    if (hit) ranked.push({ n, score: Math.min(1, (hit / total) * pr) });
  });
  ranked.sort((a, b) => b.score - a.score || (a.n.name.length - b.n.name.length));
  return { known, ranked, total };
}

// How a neighbour relates to the hit: hit --type--> neighbour reads PASSIVE; neighbour --type--> hit reads ACTIVE.
const PASSIVE = { implements: 'implemented by', reads_from: 'read by', writes_to: 'written by', tested_by: 'tests', belongs_to: 'contains', calls: 'called by',
  satisfies: 'satisfied by', integrates_with: 'integrated by', deployed_on: 'hosts' };
const ACTIVE = { implements: 'implements', reads_from: 'reads', writes_to: 'writes', tested_by: 'tested by', belongs_to: 'part of', calls: 'calls',
  satisfies: 'satisfies', integrates_with: 'integrates with', deployed_on: 'deployed on' };
const loc = (n) => { const e = (n.evidence || []).find((x) => x.file); return e ? `${e.file}${e.lines ? `:${e.lines[0]}${e.lines[1] !== e.lines[0] ? '-' + e.lines[1] : ''}` : ''}` : ''; };
const conf = (x) => (x.confidence === 'verified' ? '' : ` [${x.confidence}]`);

function noteLines(c, known) {
  const out = [];
  for (const f of ['business-rules', 'architecture', 'conventions', 'overview']) {
    const file = c.p('context', f + '.md');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const t = l.replace(/<!--.*?-->/g, '').trim();
      if (t.length < 12 || t.startsWith('#') || findSecrets(t).length) return;
      const toks = new Set(split(t));
      const s = known.filter((k) => toks.has(k.q)).reduce((a, k) => a + k.w, 0);
      if (s) out.push({ s, text: `.rmcontext/context/${f}.md:${i + 1} — ${trim(t.replace(/^[-*]\s*/, ''), 180)}` });
    });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, 3);
}

export function retrieve(c, prompt, override = {}) {
  const t0 = Date.now();
  const cfg = { ...autoConfig(c), ...override };
  const { terms, docTypes, infra } = queryTerms(prompt);
  const g = G.loadGraph(c);
  const ix = G.index(g);
  const { known, ranked, total } = rankNodes(g, terms);
  if (infra) for (const r of ranked) if (G.layerOf(r.n.type) === 'infrastructure') r.score = Math.min(1, r.score * 1.3);
  ranked.sort((a, b) => b.score - a.score);
  let hits = ranked.filter((r) => r.score >= cfg.minimumRelevance && !retired(r.n)).slice(0, cfg.maxResults);
  // override.seed: hits found per subtask, criterion and identifier (retrieveTargeted). Merged with the whole-prompt
  // hits, deduplicated by node id, best score wins; nothing below minimumRelevance is added to fill the list.
  if (cfg.seed?.length) {
    const by = new Map(hits.map((h) => [h.n.id, h]));
    for (const s of cfg.seed) { const h = by.get(s.n.id); if (!h || s.score > h.score) by.set(s.n.id, { ...h, ...s }); }
    hits = [...by.values()].sort((a, b) => b.score - a.score).slice(0, cfg.maxResults);
  }
  // Infrastructure intent ("deploy", "docker", "pipeline"…): the infrastructure inventory is the relevant context even without name matches.
  const INFRA_ORDER = ['pipeline', 'deployment', 'container', 'service', 'server', 'environment', 'network', 'integration'];
  if (infra) for (const n of g.nodes.filter((x) => INFRA_ORDER.includes(x.type)).sort((a, b) => INFRA_ORDER.indexOf(a.type) - INFRA_ORDER.indexOf(b.type)))
    if (hits.length < cfg.maxResults && !hits.some((h) => h.n === n)) hits.push({ n, score: cfg.minimumRelevance });
  const reg = readJson(c.registry, { documents: [] });
  const hitIds = new Set(hits.map((h) => h.n.id));
  const hitFiles = new Set(hits.flatMap((h) => (h.n.evidence || []).map((e) => e.file)).filter(Boolean));
  const docs = reg.documents.filter((d) => docTypes.includes(d.type) || (d.nodes || []).some((x) => hitIds.has(x)) || (d.sources || []).some((s) => hitFiles.has(s))
    || (total && known.filter((k) => split(d.title).includes(k.q)).reduce((a, k) => a + k.w, 0) / total >= cfg.minimumRelevance)).slice(0, 5);
  const notes = total ? noteLines(c, known) : [];
  if (!hits.length && !docs.length && !notes.length && !docTypes.length) return { text: '', tokens: 0, hits: 0, ms: Date.now() - t0, terms: terms.size };

  // Group hits and pull in their most useful one-hop neighbours.
  const S = { modules: new Map(), reuse: [], impl: [], apis: [], data: [], tests: [], business: [], infra: [], related: [] };
  const reuse = cfg.reuse || new Map(); // node id → why it is a reuse candidate
  const seen = new Set();
  let stale = 0;
  const put = (n, why) => {
    if (seen.has(n.id)) return; seen.add(n.id);
    const L = G.layerOf(n.type), where = loc(n);
    // override.changed: files changed since the last scan (workflow packages). Knowledge from them is marked, never trusted as fresh.
    const old = cfg.changed && (n.evidence || []).some((e) => cfg.changed.has(e.file));
    if (old) stale++;
    const line = `${n.type === 'file' || n.type === 'test' ? n.name : `${n.type} ${n.name}`}${where && !where.startsWith(n.name) ? ` — ${where}` : ''}${conf(n)}${old ? ' [stale]' : ''}${why ? ` (${why})` : ''}`;
    if (n.type === 'module') S.modules.set(n.id, n.name);
    else if (reuse.has(n.id)) S.reuse.push(`${n.type} ${n.name}${where ? ` — ${where}` : ''}${conf(n)}${old ? ' [stale]' : ''} (${reuse.get(n.id)})`);
    else if (n.type === 'api') S.apis.push(line);
    else if (['table', 'entity', 'database'].includes(n.type)) S.data.push(line);
    else if (n.type === 'test') S.tests.push(line);
    else if (L === 'business' || ['requirement', 'feature'].includes(n.type)) S.business.push(`${n.id}: ${trim(n.name, 120)}${conf(n)}`);
    else if (L === 'infrastructure' || n.type === 'integration') S.infra.push(line);
    else if (n.type !== 'dependency' && n.type !== 'project') S.impl.push(line);
  };
  for (const h of hits) put(h.n);
  for (const id of reuse.keys()) { const n = ix.byId.get(id); if (n) put(n); }
  const REL = new Set(['belongs_to', 'implements', 'reads_from', 'writes_to', 'tested_by', 'satisfies', 'calls', 'integrates_with', 'deployed_on']);
  for (const h of hits) {
    for (const e of [...ix.out(h.n.id), ...ix.inc(h.n.id)]) {
      if (!REL.has(e.type)) continue;
      const o = ix.byId.get(e.source === h.n.id ? e.target : e.source);
      if (!o || o.type === 'project' || o.type === 'dependency' || (o.type === 'function' && e.type === 'belongs_to')) continue;
      if (o.type === 'module') { S.modules.set(o.id, o.name); continue; }
      const short = h.n.name.split('/').pop();
      put(o, `${e.source === h.n.id ? PASSIVE[e.type] : ACTIVE[e.type]} ${short}`);
    }
  }

  const m = readJson(c.manifest, {});
  const out = ['[RM CONTEXT — RELEVANT PROJECT KNOWLEDGE]', `Project: ${m.project?.name || ''} · scanned ${String(m.scan?.timestamp || '').slice(0, 16).replace('T', ' ')} UTC`];
  const budget = cfg.maxContextTokens;
  const footer = ['Instruction: use this as existing project context. Verify the cited source before implementation decisions; [inferred] links are heuristics, not verified behaviour.',
    `More: rmc find <terms> · rmc impact <file|id>${docTypes.length ? ` · rmc doc new ${docTypes[0]} --title "…" --author <agent>` : ''}`].join('\n');
  let used = tokens(out.join('\n') + footer);
  const dropped = { role: 0, limit: 0, budget: 0 };
  let included = 0;
  const KEY = { 'Reusable implementations': 'reuse', 'Business rules & requirements': 'business', Implementation: 'impl', APIs: 'apis', Data: 'data', Tests: 'tests', Infrastructure: 'infra', Documents: 'docs', Templates: 'templates', Notes: 'notes' };
  const section = (title, items, max) => {
    if (!items.length) return;
    if (cfg.sections && !cfg.sections.includes(KEY[title])) { dropped.role += items.length; return; } // override.sections: a role's subset
    const head = `${title}:`;
    if (used + tokens(head) > budget) { dropped.budget += items.length; return; }
    out.push(head); used += tokens(head);
    dropped.limit += Math.max(0, items.length - max);
    const list = items.slice(0, max);
    for (let i = 0; i < list.length; i++) { const l = `- ${list[i]}`; if (used + tokens(l) > budget) { dropped.budget += list.length - i; break; } out.push(l); used += tokens(l); included++; }
  };
  if (S.modules.size) { const l = `Relevant modules: ${[...S.modules.values()].slice(0, 6).join(', ')}`; out.push(l); used += tokens(l); }
  section('Reusable implementations', S.reuse, 6);
  section('Business rules & requirements', S.business, 6);
  section('Implementation', S.impl, 8);
  section('APIs', S.apis, 6);
  section('Data', S.data, 5);
  section('Tests', S.tests, 4);
  section('Infrastructure', S.infra, infra ? 8 : 5);
  section('Documents', docs.map((d) => `${d.id} "${trim(d.title, 70)}" (${d.status}, v${d.version})${d.needsReview ? ' — needs review' : ''} · .rmcontext/${d.path.replace(/^\.rmcontext\//, '')}`), 5);
  if (docTypes.length) section('Templates', docTypes.map((t) => `${t}: create with rmc doc new ${t} (validated template; check existing documents above first)`), 2);
  section('Notes', notes.map((x) => x.text), 3);
  out.push(footer);
  // Per-line estimates ignore newlines; trim trailing body lines until the whole block fits the budget.
  while (tokens(out.join('\n')) > budget && out.length > 3) out.splice(out.length - 2, 1);
  while (out.length > 3 && /:$/.test(out[out.length - 2])) out.splice(out.length - 2, 1); // no dangling section heading
  const text = out.length > 3 && tokens(out.join('\n')) <= budget ? out.join('\n') : '';
  return { text: findSecrets(text).length ? '' : text, tokens: tokens(text), hits: hits.length, stale, ms: Date.now() - t0, terms: terms.size, topScore: hits[0]?.score ?? 0,
    included, dropped, reuseShown: S.reuse.length, hitIds: hits.map((h) => h.n.id) };
}

// Knowledge whose lifecycle ended is never offered as current (attrs.lifecycle / attrs.status on agent-written nodes).
const retired = (n) => /^(deprecated|removed|superseded|obsolete|retired)$/i.test(String(n.attrs?.lifecycle || n.attrs?.status || ''));

// ---------- targeted retrieval (workflow stage packages) ----------
// A long task dilutes any single term, so a helper named once among many words can fall below minimumRelevance.
// retrieveTargeted() therefore ranks per subtask (each clause of the task and each acceptance criterion) and per
// explicit identifier, merges and deduplicates the hits, follows the dependency graph from the strongest hits to the
// helpers they already import (reuse candidates), and renders through retrieve() with the same budget and labels.
const REUSABLE = new Set(['function', 'class', 'service', 'component']);
const CLAUSE = /[.;!?\n]+|\s(?:then|and then|after that|afterwards|also|lalu|kemudian|setelah itu|serta|selanjutnya)\s/i;
export function subtasksOf(task, criteria = []) {
  const clauses = String(task || '').split(CLAUSE).map((x) => x.trim()).filter((x) => queryTerms(x).terms.size >= 1);
  const out = [];
  clauses.slice(0, 8).forEach((text, i) => out.push({ id: `T${i + 1}`, text }));
  criteria.slice(0, 10).forEach((text, i) => out.push({ id: `C${i + 1}`, text }));
  return out;
}
// Explicit identifiers: `backticked`, camelCase / PascalCase / snake_case names, file paths, routes, plus any task
// word that is exactly the name of a function, class, service, component, entity or table in the graph.
export function identifiersOf(text, g = null) {
  const t = String(text || '');
  const found = new Set();
  for (const m of t.matchAll(/`([^`\s]{2,80})`/g)) found.add(m[1]);
  for (const m of t.matchAll(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) found.add(m[0]);
  for (const m of t.matchAll(/(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5})\b/g)) found.add(m[1]);
  for (const m of t.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/:{}.-]*)/g)) found.add(m[1]);
  if (g) {
    const names = new Map();
    for (const n of g.nodes) if (['function', 'class', 'service', 'component', 'entity', 'table'].includes(n.type)) { const b = baseName(n.name); if (b.length >= 5) names.set(b, n.name); }
    for (const w of new Set(t.split(/[^\p{L}\p{N}_$]+/u))) if (w.length >= 5 && !STOP.has(w.toLowerCase()) && names.has(w.toLowerCase())) found.add(w);
  }
  return [...found].slice(0, 12);
}
const baseName = (s) => String(s).split(/[#/\\:]/).filter(Boolean).at(-1)?.replace(/\.[a-z0-9]+$/i, '').split('.').at(-1)?.toLowerCase() || '';

export function retrieveTargeted(c, task, { criteria = [], ...override } = {}) {
  const cfg = { ...autoConfig(c), ...override };
  const g = G.loadGraph(c);
  const ix = G.index(g);
  const subs = subtasksOf(task, criteria);
  const idents = identifiersOf([task, ...criteria].join('\n'), g);
  const best = new Map(); // node id → { n, score, via: Set }
  const belowIds = new Set();
  let lifecycle = 0;
  const eliminated = [];
  const offer = (n, score, via) => {
    if (retired(n)) { lifecycle++; if (eliminated.length < 8) eliminated.push({ id: n.id, reason: 'lifecycle ended' }); return; }
    const b = best.get(n.id);
    if (b) { b.via.add(via); b.score = Math.min(1, Math.max(b.score, score) + 0.02); } else best.set(n.id, { n, score, via: new Set([via]) });
  };
  // 1. Identifiers: an exact name, file or route match is strong evidence, whatever else the task says.
  for (const id of idents) {
    const key = id.toLowerCase().replace(/^\//, ''), base = baseName(id);
    for (const n of g.nodes) {
      if (n.type === 'project' || n.type === 'dependency') continue;
      const files = (n.evidence || []).map((e) => e.file).filter(Boolean);
      const hit = (base && baseName(n.name) === base) || files.some((f) => f.toLowerCase() === key) || (n.type === 'api' && String(n.attrs?.path || n.name).toLowerCase().includes(key) && key.length >= 3);
      if (hit) offer(n, n.type === 'file' ? 0.9 : 0.95, `identifier ${id}`);
    }
  }
  // 2. Each subtask and criterion on its own, so its terms are not diluted by the rest of the task.
  for (const s of subs) {
    const { ranked } = rankNodes(g, queryTerms(s.text).terms);
    for (const r of ranked) {
      if (r.score >= cfg.minimumRelevance) offer(r.n, r.score, s.id);
      else belowIds.add(r.n.id);
    }
  }
  // 3. Dependency graph: what the strongest hits already import (and the helpers defined there) is reusable.
  const reuse = new Map();
  const fileOf = (n) => (n.type === 'file' ? n.id : (n.evidence || []).find((e) => e.file) ? `file:${n.evidence.find((e) => e.file).file}` : null);
  const strong = [...best.values()].filter((b) => b.score >= Math.max(cfg.minimumRelevance, 0.6)).sort((a, b) => b.score - a.score).slice(0, 6);
  for (const b of strong) {
    if (REUSABLE.has(b.n.type)) reuse.set(b.n.id, `matches ${[...b.via].slice(0, 2).join(', ')}`);
    const f = fileOf(b.n);
    if (!f) continue;
    let k = 0;
    for (const e of ix.out(f)) {
      if (e.type !== 'depends_on' || k >= 3) continue;
      const dep = ix.byId.get(e.target);
      if (!dep || dep.type !== 'file') continue;
      for (const d of ix.inc(dep.id)) {
        const n = ix.byId.get(d.source);
        if (d.type !== 'belongs_to' || !n || !REUSABLE.has(n.type) || retired(n) || k >= 3) continue;
        if (!reuse.has(n.id)) { reuse.set(n.id, `imported by ${f.replace(/^file:/, '').split('/').pop()}`); k++; }
      }
    }
  }
  const below = [...belowIds].filter((id) => !best.has(id)).length;
  const seed = [...best.values()].map((b) => ({ n: b.n, score: b.score }));
  const r = retrieve(c, task, { ...override, seed, reuse });
  const shownIds = new Set(r.hitIds || []);
  for (const b of best.values()) if (!shownIds.has(b.n.id) && eliminated.length < 8) eliminated.push({ id: b.n.id, reason: 'outside the result limit' });
  const diag = {
    subtasks: subs.filter((s) => s.id.startsWith('T')).length, criteria: subs.filter((s) => s.id.startsWith('C')).length,
    identifiers: idents, terms: queryTerms([task, ...criteria].join('\n')).terms.size,
    candidates: best.size + below + lifecycle, matched: best.size,
    included: r.included || 0,
    eliminated: { belowRelevance: below, lifecycle, outsideLimit: Math.max(0, best.size - (r.hits || 0)), roleSections: r.dropped?.role || 0, sectionLimit: r.dropped?.limit || 0, budget: r.dropped?.budget || 0 },
    eliminatedSample: eliminated,
    reuse: [...reuse.keys()].slice(0, 8), reuseShown: r.reuseShown || 0, tokens: r.tokens,
  };
  return { ...r, diag };
}

// ---------- change tracking & coalesced refresh ----------
const pendingFile = (c) => c.p('state', 'pending-changes.jsonl');

export function recordChange(c, hook) {
  const tool = hook.tool_name || '';
  const input = hook.tool_input || {};
  if (tool === 'Bash') {
    const cmd = String(input.command || '');
    // Read-only commands never need a refresh. Anything else is checked against git or file fingerprints at Stop.
    // A pipeline of read-only commands (e.g. `cat a | head`) is read-only too; redirection, `;` and `&` are not.
    const RO = /^\s*(ls|cat|head|tail|grep|rg|find(?!.*-(delete|exec))|wc|echo|pwd|which|stat|file|sort|uniq|less|jq|git\s+(status|diff|log|show|branch|rev-parse|ls-files))\b/;
    if (!/[>;&`]|\$\(/.test(cmd) && cmd.split('|').every((seg) => RO.test(seg))) return null;
    fs.mkdirSync(path.dirname(pendingFile(c)), { recursive: true });
    fs.appendFileSync(pendingFile(c), JSON.stringify({ at: now(), bash: true }) + '\n');
    return 'bash';
  }
  const file = input.file_path || input.notebook_path || input.path;
  if (!file) return null;
  const rel = toPosix(path.relative(c.root, path.resolve(c.root, file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith('.rmcontext/') || rel.startsWith('.git/')) return null;
  fs.mkdirSync(path.dirname(pendingFile(c)), { recursive: true });
  fs.appendFileSync(pendingFile(c), JSON.stringify({ at: now(), file: rel }) + '\n');
  return rel;
}

// Claim pending changes atomically (rename) so concurrent Stop hooks never refresh twice.
export async function applyPending(c) {
  const claimed = pendingFile(c) + `.${process.pid}`;
  try { fs.renameSync(pendingFile(c), claimed); } catch { return null; }
  const entries = fs.readFileSync(claimed, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const files = new Set(entries.map((e) => e.file).filter(Boolean));
  const bash = entries.some((e) => e.bash);
  let only = [...files];
  let mode = 'targeted';
  if (bash) {
    // git status --porcelain -z: "XY path" records (untrimmed, so the leading status column survives).
    const st = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: c.root, encoding: 'utf8' });
    if (st.status !== 0) mode = 'fingerprint'; // not a git repository: compare every file's size/mtime/hash
    else for (const rec of st.stdout.split('\0').filter(Boolean)) { const p = rec.slice(3); if (p && !p.startsWith('.rmcontext/')) only.push(p); }
  }
  const { scan } = await import('./scan.mjs');
  const { flagStaleDocuments } = await import('./docs.mjs');
  const r = scan(c.root, mode === 'fingerprint' ? {} : { only });
  fs.rmSync(claimed, { force: true });
  if (r.unchanged) return { at: now(), mode, unchanged: true, requested: files.size, bash };
  const { moduleOf } = await import('./scan.mjs');
  const flagged = flagStaleDocuments(c, r.changedFiles);
  const summary = { at: now(), mode, scanMode: r.mode, durationMs: r.durationMs, changedFiles: r.changedFiles.slice(0, 50), counts: r.files,
    modules: [...new Set(r.changedFiles.map(moduleOf).filter(Boolean))].slice(0, 10), delta: r.delta, documentsFlagged: flagged, staleAgentItems: r.staleAgentItems, fullScan: false };
  writeJson(c.p('state', 'last-refresh.json'), summary);
  return summary;
}

export function formatRefresh(s) {
  const d = s.delta;
  return `RM Context updated · ${s.changedFiles.length} file(s)${s.modules.length ? ` · modules: ${s.modules.slice(0, 4).join(', ')}` : ''} · graph +${d.nodesAdded}/~${d.nodesChanged}/-${d.nodesRemoved} nodes, +${d.edgesAdded}/-${d.edgesRemoved} relationships${s.documentsFlagged.length ? ` · ${s.documentsFlagged.length} document(s) marked for review` : ''} · full scan not required`;
}

// ---------- telemetry (metadata only) ----------
export function logEvent(c, rec) {
  try {
    const f = c.p('state', 'autocontext.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 256 * 1024) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').slice(-500).join('\n'));
    fs.appendFileSync(f, JSON.stringify({ at: now(), ...rec }) + '\n');
  } catch { /* telemetry must never break a hook */ }
}

export function contextStatus(c) {
  const cfg = autoConfig(c);
  const f = c.p('state', 'autocontext.jsonl');
  const ev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  const prompts = ev.filter((e) => e.event === 'prompt');
  const injected = prompts.filter((e) => e.tokens > 0);
  const pending = fs.existsSync(pendingFile(c)) ? fs.readFileSync(pendingFile(c), 'utf8').split('\n').filter(Boolean).length : 0;
  return { config: cfg, prompts: prompts.length, injected: injected.length,
    avgTokens: injected.length ? Math.round(injected.reduce((a, e) => a + e.tokens, 0) / injected.length) : 0,
    maxTokens: injected.reduce((a, e) => Math.max(a, e.tokens), 0), avgMs: prompts.length ? Math.round(prompts.reduce((a, e) => a + (e.ms || 0), 0) / prompts.length) : 0,
    refreshes: ev.filter((e) => e.event === 'refresh').length, pendingChanges: pending, lastRefresh: readJson(c.p('state', 'last-refresh.json'), null), errors: ev.filter((e) => e.event === 'error').slice(-3) };
}

export function formatContextStatus(s) {
  const c = s.config, lr = s.lastRefresh;
  return [`Automatic context: ${c.enabled ? 'on' : 'off'} (session ${c.sessionStart ? 'on' : 'off'} · prompt retrieval ${c.promptRetrieval ? 'on' : 'off'} · incremental refresh ${c.incrementalRefresh ? 'on' : 'off'})`,
    `Budget: ${c.maxContextTokens} tokens per prompt · ${c.maxResults} results · minimum relevance ${c.minimumRelevance}`,
    `Prompts seen: ${s.prompts} · with context: ${s.injected} · avg ${s.avgTokens} tokens (max ${s.maxTokens}) · avg ${s.avgMs} ms`,
    `Auto-refreshes: ${s.refreshes} · pending changes: ${s.pendingChanges}`,
    lr ? `Last refresh: ${lr.at} (${lr.unchanged ? 'no relevant changes' : formatRefresh(lr)})` : 'Last refresh: none yet',
    ...s.errors.map((e) => `Hook error ${e.at}: ${e.message}`)].join('\n');
}
