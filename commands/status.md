---
description: Show RM Context knowledge status — freshness, graph coverage, documents, plan and validation
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Run these and summarise them for the user. Do not perform a scan.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" validate 2>&1 | head -40`

Highlight anything actionable: STALE context (suggest `/rm-context:refresh`), validation errors, documents needing review, missing context notes (suggest `/rm-context:init` or `/rm-context:assess`), and open questions recorded in hand-offs.
