---
description: Run one task end to end as an RM Context workflow — plan the smallest sufficient sequence of specialist agents, run each stage in turn with its routed model and project knowledge, verify, write knowledge back, and return one result
argument-hint: "<task>"
allowed-tools: Bash(node:*)
---

Run this task as an RM Context workflow: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Project status:
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" status 2>&1 | head -6`

You are the orchestrator. You run every stage yourself with the Agent tool. RM Context's hooks cannot start agents; they check each call and give each agent its knowledge. The user asked for the whole workflow, so do not ask them to run intermediate `/rmc:*` commands. Show one short progress line per step ("Planning workflow…", "Running Senior Engineer (Sonnet)…", "Integrating results…").

1. If the status above says RM Context is not initialized, run `rmc init` first.
2. **Plan.** Pass the task on stdin exactly as given:
   `rmc workflow plan --session-model <your model id> [--model <model the user named, if any>] [--criteria "<criterion>; <criterion>"] <<'RMC_TASK'` … `RMC_TASK`
   Add `--criteria` only for acceptance criteria the user stated or that follow directly from the task. If the plan says *main session only*, answer the task yourself and stop: no agent runs.
3. **For each stage, in order:**
   1. `rmc workflow start <W-id>`. Show its progress line and the notice line it prints.
   2. Call the Agent tool with exactly the `subagent_type` and `model` it prints, in the foreground, and wait for the result. The delegation message is the user's task verbatim plus the stage line it prints. Never do a stage's work yourself, and never start the next stage before this one's result is in.
   3. Check the result against the stage goal. Then record it:
      `rmc workflow done <W-id> <S-id> --status pass|fail --handoff - [--reason "…"] <<'RMC_HANDOFF'` … `RMC_HANDOFF`
      Pass the agent's json hand-off on stdin. If the agent gave none, write it from its result: summary, artifacts, decisions, assumptions and open questions. Keep assumptions as assumptions.
      - Verification stages: pass the agent's verdict and its `criteria` list unchanged, one `{"id": "C1", "status": "pass|fail", "evidence": "…"}` per acceptance criterion. Never fill in a result or evidence the agent did not give. The engine refuses `pass` unless every criterion passed with evidence, and `finish` refuses while any criterion is unverified.
      - Add `--escalate` only when the result shows the task is harder than routed.
   4. Follow the `Next:` line it prints exactly:
      - next stage → `rmc workflow start`
      - failed verification → back to implementation
      - retry → start the same stage again
      - all passed → `rmc workflow finish <W-id>`
4. **Finish.** `rmc workflow finish <W-id>` refuses unless every required stage passed with a recorded agent run. It refreshes the knowledge base and prints the per-stage models and usage. Give the user one consolidated answer:
   - what was done, with files and the decisions that matter
   - the verification result
   - open questions
   - the stage table, with the actual models from its *Actual* column; a model shown as `unverified` must be reported as unverified
5. **Failures.** If an Agent call is refused or fails, record `--status fail --reason "…"` and follow `Next:`. If the workflow fails, or the user stops it (`rmc workflow cancel <W-id>`), say exactly which stage failed and why. Never present the task as done.

Delegation rules: follow the `team-workflows` skill. Run every agent in the foreground: never set `run_in_background`, wait for its result, and delegate one agent at a time (never in parallel). If an agent runs in the background anyway, wait for its completion notification before `rmc workflow done`, and tell the user it ran in the background. Report the model that actually ran from the `[RM CONTEXT] Delegation check` note, never the requested one. Agents never start other agents; the hooks deny it. Ask the user only for permissions, destructive actions or decisions the task leaves open.
