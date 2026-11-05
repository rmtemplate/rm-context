---
description: Senior Engineer — technical design, ADRs, implementation plans, implementation, code review, refactoring, tech debt, test strategy, engineering standards
argument-hint: "<engineering task>"
allowed-tools: Bash(node:*)
---

Run the **Senior Engineer** workflow for: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Model routing:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing --agent senior-engineer`

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. If no request was given, ask the user what they want the Senior Engineer to work on (one question, with 3–4 concrete options drawn from the status), then stop.
3. Delegate to the `senior-engineer` agent (`rm-context:senior-engineer`) using the routed model.
4. When it returns, give the user:
   - deliverables with ids and paths, and their validation status
   - graph changes
   - assumptions and **open questions that need the user**
   - the recommended next role
   Ask blocking questions directly. Never mark documents Approved unless the user explicitly approves.
5. Run `rmc viewer` so the snapshot reflects the new knowledge.

Delegation rules: follow the `team-workflows` skill. Pass the routed `model` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
