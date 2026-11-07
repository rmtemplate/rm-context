// Bounded database + mobile knowledge for a task. Never the whole knowledge; never definitions or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { findObjects, showObject, dbDir } from './store.mjs';
import { mobileContext } from '../mobile.mjs';

const MIN_SCORE = 4;
export function databaseContext(root, query, { maxChars = 900, limit = 4 } = {}) {
  if (!fs.existsSync(path.join(dbDir(root), 'manifest.json'))) return '';
  const hits = findObjects(root, query, { limit: 12 }).filter((h) => h.score >= MIN_SCORE).slice(0, limit);
  if (!hits.length) return '';
  const lines = ['Database objects (recorded schema; definitions only via `rmc database show … --definition`):'];
  for (const h of hits) {
    const o = showObject(root, h.kind, `${h.schema ? h.schema + '.' : ''}${h.name}`);
    if (!o) continue;
    const tag = o.scope === 'local' ? 'local DB' : 'backend DB';
    if (o.kind === 'table') lines.push(`- ${tag} table ${o.schema ? o.schema + '.' : ''}${o.name}: ${o.columns.slice(0, 10).map((c) => c.name).join(', ')}${o.primaryKey?.length ? ` · PK ${o.primaryKey.join(',')}` : ''}${o.foreignKeys?.length ? ` · FK ${o.foreignKeys.slice(0, 3).map((f) => `${f.columns.join(',')}→${f.ref.name}`).join('; ')}` : ''}`);
    else lines.push(`- ${tag} ${o.kind} ${o.schema ? o.schema + '.' : ''}${o.name}(${(o.params || []).map((p) => p.name).join(', ')})${o.dependsOn?.length ? ` · touches ${o.dependsOn.slice(0, 5).map((d) => d.to).join(', ')}` : ''}${o.encrypted ? ' · definition unavailable' : ''}${o.application?.length ? ` · used in ${o.application.slice(0, 2).map((a) => `${a.file}:${a.line}`).join(', ')}` : ''}`);
  }
  return lines.length > 1 ? lines.join('\n').slice(0, maxChars) : '';
}

export function dataMobileContext(root, query, budgetChars = 1500) {
  const parts = [];
  try { const d = databaseContext(root, query); if (d) parts.push(d); } catch { /* knowledge is optional */ }
  try { if (fs.existsSync(path.join(root, '.rmcontext', 'mobile', 'manifest.json'))) { const m = mobileContext(root, query); if (m && (/chain:|—/.test(m) || /mobile|screen|viewmodel|compose|flutter|android|ios|bloc|riverpod|room|dao|widget|react native/i.test(query))) parts.push(m); } } catch { /* optional */ }
  return parts.join('\n\n').slice(0, budgetChars);
}
