import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCHEMA_VERSION = 2;
export const GENERATOR = 'rm-context@0.4.1';

export class RmcError extends Error {}
export const fail = (msg) => { throw new RmcError(msg); };

export const now = () => new Date().toISOString();
export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
export const toPosix = (p) => p.split(path.sep).join('/');
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    fail(`Missing file: ${file}`);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail(`Invalid JSON in ${file}: ${e.message}`); }
}

// Atomic write: never leave half-written JSON behind.
export function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
export const writeJson = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');

export function git(root, args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// Minimal argv parser: positional args plus --key value / --flag.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// Paths inside a project's .rmcontext directory.
export function ctx(root) {
  const base = path.join(root, '.rmcontext');
  const p = (...xs) => path.join(base, ...xs);
  return {
    root, base, p,
    manifest: p('manifest.json'),
    config: p('config.json'),
    index: p('INDEX.md'),
    nodes: p('graph', 'nodes.json'),
    edges: p('graph', 'edges.json'),
    files: p('state', 'files.json'),
    scan: p('state', 'scan.json'),
    handoffs: p('state', 'handoffs.jsonl'),
    registry: p('documents', 'registry.json'),
    plan: p('project-management', 'plan.json'),
    refs: p('references', 'projects.json'),
    local: p('.local', 'local.json'),
    viewer: p('viewer', 'index.html'),
  };
}

export function requireInit(c) {
  if (!fs.existsSync(c.manifest)) fail('RM Context is not initialized here. Run: rmc init');
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
