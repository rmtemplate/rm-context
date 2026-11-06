---
description: Generate any professional document from the RM Context template catalog (BA, SA, PM, engineering, DevOps) with the right owning agent
argument-hint: "<type> <title or scope>  (e.g. brd Customer onboarding)"
allowed-tools: Bash(node:*)
---

Produce a document: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Available templates (type → owning agent):
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" doc types 2>&1`

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. Pick the template type from the request.
   - If the request is ambiguous, ask the user, offering the two or three closest types.
   - If no type fits, say so. Do not force a template.
3. Get the owning agent from `rmc doc types --json`, then route it with `rmc route --agent <owner> --category <the type if `rmc route categories` lists it, else document> --session-model <your model id> [--signals …]`. Show the user its `Notice:` line exactly as printed and its routing block.
4. Check `rmc doc list` for an existing document of that type and scope. Prefer revising it over creating a duplicate.
5. Delegate to the owner agent. It runs `rmc doc new <type> --title "…" --author <owner>`, fills every section, records graph links and passes `rmc doc validate`.
6. Report: id, path, validation status, assumptions and open questions. Offer export (`rmc doc export <id> --format html|pdf|docx`). Approval only happens on explicit user instruction.

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
