import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, rmc, ok, graph, readJson, allFiles } from './helpers.mjs';
import { compilePattern, isIgnored, isSecretPath, findSecrets } from '../scripts/lib/ignore.mjs';

test('init scans the fixture into a valid, evidence-backed graph', () => {
  const dir = fixture();
  const out = ok(dir, 'init');
  assert.match(out, /Initialized/);
  const g = graph(dir);
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const id of ['api:GET /users', 'api:POST /users', 'api:GET /health', 'table:users', 'table:orders', 'integration:api.stripe.com',
    'service:docker-compose.yml#web', 'service:docker-compose.yml#db', 'pipeline:.github/workflows/ci.yml', 'container:Dockerfile',
    'dependency:npm/express', 'function:src/db.js#query', 'test:tests/users.test.js', 'environment:.env.example']) assert.ok(ids.has(id), `missing ${id}`);
  const e = new Set(g.edges.map((x) => x.id));
  for (const id of ['file:src/routes/users.js|implements|api:POST /users', 'table:orders|depends_on|table:users', 'file:src/routes/users.js|writes_to|table:users',
    'service:docker-compose.yml#web|depends_on|service:docker-compose.yml#db', 'file:src/routes/users.js|tested_by|test:tests/users.test.js',
    'file:src/services/billing.js|calls|function:src/db.js#query', 'service:nginx/default.conf|depends_on|service:docker-compose.yml#web']) assert.ok(e.has(id), `missing edge ${id}`);
  // compose depends_on map form must not turn "condition" into a service dependency
  assert.ok(!e.has('service:docker-compose.yml#web|depends_on|service:docker-compose.yml#condition'));
  // every verified item has evidence with a repo-relative path and line range
  for (const x of [...g.nodes, ...g.edges].filter((x) => x.confidence === 'verified')) {
    assert.ok(x.evidence.length, `${x.id} lacks evidence`);
    for (const ev of x.evidence) if (ev.file) assert.ok(!path.isAbsolute(ev.file) && !ev.file.includes('..'));
  }
  const users = g.nodes.find((n) => n.id === 'table:users');
  assert.deepEqual(users.attrs.columns.map((c) => c.name), ['id', 'email', 'created_at']);
  assert.deepEqual(users.evidence[0].lines, [1, 5]);
  assert.match(ok(dir, 'validate'), /graph: 0 error/);
});

test('secrets, keys, dumps and ignored files are never indexed or leaked', () => {
  const dir = fixture();
  ok(dir, 'init');
  const scan = readJson(path.join(dir, '.rmcontext/state/scan.json'));
  assert.equal(scan.excluded.secret, 3, 'expected .env, keys/server.pem and backups/prod.sql to be excluded');
  const cache = readJson(path.join(dir, '.rmcontext/state/files.json')).files;
  for (const f of ['.env', 'keys/server.pem', 'backups/prod.sql', 'ignored-dir/x.js']) assert.ok(!(f in cache), `${f} indexed`);
  const env = graph(dir).nodes.find((n) => n.id === 'environment:.env.example');
  assert.deepEqual(env.attrs.variables, ['DATABASE_URL', 'STRIPE_KEY', 'PORT']);
  for (const f of allFiles(path.join(dir, '.rmcontext'))) {
    const t = fs.readFileSync(f, 'utf8');
    for (const s of ['hunter2hunter2', 'tok_live_abcdef', 'BEGIN PRIVATE KEY', 'leaked@example.com']) assert.ok(!t.includes(s), `${s} leaked into ${f}`);
  }
});

test('refresh is incremental, flags stale agent knowledge and documents, and drops orphans', () => {
  const dir = fixture();
  ok(dir, 'init');
  let r = readJson(path.join(dir, '.rmcontext/state/scan.json'));
  assert.equal(r.mode, 'full');
  ok(dir, 'refresh');
  r = readJson(path.join(dir, '.rmcontext/state/scan.json'));
  assert.equal(r.mode, 'incremental');
  assert.deepEqual([r.files.added, r.files.changed, r.files.deleted], [0, 0, 0]);
  // agent knowledge with evidence in billing.js, and an agent edge to a node that will disappear
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({
    nodes: [{ id: 'BR-002', type: 'business_requirement', name: 'Charge orders', evidence: [{ file: 'src/services/billing.js', lines: [3, 8], type: 'call' }] }],
    edges: [{ source: 'function:src/services/billing.js#chargeOrder', target: 'BR-002', type: 'implements', evidence: [{ file: 'src/services/billing.js', lines: [3, 3], type: 'declaration' }] }],
  }));
  ok(dir, 'graph', 'upsert', 'p.json');
  ok(dir, 'doc', 'new', 'technical-design', '--title', 'Billing', '--author', 'senior-engineer', '--sources', 'src/services/billing.js');
  fs.appendFileSync(path.join(dir, 'src/routes/users.js'), '\nrouter.delete(\'/users/:id\', async () => {});\n');
  fs.writeFileSync(path.join(dir, 'src/services/billing.js'), 'export const noop = () => 1;\n');
  const out = ok(dir, 'refresh');
  r = readJson(path.join(dir, '.rmcontext/state/scan.json'));
  assert.deepEqual([r.files.added, r.files.changed, r.files.deleted], [1, 2, 0]); // p.json added, 2 changed
  assert.equal(r.files.indexed, 16); // includes the CLAUDE.md that rmc init writes
  assert.match(out, /Documents needing review.*TD-001/);
  const g = graph(dir);
  assert.ok(g.nodes.find((n) => n.id === 'api:DELETE /users/:id'));
  assert.equal(g.nodes.find((n) => n.id === 'BR-002').stale, true);
  assert.ok(!g.nodes.find((n) => n.id === 'function:src/services/billing.js#chargeOrder'));
  assert.deepEqual(r.orphanedAgentEdges, ['function:src/services/billing.js#chargeOrder|implements|BR-002']);
  assert.match(ok(dir, 'status'), /Freshness: up to date/);
  fs.appendFileSync(path.join(dir, 'src/db.js'), '\n// touched\n');
  assert.match(ok(dir, 'status'), /STALE — 1 file/);
});

