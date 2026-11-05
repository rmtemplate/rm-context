---
description: Show which model each RM Context agent uses (config/models.json + .rmcontext/config.json overrides)
allowed-tools: Bash(node:*)
---

Current routing (resolved by the CLI):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing`

Present this table to the user. Explain briefly:
- To change a model for this project, set it in `.rmcontext/config.json` under `"models"`, e.g. `{ "models": { "project-manager": "opus" } }`. Valid values are `opus`, `sonnet`, `haiku`, `inherit` (use the main session's model), or a full `claude-…` model id.
- When delegating, the orchestrator passes this model to the subagent. If that model is unavailable, it retries with the main session's model.
- A subagent's model never changes the main Claude Code session model. Use `/model` for that.

If the user asked to change a value ($ARGUMENTS), edit `.rmcontext/config.json` accordingly (create the `models` key if missing), then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing` again and show the result.
