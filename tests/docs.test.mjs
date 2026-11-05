import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, rmc, ok, readJson } from './helpers.mjs';
import { mdToHtml } from '../scripts/lib/docs.mjs';

const fill = (file, map) => {
  let s = fs.readFileSync(file, 'utf8');
  for (const [h, body] of Object.entries(map)) s = s.replace(new RegExp(`(## ${h.replace(/[&]/g, '\\$&')}\\n\\n<!--[\\s\\S]*?-->\\n)`), `$1\n${body}\n`);
  fs.writeFileSync(file, s);
};
const FSD = {
  'Purpose & Scope': 'Refines BR-001.', 'Actors & Roles': '- Visitor',
  'Functional Requirements': '| ID | Requirement | Traces to | Priority | Basis |\n|---|---|---|---|---|\n| FR-001 | Create user | BR-001 | Must | Confirmed |',
  'Process Flows': 'POST /users (src/routes/users.js:10).', 'Business Rules & Validations': 'Unique email.', 'Non-Functional Requirements': 'Open Question: latency target.',
  'Acceptance Criteria': 'Given … When … Then 201.', 'Assumptions': 'None recorded.', 'Open Questions': '1. Email verification?',
};

test('document lifecycle: create → validate → review → approval gate → revise → export', () => {
  const dir = fixture();
  ok(dir, 'init');
  assert.match(ok(dir, 'doc', 'new', 'fsd', '--title', 'Registration', '--author', 'business-analyst'), /FSD-001/);
  const file = path.join(dir, '.rmcontext/documents/business/FSD-001-registration.md');
  let r = rmc(dir, 'doc', 'validate', 'FSD-001');
  assert.equal(r.code, 1);
  assert.match(r.out, /section "Purpose & Scope" is empty/);
  assert.match(r.out, /rule basis/);
  assert.equal(rmc(dir, 'doc', 'status', 'FSD-001', 'Under Review').code, 2, 'invalid docs cannot enter review');
  fill(file, FSD);
  assert.match(ok(dir, 'doc', 'validate', 'FSD-001'), /✔ valid/);
  ok(dir, 'doc', 'status', 'FSD-001', 'Under Review');
  r = rmc(dir, 'doc', 'status', 'FSD-001', 'Approved');
  assert.equal(r.code, 2);
  assert.match(r.err, /--approved-by/);
  ok(dir, 'doc', 'status', 'FSD-001', 'Approved', '--approved-by', 'Product owner');
  let d = readJson(path.join(dir, '.rmcontext/documents/registry.json')).documents[0];
  assert.equal(d.status, 'Approved');
  assert.equal(d.approvedBy, 'Product owner');
  assert.match(fs.readFileSync(file, 'utf8'), /\| Status \| Approved \|/);
  assert.match(ok(dir, 'doc', 'revise', 'FSD-001', '--note', 'Clarified FR-001'), /back to Under Review/);
  d = readJson(path.join(dir, '.rmcontext/documents/registry.json')).documents[0];
  assert.deepEqual([d.version, d.status, d.approvedBy, d.history.length], [2, 'Under Review', undefined, 4]);
  assert.ok(fs.existsSync(path.join(dir, '.rmcontext/documents/.history/FSD-001/v1.md')));
  assert.match(ok(dir, 'doc', 'export', 'FSD-001', '--format', 'html'), /FSD-001-v2\.html/);
  const html = fs.readFileSync(path.join(dir, '.rmcontext/documents/exports/FSD-001-v2.html'), 'utf8');
  assert.match(html, /<table>/);
  assert.match(html, /<h2>Functional Requirements<\/h2>/);
});

test('basis values are enforced and secrets block validation', () => {
  const dir = fixture();
  ok(dir, 'init');
  ok(dir, 'doc', 'new', 'fsd', '--title', 'X', '--author', 'business-analyst');
  const file = path.join(dir, '.rmcontext/documents/business/FSD-001-x.md');
  fill(file, { ...FSD, 'Functional Requirements': FSD['Functional Requirements'].replace('Confirmed', 'Probably'), 'Assumptions': 'DB url postgres://admin:Sup3rS3cret@db.internal/prod' });
  const r = rmc(dir, 'doc', 'validate', 'FSD-001');
  assert.match(r.out, /Basis "probably"/);
  assert.match(r.out, /secret-like content/);
});

