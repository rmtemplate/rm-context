---
description: Project health report — RAG status from plan evidence, verified vs planned progress, traceability, code/test signals, documentation and knowledge freshness
argument-hint: "[save]"
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" pm health 2>&1`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

1. Present the health report. Explain the RAG verdict using the stated rules; don't soften or inflate it.
2. Add context the report cannot see, such as uncommitted changes (`git status --short | head`). Label it clearly as your observation.
3. If there is no plan, explain that progress cannot be assessed without one, and offer `/rm-context:pm` to build it from evidence.
4. If the user passed `save`, write the report to `.rmcontext/project-management/health-<YYYY-MM-DD>.md` with `rmc pm health --out …`.
