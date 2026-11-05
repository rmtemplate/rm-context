// Core Intelligence: inventory → incremental extraction → scan-owned graph → generated context.
import fs from 'node:fs';
import path from 'node:path';
import { ctx, readJson, writeJson, writeFile, sha1, now, git, slug, SCHEMA_VERSION, GENERATOR } from './util.mjs';
import { listFiles } from './ignore.mjs';
import { extract } from './extract.mjs';
import { loadGraph, saveGraph, migrateGraph, edgeId, stats } from './graph.mjs';

const EXTRACTOR_VERSION = 3;
const CODE_LANGS = new Set(['js', 'php', 'py', 'go', 'java', 'rb', 'cs', 'sql', 'prisma', 'manifest']);
const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const NODE_BUILTINS = new Set('assert buffer child_process cluster crypto dgram dns events fs http http2 https net os path perf_hooks process querystring readline stream string_decoder timers tls tty url util v8 vm worker_threads zlib'.split(' '));

const FRAMEWORKS = {
  express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS', next: 'Next.js', nuxt: 'Nuxt', react: 'React', vue: 'Vue',
  svelte: 'Svelte', '@angular/core': 'Angular', vite: 'Vite', tailwindcss: 'Tailwind CSS', prisma: 'Prisma', '@prisma/client': 'Prisma', typeorm: 'TypeORM',
  sequelize: 'Sequelize', mongoose: 'Mongoose', jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', '@playwright/test': 'Playwright',
  'laravel/framework': 'Laravel', 'symfony/framework-bundle': 'Symfony', 'phpunit/phpunit': 'PHPUnit', 'pestphp/pest': 'Pest', 'livewire/livewire': 'Livewire',
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', sqlalchemy: 'SQLAlchemy', pytest: 'pytest', celery: 'Celery',
  rails: 'Rails', 'github.com/gin-gonic/gin': 'Gin', 'github.com/labstack/echo/v4': 'Echo', 'github.com/gofiber/fiber/v2': 'Fiber', 'gorm.io/gorm': 'GORM',
};
const DATASTORES = { pg: 'PostgreSQL', postgres: 'PostgreSQL', 'psycopg2': 'PostgreSQL', 'psycopg2-binary': 'PostgreSQL', mysql: 'MySQL', mysql2: 'MySQL', pymysql: 'MySQL',
  sqlite3: 'SQLite', 'better-sqlite3': 'SQLite', mongodb: 'MongoDB', mongoose: 'MongoDB', pymongo: 'MongoDB', redis: 'Redis', ioredis: 'Redis', 'predis/predis': 'Redis' };

export function moduleOf(rel) {
  const parts = rel.split('/');
  if (parts.length < 2) return null;
  if (['packages', 'apps', 'services', 'modules', 'src', 'app', 'lib', 'internal', 'pkg', 'cmd'].includes(parts[0]) && parts.length > 2) return parts.slice(0, 2).join('/');
  return parts[0];
}

function loadConfig(c) {
  return readJson(c.config, {});
}

function projectInfo(root, cache) {
  const pkg = cache['package.json']?.x?.meta?.name || cache['composer.json']?.x?.meta?.name;
  const name = pkg || path.basename(root);
  return { id: slug(name), name };
}

