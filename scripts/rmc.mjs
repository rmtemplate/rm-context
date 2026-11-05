#!/usr/bin/env node
// RM Context CLI — deterministic core used by commands, skills and agents.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ctx, parseArgs, readJson, writeJson, writeFile, requireInit, RmcError, PLUGIN_ROOT, now, fail } from './lib/util.mjs';

const HELP = `rmc — RM Context project intelligence CLI

Core
  init [--full]                    Create .rmcontext/ and run the first scan
  refresh [--full]                 Incremental scan (only changed files are re-read)
  status [--json]                  Coverage, freshness, documents, plan, validation summary
  validate                         Validate manifest, config, graph, documents and plan
  find <terms…> [--limit N]        Search graph nodes, documents and context notes
  impact <id|file|terms> [--changed] [--depth N] [--out file.md]
  graph stats | node <id> | upsert <file.json> [--origin manual] | validate
  rtm [--out file.md]              Requirement Traceability Matrix from the graph
  link <path>                      Register another RM Context project as a reference
  viewer [--open] [--view graph]   Build .rmcontext/viewer/index.html (graph.html opens the graph view)
  routing [--json] [--agent name]  Agent default models, tiers and overrides
  route --category <c> [--agent a] [--signals s,s] [--model m] [--workflow w] [--handoff H-id] [--json] [--no-record]
                                   Adaptive model choice for one delegation (see: route categories)
  route --escalate <R-id> --reason "…" [--handoff H-id]   Next tier for the same agent, reusing its hand-off
  route categories | stats [--json]
  handoff add <file.json> | list [--to agent]
  context <prompt…> [--max-tokens N] [--json]   Relevant knowledge for a task, within a token budget
  context --session | status [--json]           Session summary · automatic-context diagnostics

Documents
  doc types [--json]               List templates (with owning agent)
  doc new <type> --title "…" --author <agent> [--nodes id,id] [--sources a,b]
  doc validate [path|id]           Structure, metadata, placeholders, secrets
  doc revise <path|id> --note "…" [--author agent]
  doc regenerate <path|id>         Refresh the graph/plan-generated block (new version)
  doc status <path|id> <Draft|Under Review|Approved|Superseded|Archived> [--approved-by name]
  doc export <path|id> --format html|pdf|docx
  doc list

Project management
  pm init                          Create an empty plan.json
  pm validate                      Schema, dates, dependencies, cycles, evidence
  pm progress [--json]             Planned vs verified progress
  pm gantt [--out dir]             Gantt as SVG + interactive HTML
  pm mermaid                       Mermaid gantt block for documents
  pm health [--out file.md]        Project health report from evidence

Options: --root <dir> (default: current directory)`;

