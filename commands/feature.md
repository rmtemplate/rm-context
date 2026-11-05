---
description: Workflow B — feature development: BA → SA → Engineer plan → PM tasks → implementation → QA → docs → graph/RTM update
argument-hint: "<feature description>"
allowed-tools: Bash(node:*)
---

Run **workflow B (feature development)** for: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Routing:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing 2>&1`

Follow workflow B in the `team-workflows` skill.
1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. **business-analyst:** user stories with acceptance criteria and BR/US nodes. Confirm the acceptance criteria with the user before design.
3. **system-analyst:** functional flow, plus API and data deltas (sequence diagram, FSD/SRS delta), linked to the story ids.
4. **senior-engineer:** an implementation plan grounded in `rmc impact`.
5. **project-manager:** tasks and dependencies in plan.json, linked to the story and code ids. Then `rmc pm validate`.
6. **Checkpoint:** show the user the plan and ask for go-ahead before any code changes.
7. **senior-engineer:** implement, run the tests, run `rmc refresh`, add `implements`/`tested_by` edges and task evidence.
8. **qa:** independent verification against the acceptance criteria. Loop back to step 7 for failures.
9. **documentation:** revise the affected documents.
10. Run `rmc validate`, `rmc rtm` and `rmc viewer`. Report what changed, test results, traceability, and anything still open.

Delegation rules: follow the `team-workflows` skill. Pass the routed `model` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
