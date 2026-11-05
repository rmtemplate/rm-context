---
description: Build and open the full RM Context project viewer (overview, file explorer, code/API/database explorers, graph views, documents, Gantt)
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

1. Run `rmc viewer --open`. Report its output exactly. Only say the browser opened if the CLI says so; otherwise give `.rmcontext/viewer/index.html` to open manually.
2. Mention the sections briefly: Overview, File Explorer, code/API/database/infrastructure explorers, Graph (Project, Module, File dependency, Function call, API, Database, Infrastructure, Traceability), Technical Documents (rendered, with Mermaid diagrams), Project Management (Gantt), Agent Handoffs, Notes, Context Status. The viewer works offline and is a snapshot: run this command again after changes to see them.