async function main(argv) {
  const args = parseArgs(argv);
  const [cmd, sub, ...rest] = args._;
  const root = path.resolve(args.root || process.cwd());
  const c = ctx(root);
  const out = (x) => process.stdout.write(typeof x === 'string' ? x + (x.endsWith('\n') ? '' : '\n') : JSON.stringify(x, null, 2) + '\n');
  rememberCli(c);

  switch (cmd) {
    case undefined: case 'help': case '--help': return out(HELP);

    case 'init': {
      const { initProject } = await import('./lib/project.mjs');
      const created = initProject(c);
      const { scan } = await import('./lib/scan.mjs');
      const r = scan(root, { full: true });
      const { buildViewer } = await import('./lib/viewer.mjs');
      buildViewer(c);
      return out(`Initialized ${path.relative(root, c.base) || '.rmcontext'} (${created.length} items created).\n${scanSummary(r)}\nViewer: .rmcontext/viewer/index.html`);
    }
    case 'refresh': case 'scan': {
      requireInit(c);
      const { scan } = await import('./lib/scan.mjs');
      const r = scan(root, { full: !!args.full });
      const { flagStaleDocuments } = await import('./lib/docs.mjs');
      const flagged = flagStaleDocuments(c, r.changedFiles);
      const { buildViewer } = await import('./lib/viewer.mjs');
      buildViewer(c);
      return out(scanSummary(r) + (flagged.length ? `\nDocuments needing review (sources changed): ${flagged.join(', ')}` : ''));
    }
    case 'status': {
      requireInit(c);
      const { status, formatStatus } = await import('./lib/project.mjs');
      const s = status(c);
      return out(args.json ? s : formatStatus(s));
    }
    case 'validate': {
      requireInit(c);
      const { validateAll } = await import('./lib/project.mjs');
      const r = validateAll(c);
      for (const [area, { errors, warnings }] of Object.entries(r)) {
        out(`${errors.length ? '✘' : '✔'} ${area}: ${errors.length} error(s), ${warnings.length} warning(s)`);
        for (const e of errors) out(`    error: ${e}`);
        for (const w of warnings) out(`    warn:  ${w}`);
      }
      if (Object.values(r).some((x) => x.errors.length)) process.exitCode = 1;
      return;
    }
    case 'find': {
      requireInit(c);
      const { find } = await import('./lib/project.mjs');
      return out(find(c, [sub, ...rest].filter(Boolean).join(' '), Number(args.limit) || 12));
    }
    case 'impact': {
      requireInit(c);
      const { impactReport } = await import('./lib/project.mjs');
      const md = impactReport(c, [sub, ...rest].filter(Boolean).join(' '), { changed: !!args.changed, depth: Number(args.depth) || 4 });
      if (args.out) { writeFile(path.resolve(root, args.out), md); return out(`Wrote ${args.out}`); }
      return out(md);
    }
    case 'graph': {
      requireInit(c);
      const g = await import('./lib/graph.mjs');
      const graph = g.loadGraph(c);
      if (sub === 'stats' || !sub) return out(g.stats(graph));
      if (sub === 'validate') { const r = g.validateGraph(graph); out(r); if (r.errors.length) process.exitCode = 1; return; }
      if (sub === 'node') {
        const ix = g.index(graph);
        const n = ix.byId.get(rest[0]) || fail(`No node ${rest[0]}`);
        return out({ node: n, outgoing: ix.out(n.id).map((e) => `${e.type} → ${e.target} [${e.confidence}]`), incoming: ix.inc(n.id).map((e) => `${e.source} → ${e.type} [${e.confidence}]`) });
      }
      if (sub === 'upsert') {
        const payload = readJson(path.resolve(root, rest[0] || fail('Usage: rmc graph upsert <file.json>')));
        const r = g.upsert(graph, payload, { origin: args.origin || 'agent' });
        g.saveGraph(c, graph);
        return out(`Graph updated: ${r.added} added, ${r.updated} updated, ${r.removed} removed.`);
      }
      return fail(`Unknown graph subcommand: ${sub}`);
    }
    case 'rtm': {
      requireInit(c);
      const { rtmMarkdown } = await import('./lib/project.mjs');
      const md = rtmMarkdown(c);
      if (args.out) { writeFile(path.resolve(root, args.out), md); return out(`Wrote ${args.out}`); }
      return out(md);
    }
    case 'link': {
      requireInit(c);
      const { link } = await import('./lib/project.mjs');
      return out(link(c, sub || fail('Usage: rmc link <path>')));
    }
    case 'viewer': {
      requireInit(c);
      const { buildViewer } = await import('./lib/viewer.mjs');
      buildViewer(c);
      const target = args.view === 'graph' ? path.join(path.dirname(c.viewer), 'graph.html') : c.viewer;
      const opened = args.open ? openInBrowser(target) : null;
      return out(`Viewer: ${path.relative(root, c.viewer)}${opened === null ? '' : opened ? ' (opened in browser)' : ' (could not open a browser; open the file manually)'}`);
    }
    case 'routing': {
      const { resolveRouting, formatRouting } = await import('./lib/project.mjs');
      const r = resolveRouting(c);
      if (args.agent) {
        const row = r.rows.find((x) => x.agent === args.agent) || fail(`Unknown agent ${args.agent}. Agents: ${r.rows.map((x) => x.agent).join(', ')}`);
        return out(`${row.agent}: model=${row.model} (${row.source})${row.model === 'inherit' ? ' → pass your own model alias' : ''}; fallback: retry with your own model alias`);
      }
      if (args.json) return out(r);
      const { loadModelConfig } = await import('./lib/routing.mjs');
      const m = loadModelConfig(c);
      return out(formatRouting(r) + `\n\nAdaptive routing: ${m.routing.enabled ? 'on' : 'off'} · tiers low=${m.tiers.low} medium=${m.tiers.medium} high=${m.tiers.high} · fallback tier ${m.routing.fallbackTier} · escalation ${m.routing.allowEscalation ? `max ${m.routing.maxEscalations}` : 'off'}\nThe agent defaults above apply when a delegation has no task category; with a category, use: rmc route --category <c>`);
    }
    case 'route': {
      const R = await import('./lib/routing.mjs');
      if (sub === 'categories') return out(R.formatCategories(c));
      if (sub === 'stats') { const st = R.routeStats(c); return out(args.json ? st : R.formatStats(st)); }
      if (sub) fail(`Unknown: rmc route ${sub}. Use: rmc route --category <c> | categories | stats`);
      const r = R.route(c, { agent: args.agent, category: args.category, signals: args.signals, model: args.model,
        workflow: args.workflow, handoff: args.handoff, contextReuse: Boolean(args['context-reuse']),
        escalate: args.escalate, reason: typeof args.reason === 'string' ? args.reason : undefined, record: !args['no-record'] });
      return out(args.json ? r : R.formatRoute(r));
    }
    case 'context': {
      requireInit(c);
      const X = await import('./lib/context.mjs');
      if (sub === 'status') { const st = X.contextStatus(c); return out(args.json ? st : X.formatContextStatus(st)); }
      if (args.session) return out(X.sessionSummary(c, path.join(PLUGIN_ROOT, 'scripts', 'rmc.mjs')) || '(session context disabled)');
      const prompt = [sub, ...rest].filter(Boolean).join(' ') || fail('Usage: rmc context <prompt…> | --session | status');
      const r = X.retrieve(c, prompt, args['max-tokens'] ? { maxContextTokens: Number(args['max-tokens']) } : {});
      return out(args.json ? r : r.text || `No sufficiently relevant knowledge (searched ${r.terms} term(s)).`);
    }
    case 'handoff': {
      requireInit(c);
      const { addHandoff, listHandoffs } = await import('./lib/project.mjs');
      if (sub === 'add') return out(addHandoff(c, readJson(path.resolve(root, rest[0] || fail('Usage: rmc handoff add <file.json>')))));
      return out(listHandoffs(c, args.to));
    }
    case 'doc': {
      requireInit(c);
      const d = await import('./lib/docs.mjs');
      return out(await d.cli(c, sub, rest, args));
    }
    case 'pm': {
      requireInit(c);
      const p = await import('./lib/pm.mjs');
      const r = await p.cli(c, sub, rest, args);
      return out(r);
    }
    default:
      fail(`Unknown command "${cmd}". Run: rmc help`);
  }
}

