import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'scripts', 'rmc.mjs');

// Copy a fixture into a fresh temp dir. Secret files are generated here, never committed.
export function fixture(name = 'node-app') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-test-'));
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', name), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=hunter2hunter2-SECRET\nAPI_TOKEN=tok_live_abcdef123456\n');
  fs.mkdirSync(path.join(dir, 'keys'));
  fs.writeFileSync(path.join(dir, 'keys', 'server.pem'), '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n');
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.writeFileSync(path.join(dir, 'backups', 'prod.sql'), "INSERT INTO users VALUES (1, 'leaked@example.com');\n");
  return dir;
}

// RMC_SESSION_ID is cleared so a test never links to the developer's live Claude Code session.
export function rmc(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, RMC_SESSION_ID: '' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
export const ok = (cwd, ...args) => {
  const r = rmc(cwd, ...args);
  if (r.code !== 0) throw new Error(`rmc ${args.join(' ')} failed (${r.code}): ${r.err || r.out}`);
  return r.out;
};
// Fingerprint of this repository's own RM Context telemetry. Tests run hooks and the CLI in temp projects only,
// so it must be identical before and after every test file.
export const repoTelemetry = () => ['autocontext.jsonl', 'routing.jsonl', 'pending-changes.jsonl'].map((f) => {
  try { const s = fs.statSync(path.join(ROOT, '.rmcontext', 'state', f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return `${f}:none`; }
}).join(' | ');
// An empty directory with no RM Context project above it: hooks spawned here never find this repository's .rmcontext.
export const isolatedCwd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-cwd-'));
export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const graph = (dir) => ({ nodes: readJson(path.join(dir, '.rmcontext/graph/nodes.json')), edges: readJson(path.join(dir, '.rmcontext/graph/edges.json')) });
export function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
