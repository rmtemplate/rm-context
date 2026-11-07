// Dependency-free SQL helpers: comment/string blanking, statement splitting, and a tolerant DDL parser for tables,
// indexes, routines (procedure, function, view, trigger), their parameters, referenced tables/routines and DDL operations.
// It reads text only. It never connects to a database and never executes anything.
import crypto from 'node:crypto';
import { findSecrets } from '../ignore.mjs';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Remove comments; keep string contents.
export function stripComments(sql) {
  let out = '', i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === '-' && n === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; out += ' '; continue; }
    if (c === "'") { const st = i++; while (i < s.length) { if (s[i] === "'" && s[i + 1] === "'") i += 2; else if (s[i] === "'") { i++; break; } else i++; } out += s.slice(st, i); continue; }
    out += c; i++;
  }
  return out;
}

// Comments removed and every quoted literal / quoted identifier emptied: only keywords and bare identifiers remain.
export function blank(sql) {
  const s = stripComments(sql);
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    const close = c === "'" ? "'" : c === '"' ? '"' : c === '`' ? '`' : c === '[' ? ']' : null;
    if (close) {
      i++;
      while (i < s.length) { if (s[i] === close && s[i + 1] === close && close !== ']') i += 2; else if (s[i] === close) { i++; break; } else i++; }
      out += c === "'" ? "''" : '_q_';
      continue;
    }
    if (c === '$') { const m = /^\$([A-Za-z_]*)\$/.exec(s.slice(i)); if (m) { const e = s.indexOf(m[0], i + m[0].length); i = e < 0 ? s.length : e + m[0].length; out += "''"; continue; } }
    out += c; i++;
  }
  return out;
}

// Statements, aware of quotes, comments, $tag$ bodies, DELIMITER, GO batches and BEGIN…END depth.
export function splitStatements(sql) {
  const lines = String(sql).split(/\r?\n/);
  const out = [];
  let delim = ';', buf = [], startLine = 1, depth = 0, inBlock = false, dollar = null;
  const flush = (line) => { const t = buf.join('\n').trim(); if (t) out.push({ text: t, line: startLine }); buf = []; depth = 0; startLine = line + 1; };
  lines.forEach((raw, idx) => {
    const ln = idx + 1;
    if (!buf.length && !inBlock && !dollar) {
      const d = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(raw);
      if (d) { delim = d[1]; startLine = ln + 1; return; }
      if (/^\s*GO(?:\s+\d+)?\s*$/i.test(raw)) { startLine = ln + 1; return; }
    } else if (/^\s*GO(?:\s+\d+)?\s*$/i.test(raw) && !inBlock && !dollar) { flush(ln); return; }
    if (!buf.length) startLine = ln;
    let i = 0, seg = '';
    while (i < raw.length) {
      const c = raw[i], n = raw[i + 1];
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; seg += '*/'; i += 2; } else { seg += c; i++; } continue; }
      if (dollar) { if (raw.startsWith(dollar, i)) { seg += dollar; i += dollar.length; dollar = null; } else { seg += c; i++; } continue; }
      if (c === '-' && n === '-') { seg += raw.slice(i); i = raw.length; continue; }
      if (c === '/' && n === '*') { inBlock = true; seg += '/*'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { let j = i + 1; while (j < raw.length) { if (raw[j] === c && raw[j + 1] === c) j += 2; else if (raw[j] === c) { j++; break; } else j++; } seg += raw.slice(i, j); i = j; continue; }
      if (c === '$') { const m = /^\$([A-Za-z_]*)\$/.exec(raw.slice(i)); if (m) { dollar = m[0]; seg += m[0]; i += m[0].length; continue; } }
      if (raw.startsWith(delim, i) && depth <= 0) { buf.push(seg); flush(ln); seg = ''; i += delim.length; startLine = ln; continue; }
      seg += c; i++;
    }
    buf.push(seg);
    if (!dollar && !inBlock) {
      const code = blank(seg);
      for (const m of code.matchAll(/\b(BEGIN(?!\s+(?:TRAN|TRANSACTION|DISTRIBUTED))|CASE|END(?:\s+(IF|LOOP|WHILE|REPEAT|CASE))?)\b/gi)) {
        const w = m[1].toUpperCase();
        if (w === 'BEGIN' || w === 'CASE') depth++;
        else if (w.startsWith('END')) { if (!/^END\s+(IF|LOOP|WHILE|REPEAT)$/.test(w)) depth--; }
      }
    }
  });
  if (buf.join('').trim()) flush(lines.length);
  // A T-SQL file without GO: a new top-level CREATE/ALTER of a routine or table starts a new statement.
  const res = [];
  for (const st of out) {
    const parts = st.text.split(/\r?\n(?=\s*(?:CREATE|ALTER)\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(?:PROC(?:EDURE)?|FUNCTION|VIEW|TRIGGER|TABLE)\b)/i);
    if (parts.length > 1 && parts[0].trim()) { let ln = st.line; for (const p of parts) { res.push({ text: p.trim(), line: ln }); ln += p.split('\n').length; } } else res.push(st);
  }
  return res;
}

