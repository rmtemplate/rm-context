---
description: Initialize RM Context — scan the repository into .rmcontext/ (graph, stack, index, viewer) and write architecture notes
argument-hint: "[--quick to skip the architecture write-up]"
allowed-tools: Bash(node:*)
---

Initialize RM Context project intelligence for this repository. Arguments: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Model routing:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing --agent architecture`

1. If `.rmcontext/manifest.json` already exists, run `rmc refresh` instead of `rmc init`. Never delete existing `.rmcontext/` content.
2. Otherwise run `rmc init`. It scans the repository (excluding secrets, dependencies and build output), builds the graph, writes `INDEX.md`, `context/tech-stack.md` and `state/scan.json`, and generates the viewer.
3. Show the scan summary, including excluded secret files (count only).
4. Unless `--quick` was passed, delegate to the `architecture` agent (`rm-context:architecture`) with the routed model. It writes `context/overview.md`, `architecture.md`, `conventions.md` and `business-rules.md` with `path:line` evidence, and records verified relationships. Tell it which `rmc` command line to use.
5. Finish with `rmc status`, then tell the user about `/rm-context:viewer`, `/rm-context:assess` and `/rm-context:find`. Suggest adding `.rmcontext/` to version control (its own `.gitignore` already excludes machine-local state).

Delegation rules: follow the `team-workflows` skill. Pass the routed `model` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
