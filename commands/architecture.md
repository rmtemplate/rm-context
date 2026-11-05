---
description: Analyze the system architecture from evidence — layers, flows, integrations, data, conventions — and update context/architecture.md
argument-hint: "[focus area or question]"
allowed-tools: Bash(node:*)
---

Analyse the architecture. Focus: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Model routing:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing --agent architecture`

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary. If the status says STALE, run `rmc refresh` first.
2. Delegate to the `architecture` agent (`rm-context:architecture`) with the routed model. It updates `context/architecture.md`, and `overview.md`/`conventions.md` if missing, with a mermaid diagram and `path:line` evidence. It records verified relationships and lists architectural risks (as `risk` nodes) and candidate ADRs.
3. Summarise the architecture for the user, with the diagram and the main risks. Suggest `/rm-context:adr` for decisions that need recording.

Delegation rules: follow the `team-workflows` skill. Pass the routed `model` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
