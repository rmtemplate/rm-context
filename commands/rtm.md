---
description: Requirement Traceability Matrix — requirements → use cases → system elements → code → tests → tasks, derived from the graph
argument-hint: "[save]  — 'save' also creates/updates an RTM document with gap analysis"
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Model routing: right before delegating, run `rmc route --agent business-analyst --category rtm [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Pass its `model` to the Agent tool and show the user its routing block.

Current matrix:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" rtm 2>&1`

1. Present the matrix and coverage counts. Call out requirements that are *Not traced* or *Partial*.
2. If there are no requirements, explain that the BA records them (`/rm-context:ba`). For an existing codebase, `/rm-context:assess` infers them from evidence.
3. If the user passed `save` ($ARGUMENTS), delegate to `business-analyst` with the routed model. It creates or regenerates the RTM document (`rmc doc new rtm …` or `rmc doc regenerate <id>`) and fills the *Gaps* section with actions.

Delegation rules: follow the `team-workflows` skill. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