test('git mode honours nested .gitignore files', { skip: spawnSync('git', ['--version']).status !== 0 && 'git not installed' }, () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'src', '.gitignore'), 'services/\n');
  const g = (...a) => spawnSync('git', a, { cwd: dir });
  g('init', '-q'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  ok(dir, 'init');
  const cache = readJson(path.join(dir, '.rmcontext/state/files.json')).files;
  assert.ok(!('src/services/billing.js' in cache));
  assert.ok('src/db.js' in cache);
  assert.match(readJson(path.join(dir, '.rmcontext/manifest.json')).scan.commit, /^[0-9a-f]{40}$/);
});

test('gitignore pattern semantics', () => {
  const pats = ['node_modules/', '*.log', '!keep.log', '/build', 'docs/**/*.tmp', 'a?c'].map(compilePattern);
  assert.ok(isIgnored('node_modules/x/y.js', pats));
  assert.ok(isIgnored('src/node_modules/y.js', pats));
  assert.ok(isIgnored('logs/x.log', pats));
  assert.ok(!isIgnored('keep.log', pats));
  assert.ok(isIgnored('build/out.js', pats));
  assert.ok(!isIgnored('src/build/out.js', pats));
  assert.ok(isIgnored('docs/a/b/c.tmp', pats));
  assert.ok(isIgnored('abc', pats) && !isIgnored('abbc', pats));
});

test('secret path and content detection', () => {
  for (const p of ['.env', '.env.production', 'config/.env.local', 'id_rsa', 'certs/server.key', 'a/b.pem', '.npmrc', 'credentials.json', 'service-account-prod.json', 'infra/terraform.tfstate', 'db/backup.dump', 'dumps/prod.sql'])
    assert.ok(isSecretPath(p), p);
  for (const p of ['.env.example', '.env.sample', 'db/schema.sql', 'src/secret_service.js', 'src/keys.js']) assert.ok(!isSecretPath(p), p);
  const bad = ['-----BEGIN RSA PRIVATE KEY-----', 'AKIAIOSFODNN7EXAMPLE', 'password = "S3cr3tValue!"', 'postgres://app:pa55word@db/app', 'token: ghp_' + 'a'.repeat(36)];
  for (const s of bad) assert.ok(findSecrets(s).length, s);
  const fine = ['password = "${DB_PASSWORD}"', 'API_KEY=<your key>', 'secret: process.env.SECRET', 'Set `DATABASE_URL` in the secret store', 'token = REDACTED'];
  for (const s of fine) assert.equal(findSecrets(s).length, 0, s);
});

test('legacy 0.2.0 graphs are migrated, not dropped', () => {
  const dir = fixture();
  ok(dir, 'init');
  const g = graph(dir);
  g.nodes.push({ id: 'legacy:svc', type: 'external_service', name: 'Mailer', evidenceStatus: 'inferred' });
  g.edges.push({ source: 'module:src', target: 'legacy:svc', type: 'uses' });
  fs.writeFileSync(path.join(dir, '.rmcontext/graph/nodes.json'), JSON.stringify(g.nodes));
  fs.writeFileSync(path.join(dir, '.rmcontext/graph/edges.json'), JSON.stringify(g.edges));
  const out = ok(dir, 'refresh');
  assert.match(out, /Migrated 2 legacy graph item/);
  const after = graph(dir);
  assert.equal(after.nodes.find((n) => n.id === 'legacy:svc').type, 'integration');
  assert.ok(after.edges.find((e) => e.id === 'module:src|depends_on|legacy:svc'));
});

test('find, impact and CLI errors', () => {
  const dir = fixture();
  assert.equal(rmc(dir, 'status').code, 2, 'status before init must fail clearly');
  assert.match(rmc(dir, 'status').err, /not initialized/);
  ok(dir, 'init');
  assert.match(ok(dir, 'find', 'stripe'), /integration:api\.stripe\.com/);
  const md = ok(dir, 'impact', 'src/db.js');
  assert.match(md, /file:src\/routes\/users\.js/);
  assert.match(md, /api:POST \/users/);
  assert.doesNotMatch(md, /project:sample-shop/);
  assert.equal(rmc(dir, 'nonsense').code, 2);
});
