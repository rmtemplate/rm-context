---
description: Initialize RM Context — scan the repository into .rmcontext/ (graph, stack, index, viewer) and write architecture notes
argument-hint: "[--quick to skip the architecture write-up]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Initialize RM Context project intelligence for this repository. Arguments: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Model routing: right before delegating, run `rmc route --origin command --agent architecture --category repo-analysis --session-model <your model id> [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Show the user its `Notice:` line exactly as printed and its routing block, then call the Agent tool with its `model`.

1. **Check first, change nothing:** run `rmc claude-md --check`, and check whether `.rmcontext/manifest.json` exists.
2. **CLAUDE.md strategy.** Ask only if the check says `unmanaged … choose combine (recommended) or replace`. That means an existing CLAUDE.md with no RM Context section and no remembered choice. Ask with the AskUserQuestion tool: "CLAUDE.md sudah ditemukan. Bagaimana ingin mengelolanya?"
   - **Combine (Recommended):** keep everything in the existing CLAUDE.md and add the RM Context managed section. Later runs update only that section. → `--claude-md combine`
   - **Replace Entire File:** replace the whole file with the generated RM Context version. If chosen, warn that the existing instructions (the line count from the check) will be replaced, and that a backup goes to `.rmcontext/backups/` first. Then ask for an explicit confirmation as a second question.
     - Only after an explicit yes: `--claude-md replace --confirm`.
     - If the user cancels or declines: `--claude-md skip`, and CLAUDE.md is not touched.

   Do not ask when CLAUDE.md is missing (it is created), already has the managed section, the choice is remembered, or the check says `disabled`. Never pass `--confirm` without the user's explicit yes. Without a way to ask, the default is combine.
3. **New project** (no manifest): run `rmc init [--claude-md <choice>] [--confirm]`. It:
   - scans the repository, excluding secrets, dependencies and build output
   - builds the graph, writes `INDEX.md`, `context/tech-stack.md` and `state/scan.json`, and generates the viewer
   - writes the CLAUDE.md section before the scan

   Show the scan summary, including excluded secret files (count only), and the `CLAUDE.md:` line.
4. **Already initialized** (manifest exists): run the same `rmc init [--claude-md <choice>] [--confirm]`. On an initialized project it is a **policy update**, not a re-initialization:
   - no scan, and no change to the graph, knowledge or telemetry
   - it updates the CLAUDE.md managed section to the current policy and indexes only that file
   - it reports the schema, model overrides it kept, and stale files

   Show its report. Never delete or recreate `.rmcontext/`. Run `rmc refresh` (incremental) only if the user wants the stale files re-read. Run a full rescan (`rmc init --full`) only on request. Skip steps 5–6 unless the user asks for a new architecture write-up.
5. New project, unless `--quick` was passed: delegate to the `architecture` agent (`rmc:architecture`) with the routed model. It writes `context/overview.md`, `architecture.md`, `conventions.md` and `business-rules.md` with `path:line` evidence, and records verified relationships. Tell it which `rmc` command line to use.
6. Finish with `rmc status`, then tell the user about `/rmc:viewer`, `/rmc:assess`, `/rmc:find` and `/rmc:run`. Suggest adding `.rmcontext/` to version control (its own `.gitignore` already excludes machine-local state).

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel unless the user explicitly asks). Afterwards, report the model that actually ran from the `[RM CONTEXT] Delegation check` note; never present the requested model as the one that ran. Pass the `model` from `rmc route` when you delegate. If it fails because the model is unavailable, retry once with your own model alias. If the agent shows the task is harder than classified, escalate once with `rmc route --escalate <R-id> --reason "<new evidence>" --handoff <H-id>` instead of restarting the work. In the delegation prompt, include the user's request verbatim, the exact `rmc` command line above, relevant ids and paths from `rmc find`, and related hand-off ids. Do not spawn other roles unless this command says to.
