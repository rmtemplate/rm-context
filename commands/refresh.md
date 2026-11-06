---
description: Incrementally refresh RM Context after code changes (only changed files are re-read) and reconcile stale knowledge
argument-hint: "[--full] [--scan-only]"
allowed-tools: Bash(node:*)
---

Refresh RM Context. Arguments: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Model routing: right before delegating, run `rmc route --agent documentation --category doc-update --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

1. Run `rmc refresh` (add `--full` only if the user passed it). Show the summary: files added, changed and deleted; stale agent items; orphaned edges; documents needing review.
2. If nothing changed, say so and stop.
3. Unless `--scan-only` was passed, and if items were marked stale or documents need review: delegate to the `documentation` agent (`rmc:documentation`) with the routed model. Give it the list of changed files from `.rmcontext/state/scan.json`. It re-verifies stale items and revises affected documents.
4. Run `rmc validate` and report the outcome.

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
