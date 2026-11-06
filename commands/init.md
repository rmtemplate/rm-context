---
description: Initialize RM Context — scan the repository into .rmcontext/ (graph, stack, index, viewer) and write architecture notes
argument-hint: "[--quick to skip the architecture write-up]"
allowed-tools: Bash(node:*)
---

Initialize RM Context project intelligence for this repository. Arguments: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Model routing: right before delegating, run `rmc route --agent architecture --category repo-analysis --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

1. If `.rmcontext/manifest.json` already exists, run `rmc refresh` instead of `rmc init`. Never delete existing `.rmcontext/` content.
2. Otherwise run `rmc init`. It scans the repository (excluding secrets, dependencies and build output), builds the graph, writes `INDEX.md`, `context/tech-stack.md` and `state/scan.json`, and generates the viewer.
3. Show the scan summary, including excluded secret files (count only).
4. Unless `--quick` was passed, delegate to the `architecture` agent (`rmc:architecture`) with the routed model. It writes `context/overview.md`, `architecture.md`, `conventions.md` and `business-rules.md` with `path:line` evidence, and records verified relationships. Tell it which `rmc` command line to use.
5. Finish with `rmc status`, then tell the user about `/rmc:viewer`, `/rmc:assess` and `/rmc:find`. Suggest adding `.rmcontext/` to version control (its own `.gitignore` already excludes machine-local state).

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