const unq = (s) => String(s).replace(/^[\s`"[]+|[\s`"\]]+$/g, '');
export function splitName(raw) {
  const parts = String(raw).trim().split('.').map(unq).filter(Boolean);
  const name = parts.pop() || '';
  const schema = parts.pop() || '';
  return { name, schema, extra: parts }; // extra: database / server prefixes (cross-database)
}
export const objKey = (schema, name) => `${schema ? schema.toLowerCase() + '.' : ''}${String(name).toLowerCase()}`;

const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|\`[^\`]+\`|[\w$#@]+)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,3}`;

function topLevelSplit(text, sep = ',') {
  const parts = []; let depth = 0, cur = '', q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
const balanced = (text, from) => { let d = 0; for (let i = from; i < text.length; i++) { if (text[i] === '(') d++; else if (text[i] === ')') { d--; if (!d) return i; } } return -1; };

function parseColumn(item) {
  const m = new RegExp(`^(${IDENT})\\s+(.+)$`, 's').exec(item);
  if (!m) return null;
  const name = unq(m[1]);
  let rest = m[2];
  const tm = /^((?:double\s+precision|character\s+varying|timestamp\s+with(?:out)?\s+time\s+zone|[\w.]+)(?:\s*\([^)]*\))?(?:\s+unsigned)?)/i.exec(rest);
  const type = tm ? tm[1].replace(/\s+/g, ' ').trim() : '';
  const after = rest.slice(tm ? tm[0].length : 0);
  const flat = blank(after);
  const col = { name, type, nullable: !/\bNOT\s+NULL\b/i.test(flat) && !/\bPRIMARY\s+KEY\b/i.test(flat), pk: /\bPRIMARY\s+KEY\b/i.test(flat), identity: /\b(IDENTITY|AUTO_INCREMENT|AUTOINCREMENT|SERIAL|GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY)\b/i.test(flat) || /^(big|small)?serial/i.test(type),
    computed: /\bGENERATED\s+ALWAYS\s+AS\b|\bAS\s*\(/i.test(flat) && !/\bAS\s+IDENTITY\b/i.test(flat) };
  const d = /\bDEFAULT\s+(\([^)]*\)|'[^']*'|[^\s,]+)/i.exec(after);
  if (d) col.default = d[1];
  const r = new RegExp(`\\bREFERENCES\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, 'i').exec(after);
  if (r) col.references = { ...splitName(r[1]), columns: (r[2] || '').split(',').map(unq).filter(Boolean) };
  return col;
}

export function parseTable(stmt) {
  const m = new RegExp(`^\\s*CREATE\\s+(?:(?:GLOBAL\\s+|LOCAL\\s+)?TEMP(?:ORARY)?\\s+|UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QNAME})\\s*\\(`, 'i').exec(stmt);
  if (!m) return null;
  const start = stmt.indexOf('(', m.index + m[0].length - 1);
  const end = balanced(stmt, start);
  if (end < 0) return null;
  const { name, schema } = splitName(m[1]);
  const t = { schema, name, columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [], indexes: [] };
  for (const raw of topLevelSplit(stmt.slice(start + 1, end))) {
    const item = raw.replace(/^CONSTRAINT\s+\S+\s+/i, '');
    const cname = /^CONSTRAINT\s+(\S+)/i.exec(raw)?.[1];
    let x;
    if ((x = /^PRIMARY\s+KEY\s*(?:CLUSTERED|NONCLUSTERED)?\s*\(([^)]*)\)/i.exec(item))) t.primaryKey = x[1].split(',').map((c) => unq(c.replace(/\b(ASC|DESC)\b/i, '')));
    else if ((x = new RegExp(`^FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, 'i').exec(item))) t.foreignKeys.push({ name: cname && unq(cname), columns: x[1].split(',').map(unq), ref: splitName(x[2]), refColumns: (x[3] || '').split(',').map(unq).filter(Boolean) });
    else if ((x = /^UNIQUE\s*(?:KEY|INDEX)?\s*(?:\S+\s*)?\(([^)]*)\)/i.exec(item))) t.uniques.push({ name: cname && unq(cname), columns: x[1].split(',').map(unq) });
    else if ((x = /^CHECK\s*\((.*)\)\s*$/is.exec(item))) t.checks.push({ name: cname && unq(cname), definition: x[1].trim() });
    else if (/^(KEY|INDEX|FULLTEXT|SPATIAL)\b/i.test(item)) { const y = /^(?:KEY|INDEX)\s+(\S+)\s*\(([^)]*)\)/i.exec(item); if (y) t.indexes.push({ name: unq(y[1]), columns: y[2].split(',').map(unq), unique: false }); }
    else { const col = parseColumn(item); if (col) { t.columns.push(col); if (col.pk) t.primaryKey.push(col.name); if (col.references) t.foreignKeys.push({ columns: [col.name], ref: { name: col.references.name, schema: col.references.schema }, refColumns: col.references.columns }); } }
  }
  for (const c of t.columns) if (t.primaryKey.includes(c.name)) { c.pk = true; c.nullable = false; }
  return t;
}