test('generated types are prefilled from evidence and can be regenerated', () => {
  const dir = fixture();
  ok(dir, 'init');
  ok(dir, 'doc', 'new', 'erd', '--title', 'Data model', '--author', 'system-analyst');
  ok(dir, 'doc', 'new', 'api-spec', '--title', 'API', '--author', 'system-analyst');
  ok(dir, 'doc', 'new', 'env-matrix', '--title', 'Env', '--author', 'devops-engineer');
  const read = (p) => fs.readFileSync(path.join(dir, '.rmcontext/documents', p), 'utf8');
  const erd = read('system/ERD-001-data-model.md');
  assert.match(erd, /erDiagram/);
  assert.match(erd, /users \|\|--o\{ orders : "FK"/);
  assert.match(erd, /`db\/schema\.sql:1`/);
  assert.match(read('system/API-001-api.md'), /\| POST \| `\/users` \| `src\/routes\/users\.js`/);
  const env = read('infrastructure/ENV-001-env.md');
  assert.match(env, /`STRIPE_KEY`/);
  assert.doesNotMatch(env, /hunter2/);
  fs.appendFileSync(path.join(dir, 'db/schema.sql'), '\nCREATE TABLE invoices (id SERIAL PRIMARY KEY, order_id INTEGER REFERENCES orders(id));\n');
  ok(dir, 'refresh');
  assert.match(ok(dir, 'doc', 'regenerate', 'ERD-001'), /v2/);
  assert.match(read('system/ERD-001-data-model.md'), /orders \|\|--o\{ invoices/);
});

test('refuses unknown types/authors, duplicates are numbered, user files are never overwritten', () => {
  const dir = fixture();
  ok(dir, 'init');
  assert.match(rmc(dir, 'doc', 'new', 'novel', '--title', 'x', '--author', 'qa').err, /Unknown document type/);
  assert.match(rmc(dir, 'doc', 'new', 'adr', '--title', 'x', '--author', 'intern').err, /--author must be/);
  assert.match(rmc(dir, 'doc', 'new', 'adr', '--title', 'x', '--author', 'senior-engineer', '--nodes', 'nope').err, /Unknown graph node/);
  ok(dir, 'doc', 'new', 'adr', '--title', 'Use Postgres', '--author', 'senior-engineer');
  assert.match(ok(dir, 'doc', 'new', 'adr', '--title', 'Use Redis', '--author', 'senior-engineer'), /ADR-002/);
  fs.writeFileSync(path.join(dir, '.rmcontext/documents/engineering/ADR-003-use-kafka.md'), 'mine');
  assert.match(rmc(dir, 'doc', 'new', 'adr', '--title', 'Use Kafka', '--author', 'senior-engineer').err, /refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(dir, '.rmcontext/documents/engineering/ADR-003-use-kafka.md'), 'utf8'), 'mine');
});

test('every catalog template is structurally valid', async () => {
  const cat = JSON.parse(fs.readFileSync(new URL('../templates/catalog.json', import.meta.url)));
  const { AGENTS } = await import('../scripts/lib/project.mjs');
  const prefixes = new Set();
  for (const [k, t] of Object.entries(cat.types)) {
    assert.ok(t.title && t.layer && t.prefix && t.sections.length, k);
    assert.ok(AGENTS.includes(t.owner), `${k}: owner ${t.owner}`);
    assert.ok(!prefixes.has(t.prefix), `${k}: duplicate prefix`); prefixes.add(t.prefix);
    for (const r of t.rules) assert.ok(cat.rules[r.split(':')[0]], `${k}: unknown rule ${r}`);
    for (const s of t.sections) assert.ok(s.h && s.g, `${k}: section needs heading and guidance`);
  }
  assert.ok(Object.keys(cat.types).length >= 37);
});

test('markdown export escapes HTML', () => {
  const html = mdToHtml('# T\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| <img> | `x` |\n\n[ok](https://x.y) [bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<script>|<img>|javascript:/);
  assert.match(html, /<a href="https:\/\/x\.y">ok<\/a>/);
});
