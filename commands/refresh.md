---
description: Incrementally refresh RM Context after code changes (only changed files are re-read) and reconcile stale knowledge
argument-hint: "[--full] [--scan-only]"
allowed-tools: Bash(node:*)
---

Refresh RM Context. Arguments: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Model routing:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing --agent documentation`

1. Run `rmc refresh` (add `--full` only if the user passed it). Show the summary: files added, changed and deleted; stale agent items; orphaned edges; documents needing review.
2. If nothing changed, say so and stop.
3. Unless `--scan-only` was passed, and if items were marked stale or documents need review: delegate to the `documentation` agent (`rm-context:documentation`) with the routed model. Give it the list of changed files from `.rmcontext/state/scan.json`. It re-verifies stale items and revises affected documents.
4. Run `rmc validate` and report the outcome.

Delegation rules: follow the `team-workflows` skill. Pass the routed `model` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
