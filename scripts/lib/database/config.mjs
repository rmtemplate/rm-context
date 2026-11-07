// Secret-safe database configuration detection. Parses config locally and keeps ONLY non-secret metadata:
// engine, host, port, database name, profile, ORM/client, and where it came from. Passwords, users, tokens and full
// connection strings are dropped at parse time and never reach the return value, the knowledge store, agents or telemetry.
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'target', 'vendor', '.rmcontext', '.venv', 'venv', '__pycache__', '.gradle', '.idea', 'Pods', '.dart_tool']);
export const ENGINES = ['mssql', 'mysql', 'postgres', 'sqlite'];
export const ENVIRONMENTS = ['LOCAL', 'DEV', 'TEST', 'STAGING', 'PRODUCTION', 'UNKNOWN'];

export function walkFiles(root, { max = 4000, depth = 6 } = {}) {
  const out = [];
  const rec = (dir, d) => {
    if (d > depth || out.length >= max) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(path.join(dir, e.name), d + 1); }
      else out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  };
  rec(root, 0);
  return out;
}

export function engineFrom(text) {
  const t = String(text || '').toLowerCase();
  if (/sqlserver|mssql|sql\s*server|system\.data\.sqlclient|microsoft\.data\.sqlclient|sqlsrv|tds|mcr\.microsoft\.com\/mssql|\bdata source=.*(sqlexpress|\\\\)/.test(t)) return 'mssql';
  if (/postgres|npgsql|pgsql|psycopg|\bpg\b|timescale/.test(t)) return 'postgres';
  if (/mariadb|mysql|mysqli|pymysql/.test(t)) return 'mysql';
  if (/sqlite|\.db3?\b|\.sqlite3?\b/.test(t)) return 'sqlite';
  return null;
}

