---
description: System Analyst — translate requirements into system specs; produce SRS, system design, UML, ERD, API spec, data dictionary, integration spec
argument-hint: "<requirement ids, feature or deliverable>"
allowed-tools: Bash(node:*)
---

Run the **System Analyst** workflow for: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Model routing: right before delegating, run `rmc route --agent system-analyst --category <srs, erd, uml or system-analysis> --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. If no request was given, ask the user what they want the System Analyst to work on (one question, with 3–4 concrete options drawn from the status), then stop.
3. Delegate to the `system-analyst` agent (`rmc:system-analyst`) using the routed model.
4. When it returns, give the user:
   - deliverables with ids and paths, and their validation status
   - graph changes
   - assumptions and **open questions that need the user**
   - the recommended next role
   Ask blocking questions directly. Never mark documents Approved unless the user explicitly approves.
5. Run `rmc viewer` so the snapshot reflects the new knowledge.

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
