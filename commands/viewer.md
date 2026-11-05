---
description: Build and open the full RM Context project viewer (overview, graph views, Gantt, documents)
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

1. Run `rmc viewer --open`. Report its output exactly. Only say the browser opened if the CLI says so; otherwise give `.rmcontext/viewer/index.html` to open manually.
2. Mention the sections: Overview, Knowledge graph, Business, System architecture, Code dependencies, Infrastructure, Project management (Gantt and tasks), Documents. The viewer works offline and is a snapshot of the current knowledge.
