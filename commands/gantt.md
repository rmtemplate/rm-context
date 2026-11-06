---
description: Generate the project Gantt chart (SVG + interactive HTML with dependencies, milestones, today line, planned vs actual, critical path)
argument-hint: "[planning context if no plan exists yet]"
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Model routing: right before delegating, run `rmc route --origin command --agent project-manager --category gantt --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. If `.rmcontext/project-management/plan.json` exists, run `rmc pm validate`.
   - If it is valid, run `rmc pm gantt` and `rmc pm progress`. No agent is needed.
   - If it has errors, delegate to `project-manager` to fix the plan data (not the chart), then run `rmc pm gantt`.
3. If no plan exists, delegate to the `project-manager` agent (`rmc:project-manager`) with the routed model. It builds plan.json from requirements, the graph, git evidence and the user's input in $ARGUMENTS. Dates are TBD unless known. Then run `rmc pm gantt`.
4. Report the paths (`project-management/gantt.svg` and `gantt.html`), the critical path (or why it could not be computed), and verified vs planned progress. List tasks with TBD dates. Offer to open `gantt.html`.

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
