---
description: Engineering review — Senior Engineer code/architecture review of a change set or area, with severity-ranked findings and checks run
argument-hint: "[path, module, branch or 'diff' (default: uncommitted changes)]"
allowed-tools: Bash(node:*)
---

Run an engineering review of: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -12`

Model routing: right before delegating, run `rmc route --agent senior-engineer --category code-review --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. Determine the scope:
   - with no argument, review uncommitted changes (`git diff`, `git status`); if there are none, ask what to review
   - for a path or module, use it, plus `rmc impact "<path>"` for dependents
3. Delegate to the `senior-engineer` agent (`rmc:senior-engineer`) with the routed model. It reviews the scope against the requirements (`rmc rtm`) and the review checklist, runs the project's checks, and writes a `code-review` document (`rmc doc new code-review …`). It records tech debt as `issue` nodes.
4. Report findings by severity with `file:line`, the checks run and their results, and the verdict. Ask whether the user wants fixes implemented (`/rmc:engineering`).

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
