// File selection: .gitignore + .rmcontextignore + hard security exclusions.
import fs from 'node:fs';
import path from 'node:path';
import { git, toPosix } from './util.mjs';

export const DEFAULT_DIRS = ['.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv', 'env',
  '.tox', '.mypy_cache', '.pytest_cache', '.idea', '.vscode', 'bower_components', '.terraform', '.rmcontext',
  'storage/framework', 'storage/logs', 'public/build', 'public/hot', 'tmp', 'logs'];

const BINARY_EXT = new Set(('png jpg jpeg gif webp bmp ico svg psd ai woff woff2 ttf otf eot mp3 mp4 mov avi webm wav ogg ' +
  'zip tar gz tgz bz2 xz 7z rar jar war ear pdf doc docx xls xlsx ppt pptx exe dll so dylib bin o a class pyc ' +
  'wasm map min.js lock').split(' '));
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'go.sum']);

// Never read, never index — regardless of .gitignore. Names are matched case-insensitively on the basename.
const SECRET_RULES = [
  /^\.env(\..+)?$/,                 // .env, .env.production … (examples allowed below)
  /\.(pem|key|p12|pfx|jks|keystore|ppk|crt|cer|der|kdbx|asc|gpg)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^(\.npmrc|\.pypirc|\.netrc|\.htpasswd|\.pgpass|\.git-credentials|\.dockercfg|kubeconfig)$/,
  /^(auth|credentials?|secrets?|service[-_]?account.*)\.(json|ya?ml|toml|ini|txt|xml)$/,
  /^credentials$/,
  /\.(tfstate|tfstate\.backup|tfvars)$/,
  /\.(sql\.gz|dump|bak|sqlite3?|db|mdb)$/,
];
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist|defaults)$/;

export function isSecretPath(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  if (ENV_EXAMPLE.test(base)) return false;
  for (const r of SECRET_RULES) if (r.test(base)) return true;
  // SQL files under dump/backup folders are data, not schema.
  return /(^|\/)(dumps?|backups?)\//i.test(rel) && /\.sql$/i.test(base);
}

export function isBinaryPath(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  if (LOCKFILES.has(path.posix.basename(rel))) return true;
  if (base.endsWith('.min.js') || base.endsWith('.min.css')) return true;
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return BINARY_EXT.has(ext);
}

// gitignore glob → RegExp. Supports *, **, ?, [..], leading /, trailing /, ! negation.
export function compilePattern(line) {
  let pat = line.trim();
  if (!pat || pat.startsWith('#')) return null;
  const negate = pat.startsWith('!');
  if (negate) pat = pat.slice(1);
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.startsWith('/') || pat.slice(0, -1).includes('/');
  if (pat.startsWith('/')) pat = pat.slice(1);
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') { re += pat[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += pat[i + 2] === '/' ? 2 : 1; }
      else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') { const j = pat.indexOf(']', i); re += j > i ? pat.slice(i, j + 1) : '\\['; i = j > i ? j : i; }
    else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  const prefix = anchored ? '^' : '(?:^|/)';
  // Matching a directory also matches everything below it.
  return { negate, dirOnly, re: new RegExp(`${prefix}${re}(?:/.*)?$`), dirRe: new RegExp(`${prefix}${re}$`) };
}

export function loadPatterns(root, extra = []) {
  const lines = [...extra];
  for (const f of ['.gitignore', '.rmcontextignore']) {
    const fp = path.join(root, f);
    if (fs.existsSync(fp)) lines.push(...fs.readFileSync(fp, 'utf8').split(/\r?\n/));
  }
  return lines.map(compilePattern).filter(Boolean);
}

export function isIgnored(rel, patterns) {
  let ignored = false;
  for (const p of patterns) if (p.re.test(rel)) ignored = !p.negate;
  return ignored;
}

const inDefaultDir = (rel) => DEFAULT_DIRS.some((d) => rel === d || rel.startsWith(d + '/') || rel.includes('/' + d + '/'));

// Returns { files: [rel...], excluded: {secret, binary, ignored, large} }
export function listFiles(root, { extraIgnore = [], maxBytes = 1_000_000 } = {}) {
  const patterns = loadPatterns(root, extraIgnore);
  const excluded = { secret: 0, binary: 0, ignored: 0, large: 0 };
  let candidates;
  // Prefer git: it applies nested .gitignore files and global excludes exactly.
  const fromGit = git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  if (fromGit !== null && git(root, ['rev-parse', '--show-toplevel']) !== null) {
    candidates = fromGit.split('\0').filter(Boolean);
  } else {
    // ponytail: fallback walker honours only root .gitignore + .rmcontextignore, not nested ones.
    candidates = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${ent.name}` : ent.name;
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) { if (!inDefaultDir(rel) && !isIgnored(rel, patterns)) walk(rel); }
        else if (ent.isFile()) candidates.push(rel);
      }
    };
    walk('');
  }
  const files = [];
  for (const raw of candidates) {
    const rel = toPosix(raw);
    if (inDefaultDir(rel)) { excluded.ignored++; continue; }
    if (isSecretPath(rel)) { excluded.secret++; continue; }
    if (isIgnored(rel, patterns)) { excluded.ignored++; continue; }
    if (isBinaryPath(rel)) { excluded.binary++; continue; }
    let st;
    try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > maxBytes) { excluded.large++; continue; }
    files.push(rel);
  }
  return { files: files.sort(), excluded };
}

// Secret-looking content. Used to block generated documents/graph data from leaking values.
const SECRET_CONTENT = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['API secret key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['connection string with password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i],
];
const ASSIGNMENT = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?([^\s"'`,;)]{8,})/gi;
const PLACEHOLDER = /^(\$\{|\{\{|<|%|\*{3}|x{3,}|redacted|changeme|your[_-]|example|placeholder|null|none|env\(|process\.env|os\.environ|getenv|\[)/i;

export function findSecrets(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [name, re] of SECRET_CONTENT) if (re.test(line)) hits.push({ line: i + 1, kind: name });
    for (const m of line.matchAll(ASSIGNMENT)) if (!PLACEHOLDER.test(m[2])) hits.push({ line: i + 1, kind: `${m[1]} assignment` });
  });
  return hits;
}