function scanSummary(r) {
  const f = r.files, x = r.excluded;
  return [`Scan (${r.mode}) in ${r.durationMs} ms: ${f.indexed} files indexed — ${f.added} added, ${f.changed} changed, ${f.deleted} deleted.`,
    `Excluded: ${x.secret} secret/credential files, ${x.ignored} ignored, ${x.binary + x.binaryContent} binary, ${x.large} oversized.`,
    r.unchanged ? 'No changes since the last scan; graph untouched.' : `Graph: ${r.graph.nodes} nodes, ${r.graph.edges} edges.${r.staleAgentItems ? ` ${r.staleAgentItems} agent-authored item(s) marked stale.` : ''}${r.orphanedAgentEdges.length ? ` ${r.orphanedAgentEdges.length} orphaned agent edge(s) removed.` : ''}`,
    ...(r.migration?.length ? [`Migrated ${r.migration.length} legacy graph item(s).`] : [])].join('\n');
}

// Agents locate the CLI from this local (uncommitted) file when no path was given to them.
function rememberCli(c) {
  if (!fs.existsSync(c.base)) return;
  const local = readJson(c.local, {});
  const cli = path.join(PLUGIN_ROOT, 'scripts', 'rmc.mjs');
  if (local.cli !== cli) writeJson(c.local, { ...local, cli, updated: now() });
}

function openInBrowser(file) {
  const tries = process.platform === 'win32' ? [['cmd', ['/c', 'start', '', file]]]
    : process.platform === 'darwin' ? [['open', [file]]]
    : [['xdg-open', [file]], ['wslview', [file]]];
  // WSL without a Linux browser: hand the Windows path to Explorer.
  const wsl = process.platform === 'linux' && spawnSync('wslpath', ['-w', file], { encoding: 'utf8' });
  if (wsl && wsl.status === 0) tries.push(['explorer.exe', [wsl.stdout.trim()]]);
  for (const [bin, argv] of tries) {
    const r = spawnSync(bin, argv, { stdio: 'ignore' });
    // explorer.exe returns 1 even on success.
    if (r.status === 0 || (bin === 'explorer.exe' && r.status === 1 && !r.error)) return true;
  }
  return false;
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof RmcError) { process.stderr.write(`rmc: ${e.message}\n`); process.exitCode = 2; }
  else { process.stderr.write(`rmc: unexpected error: ${e.stack}\n`); process.exitCode = 3; }
});
