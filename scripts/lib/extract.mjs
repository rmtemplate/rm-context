// Per-file fact extraction. Regex-based, zero dependencies.
// ponytail: regex, not AST — literal declarations/imports/routes are reliable; dynamic registration, macros,
// route prefixes/groups and computed names are missed. Swap a language for a real parser if precision matters.
import path from 'node:path';

const LANG = {
  js: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'], php: ['php'], py: ['py'], go: ['go'],
  java: ['java', 'kt', 'kts'], rb: ['rb'], cs: ['cs'], sql: ['sql'], prisma: ['prisma'],
};
const EXT_LANG = Object.fromEntries(Object.entries(LANG).flatMap(([l, xs]) => xs.map((x) => [x, l])));

export const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(php|java|kt|cs)$/;

export function langOf(rel) {
  const base = path.posix.basename(rel);
  if (/^Dockerfile(\..+)?$|\.dockerfile$/i.test(base)) return 'dockerfile';
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(base)) return 'compose';
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(rel) || /^(\.gitlab-ci\.yml|bitbucket-pipelines\.yml|azure-pipelines\.yml|Jenkinsfile|\.drone\.yml|\.circleci\/config\.yml)$/.test(rel)) return 'ci';
  if (/^\.env\.(example|sample|template|dist|defaults)$/.test(base)) return 'envexample';
  if (base === 'package.json' || base === 'composer.json' || base === 'go.mod' || base === 'Gemfile' || base === 'Cargo.toml' || base === 'pyproject.toml' || /^requirements.*\.txt$/.test(base)) return 'manifest';
  if (base === 'Procfile') return 'procfile';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  if (ext === 'tf') return 'terraform';
  if (ext === 'conf' && /nginx|sites-|conf\.d/i.test(rel)) return 'nginx';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return EXT_LANG[ext] || null;
}

function lines(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (idx) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= idx) lo = m; else hi = m - 1; } return lo + 1; };
}

// End line of a brace-delimited block starting at or after `idx`. Ignores braces inside simple strings.
function braceEnd(text, idx, lineAt) {
  let i = text.indexOf('{', idx);
  const stop = text.indexOf(';', idx);
  if (i < 0 || (stop >= 0 && stop < i && text.slice(idx, stop).indexOf('=>') < 0)) return lineAt(idx);
  let depth = 0, q = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return lineAt(i);
  }
  return lineAt(idx);
}

function pyEnd(src, startLine) {
  const ls = src.split('\n');
  const indent = ls[startLine - 1].match(/^\s*/)[0].length;
  let end = startLine;
  for (let i = startLine; i < ls.length; i++) {
    if (!ls[i].trim()) continue;
    if (ls[i].match(/^\s*/)[0].length <= indent) break;
    end = i + 1;
  }
  return end;
}

const all = (re, text, fn) => { for (const m of text.matchAll(re)) fn(m); };

