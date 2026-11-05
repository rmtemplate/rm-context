---
description: Workflow A — new project discovery: BA → SA → Senior Engineer → DevOps → PM, producing connected requirements, system design, feasibility, infrastructure needs and a plan
argument-hint: "<business idea or project brief>"
allowed-tools: Bash(node:*)
---

Run **workflow A (new project discovery)** for: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Routing for every role:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing 2>&1`

Follow workflow A in the `team-workflows` skill, step by step. Run the steps **sequentially**: each role consumes the previous role's hand-off.
1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary. An empty repository is fine.
2. If the brief is thin, ask the user three to five essential questions (goal, users, scope, constraints, deadline) **before** delegating. Discovery built on guesses is worse than a short delay.
3. **business-analyst:** BRD and stakeholder analysis, with BR nodes. Show its open questions to the user. If any block scope, get answers before continuing.
4. **system-analyst:** SRS and system context (UML), plus an ERD if there is data, all linked to BR ids.
5. **senior-engineer:** a feasibility pass, i.e. a technical design outline plus ADRs for irreversible choices. Analysis only; no implementation.
6. **devops-engineer:** infrastructure needs (infrastructure design draft).
7. **project-manager:** plan.json with WBS, milestones and dependencies (dates TBD unless given), roadmap and RAID log. Then run `rmc pm gantt`.
8. Run `rmc validate`, `rmc rtm` and `rmc viewer`. Summarise:
   - documents per role
   - traceability coverage
   - top risks
   - every open question that needs the user

Delegation rules: follow the `team-workflows` skill. Pass the routed `model` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
