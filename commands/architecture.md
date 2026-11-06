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

Model routing: right before delegating, run `rmc route --agent architecture --category architecture (or explain/search for a simple question) --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary. If the status says STALE, run `rmc refresh` first.
2. Delegate to the `architecture` agent (`rmc:architecture`) with the routed model. It updates `context/architecture.md`, and `overview.md`/`conventions.md` if missing, with a mermaid diagram and `path:line` evidence. It records verified relationships and lists architectural risks (as `risk` nodes) and candidate ADRs.
3. Summarise the architecture for the user, with the diagram and the main risks. Suggest `/rmc:adr` for decisions that need recording.

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
