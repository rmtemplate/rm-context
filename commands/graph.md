---
description: Build and open the interactive knowledge graph (business, system, code, infrastructure and delivery nodes)
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

1. Run `rmc viewer --open --view graph`. This regenerates `.rmcontext/viewer/index.html` from the current graph, documents and plan, then opens `.rmcontext/viewer/graph.html`, which jumps to the graph view.
2. Report the CLI's output exactly. Only say the browser opened if the CLI says so; otherwise give the path to open manually.
3. Briefly explain the controls:
   - views: Business, System, Code, Infrastructure, Project
   - legend chips filter node types; confidence chips filter verified, inferred and manual
   - clicking a node shows its evidence and relationships; "Show change impact" highlights the blast radius
   - `/` searches
4. Note that it is a snapshot: re-run after `/rmc:refresh`.