// key=value;key=value connection string → only non-secret fields
export function parseConnString(cs) {
  const kv = {};
  for (const part of String(cs || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const secretKeys = /^(password|pwd|user id|uid|user|username|accesstoken|access token|secret|apikey|api_key|token)$/;
  const hostRaw = kv['data source'] || kv.server || kv.host || kv.hostname || kv['server name'] || kv.address || '';
  let host = hostRaw.replace(/^(tcp|np):/i, '');
  let port = kv.port || '';
  const hp = /^([^,:]+)[,:](\d+)$/.exec(host);
  if (hp) { host = hp[1]; port = port || hp[2]; }
  const file = kv['data source'] && /\.(db3?|sqlite3?)$/i.test(kv['data source']) ? path.basename(kv['data source']) : '';
  const database = kv['initial catalog'] || kv.database || kv.dbname || kv['database name'] || '';
  const present = Object.keys(kv).filter((k) => secretKeys.test(k));
  return { host: file ? '' : host, port, database: file || database, integratedSecurity: /^(true|sspi|yes)$/i.test(kv['integrated security'] || kv['trusted_connection'] || ''), credentialsPresent: present.length > 0 };
}

// URL-style (jdbc:, postgres://, mysql://, mongodb://) → engine/host/port/database without userinfo or query
export function parseUrl(u) {
  const s = String(u || '').trim().replace(/^jdbc:/i, '');
  let engine = engineFrom(s.split(':')[0]) || engineFrom(s);
  let m = /^(\w+)(?:\+\w+)?:\/\/(?:[^@/]*@)?([^/:?;]+)?(?::(\d+))?(?:\/([^?;]*))?/.exec(s);
  if (!m) m = /^(\w+):(?:@)?\/\/([^/:?;]+)(?::(\d+))?(?:;databaseName=([^;]+))?/i.exec(s);
  if (m) {
    const database = (m[4] || '').split(';')[0] || (/databaseName=([^;&]+)/i.exec(s)?.[1] ?? '');
    return { engine: engine || engineFrom(m[1]), host: m[2] || '', port: m[3] || '', database: database.replace(/^\//, '') };
  }
  const sq = /^sqlite:(?:\/\/\/?)?(.+)$/i.exec(s);
  if (sq) return { engine: 'sqlite', host: '', port: '', database: path.basename(sq[1]) };
  return { engine, host: '', port: '', database: '' };
}

const profileOf = (file) => {
  const b = path.basename(file).toLowerCase();
  let m = /^web\.([\w.-]+)\.config$/.exec(b) || /^appsettings\.([\w.-]+)\.json$/.exec(b) || /^application-([\w.-]+)\.(properties|ya?ml)$/.exec(b) || /^\.env\.([\w.-]+)$/.exec(b) || /^\.env\.?$/.exec(b) && null;
  if (m) return m[1];
  const dir = /(?:^|\/)(?:settings|config)\/(dev|development|local|test|testing|staging|stage|prod|production)(?:\.py|\.php|\/)/.exec(file.toLowerCase());
  return dir ? dir[1] : '';
};

const isRef = (v) => /^\s*(\$\{|%\{|env\(|process\.env|os\.environ|getenv|<%|\{\{)/.test(String(v));
const envName = (v) => /(?:\$\{([A-Z0-9_]+)|env\(\s*['"]([A-Z0-9_]+)|process\.env\.([A-Z0-9_]+)|environ(?:\.get)?[\[(]\s*['"]([A-Z0-9_]+)|getenv\(\s*['"]([A-Z0-9_]+))/.exec(String(v));
const refName = (v) => { const m = envName(v); return m ? `env:${m.slice(1).find(Boolean)}` : ''; };

function readSafe(file) { try { const s = fs.statSync(file); if (s.size > 1_000_000) return ''; return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function parseEnvFile(text) {
  const o = {};
  for (const l of String(text).split(/\r?\n/)) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l); if (m && !/^\s*#/.test(l)) o[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ''); }
  return o;
}

function target(partial) {
  const t = { engine: null, host: '', port: '', database: '', schema: '', profile: '', orm: '', source: '', file: '', connectionName: '', credentialsPresent: false, hostFromEnv: '', ...partial };
  t.id = [t.engine || '?', t.host || t.hostFromEnv || '-', t.port || '-', t.database || '-', t.profile || '-'].join('|').toLowerCase();
  return t;
}

const DETECTORS = [
  {
    name: 'web-config', match: (f) => /(^|\/)web(\.[\w.-]+)?\.config$|(^|\/)app\.config$/i.test(f),
    run(f, text) {
      const out = [];
      for (const m of text.matchAll(/<add\s+[^>]*?name\s*=\s*"([^"]+)"[^>]*?connectionString\s*=\s*"([^"]*)"[^>]*?>/gi)) {
        const prov = /providerName\s*=\s*"([^"]+)"/i.exec(m[0])?.[1] || '';
        const p = parseConnString(m[2].replace(/&quot;/g, '"'));
        const engine = engineFrom(prov) || (p.port === '5432' ? 'postgres' : p.port === '3306' ? 'mysql' : /\.(db3?|sqlite3?)$/i.test(p.database) ? 'sqlite' : p.host || p.database ? 'mssql' : null);
        out.push(target({ engine, host: p.host, port: p.port, database: p.database, orm: /EntityFramework|edmx/i.test(text) ? 'entity-framework' : 'ado.net', connectionName: m[1], credentialsPresent: p.credentialsPresent }));
      }
      return out;
    },
  },
  {
    name: 'appsettings', match: (f) => /(^|\/)appsettings(\.[\w.-]+)?\.json$/i.test(f),
    run(f, text) {
      let j; try { j = JSON.parse(text.replace(/^﻿/, '').replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm, '$1')); } catch { return []; }
      const out = []; const cs = j.ConnectionStrings || j.connectionStrings || {};
      for (const [name, v] of Object.entries(cs)) {
        if (typeof v !== 'string') continue;
        const p = parseConnString(v);
        const engine = /^(postgres|npgsql)/i.test(v) || /\bhost=/i.test(v) && /\busername=/i.test(v) ? 'postgres' : /\bserver=.*;.*(uid|user id)=/i.test(v) && /mysql/i.test(name + JSON.stringify(j).slice(0, 4000)) ? 'mysql' : /\.(db3?|sqlite3?)\b/i.test(v) ? 'sqlite' : (engineFrom(JSON.stringify(j).slice(0, 8000)) || (p.host || p.database ? 'mssql' : null));
        out.push(target({ engine: engineFrom(name) || engine, host: p.host, port: p.port, database: p.database, orm: 'ef-core-or-ado.net', connectionName: name, credentialsPresent: p.credentialsPresent }));
      }
      return out;
    },
  },
  {
    name: 'dotenv', match: (f) => /(^|\/)\.env(\.[\w.-]+)?$/i.test(f) && !/\.(example|sample|dist)$/i.test(f) || /(^|\/)\.env\.(example|sample)$/i.test(f),
    run(f, text) {
      const e = parseEnvFile(text);
      const k = (...ks) => ks.map((x) => e[x]).find((v) => v);
      let engine = engineFrom(k('DB_CONNECTION', 'DB_TYPE', 'DB_ENGINE', 'DATABASE_TYPE', 'TYPEORM_CONNECTION', 'DB_DIALECT')) || null;
      let host = k('DB_HOST', 'DATABASE_HOST', 'TYPEORM_HOST', 'POSTGRES_HOST', 'MYSQL_HOST', 'DB_SERVER') || '';
      let port = k('DB_PORT', 'DATABASE_PORT', 'TYPEORM_PORT') || '';
      let database = k('DB_DATABASE', 'DB_NAME', 'DATABASE_NAME', 'TYPEORM_DATABASE', 'POSTGRES_DB', 'MYSQL_DATABASE') || '';
      const url = k('DATABASE_URL', 'DB_URL', 'DB_CONNECTION_STRING') || '';
      let credentialsPresent = Boolean(k('DB_PASSWORD', 'DATABASE_PASSWORD', 'DB_USERNAME', 'DB_USER', 'TYPEORM_PASSWORD'));
      if (url) { const p = /^\w[\w+.-]*:\/\//.test(url) ? parseUrl(url) : { ...parseConnString(url), engine: null }; engine ||= p.engine || engineFrom(url); host ||= p.host; port ||= p.port; database ||= p.database; credentialsPresent ||= /@|password|pwd/i.test(url); }
      if (!engine && !host && !database && !url) return [];
      const orm = e.TYPEORM_CONNECTION || e.TYPEORM_HOST ? 'typeorm' : e.DB_CONNECTION ? 'laravel' : '';
      return [target({ engine, host: isRef(host) ? '' : host, hostFromEnv: isRef(host) ? refName(host) : '', port, database: isRef(database) ? '' : database, orm, connectionName: e.DB_CONNECTION ? 'default' : url ? 'DATABASE_URL' : '', credentialsPresent, appEnv: k('APP_ENV', 'NODE_ENV', 'ASPNETCORE_ENVIRONMENT', 'ENVIRONMENT', 'RAILS_ENV') || '' })];
    },
  },
  {
    name: 'laravel-config', match: (f) => /(^|\/)config\/database\.php$/i.test(f),
    run(f, text) {
      const def = /'default'\s*=>\s*env\(\s*'DB_CONNECTION'\s*,\s*'([^']*)'/i.exec(text)?.[1] || /'default'\s*=>\s*'([^']+)'/i.exec(text)?.[1];
      const out = [];
      for (const m of text.matchAll(/'(mysql|mariadb|pgsql|sqlsrv|sqlite)'\s*=>\s*\[([\s\S]*?)\n\s{4}\],/g)) {
        const body = m[2];
        const db = /'database'\s*=>\s*env\(\s*'([A-Z_]+)'\s*,\s*'([^']*)'/.exec(body);
        const host = /'host'\s*=>\s*env\(\s*'([A-Z_]+)'\s*,\s*'([^']*)'/.exec(body);
        out.push(target({ engine: engineFrom(m[1]), database: db?.[2] && !/\//.test(db[2]) ? db[2] : '', host: host?.[2] || '', hostFromEnv: host ? `env:${host[1]}` : '', orm: 'laravel', connectionName: m[1], isDefault: def === m[1] }));
      }
      return out.filter((t) => t.isDefault !== false || out.length === 1);
    },
  },
  {
    name: 'prisma', match: (f) => /(^|\/)schema\.prisma$/i.test(f),
    run(f, text) {
      const m = /datasource\s+\w+\s*\{([\s\S]*?)\}/.exec(text); if (!m) return [];
      const provider = /provider\s*=\s*"([^"]+)"/.exec(m[1])?.[1]; const url = /url\s*=\s*(.+)/.exec(m[1])?.[1] || '';
      const lit = /^"([^"]*)"/.exec(url.trim());
      const p = lit && /:\/\//.test(lit[1]) ? parseUrl(lit[1]) : lit && provider === 'sqlite' ? parseUrl('sqlite:' + lit[1].replace(/^file:/, '')) : {};
      return [target({ engine: engineFrom(provider === 'sqlserver' ? 'mssql' : provider), host: p.host || '', port: p.port || '', database: p.database || '', hostFromEnv: !lit ? refName(url) : '', orm: 'prisma', connectionName: 'datasource', credentialsPresent: /@/.test(lit?.[1] || '') })];
    },
  },
  {
    name: 'spring', match: (f) => /(^|\/)application(-[\w.-]+)?\.(properties|ya?ml)$/i.test(f) || /(^|\/)bootstrap\.(properties|ya?ml)$/i.test(f),
    run(f, text) {
      let url = /^\s*spring\.datasource\.url\s*[=:]\s*(.+)$/m.exec(text)?.[1];
      if (!url && /\.ya?ml$/i.test(f)) { const m = /\bdatasource:\s*\n(?:[ \t]+.*\n)*?[ \t]+url:\s*(\S+)/.exec(text); url = m?.[1]; }
      const driver = /(?:driver-class-name|driverClassName)\s*[=:]\s*(\S+)/.exec(text)?.[1] || '';
      const orm = /hibernate|jpa/i.test(text) ? 'spring-data-jpa' : 'jdbc';
      if (!url) return driver ? [target({ engine: engineFrom(driver), orm })] : [];
      url = url.trim().replace(/^['"]|['"]$/g, '');
      if (isRef(url)) return [target({ engine: engineFrom(driver), hostFromEnv: refName(url), orm })];
      const p = parseUrl(url);
      return [target({ engine: p.engine || engineFrom(driver), host: p.host, port: p.port, database: p.database, orm, credentialsPresent: /username|password/i.test(text) })];
    },
  },
  {
    name: 'django', match: (f) => /(^|\/)settings(\/[\w]+)?\.py$/i.test(f),
    run(f, text) {
      const m = /DATABASES\s*=\s*\{([\s\S]*?)\n\}/.exec(text); if (!m) return [];
      const b = m[1];
      const engine = engineFrom(/ENGINE['"]\s*:\s*['"]([^'"]+)/.exec(b)?.[1]);
      const name = /NAME['"]\s*:\s*(['"][^'"]*['"]|[^,\n]+)/.exec(b)?.[1] || '';
      const host = /HOST['"]\s*:\s*(['"][^'"]*['"]|[^,\n]+)/.exec(b)?.[1] || '';
      const lit = (v) => /^['"]/.test(v.trim()) ? v.trim().slice(1, -1) : '';
      return [target({ engine, database: engine === 'sqlite' ? (lit(name) || path.basename(name).replace(/[^\w.]/g, '')) : lit(name), host: lit(host), hostFromEnv: !lit(host) ? refName(host) : '', orm: 'django-orm', connectionName: 'default', credentialsPresent: /PASSWORD/.test(b) })];
    },
  },
  {
    name: 'docker-compose', match: (f) => /(^|\/)(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(f),
    run(f, text) {
      const out = [];
      for (const m of text.matchAll(/^\s{2}([\w.-]+):\s*\n((?:\s{4,}.*\n?)+)/gm)) {
        const image = /image:\s*['"]?([^\s'"]+)/.exec(m[2])?.[1] || '';
        const engine = engineFrom(image); if (!engine || /^(redis|mongo)/i.test(image)) continue;
        const env = m[2];
        const database = /(?:POSTGRES_DB|MYSQL_DATABASE|MARIADB_DATABASE)\s*[:=]\s*['"]?([\w-]+)/.exec(env)?.[1] || '';
        out.push(target({ engine, host: m[1], port: /["']?(\d+):(?:5432|3306|1433)/.exec(m[2])?.[1] || '', database, orm: '', connectionName: m[1], credentialsPresent: /PASSWORD/i.test(env), localService: true }));
      }
      return out;
    },
  },
  {
    name: 'typeorm', match: (f) => /(^|\/)(ormconfig\.(json|js|ts)|data-source\.ts|typeorm\.config\.ts|app\.module\.ts)$/i.test(f),
    run(f, text) {
      if (!/typeorm/i.test(text)) return [];
      const type = /type\s*:\s*['"](\w+)['"]/.exec(text)?.[1];
      if (!type) return [];
      const db = /database\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1] || '';
      const host = /host\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1] || '';
      return [target({ engine: engineFrom(type === 'mssql' ? 'mssql' : type), host, database: db, hostFromEnv: !host ? refName(/host\s*:\s*([^,\n]+)/.exec(text)?.[1] || '') : '', orm: 'typeorm', connectionName: 'default' })];
    },
  },
  {
    name: 'sqlite-file', match: (f) => /\.(sqlite3?|db3)$/i.test(f),
    run(f) { return [target({ engine: 'sqlite', database: path.basename(f), orm: '', connectionName: 'file' })]; },
  },
];

// Environment from independent signals. Needs two agreeing signals; any conflict or lack of evidence → UNKNOWN.
const ENV_WORDS = [
  ['PRODUCTION', /\b(prod|production|live|prd)\b/], ['STAGING', /\b(stag|staging|stage|uat|preprod|pre-prod)\b/],
  ['TEST', /\b(test|testing|qa)\b/], ['DEV', /\b(dev|development|develop)\b/], ['LOCAL', /\b(local|localhost|localdb)\b/],
];
const wordsEnv = (s) => { const t = String(s || '').toLowerCase().replace(/[_.\\/-]+/g, ' '); for (const [e, rx] of ENV_WORDS) if (rx.test(t)) return e; return null; };
export function classifyEnvironment(t, { confirmed } = {}) {
  if (confirmed && ENVIRONMENTS.includes(confirmed)) return { environment: confirmed, signals: [{ from: 'user-confirmed', value: confirmed }], confirmed: true };
  const signals = [];
  const push = (from, env) => { if (env) signals.push({ from, value: env }); };
  push('profile', wordsEnv(t.profile));
  push('app-env', wordsEnv(t.appEnv));
  push('database-name', wordsEnv(t.database));
  const h = String(t.host || '').toLowerCase();
  if (/^(localhost|127\.\d+\.\d+\.\d+|::1|\(localdb\)|\.|host\.docker\.internal)$/.test(h) || /\(localdb\)|^\(local\)$/.test(h) || t.localService) push('host', 'LOCAL');
  else if (h) push('host', wordsEnv(h));
  if (t.engine === 'sqlite' && !t.host) push('file-database', 'LOCAL');
  const kinds = new Set(signals.map((s) => s.value));
  if (kinds.size > 1) {
    // DEV and LOCAL are compatible families; anything else conflicting is ambiguous.
    const protectedSeen = ['PRODUCTION', 'STAGING'].filter((e) => kinds.has(e));
    return { environment: 'UNKNOWN', signals, conflict: true, note: protectedSeen.length ? `conflicting signals include ${protectedSeen.join('/')}: treated as UNKNOWN (protected)` : 'conflicting signals' };
  }
  if (signals.length >= 2) return { environment: [...kinds][0], signals };
  return { environment: 'UNKNOWN', signals, note: signals.length ? 'one signal is not enough to identify the environment' : 'no environment signal found' };
}

export const PROTECTED = new Set(['STAGING', 'PRODUCTION']);
export const sanitize = (t) => ({ id: t.id, engine: t.engine, host: t.host || undefined, hostFromEnv: t.hostFromEnv || undefined, port: t.port || undefined, database: t.database || undefined, schema: t.schema || undefined, profile: t.profile || undefined, orm: t.orm || undefined, connectionName: t.connectionName || undefined, source: t.source, file: t.file, credentialsPresent: t.credentialsPresent || undefined });
export const identityHash = (t) => t.id; // non-secret composite: engine|host|port|database|profile

export function detectDatabaseConfig(root, { files } = {}) {
  const list = files || walkFiles(root);
  const targets = [];
  for (const f of list) {
    for (const d of DETECTORS) {
      if (!d.match(f)) continue;
      const text = d.name === 'sqlite-file' ? '' : readSafe(path.join(root, f));
      if (!text && d.name !== 'sqlite-file') continue;
      let found = [];
      try { found = d.run(f, text) || []; } catch { found = []; }
      for (const t of found) {
        t.source = d.name; t.file = f; t.profile ||= profileOf(f);
        const env = classifyEnvironment(t);
        targets.push({ ...t, environment: env.environment, environmentSignals: env.signals, environmentNote: env.note });
      }
      break;
    }
  }
  // merge duplicate identities (same db seen in several files), keep every source
  const byId = new Map();
  for (const t of targets) {
    const k = t.id; const prev = byId.get(k);
    if (!prev) byId.set(k, { ...t, sources: [{ source: t.source, file: t.file }] });
    else { prev.sources.push({ source: t.source, file: t.file }); if (!prev.orm && t.orm) prev.orm = t.orm; }
  }
  const out = [...byId.values()].map((t) => ({ ...sanitize(t), environment: t.environment, environmentSignals: t.environmentSignals, environmentNote: t.environmentNote, sources: t.sources }));
  return out;
}

// Migration framework detection (framework + directory + the command that applies it); the CLI never guesses a command.
export function detectMigrations(root, { files } = {}) {
  const list = files || walkFiles(root);
  const has = (rx) => list.filter((f) => rx.test(f));
  const out = [];
  const add = (framework, dir, files, extra = {}) => { if (files.length || extra.force) out.push({ framework, dir, count: files.length, sample: files.slice(0, 3), ...extra }); };
  const read = (f) => readSafe(path.join(root, f));
  const pkg = (() => { try { return JSON.parse(read('package.json') || '{}'); } catch { return {}; } })();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const csproj = has(/\.csproj$/i).map(read).join('\n');
  const flyway = has(/(^|\/)db\/migration\/V[\w.]+__[^/]+\.sql$/i).concat(has(/(^|\/)migrations?\/V\d[\w.]*__[^/]+\.sql$/i));
  add('flyway', 'db/migration', [...new Set(flyway)], { up: 'flyway migrate', down: 'flyway undo (Teams edition) or a U__ script' });
  const ef = has(/(^|\/)Migrations\/\d{14}_[^/]+\.cs$/i);
  add('ef-core', 'Migrations', ef, { up: 'dotnet ef database update', down: 'dotnet ef database update <previous>' });
  const knex = has(/(^|\/)migrations\/\d{8,14}_[^/]+\.(js|ts|cjs|mjs)$/i);
  if (deps.knex) add('knex', 'migrations', knex, { up: 'npx knex migrate:latest', down: 'npx knex migrate:rollback' });
  else if (deps.sequelize) add('sequelize', 'migrations', knex, { up: 'npx sequelize-cli db:migrate', down: 'npx sequelize-cli db:migrate:undo' });
  const lar = has(/(^|\/)database\/migrations\/\d{4}_\d{2}_\d{2}_\d{6}_[^/]+\.php$/i);
  add('laravel', 'database/migrations', lar, { up: 'php artisan migrate', down: 'php artisan migrate:rollback' });
  const typeorm = has(/(^|\/)(src\/)?migrations?\/\d{10,}-[^/]+\.ts$/i);
  if (deps.typeorm) add('typeorm', 'src/migrations', typeorm, { up: 'npx typeorm migration:run', down: 'npx typeorm migration:revert' });
  const prisma = has(/(^|\/)prisma\/migrations\/\d{14}_[^/]+\/migration\.sql$/i);
  add('prisma', 'prisma/migrations', prisma, { up: 'npx prisma migrate deploy', down: 'no automatic down (Prisma): write a reverse migration' });
  const dj = has(/(^|\/)migrations\/\d{4}_[^/]+\.py$/i).filter((f) => !/__init__/.test(f));
  add('django', 'migrations', dj, { up: 'python manage.py migrate', down: 'python manage.py migrate <app> <previous>' });
  const alembic = has(/(^|\/)alembic\/versions\/[^/]+\.py$/i);
  add('alembic', 'alembic/versions', alembic, { up: 'alembic upgrade head', down: 'alembic downgrade -1' });
  const lb = has(/(^|\/)(db\/)?changelog[^/]*\.(xml|ya?ml|json|sql)$/i);
  add('liquibase', 'db/changelog', lb, { up: 'liquibase update', down: 'liquibase rollback' });
  const rails = has(/(^|\/)db\/migrate\/\d{14}_[^/]+\.rb$/i);
  add('rails', 'db/migrate', rails, { up: 'rails db:migrate', down: 'rails db:rollback' });
  if (!out.length) {
    const sql = has(/(^|\/)(migrations?|db\/migrations?|sql|scripts\/sql|database)\/[^/]+\.sql$/i);
    if (sql.length) add('plain-sql', path.posix.dirname(sql[0]), sql, { up: null, down: null, note: 'no migration runner detected: scripts are applied manually' });
  }
  void csproj;
  return out;
}

// Static schema sources that can be used instead of a connection.
export function detectSchemaSources(root, { files } = {}) {
  const list = files || walkFiles(root);
  const kinds = [
    ['sql-script', /\.sql$/i], ['dacpac', /\.(dacpac|sqlproj)$/i], ['schema-dump', /(schema|dump|structure)[\w.-]*\.sql$/i],
    ['orm-model', /(^|\/)(Models?|Entities|entities|models)\/[^/]+\.(cs|java|kt|py|ts|php)$|\.entity\.ts$|schema\.prisma$|\.edmx$|DbContext\.cs$/i],
  ];
  const out = {};
  for (const [k, rx] of kinds) out[k] = list.filter((f) => rx.test(f));
  return out;
}
