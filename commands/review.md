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

Model routing:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing --agent senior-engineer`

1. If the status above says RM Context is not initialized, run `rmc init` first and show its summary.
2. Determine the scope:
   - with no argument, review uncommitted changes (`git diff`, `git status`); if there are none, ask what to review
   - for a path or module, use it, plus `rmc impact "<path>"` for dependents
3. Delegate to the `senior-engineer` agent (`rm-context:senior-engineer`) with the routed model. It reviews the scope against the requirements (`rmc rtm`) and the review checklist, runs the project's checks, and writes a `code-review` document (`rmc doc new code-review …`). It records tech debt as `issue` nodes.
4. Report findings by severity with `file:line`, the checks run and their results, and the verdict. Ask whether the user wants fixes implemented (`/rm-context:engineering`).

Delegation rules: follow the `team-workflows` skill. Pass the routed `model` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