function detectStack(cache, files) {
  const languages = {};
  const LANG_NAMES = { js: 'JavaScript/TypeScript', php: 'PHP', py: 'Python', go: 'Go', java: 'Java/Kotlin', rb: 'Ruby', cs: 'C#', sql: 'SQL', prisma: 'Prisma schema' };
  const frameworks = new Set(), datastores = new Set(), ecosystems = new Set(), infra = new Set();
  for (const rel of files) {
    const x = cache[rel]?.x;
    if (!x) continue;
    if (LANG_NAMES[x.lang]) languages[LANG_NAMES[x.lang]] = (languages[LANG_NAMES[x.lang]] || 0) + 1;
    if (/\.tsx?$/.test(rel)) languages.TypeScript = (languages.TypeScript || 0) + 1;
    for (const d of x.deps || []) {
      ecosystems.add(d.eco);
      if (FRAMEWORKS[d.name]) frameworks.add(FRAMEWORKS[d.name]);
      if (DATASTORES[d.name]) datastores.add(DATASTORES[d.name]);
    }
    if (x.lang === 'dockerfile') infra.add('Docker');
    if (x.lang === 'compose') infra.add('Docker Compose');
    if (x.lang === 'ci') infra.add(rel.startsWith('.github/') ? 'GitHub Actions' : rel.includes('gitlab') ? 'GitLab CI' : 'CI pipeline');
    if (x.lang === 'terraform') infra.add('Terraform');
    if (x.lang === 'nginx') infra.add('Nginx');
    if (x.lang === 'yaml' && x.infra?.length) infra.add('Kubernetes');
    for (const i of x.infra || []) for (const img of [i.attrs?.image, ...(i.attrs?.baseImages || [])].filter(Boolean)) {
      for (const [k, v] of Object.entries({ postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', redis: 'Redis', mongo: 'MongoDB', nginx: 'Nginx', rabbitmq: 'RabbitMQ' })) if (img.includes(k)) (k === 'nginx' ? infra : datastores).add(v);
    }
  }
  return { languages, frameworks: [...frameworks].sort(), datastores: [...datastores].sort(), ecosystems: [...ecosystems].sort(), infrastructure: [...infra].sort() };
}

// Build the scan-owned part of the graph purely from the extraction cache (no file I/O).
export function buildScanGraph(cache, project) {
  const nodes = new Map(), edges = new Map();
  const ev = (file, line, end, type, confidence = 'verified') => ({ file, lines: line ? [line, Math.max(line, end || line)] : undefined, type, confidence });
  const node = (id, type, name, evidence, extra = {}) => {
    const n = nodes.get(id);
    if (n) { if (evidence) n.evidence.push(evidence); Object.assign(n.attrs ||= {}, extra.attrs); return n; }
    const fresh = { id, type, name, origin: 'scan', confidence: 'verified', evidence: evidence ? [evidence] : [], ...extra };
    nodes.set(id, fresh);
    return fresh;
  };
  const edge = (source, target, type, evidence, confidence = evidence?.confidence || 'verified') => {
    if (source === target) return;
    const e = { source, target, type, origin: 'scan', confidence, evidence: evidence ? [evidence] : [] };
    e.id = edgeId(e);
    if (!edges.has(e.id)) edges.set(e.id, e);
  };
  const projId = `project:${project.id}`;
  node(projId, 'project', project.name, ev('.rmcontext/manifest.json', undefined, undefined, 'config'));

  const files = Object.keys(cache).sort();
  const has = new Set(files);
  const fileId = (rel) => (cache[rel]?.x?.test ? `test:${rel}` : `file:${rel}`);
  const deps = new Map(); // "eco/name" → node id
  const psr4 = {}; let goModule = null;
  const javaIndex = new Map();
  for (const rel of files) {
    const x = cache[rel].x;
    if (x?.meta?.psr4) for (const [ns, dir] of Object.entries(x.meta.psr4)) psr4[ns] = path.posix.join(path.posix.dirname(rel), String(Array.isArray(dir) ? dir[0] : dir));
    if (x?.meta?.module) goModule = x.meta.module;
    if (x?.lang === 'java') for (const d of x.decls || []) if (d.type === 'class') javaIndex.set(`${x.meta?.package}.${d.name}`.replace(/^\./, ''), rel);
    for (const d of x?.deps || []) {
      const id = `dependency:${d.eco}/${d.name}`;
      node(id, 'dependency', d.name, ev(rel, d.line, d.line, 'config'), { attrs: { ecosystem: d.eco, version: d.version, dev: d.dev } });
      deps.set(`${d.eco}/${d.name}`, id);
    }
  }
  const phpClassFile = (fqcn) => {
    for (const [ns, dir] of Object.entries(psr4).sort((a, b) => b[0].length - a[0].length)) {
      if (fqcn.startsWith(ns)) { const f = path.posix.normalize(`${dir}/${fqcn.slice(ns.length).replace(/\\/g, '/')}.php`); if (has.has(f)) return f; }
    }
    return null;
  };
  const resolveJs = (from, spec) => {
    let base = null;
    if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else if (spec.startsWith('@/') || spec.startsWith('~/')) base = 'src/' + spec.slice(2);
    if (base) { for (const ext of JS_EXT) if (has.has(base + ext)) return { file: base + ext }; return null; }
    if (spec.startsWith('node:') || NODE_BUILTINS.has(spec.split('/')[0])) return null;
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    return deps.has(`npm/${pkg}`) ? { dep: deps.get(`npm/${pkg}`) } : null;
  };
  const resolvePy = (from, spec) => {
    const dots = spec.match(/^\.*/)[0].length;
    const mod = spec.slice(dots).replace(/\./g, '/');
    const bases = dots ? [path.posix.join(path.posix.dirname(from), ...Array(dots - 1).fill('..'), mod)] : [mod, `src/${mod}`];
    for (const b of bases) for (const c of [`${b}.py`, `${b}/__init__.py`]) if (has.has(path.posix.normalize(c))) return { file: path.posix.normalize(c) };
    const top = spec.slice(dots).split('.')[0].toLowerCase();
    return deps.has(`pypi/${top}`) ? { dep: deps.get(`pypi/${top}`) } : deps.has(`pypi/${top.replace(/_/g, '-')}`) ? { dep: deps.get(`pypi/${top.replace(/_/g, '-')}`) } : null;
  };
  const resolveImport = (rel, x, spec) => {
    if (x.lang === 'js') return resolveJs(rel, spec);
    if (x.lang === 'py') return resolvePy(rel, spec);
    if (x.lang === 'php') { const f = phpClassFile(spec); return f ? { file: f } : null; }
    if (x.lang === 'java') { const f = javaIndex.get(spec); return f ? { file: f } : null; }
    if (x.lang === 'go') {
      if (goModule && spec.startsWith(goModule + '/')) { const dir = spec.slice(goModule.length + 1); const m = moduleOf(dir + '/x'); return m ? { module: `module:${m}` } : null; }
      const d = [...deps.keys()].find((k) => k.startsWith('go/') && spec.startsWith(k.slice(3)));
      return d ? { dep: deps.get(d) } : null;
    }
    return null;
  };

  // Pass 1: files, modules, declarations, tables.
  const declIndex = new Map(); // file → name → id
  const tables = new Map(); // lowercased table name → id
  for (const rel of files) {
    const x = cache[rel].x;
    if (!x) continue;
    if (CODE_LANGS.has(x.lang)) {
      const fid = fileId(rel);
      node(fid, x.test ? 'test' : 'file', rel, ev(rel, 1, x.loc, 'declaration'), { attrs: { lang: x.lang, loc: x.loc } });
      const mod = moduleOf(rel);
      if (mod) {
        node(`module:${mod}`, 'module', mod, null, { confidence: 'inferred', attrs: { basis: 'directory structure' } });
        edge(fid, `module:${mod}`, 'belongs_to', ev(rel, undefined, undefined, 'declaration', 'inferred'), 'inferred');
      }
      const names = new Map();
      for (const d of x.decls || []) {
        if (d.type === 'entity') continue;
        let id = `${d.type}:${rel}#${d.name}`;
        if (nodes.has(id)) id = `${id}@${d.line}`;
        node(id, d.type, d.name, ev(rel, d.line, d.end, 'declaration'));
        edge(id, fid, 'belongs_to', ev(rel, d.line, d.end, 'declaration'));
        if (!names.has(d.name)) names.set(d.name, id);
      }
      declIndex.set(rel, names);
    }
    for (const t of x.tables || []) {
      const name = t.mappedTo || t.name;
      const id = `table:${name}`;
      node(id, 'table', name, ev(rel, t.line, t.end, 'schema'), { attrs: t.columns?.length ? { columns: t.columns } : {} });
      tables.set(name.toLowerCase(), id);
      if (t.mappedTo) tables.set(t.name.toLowerCase(), id);
    }
  }
  for (const m of [...nodes.values()].filter((n) => n.type === 'module')) edge(m.id, projId, 'belongs_to', null, 'inferred');
  if (tables.size) {
    node('database:main', 'database', 'Primary database', null, { confidence: 'inferred', attrs: { basis: 'schema/migration files' } });
    for (const id of new Set(tables.values())) edge(id, 'database:main', 'belongs_to', null, 'inferred');
  }
  const tableFor = (name) => tables.get(String(name).toLowerCase()) || tables.get(String(name).toLowerCase() + 's') || tables.get(String(name).toLowerCase().replace(/s$/, ''));

  // Pass 2: relationships.
  for (const rel of files) {
    const x = cache[rel].x;
    if (!x) continue;
    const fid = fileId(rel);
    for (const t of x.tables || []) for (const r of t.refs || []) {
      const target = tableFor(r.table);
      if (target) edge(`table:${t.mappedTo || t.name}`, target, 'depends_on', ev(rel, r.line, r.line, 'schema', r.inferred ? 'inferred' : 'verified'));
    }
    const imported = new Map(); // local name → resolved file
    for (const im of x.imports || []) {
      const r = resolveImport(rel, x, im.spec);
      if (!r) continue;
      const target = r.file ? fileId(r.file) : r.dep || r.module;
      if (!nodes.has(target)) continue;
      edge(fid, target, 'depends_on', ev(rel, im.line, im.line, 'import'));
      if (r.file) {
        for (const n of im.names) imported.set(n, r.file);
        if (x.test && !cache[r.file]?.x?.test) edge(fileId(r.file), fid, 'tested_by', ev(rel, im.line, im.line, 'test', 'inferred'), 'inferred');
      }
    }
    if (imported.size && cache[rel].calls) {
      for (const [name, line] of Object.entries(cache[rel].calls)) {
        const target = declIndex.get(imported.get(name))?.get(name);
        if (target && nodes.get(target)?.type === 'function') edge(fid, target, 'calls', ev(rel, line, line, 'call', 'inferred'), 'inferred');
      }
    }
    for (const r of x.routes || []) {
      const id = `api:${r.method} ${r.path}`;
      node(id, 'api', `${r.method} ${r.path}`, ev(rel, r.line, r.line, 'route'), { attrs: { method: r.method, path: r.path } });
      edge(fid, id, 'implements', ev(rel, r.line, r.line, 'route'));
      if (r.handler && x.lang === 'php') {
        const fq = x.meta?.uses?.[r.handler.split('\\').pop()] || (r.handler.includes('\\') ? r.handler : `${x.meta?.namespace}\\${r.handler}`);
        const hf = phpClassFile(fq.replace(/^\\/, ''));
        const short = r.handler.split('\\').pop();
        const target = hf && (r.action ? declIndex.get(hf)?.get(r.action) : null) || (hf && declIndex.get(hf)?.get(short));
        if (target) edge(id, target, 'calls', ev(rel, r.line, r.line, 'route'));
      }
      const mod = moduleOf(rel);
      if (mod) edge(id, `module:${mod}`, 'belongs_to', ev(rel, r.line, r.line, 'route', 'inferred'), 'inferred');
    }
    for (const u of x.dbUses || []) {
      const target = tableFor(u.table);
      if (!target) continue;
      const conf = u.viaModel ? 'verified' : 'inferred';
      edge(fid, target, u.mode === 'write' ? 'writes_to' : 'reads_from', ev(rel, u.line, u.line, 'call', conf), conf);
    }
    for (const d of (x.decls || []).filter((d) => d.type === 'entity')) {
      const id = `entity:${d.name}`;
      node(id, 'entity', d.name, ev(rel, d.line, d.line, 'declaration'));
      const cls = declIndex.get(rel)?.get(d.name);
      if (cls) edge(cls, id, 'implements', ev(rel, d.line, d.line, 'declaration'));
      const explicit = x.meta?.modelTable;
      const conv = d.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      const target = explicit ? tableFor(explicit) : tableFor(conv) || tableFor(conv + 's');
      if (target) edge(id, target, 'depends_on', ev(rel, d.line, d.line, 'declaration', explicit ? 'verified' : 'inferred'));
    }
    for (const h of x.http || []) {
      const id = `integration:${h.host}`;
      node(id, 'integration', h.host, ev(rel, h.line, h.line, 'call'), { attrs: { kind: 'http' } });
      edge(fid, id, 'integrates_with', ev(rel, h.line, h.line, 'call'));
    }
    if (x.env?.length) node(`environment:${rel}`, 'environment', `env template ${rel}`, ev(rel, 1, 1, 'config'), { attrs: { variables: x.env, note: 'variable names only; values are never read' } });
    for (const i of x.infra || []) {
      node(i.id, i.type, i.name, ev(rel, i.line, i.line, 'config'), { attrs: Object.fromEntries(Object.entries(i.attrs || {}).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) });
      if (i.type === 'pipeline') edge(i.id, projId, 'belongs_to', ev(rel, 1, 1, 'config'));
      for (const l of i.links || []) {
        if (l.ensure) node(l.target, l.ensure.type, l.ensure.name, ev(rel, l.line, l.line, 'config'));
        edge(i.id, l.target, l.type, ev(rel, l.line, l.line, 'config'));
      }
      if (i.attrs?.build) {
        const ctxDir = path.posix.normalize(path.posix.join(path.posix.dirname(rel), i.attrs.build === '(context)' ? '.' : i.attrs.build));
        const df = `container:${ctxDir === '.' ? '' : ctxDir + '/'}Dockerfile`;
        if (cache[df.slice(10)]) edge(i.id, df, 'depends_on', ev(rel, i.line, i.line, 'config', 'inferred'), 'inferred');
      }
    }
  }
  // Nginx proxy_pass → compose service with the same hostname.
  for (const rel of files) for (const i of cache[rel].x?.infra || []) for (const p of i.proxies || []) {
    const svc = [...nodes.values()].find((n) => n.type === 'service' && n.name === p.host && n.id !== i.id);
    if (svc) edge(i.id, svc.id, 'depends_on', ev(rel, p.line, p.line, 'config', 'inferred'), 'inferred');
  }
  // Name-based test pairing (foo.test.js ↔ foo.js) when no import evidence exists.
  for (const rel of files) {
    if (!cache[rel].x?.test || !CODE_LANGS.has(cache[rel].x.lang)) continue;
    const stem = path.posix.basename(rel).replace(/(\.(test|spec))?\.[a-z]+$/i, '').replace(/^test_|_test$|Tests?$/g, '');
    const target = files.find((f) => !cache[f].x?.test && CODE_LANGS.has(cache[f].x?.lang) && path.posix.basename(f).replace(/\.[a-z]+$/i, '') === stem);
    if (target) edge(fileId(target), fileId(rel), 'tested_by', ev(rel, 1, 1, 'test', 'inferred'), 'inferred');
  }
  // Every scan edge needs both endpoints (e.g. a module created only by a route).
  const out = [...edges.values()].filter((e) => nodes.has(e.source) && nodes.has(e.target));
  return { nodes: [...nodes.values()], edges: out };
}

// Named function calls: only for names imported from local files (keeps the cache small).
function callSites(x, text) {
  const names = (x.imports || []).flatMap((i) => i.names || []);
  if (!names.length) return undefined;
  const ls = text.split('\n');
  const out = {};
  for (const n of new Set(names)) {
    const re = new RegExp(`(^|[^\\w$.])${n.replace(/[$]/g, '\\$')}\\s*\\(`);
    const idx = ls.findIndex((l) => re.test(l) && !/^\s*(import|from|export)\b/.test(l));
    if (idx >= 0) out[n] = idx + 1;
  }
  return Object.keys(out).length ? out : undefined;
}

// Wrap generated content in markers so user-authored text around it survives regeneration.
export function writeGenerated(file, body) {
  const start = '<!-- rmc:generated:start -->', end = '<!-- rmc:generated:end -->';
  const block = `${start}\n${body.trim()}\n${end}`;
  if (!fs.existsSync(file)) { writeFile(file, block + '\n'); return 'created'; }
  const cur = fs.readFileSync(file, 'utf8');
  const a = cur.indexOf(start), b = cur.indexOf(end);
  if (a < 0 || b < a) return 'skipped (user-authored, no generated markers)';
  const next = cur.slice(0, a) + block + cur.slice(b + end.length);
  if (next !== cur) writeFile(file, next);
  return 'updated';
}

export function scan(root, { full = false } = {}) {
  const t0 = Date.now();
  const c = ctx(root);
  const config = loadConfig(c);
  const prevState = full ? null : readJson(c.files, null);
  const reuse = prevState && prevState.extractorVersion === EXTRACTOR_VERSION;
  const cache = reuse ? prevState.files : {};
  const { files, excluded } = listFiles(root, { extraIgnore: config.ignore || [], maxBytes: config.maxFileBytes || 1_000_000 });
  const seen = new Set(files);
  const added = [], changed = [], deleted = [];
  let skippedBinary = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    const prev = cache[rel];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) { skippedBinary++; seen.delete(rel); delete cache[rel]; continue; }
    const hash = sha1(buf);
    if (prev && prev.hash === hash) { prev.mtimeMs = st.mtimeMs; continue; }
    const text = buf.toString('utf8');
    const x = extract(rel, text);
    cache[rel] = { hash, size: st.size, mtimeMs: st.mtimeMs, x, calls: callSites(x, text) };
    (prev ? changed : added).push(rel);
  }
  for (const rel of Object.keys(cache)) if (!seen.has(rel)) { deleted.push(rel); delete cache[rel]; }

  const project = projectInfo(root, cache);
  const old = loadGraph(c);
  const migration = migrateGraph(old);
  const scanned = buildScanGraph(cache, project);
  const touched = new Set([...changed, ...deleted]);
  const keep = (items) => items.filter((i) => i.origin !== 'scan');
  const agentNodes = keep(old.nodes);
  const scanIds = new Set(scanned.nodes.map((n) => n.id));
  // Preserve agent annotations on scan nodes that still exist.
  const oldScan = new Map(old.nodes.filter((n) => n.origin === 'scan').map((n) => [n.id, n]));
  for (const n of scanned.nodes) { const o = oldScan.get(n.id); if (o?.description) n.description = o.description; if (o?.tags) n.tags = o.tags; }
  const nodes = [...scanned.nodes, ...agentNodes.filter((n) => !scanIds.has(n.id))];
  const ids = new Set(nodes.map((n) => n.id));
  const orphaned = [];
  const agentEdges = keep(old.edges).filter((e) => { const ok = ids.has(e.source) && ids.has(e.target); if (!ok) orphaned.push(e.id); return ok; });
  const scanEdgeIds = new Set(scanned.edges.map((e) => e.id));
  let staleCount = 0;
  for (const item of [...agentNodes, ...agentEdges]) if ((item.evidence || []).some((e) => touched.has(e.file))) { item.stale = true; staleCount++; }
  const graph = { nodes, edges: [...scanned.edges, ...agentEdges.filter((e) => !scanEdgeIds.has(e.id))] };
  saveGraph(c, graph);

  const commit = git(root, ['rev-parse', 'HEAD']);
  const stack = detectStack(cache, Object.keys(cache));
  const manifest = readJson(c.manifest, {});
  Object.assign(manifest, {
    schemaVersion: SCHEMA_VERSION, generator: GENERATOR, project, stack,
    createdAt: manifest.createdAt || now(), updatedAt: now(),
    scan: { timestamp: now(), commit, mode: reuse ? 'incremental' : 'full' },
  });
  writeJson(c.manifest, manifest);
  writeJson(c.files, { extractorVersion: EXTRACTOR_VERSION, files: cache });
  const report = {
    timestamp: now(), commit, mode: reuse ? 'incremental' : 'full', durationMs: Date.now() - t0,
    files: { indexed: Object.keys(cache).length, added: added.length, changed: changed.length, deleted: deleted.length },
    changedFiles: [...added, ...changed, ...deleted].slice(0, 200),
    excluded: { ...excluded, binaryContent: skippedBinary },
    graph: stats(graph), staleAgentItems: staleCount, orphanedAgentEdges: orphaned, migration,
    limitations: [
      'Regex extraction: dynamic routes, route groups/prefixes, reflection and runtime registration are not detected.',
      'Function-level "calls" edges are inferred from imported names, not resolved by type analysis.',
      'Modules are inferred from directory structure.',
      'Business, system-design, infrastructure-intent and project-management knowledge comes from agents, not the scanner.',
    ],
  };
  writeJson(c.scan, report);
  writeGenerated(c.p('context', 'tech-stack.md'), techStackMd(stack, cache));
  writeIndex(c, manifest, graph);
  return report;
}

function techStackMd(stack, cache) {
  const files = Object.keys(cache);
  const scripts = cache['package.json']?.x?.meta?.scripts || [];
  const list = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none detected)');
  return `# Tech Stack

> Generated by \`rmc scan\` from manifests and file types. Edit outside the generated markers.

## Languages (files)
${Object.entries(stack.languages).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- (none detected)'}

## Frameworks & libraries
${list(stack.frameworks)}

## Data stores
${list(stack.datastores)}

## Infrastructure & delivery
${list(stack.infrastructure)}

## Package ecosystems
${list(stack.ecosystems)}

## Manifests
${list(files.filter((f) => cache[f].x?.lang === 'manifest').map((f) => `\`${f}\``))}
${scripts.length ? `\n## npm scripts\n${list(scripts.map((s) => `\`${s}\``))}\n` : ''}`;
}

