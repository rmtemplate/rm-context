---
description: Requirement Traceability Matrix — requirements → use cases → system elements → code → tests → tasks, derived from the graph
argument-hint: "[save]  — 'save' also creates/updates an RTM document with gap analysis"
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Model routing: right before delegating, run `rmc route --agent business-analyst --category rtm --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

Current matrix:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" rtm 2>&1`

1. Present the matrix and coverage counts. Call out requirements that are *Not traced* or *Partial*.
2. If there are no requirements, explain that the BA records them (`/rmc:ba`). For an existing codebase, `/rmc:assess` infers them from evidence.
3. If the user passed `save` ($ARGUMENTS), delegate to `business-analyst` with the routed model. It creates or regenerates the RTM document (`rmc doc new rtm …` or `rmc doc regenerate <id>`) and fills the *Gaps* section with actions.

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
