---
description: Workflow C — existing project assessment: scan → BA (business functionality from evidence) → SA (behaviour, data, integrations) → Engineering review → DevOps assessment → PM progress from evidence
argument-hint: "[focus or depth, e.g. 'quick' or 'billing module']"
allowed-tools: Bash(node:*)
---

Run **workflow C (existing project assessment)**. Focus: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Model routing: before each step, run `rmc route --agent <role> --category <category> --workflow <slug> [--signals …] [--handoff <H-id of the previous step>]` and pass its `model`. Each step is routed on its own, so the same role can get a different model for a different step. See *Model routing* in the `team-workflows` skill.

Follow workflow C in the `team-workflows` skill.
1. Run `rmc init`, or `rmc refresh` if already initialized. If `context/architecture.md` is missing, delegate to **architecture** to write the context notes.
2. **business-analyst:** infer business functionality from evidence. Every BR is `inferred` with code evidence, or an Open Question. Produce a business rules catalog and a BRD draft clearly labelled "reverse-engineered".
3. **system-analyst:** system behaviour, integrations and the data model. Regenerate the ERD, API spec and data dictionary, and add integration notes.
4. **senior-engineer:** architecture and code-quality review (code review and tech-debt register).
5. **devops-engineer:** deployment and infrastructure assessment (infrastructure design and security checklist).
6. **project-manager:** actual progress from repository evidence. If a plan exists, verify its task evidence. Otherwise, only describe what is demonstrably implemented. Then run `rmc pm health`.
7. If the user asked for `quick`, run steps 1, 4 and 5 only and say what was skipped.
8. Run `rmc validate` and `rmc viewer`. Summarise findings per role and the top risks, separating verified facts from inferences.

Steps 4 and 5 are independent and may run in parallel. Everything else is sequential.

Delegation rules: follow the `team-workflows` skill. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