export function writeIndex(c, manifest, graph) {
  const s = stats(graph);
  const reg = readJson(c.registry, { documents: [] });
  const mods = graph.nodes.filter((n) => n.type === 'module').map((m) => ({ m, n: graph.edges.filter((e) => e.target === m.id && e.type === 'belongs_to').length })).sort((a, b) => b.n - a.n);
  const layerLine = Object.entries(s.byLayer).map(([k, v]) => `${k} ${v}`).join(' · ');
  const body = `# ${manifest.project.name} — RM Context Index

Last scan: ${manifest.scan.timestamp}${manifest.scan.commit ? ` @ \`${manifest.scan.commit.slice(0, 10)}\`` : ''} (${manifest.scan.mode})
Stack: ${[...Object.keys(manifest.stack.languages).slice(0, 4), ...manifest.stack.frameworks.slice(0, 6)].join(', ') || 'unknown'}
Graph: ${s.nodes} nodes, ${s.edges} edges (${layerLine})${s.stale ? ` · **${s.stale} stale items**` : ''}

## Where to look
- Stack: \`context/tech-stack.md\` · Architecture: \`context/architecture.md\` · Business rules: \`context/business-rules.md\`
- Documents: \`documents/registry.json\` (${reg.documents.length} documents)
- Plan: \`project-management/plan.json\` · Graph: \`graph/nodes.json\`, \`graph/edges.json\`
- Query instead of reading JSON: \`rmc find <terms>\`, \`rmc impact <node|file>\`

## Modules (by file count)
${mods.slice(0, 25).map(({ m, n }) => `- \`${m.name}\` — ${n} items`).join('\n') || '- (none)'}${mods.length > 25 ? `\n- …and ${mods.length - 25} more` : ''}

## APIs: ${s.byType.api || 0} · Tables: ${s.byType.table || 0} · Tests: ${s.byType.test || 0} · Services: ${(s.byType.service || 0) + (s.byType.container || 0)}
`;
  return writeGenerated(c.index, body);
}
