// Token usage from Claude Code's own transcripts (JSONL). Deterministic, no model calls, never estimates from text length.
// Each assistant API response is written as one line per content block, every line repeating the same message.id and
// usage, so usage is counted once per message.id. Sidechain lines (subagents, older Claude Code) are skipped for the main
// session: subagent usage is read from its own transcript (subagents/agent-<id>.jsonl), so nothing is counted twice.
// Verified against Claude Code 2.1.319: the per-message sums equal the session's own "cost-state" modelUsage totals.
import fs from 'node:fs';

export const TOKEN_FIELDS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnsplit', 'cacheRead'];
// Haiku 5.5 bills a request whose prompt (input + cache reads + cache writes) exceeds this at higher rates.
export const LONG_PROMPT = 100000;
// API calls that issue the delegation itself: the Agent/Task tool call, or a Bash command running `rmc route`.
const ROUTE_CMD = /\brmc(?:\.mjs)?["']?\s+route\b/;
const isDelegationCall = (b) => b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task' || (b.name === 'Bash' && ROUTE_CMD.test(String(b.input?.command || ''))));

export const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return null; } };

function readFrom(file, from) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - from));
    fs.readSync(fd, buf, 0, buf.length, Math.min(from, size));
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function tokensOf(u) {
  const split = u.cache_creation && typeof u.cache_creation === 'object';
  const w5 = split ? u.cache_creation.ephemeral_5m_input_tokens || 0 : 0;
  const w1 = split ? u.cache_creation.ephemeral_1h_input_tokens || 0 : 0;
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite5m: w5, cacheWrite1h: w1,
    // Older transcripts have no 5m/1h split: kept apart, because the two write rates differ.
    cacheWriteUnsplit: Math.max(0, (u.cache_creation_input_tokens || 0) - w5 - w1), cacheRead: u.cache_read_input_tokens || 0 };
}

// Usage groups are keyed by everything that changes the price of a token: actual model, speed, inference geo,
// service tier and whether the prompt exceeded LONG_PROMPT. Facts only; prices are applied later (efficiency.mjs).
function addTo(groups, key, base, t) {
  const g = groups.get(key) || groups.set(key, { ...base, calls: 0 }).get(key);
  g.calls++;
  for (const k of TOKEN_FIELDS) if (t[k]) g[k] = (g[k] || 0) + t[k];
}

// → { calls, at, groups, overhead } or null when the transcript cannot be read. `from` = byte offset (one turn only).
export function readUsage(file, { from = 0, skipSidechain = false } = {}) {
  if (!file) return null;
  let text;
  try { text = readFrom(file, from); } catch { return null; }
  const msgs = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; } // partial line
    const m = d.message;
    if (d.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>' || (skipSidechain && d.isSidechain)) continue;
    const id = m.id || d.requestId || d.uuid;
    const prev = msgs.get(id);
    msgs.set(id, { at: prev?.at || d.timestamp, model: m.model, usage: m.usage, delegation: prev?.delegation || (m.content || []).some(isDelegationCall) });
  }
  const groups = new Map(), overhead = new Map();
  let at = null;
  for (const x of msgs.values()) {
    const t = tokensOf(x.usage);
    const speed = x.usage.speed && x.usage.speed !== 'standard' ? x.usage.speed : undefined;
    const geo = x.usage.inference_geo && x.usage.inference_geo !== 'global' ? x.usage.inference_geo : undefined;
    const tier = x.usage.service_tier && x.usage.service_tier !== 'standard' ? x.usage.service_tier : undefined;
    const long = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteUnsplit > LONG_PROMPT || undefined;
    const base = { model: x.model, speed, geo, tier, long };
    const key = JSON.stringify(base);
    addTo(groups, key, base, t);
    if (x.delegation) addTo(overhead, key, base, t);
    if (x.at && (!at || x.at < at)) at = x.at;
  }
  const strip = (m) => [...m.values()].map((g) => JSON.parse(JSON.stringify(g))); // drop undefined keys
  return { calls: msgs.size, at, groups: strip(groups), overhead: strip(overhead) };
}

export const totalTokens = (groups = []) => groups.reduce((a, g) => a + TOKEN_FIELDS.reduce((s, k) => s + (g[k] || 0), 0), 0);
export const sumField = (groups = [], k) => groups.reduce((a, g) => a + (g[k] || 0), 0);