// SQL in string literals: uppercase keywords only, to avoid matching JS `import … from`.
function sqlUses(text, lineAt, out) {
  all(/\b(?:FROM|JOIN)\s+[`"]?([A-Za-z_][\w]*)[`"]?/g, text, (m) => { if (!/^(SELECT|WHERE|DUAL)$/i.test(m[1])) out.push({ table: m[1], mode: 'read', line: lineAt(m.index) }); });
  all(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"]?([A-Za-z_]\w*)[`"]?/g, text, (m) => out.push({ table: m[1], mode: 'write', line: lineAt(m.index) }));
}

function httpCalls(text, lineAt, out) {
  all(/\b(?:fetch|axios(?:\.\w+)?|got|request|requests\.\w+|http\.(?:get|post)|Http::\w+|httpx\.\w+)\(\s*['"`](https?:\/\/[^/'"`\s$]+)/g, text, (m) => {
    const host = m[1].replace(/^https?:\/\//, '');
    if (!/^(localhost|127\.|0\.0\.0\.0)/.test(host)) out.push({ host, line: lineAt(m.index) });
  });
}

const X = () => ({ decls: [], imports: [], routes: [], tables: [], dbUses: [], http: [], deps: [], infra: [], env: [], meta: {} });

const EXTRACTORS = {
  js(text, rel, lineAt) {
    const x = X();
    all(/^\s*(?:import|export)\s+(?:type\s+)?(?:([\w*{}\s,$]+?)\s+from\s+)?['"]([^'"]+)['"]/gm, text, (m) => {
      const names = (m[1] || '').replace(/[{}]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '')).filter((s) => s && s !== '*');
      x.imports.push({ spec: m[2], line: lineAt(m.index), names });
    });
    all(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g, text, (m) => x.imports.push({ spec: m[1], line: lineAt(m.index), names: [] }));
    const isUi = /\.(jsx|tsx|vue|svelte)$/.test(rel);
    all(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm, text, (m) =>
      x.decls.push({ type: isUi && /^[A-Z]/.test(m[1]) ? 'component' : 'function', name: m[1], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt) }));
    all(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/gm, text, (m) =>
      x.decls.push({ type: isUi && /^[A-Z]/.test(m[1]) ? 'component' : 'function', name: m[1], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt) }));
    all(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, text, (m) =>
      x.decls.push({ type: 'class', name: m[1], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt) }));
    all(/\b(?:app|router|server|api|routes?)\.(get|post|put|patch|delete|all|options)\(\s*['"`]([^'"`]+)['"`]/g, text, (m) =>
      x.routes.push({ method: m[1].toUpperCase(), path: m[2], line: lineAt(m.index) }));
    // Next.js app router: app/**/route.ts exporting HTTP verbs.
    const nx = rel.match(/(?:^|\/)app\/(.*?)\/?route\.[jt]sx?$/);
    if (nx) all(/^export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm, text, (m) =>
      x.routes.push({ method: m[1], path: '/' + nx[1].replace(/\[([^\]]+)\]/g, ':$1').replace(/\([^)]*\)\/?/g, ''), line: lineAt(m.index) }));
    const pg = rel.match(/(?:^|\/)pages\/(api\/.*)\.[jt]sx?$/);
    if (pg) x.routes.push({ method: 'ANY', path: '/' + pg[1].replace(/\/index$/, '').replace(/\[([^\]]+)\]/g, ':$1'), line: 1 });
    all(/\bprisma\.(\w+)\.(findMany|findUnique|findFirst|count|aggregate|groupBy|create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g, text, (m) =>
      x.dbUses.push({ table: m[1], mode: /^(find|count|aggregate|groupBy)/.test(m[2]) ? 'read' : 'write', line: lineAt(m.index), viaModel: true }));
    sqlUses(text, lineAt, x.dbUses);
    httpCalls(text, lineAt, x.http);
    return x;
  },

  php(text, rel, lineAt) {
    const x = X();
    const ns = text.match(/^\s*namespace\s+([\w\\]+)\s*;/m);
    x.meta.namespace = ns ? ns[1] : '';
    x.meta.uses = {};
    all(/^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm, text, (m) => {
      x.imports.push({ spec: m[1], line: lineAt(m.index), names: [] });
      x.meta.uses[m[2] || m[1].split('\\').pop()] = m[1];
    });
    all(/^\s*(?:final\s+|abstract\s+|readonly\s+)*(class|interface|trait|enum)\s+(\w+)(?:\s+extends\s+([\w\\]+))?/gm, text, (m) => {
      x.decls.push({ type: 'class', name: m[2], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt), extends: m[3] });
      if (m[3] && /(^|\\)(Model|Authenticatable|Pivot)$/.test(m[3])) x.decls.push({ type: 'entity', name: m[2], line: lineAt(m.index) });
    });
    all(/^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?(\w+)\s*\(/gm, text, (m) => {
      if (!m[1].startsWith('__')) x.decls.push({ type: 'function', name: m[1], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt) });
    });
    const tbl = text.match(/protected\s+\$table\s*=\s*['"](\w+)['"]/);
    if (tbl) x.meta.modelTable = tbl[1];
    all(/Route::(get|post|put|patch|delete|options|any|match|resource|apiResource)\(\s*(?:\[[^\]]*\]\s*,\s*)?['"]([^'"]+)['"]\s*,\s*(?:\[\s*)?([\w\\]+)::class(?:\s*,\s*['"](\w+)['"])?/g, text, (m) =>
      x.routes.push({ method: m[1].toUpperCase(), path: '/' + m[2].replace(/^\//, ''), handler: m[3], action: m[4], line: lineAt(m.index) }));
    all(/Schema::create\(\s*['"](\w+)['"]/g, text, (m) => {
      const close = text.indexOf('});', m.index);
      const body = text.slice(m.index, close < 0 ? text.length : close + 3);
      const columns = [...body.matchAll(/\$table->(\w+)\(\s*['"](\w+)['"]/g)].map((c) => ({ name: c[2], type: c[1] }));
      const refs = [...body.matchAll(/->on\(\s*['"](\w+)['"]|->constrained\(\s*['"](\w+)['"]/g)].map((r) => ({ table: r[1] || r[2], line: lineAt(m.index + r.index) }));
      for (const c of body.matchAll(/foreignId\(\s*['"](\w+)_id['"]\s*\)\s*->constrained\(\s*\)/g)) refs.push({ table: c[1] + 's', line: lineAt(m.index + c.index), inferred: true });
      x.tables.push({ name: m[1], line: lineAt(m.index), end: lineAt(m.index + body.length), columns, refs });
    });
    all(/DB::table\(\s*['"](\w+)['"]/g, text, (m) => x.dbUses.push({ table: m[1], mode: 'read', line: lineAt(m.index), uncertain: true }));
    sqlUses(text, lineAt, x.dbUses);
    httpCalls(text, lineAt, x.http);
    return x;
  },

  py(text, rel, lineAt) {
    const x = X();
    all(/^\s*from\s+(\.*[\w.]*)\s+import\s+([\w, ()*]+)/gm, text, (m) => x.imports.push({ spec: m[1], line: lineAt(m.index), names: m[2].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter((s) => s && s !== '*') }));
    all(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm, text, (m) => m[1].split(',').forEach((s) => x.imports.push({ spec: s.trim(), line: lineAt(m.index), names: [] })));
    all(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/gm, text, (m) => { const l = lineAt(m.index + m[1].length); x.decls.push({ type: 'function', name: m[2], line: l, end: pyEnd(text, l) }); });
    all(/^(\s*)class\s+(\w+)(?:\(([^)]*)\))?\s*:/gm, text, (m) => {
      const l = lineAt(m.index + m[1].length);
      x.decls.push({ type: 'class', name: m[2], line: l, end: pyEnd(text, l) });
      if (/models\.Model|Base\b|DeclarativeBase|SQLModel/.test(m[3] || '')) x.decls.push({ type: 'entity', name: m[2], line: l });
    });
    const tn = text.match(/__tablename__\s*=\s*['"](\w+)['"]/);
    if (tn) x.meta.modelTable = tn[1];
    all(/@\w+\.(get|post|put|patch|delete|route|api_route)\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]+)\])?/g, text, (m) =>
      x.routes.push({ method: m[1] === 'route' || m[1] === 'api_route' ? (m[3] ? m[3].replace(/['"\s]/g, '') : 'GET') : m[1].toUpperCase(), path: m[2], line: lineAt(m.index) }));
    if (/urls\.py$/.test(rel)) all(/\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]/g, text, (m) => x.routes.push({ method: 'ANY', path: '/' + m[1], line: lineAt(m.index) }));
    sqlUses(text, lineAt, x.dbUses);
    httpCalls(text, lineAt, x.http);
    return x;
  },

  go(text, rel, lineAt) {
    const x = X();
    all(/^import\s+(?:\w+\s+)?"([^"]+)"/gm, text, (m) => x.imports.push({ spec: m[1], line: lineAt(m.index), names: [] }));
    all(/^import\s*\(([\s\S]*?)\)/gm, text, (m) => all(/"([^"]+)"/g, m[1], (n) => x.imports.push({ spec: n[1], line: lineAt(m.index + n.index), names: [] })));
    all(/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/gm, text, (m) => x.decls.push({ type: 'function', name: m[1], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt) }));
    all(/^type\s+(\w+)\s+(struct|interface)\b/gm, text, (m) => x.decls.push({ type: 'class', name: m[1], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt) }));
    all(/\.(GET|POST|PUT|PATCH|DELETE|HandleFunc|Handle|Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g, text, (m) =>
      x.routes.push({ method: /^Handle/.test(m[1]) ? 'ANY' : m[1].toUpperCase(), path: m[2], line: lineAt(m.index) }));
    sqlUses(text, lineAt, x.dbUses);
    httpCalls(text, lineAt, x.http);
    return x;
  },

  java(text, rel, lineAt) {
    const x = X();
    x.meta.package = (text.match(/^\s*package\s+([\w.]+)/m) || [])[1] || '';
    all(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;?/gm, text, (m) => x.imports.push({ spec: m[1], line: lineAt(m.index), names: [] }));
    all(/^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|data\s+|open\s+|sealed\s+)*(?:class|interface|enum|record|object)\s+(\w+)/gm, text, (m) =>
      x.decls.push({ type: 'class', name: m[1], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt) }));
    if (/@Entity\b/.test(text)) { const c = x.decls.find((d) => d.type === 'class'); if (c) x.decls.push({ type: 'entity', name: c.name, line: c.line }); }
    const t = text.match(/@Table\(\s*name\s*=\s*"(\w+)"/);
    if (t) x.meta.modelTable = t[1];
    const base = (text.match(/@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/) || [])[1] || '';
    all(/@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/g, text, (m) =>
      x.routes.push({ method: m[1].toUpperCase(), path: (base + '/' + m[2]).replace(/\/+/g, '/'), line: lineAt(m.index) }));
    sqlUses(text, lineAt, x.dbUses);
    return x;
  },

  rb(text, rel, lineAt) {
    const x = X();
    all(/^\s*class\s+([\w:]+)(?:\s*<\s*([\w:]+))?/gm, text, (m) => {
      x.decls.push({ type: 'class', name: m[1], line: lineAt(m.index) });
      if (/ApplicationRecord|ActiveRecord::Base/.test(m[2] || '')) x.decls.push({ type: 'entity', name: m[1], line: lineAt(m.index) });
    });
    all(/^\s*def\s+(?:self\.)?(\w+[?!]?)/gm, text, (m) => x.decls.push({ type: 'function', name: m[1], line: lineAt(m.index) }));
    if (/routes\.rb$/.test(rel)) {
      all(/^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm, text, (m) => x.routes.push({ method: m[1].toUpperCase(), path: '/' + m[2].replace(/^\//, ''), line: lineAt(m.index) }));
      all(/^\s*resources?\s+:(\w+)/gm, text, (m) => x.routes.push({ method: 'RESOURCE', path: '/' + m[1], line: lineAt(m.index) }));
    }
    all(/create_table\s+:(\w+)/g, text, (m) => x.tables.push({ name: m[1], line: lineAt(m.index), columns: [], refs: [] }));
    return x;
  },

  cs(text, rel, lineAt) {
    const x = X();
    all(/^\s*using\s+([\w.]+)\s*;/gm, text, (m) => x.imports.push({ spec: m[1], line: lineAt(m.index), names: [] }));
    all(/^\s*(?:public\s+|internal\s+|private\s+|sealed\s+|abstract\s+|static\s+|partial\s+)*(?:class|interface|record|struct)\s+(\w+)/gm, text, (m) =>
      x.decls.push({ type: 'class', name: m[1], line: lineAt(m.index), end: braceEnd(text, m.index, lineAt) }));
    all(/\[Http(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"\s*\)\]/g, text, (m) => x.routes.push({ method: m[1].toUpperCase(), path: '/' + m[2], line: lineAt(m.index) }));
    return x;
  },

  sql(text, rel, lineAt) {
    const x = X();
    all(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(?:\w+[`"\]]?\.[`"[]?)?(\w+)[`"\]]?\s*\(/gi, text, (m) => {
      let depth = 0, i = text.indexOf('(', m.index);
      const start = i;
      for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
      const body = text.slice(start + 1, i);
      const columns = body.split(/,(?![^(]*\))/).map((s) => s.trim().match(/^[`"[]?(\w+)[`"\]]?\s+([A-Za-z]+(?:\([^)]*\))?)/)).filter((c) => c && !/^(PRIMARY|FOREIGN|UNIQUE|KEY|CONSTRAINT|INDEX|CHECK)$/i.test(c[1])).map((c) => ({ name: c[1], type: c[2] }));
      const refs = [...body.matchAll(/REFERENCES\s+[`"[]?(\w+)/gi)].map((r) => ({ table: r[1], line: lineAt(start + 1 + r.index) }));
      x.tables.push({ name: m[1], line: lineAt(m.index), end: lineAt(i), columns, refs });
    });
    return x;
  },

  prisma(text, rel, lineAt) {
    const x = X();
    const models = [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
    const names = new Set(models.map((m) => m[1]));
    for (const m of models) {
      const columns = [], refs = [];
      const bodyStart = m.index + m[0].indexOf('{') + 1;
      all(/^\s*(\w+)\s+(\w+)(\[\])?(\?)?/gm, m[2], (f) => {
        if (names.has(f[2])) { if (!f[3]) refs.push({ table: f[2], line: lineAt(bodyStart + f.index) }); }
        else columns.push({ name: f[1], type: f[2] + (f[4] || '') });
      });
      const map = m[2].match(/@@map\(\s*"(\w+)"/);
      x.tables.push({ name: m[1], line: lineAt(m.index), end: lineAt(m.index + m[0].length - 1), columns, refs, mappedTo: map?.[1] });
    }
    return x;
  },

  manifest(text, rel, lineAt) {
    const x = X();
    const base = path.posix.basename(rel);
    const lineOf = (needle) => { const i = text.indexOf(needle); return i < 0 ? 1 : lineAt(i); };
    if (base === 'package.json' || base === 'composer.json') {
      let j; try { j = JSON.parse(text); } catch { x.meta.error = 'invalid JSON'; return x; }
      const eco = base === 'package.json' ? 'npm' : 'composer';
      x.meta.name = j.name;
      if (eco === 'npm') x.meta.scripts = Object.keys(j.scripts || {});
      if (eco === 'composer') x.meta.psr4 = { ...(j.autoload?.['psr-4'] || {}), ...(j['autoload-dev']?.['psr-4'] || {}) };
      const groups = eco === 'npm' ? [['dependencies', false], ['devDependencies', true], ['peerDependencies', false]] : [['require', false], ['require-dev', true]];
      for (const [k, dev] of groups) for (const [name, version] of Object.entries(j[k] || {})) {
        if (eco === 'composer' && (name === 'php' || name.startsWith('ext-'))) continue;
        x.deps.push({ eco, name, version: String(version), dev, line: lineOf(`"${name}"`) });
      }
    } else if (/^requirements.*\.txt$/.test(base)) {
      text.split('\n').forEach((l, i) => { const m = l.match(/^\s*([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*([<>=!~].*)?$/); if (m) x.deps.push({ eco: 'pypi', name: m[1].toLowerCase(), version: (m[2] || '').trim(), dev: /dev/.test(base), line: i + 1 }); });
    } else if (base === 'pyproject.toml') {
      const deps = text.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
      if (deps) all(/["']([A-Za-z0-9][\w.-]*)/g, deps[1], (m) => x.deps.push({ eco: 'pypi', name: m[1].toLowerCase(), version: '', dev: false, line: lineOf(m[0]) }));
      const poetry = text.match(/^\[tool\.poetry\.dependencies\]([\s\S]*?)(^\[|$(?![\s\S]))/m);
      if (poetry) all(/^([A-Za-z0-9][\w.-]*)\s*=/gm, poetry[1], (m) => { if (m[1] !== 'python') x.deps.push({ eco: 'pypi', name: m[1].toLowerCase(), version: '', dev: false, line: lineOf(m[0]) }); });
    } else if (base === 'go.mod') {
      x.meta.module = (text.match(/^module\s+(\S+)/m) || [])[1];
      all(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+(v[\w.+-]+)/gm, text, (m) => x.deps.push({ eco: 'go', name: m[1], version: m[2], dev: false, line: lineAt(m.index) }));
    } else if (base === 'Gemfile') {
      all(/^\s*gem\s+['"]([\w-]+)['"]/gm, text, (m) => x.deps.push({ eco: 'gem', name: m[1], version: '', dev: false, line: lineAt(m.index) }));
    } else if (base === 'Cargo.toml') {
      const sec = text.match(/^\[dependencies\]([\s\S]*?)(^\[|$(?![\s\S]))/m);
      if (sec) all(/^([\w-]+)\s*=/gm, sec[1], (m) => x.deps.push({ eco: 'cargo', name: m[1], version: '', dev: false, line: lineOf(m[0]) }));
    }
    return x;
  },

  dockerfile(text, rel, lineAt) {
    const x = X();
    const from = [...text.matchAll(/^FROM\s+(?:--\S+\s+)?(\S+)/gim)];
    const expose = [...text.matchAll(/^EXPOSE\s+(.+)$/gim)].flatMap((m) => m[1].trim().split(/\s+/));
    x.infra.push({ type: 'container', id: `container:${rel}`, name: path.posix.dirname(rel) === '.' ? 'Dockerfile' : `${path.posix.dirname(rel)}/Dockerfile`, line: from[0] ? lineAt(from[0].index) : 1,
      attrs: { baseImages: from.map((m) => m[1]), expose, stages: from.length } });
    return x;
  },

  compose(text, rel, lineAt) {
    const x = X();
    // ponytail: line-based compose reader (2-space or 4-space indent); anchors/extends/overrides not resolved.
    const ls = text.split(/\r?\n/);
    let section = null, svc = null, key = null, unit = 2;
    const services = new Map(), networks = [];
    ls.forEach((raw, i) => {
      if (/^\s*(#|$)/.test(raw)) return;
      const ind = raw.match(/^ */)[0].length;
      const t = raw.trim();
      if (ind === 0) { section = t.replace(/:.*$/, ''); svc = null; return; }
      if (section === 'networks' && /^[\w.-]+:/.test(t) && ind <= 4 && !svc) { if (!networks.includes(t.split(':')[0])) networks.push(t.split(':')[0]); return; }
      if (section !== 'services') return;
      if (!svc || ind <= unit) { if (/^[\w.-]+:\s*$/.test(t)) { unit = ind; svc = { name: t.slice(0, -1), line: i + 1, depends: [], networks: [], ports: [] }; services.set(svc.name, svc); key = null; } return; }
      const kv = t.match(/^([\w-]+):\s*(.*)$/);
      if (kv && ind === unit * 2) {
        key = kv[1];
        if (key === 'image') svc.image = kv[2].replace(/['"]/g, '');
        if (key === 'build') svc.build = kv[2] || '(context)';
        if (kv[2].startsWith('[')) kv[2].replace(/[[\]'"]/g, '').split(',').map((s) => s.trim()).filter(Boolean).forEach((v) => push(key, v, i + 1));
        return;
      }
      const item = t.match(/^-\s*['"]?([^'"#]+?)['"]?\s*$/) || ((key === 'depends_on' || key === 'networks') && ind === unit * 3 ? t.match(/^([\w.-]+):/) : null);
      if (item && key) push(key, item[1], i + 1);
    });
    function push(k, v, line) {
      if (k === 'depends_on') svc.depends.push({ name: v, line });
      if (k === 'networks') svc.networks.push({ name: v, line });
      if (k === 'ports') svc.ports.push(v);
    }
    for (const n of networks) x.infra.push({ type: 'network', id: `network:${rel}#${n}`, name: n, line: 1, attrs: {} });
    for (const s of services.values()) {
      x.infra.push({ type: 'service', id: `service:${rel}#${s.name}`, name: s.name, line: s.line, attrs: { image: s.image, build: s.build, ports: s.ports },
        links: [...s.depends.map((d) => ({ type: 'depends_on', target: `service:${rel}#${d.name}`, line: d.line })),
          ...s.networks.map((n) => ({ type: 'belongs_to', target: `network:${rel}#${n.name}`, line: n.line, ensure: { type: 'network', name: n.name } }))] });
    }
    return x;
  },

  ci(text, rel, lineAt) {
    const x = X();
    const name = (text.match(/^name:\s*['"]?(.+?)['"]?\s*$/m) || [])[1] || rel;
    const jobsAt = text.search(/^jobs:\s*$/m);
    const jobs = jobsAt < 0 ? [...text.matchAll(/^([\w-]+):\s*$/gm)].map((m) => m[1]).filter((j) => !/^(stages|variables|default|include|workflow|image|services|cache)$/.test(j))
      : [...text.slice(jobsAt).matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]);
    const triggers = (text.match(/^on:\s*\[?([^\]\n]*)/m) || [])[1];
    x.infra.push({ type: 'pipeline', id: `pipeline:${rel}`, name, line: 1, attrs: { jobs, triggers: triggers?.trim() || undefined } });
    return x;
  },

  yaml(text, rel, lineAt) {
    const x = X();
    if (!/^apiVersion:/m.test(text) || !/^kind:/m.test(text)) return x;
    let offset = 0;
    for (const doc of text.split(/^---\s*$/m)) {
      const kind = (doc.match(/^kind:\s*(\w+)/m) || [])[1];
      const name = (doc.match(/^metadata:\s*\n(?:\s+.*\n)*?\s+name:\s*['"]?([\w.-]+)/m) || [])[1];
      const type = { Deployment: 'deployment', StatefulSet: 'deployment', DaemonSet: 'deployment', Service: 'service', Ingress: 'network', Namespace: 'environment' }[kind];
      if (type && name) x.infra.push({ type, id: `${type}:k8s/${kind}/${name}`, name: `${kind}/${name}`, line: lineAt(offset + doc.search(/^kind:/m)), attrs: { kind } });
      offset += doc.length + 4;
    }
    return x;
  },

  terraform(text, rel, lineAt) {
    const x = X();
    all(/^resource\s+"([\w-]+)"\s+"([\w-]+)"/gm, text, (m) => {
      const t = m[1];
      const type = /instance|vm|droplet|server|compute/.test(t) ? 'server' : /vpc|subnet|network|security_group|firewall|lb|load_balancer/.test(t) ? 'network'
        : /db|rds|sql|database/.test(t) ? 'service' : /cluster|container|ecs|eks|gke|aks|k8s/.test(t) ? 'container' : 'service';
      x.infra.push({ type, id: `${type}:tf/${t}.${m[2]}`, name: `${t}.${m[2]}`, line: lineAt(m.index), attrs: { resource: t } });
    });
    return x;
  },

  nginx(text, rel, lineAt) {
    const x = X();
    const names = [...text.matchAll(/server_name\s+([^;]+);/g)].flatMap((m) => m[1].trim().split(/\s+/));
    const proxies = [...text.matchAll(/proxy_pass\s+https?:\/\/([\w.-]+)/g)].map((m) => ({ host: m[1], line: lineAt(m.index) }));
    if (names.length || proxies.length) x.infra.push({ type: 'service', id: `service:${rel}`, name: `nginx ${names[0] || path.posix.basename(rel)}`, line: 1, attrs: { role: 'reverse-proxy', serverNames: names }, proxies });
    return x;
  },

  envexample(text) {
    const x = X();
    // Names only. Values are never read into the result.
    for (const l of text.split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/); if (m) x.env.push(m[1]); }
    return x;
  },

  procfile(text, rel, lineAt) {
    const x = X();
    all(/^([\w-]+):\s*(.+)$/gm, text, (m) => x.infra.push({ type: 'service', id: `service:${rel}#${m[1]}`, name: m[1], line: lineAt(m.index), attrs: { process: true } }));
    return x;
  },
};

export function extract(rel, text) {
  const lang = langOf(rel);
  if (!lang || !EXTRACTORS[lang]) return { lang: lang || 'other', test: TEST_RE.test(rel) };
  const x = EXTRACTORS[lang](text, rel, lines(text));
  // Drop empty arrays to keep the cache small.
  for (const k of Object.keys(x)) if (Array.isArray(x[k]) && !x[k].length) delete x[k];
  if (x.meta && !Object.keys(x.meta).length) delete x.meta;
  return { lang, test: TEST_RE.test(rel), loc: text.split('\n').length, ...x };
}