function paramsOf(text, style) {
  const list = style === 'paren' ? topLevelSplit(text) : topLevelSplit(text);
  const out = [];
  for (const raw of list) {
    let p = raw.trim().replace(/\s+(?:=|DEFAULT)\s+.*$/is, '');
    let mode = 'IN';
    const mm = /^(INOUT|IN|OUT|VARIADIC)\s+/i.exec(p);
    if (mm) { mode = mm[1].toUpperCase(); p = p.slice(mm[0].length); }
    if (/\s+(OUTPUT|OUT)\s*$/i.test(p)) { mode = 'OUT'; p = p.replace(/\s+(OUTPUT|OUT)\s*$/i, ''); }
    p = p.replace(/\s+READONLY\s*$/i, '');
    const m = /^(@?[\w$]+)\s+(.+)$/s.exec(p);
    if (m) out.push({ name: m[1], type: m[2].replace(/\s+/g, ' ').trim(), mode });
  }
  return out;
}

const KW = new Set('select where set values on and or not null as from join inner left right outer cross full natural using lateral table only if exists case when then else end group order by having limit offset union all distinct top with nolock readonly output into for update returning default begin declare'.split(' '));
const isTempOrVar = (n) => /^[@#]/.test(n);

// Static references of a routine body (or any SQL): tables read/written, routines executed, dynamic SQL, cross-database names.
export function analyzeSql(sql, { selfName } = {}) {
  const code = blank(sql);
  const body = code;
  const refs = new Map();
  const ctes = new Set([...body.matchAll(/\b(?:WITH|,)\s*([\w$]+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const add = (raw, mode, kind) => {
    const { name, schema, extra } = splitName(raw);
    if (!name || isTempOrVar(name) || KW.has(name.toLowerCase()) || ctes.has(name.toLowerCase()) && !schema) return;
    if (selfName && objKey(schema, name) === objKey(...selfName)) return;
    const key = `${kind}:${objKey(schema, name)}:${extra.join('.')}`;
    const r = refs.get(key) || { kind, schema, name, mode: new Set(), crossDatabase: extra.length > 0, extra };
    r.mode.add(mode); refs.set(key, r);
  };
  const re = (kw, mode) => { for (const m of body.matchAll(new RegExp(`\\b${kw}\\s+(?!\\()(${QNAME})(?!\\s*\\()`, 'gi'))) add(m[1], mode, 'table'); };
  re('FROM', 'read'); re('JOIN', 'read'); re('INSERT\\s+INTO', 'write'); re('MERGE\\s+INTO', 'write'); re('MERGE', 'write'); re('TRUNCATE\\s+TABLE', 'write'); re('DELETE\\s+FROM', 'write'); re('USING', 'read');
  for (const m of body.matchAll(new RegExp(`\\bUPDATE\\s+(?!SET\\b)(${QNAME})\\s+SET\\b`, 'gi'))) add(m[1], 'write', 'table');
  for (const m of body.matchAll(new RegExp(`\\b(?:EXEC(?:UTE)?)\\s+(?!\\(|sp_executesql\\b|IMMEDIATE\\b)(?:@\\w+\\s*=\\s*)?(${QNAME})`, 'gi'))) add(m[1], 'exec', 'routine');
  for (const m of body.matchAll(new RegExp(`\\bCALL\\s+(${QNAME})\\s*\\(`, 'gi'))) add(m[1], 'exec', 'routine');
  const dynamic = /\bEXEC(?:UTE)?\s*\(|\bsp_executesql\b|\bEXECUTE\s+IMMEDIATE\b|\bPREPARE\b|\bEXEC(?:UTE)?\s+@\w+/i.test(body);
  const list = [...refs.values()].map((r) => ({ ...r, mode: [...r.mode] }));
  return { refs: list, dynamic, crossDatabase: list.some((r) => r.crossDatabase) };
}

// Secret-looking literals in a SQL definition (never stored raw when found).
export function sensitiveSql(text) {
  const hits = findSecrets(String(text)).map((h) => h.kind);
  for (const m of String(text).matchAll(/\b(?:PASSWORD|PWD|IDENTIFIED\s+BY|SECRET|API[_-]?KEY|TOKEN)\b\s*(?:=|\s)\s*N?'([^']{4,})'/gi)) if (!/^(x{3,}|\*+|<.*>|\?)$/i.test(m[1])) hits.push('credential literal');
  return [...new Set(hits)];
}

// Everything a SQL text declares. engine is only a hint for default schema.
export function parseSql(text, { engine } = {}) {
  const result = { tables: [], routines: [], ops: [], indexes: [] };
  const defSchema = engine === 'mssql' ? 'dbo' : engine === 'postgres' ? 'public' : '';
  for (const st of splitStatements(text)) {
    const s = st.text;
    const code = blank(s).trim();
    let m;
    const table = parseTable(stripComments(s));
    if (table) { table.schema ||= defSchema; table.line = st.line; result.tables.push(table); result.ops.push({ op: 'create', kind: 'table', schema: table.schema, name: table.name }); continue; }
    if ((m = new RegExp(`^(CREATE|ALTER)\\s+(?:OR\\s+(?:ALTER|REPLACE)\\s+)?(?:DEFINER\\s*=\\s*\\S+\\s+)?(?:(?:ALGORITHM|SQL\\s+SECURITY)\\s*=?\\s*\\w+\\s+)*(PROC(?:EDURE)?|FUNCTION|VIEW|TRIGGER)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QNAME})`, 'i').exec(code))) {
      const kind = /^proc/i.test(m[2]) ? 'procedure' : m[2].toLowerCase();
      const { name, schema } = splitName(stripComments(s).match(new RegExp(`${m[2]}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QNAME})`, 'i'))?.[1] || m[3]);
      const clean = stripComments(s);
      let params = [];
      const head = clean.slice(clean.search(new RegExp(`${m[2]}\\s+`, 'i')));
      const after = head.replace(new RegExp(`^${m[2]}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QNAME}`, 'i'), '');
      if (kind !== 'view' && kind !== 'trigger') {
        const paren = /^\s*\(/.test(after);
        if (paren) { const e = balanced(after, after.indexOf('(')); params = paramsOf(after.slice(after.indexOf('(') + 1, e), 'paren'); }
        else { const a = /\bAS\b/i.exec(after); if (a) { const pre = after.slice(0, a.index); if (/@/.test(pre)) params = paramsOf(pre.replace(/^\s*WITH\s+\w+(?:\s*,\s*\w+)*/i, ''), 'at'); } }
      }
      const a = analyzeSql(clean.slice(clean.search(/\b(AS|BEGIN|RETURNS|BEGIN)\b/i)), { selfName: [schema, name] });
      result.routines.push({ kind, schema: schema || defSchema, name, params, definition: clean, line: st.line, refs: a.refs, dynamic: a.dynamic, crossDatabase: a.crossDatabase });
      result.ops.push({ op: m[1].toLowerCase() === 'alter' ? 'alter' : 'create', kind, schema: schema || defSchema, name });
      continue;
    }
    if ((m = new RegExp(`^CREATE\\s+(UNIQUE\\s+)?(?:CLUSTERED\\s+|NONCLUSTERED\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(${QNAME})\\s*(?:USING\\s+\\w+\\s*)?\\(([^)]*)\\)`, 'i').exec(code.replace(/_q_/g, 'x') && stripComments(s)))) {
      const { name: tn, schema: ts } = splitName(m[3]);
      result.indexes.push({ name: unq(m[2]), unique: Boolean(m[1]), schema: ts || defSchema, table: tn, columns: m[4].split(',').map((c) => unq(c.replace(/\b(ASC|DESC)\b/i, ''))) });
      continue;
    }
    if ((m = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QNAME})\\s+(.*)$`, 'is').exec(stripComments(s).trim()))) {
      const { name, schema } = splitName(m[1]);
      const tail = m[2];
      const fk = new RegExp(`ADD\\s+(?:CONSTRAINT\\s+(\\S+)\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, 'i').exec(tail);
      const drops = /\bDROP\s+(COLUMN|CONSTRAINT)\b/i.test(blank(tail));
      const alterType = /\bALTER\s+COLUMN\b/i.test(blank(tail)) || /\bMODIFY\b/i.test(blank(tail));
      result.ops.push({ op: 'alter', kind: 'table', schema: schema || defSchema, name, destructive: drops ? 'drops a column or constraint' : alterType ? 'changes a column type or nullability (can truncate or fail on existing data)' : null });
      result.alters = [...(result.alters || []), { schema: schema || defSchema, table: name, foreignKey: fk && { name: fk[1] && unq(fk[1]), columns: fk[2].split(',').map(unq), ref: splitName(fk[3]), refColumns: (fk[4] || '').split(',').map(unq).filter(Boolean) } }];
      continue;
    }
    if ((m = new RegExp(`^DROP\\s+(TABLE|PROC(?:EDURE)?|FUNCTION|VIEW|TRIGGER)\\s+(?:IF\\s+EXISTS\\s+)?(${QNAME})`, 'i').exec(code.replace(/_q_/g, 'x') && stripComments(s).trim()))) {
      const { name, schema } = splitName(m[2]);
      result.ops.push({ op: 'drop', kind: /^proc/i.test(m[1]) ? 'procedure' : m[1].toLowerCase(), schema: schema || defSchema, name, destructive: 'drops the object' });
      continue;
    }
    if ((m = new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?(${QNAME})`, 'i').exec(stripComments(s).trim()))) {
      const { name, schema } = splitName(m[1]);
      result.ops.push({ op: 'truncate', kind: 'table', schema: schema || defSchema, name, destructive: 'removes all rows' });
      continue;
    }
    if (/^(DELETE|UPDATE)\b/i.test(code) && !/\bWHERE\b/i.test(code)) result.ops.push({ op: 'data', kind: 'data', destructive: 'changes every row (no WHERE clause)' });
    else if (/^(INSERT|UPDATE|DELETE|MERGE)\b/i.test(code)) result.ops.push({ op: 'data', kind: 'data', destructive: /^DELETE|^MERGE/i.test(code) ? 'deletes or merges rows' : null });
  }
  // CREATE INDEX / ALTER … ADD FOREIGN KEY apply to tables declared in the same text.
  const byKey = new Map(result.tables.map((t) => [objKey(t.schema, t.name), t]));
  for (const ix of result.indexes) { const t = byKey.get(objKey(ix.schema, ix.table)); if (t) t.indexes.push({ name: ix.name, columns: ix.columns, unique: ix.unique }); }
  for (const a of result.alters || []) { const t = byKey.get(objKey(a.schema, a.table)); if (t && a.foreignKey) t.foreignKeys.push(a.foreignKey); }
  return result;
}

// Definition text normalised for comparing an original with its backup: comments, quoting, case, CREATE/ALTER form, spacing.
export function normalizeDefinition(def, names = []) {
  let s = stripComments(def).replace(/[\[\]"`]/g, '').toLowerCase();
  for (const n of names) s = s.split(String(n).toLowerCase()).join('<name>');
  s = s.replace(/\b(create|alter)\s+(or\s+(alter|replace)\s+)?/g, 'create ').replace(/\bdefiner\s*=\s*\S+/g, '').replace(/\s+/g, ' ').replace(/\s*([(),;=])\s*/g, '$1');
  return s.trim();
}
