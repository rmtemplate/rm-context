---
description: Generate Project Roadmap (roadmap) with the project-manager agent, using the RM Context template, graph evidence and validation
argument-hint: "<title or scope>"
allowed-tools: Bash(node:*)
---

Produce a **Project Roadmap** for: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Model routing: right before delegating, run `rmc route --origin command --agent project-manager --category roadmap --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. Check for an existing document: `rmc doc list`. If a roadmap on the same scope exists, have the agent **revise** it (`rmc doc revise`) instead of creating a duplicate.
3. Delegate to the `project-manager` agent (`rmc:project-manager`) with the routed model. Tell it to:
   - create the document with `rmc doc new roadmap --title "<title>" --author project-manager` (plus `--nodes`/`--sources` for what it covers)
   - fill every section from evidence and upstream hand-offs
   - record matching graph nodes and links
   - pass `rmc doc validate`
   The roadmap is generated from plan.json milestones. If the plan has no milestones, the agent adds them, with TBD dates unless the user gave them, and runs `rmc pm validate` first.
4. Report to the user:
   - the document id and path, and its validation result
   - assumptions and open questions
   Offer export: `rmc doc export <id> --format html|pdf|docx`. The document stays Draft until the user explicitly approves it.

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
