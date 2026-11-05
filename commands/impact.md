---
description: Change impact analysis — affected requirements, modules, APIs, tables, files, infrastructure, tasks and documents for a change
argument-hint: "<requirement id, node id, file path or description>  |  --changed"
allowed-tools: Bash(node:*)
---

Analyse the impact of: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Follow workflow D in the `team-workflows` skill. Do this yourself; delegation is only needed for deep verification.
1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary. If the request is about uncommitted work, run `rmc refresh` first, then `rmc impact --changed`.
2. Resolve the change origin:
   - use an id or path directly
   - for a description, run `rmc find …` and confirm the starting node(s) with the user if it's ambiguous
3. Run `rmc impact "<origin>" --out .rmcontext/project-management/impact-<slug>.md`, then read it.
4. Verify the important `inferred` hops by opening the cited source. Remove false positives from your summary and say what you removed.
5. Add a narrative section to the report file:
   - what changes, and the risk level
   - required actions per role: BA, SA, Engineering, DevOps, PM
   - tests to run, and documents to revise
   - open questions
6. If the change is a requirement change the user accepts, record it: update the graph (`rmc graph upsert`), list affected documents for revision, and ask whether the PM should update plan.json.
7. Summarise for the user with the report path.
