---
description: Generate System Requirement Specification (srs) with the system-analyst agent, using the RM Context template, graph evidence and validation
argument-hint: "<title or scope>"
allowed-tools: Bash(node:*)
---

Produce a **System Requirement Specification** for: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Model routing:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing --agent system-analyst`

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. Check for an existing document: `rmc doc list`. If a srs on the same scope exists, have the agent **revise** it (`rmc doc revise`) instead of creating a duplicate.
3. Delegate to the `system-analyst` agent (`rm-context:system-analyst`) with the routed model. Tell it to:
   - create the document with `rmc doc new srs --title "<title>" --author system-analyst` (plus `--nodes`/`--sources` for what it covers)
   - fill every section from evidence and upstream hand-offs
   - record matching graph nodes and links
   - pass `rmc doc validate`
   If no BA requirements exist yet (`rmc find business_requirement` is empty), tell the user and suggest `/rm-context:ba` first. Continue only if they want an SRS derived from the existing code, with every SR marked inferred.
4. Report to the user:
   - the document id and path, and its validation result
   - assumptions and open questions
   Offer export: `rmc doc export <id> --format html|pdf|docx`. The document stays Draft until the user explicitly approves it.

Delegation rules: follow the `team-workflows` skill. Pass the routed `model` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
