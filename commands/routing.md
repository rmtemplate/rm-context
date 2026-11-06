---
description: Show which model each RM Context agent uses (config/models.json + .rmcontext/config.json overrides)
allowed-tools: Bash(node:*)
---

Current routing (resolved by the CLI):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing`

Categories and tiers:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" route categories`

Present both to the user. Explain briefly:
- Agent and model are chosen separately. Each delegation runs `rmc route --origin command --category …`, which picks the low (Haiku), medium (Sonnet) or high (Opus) tier from the task category and complexity signals. The agent defaults in the first table apply only when no category is given.
- Precedence: the user's explicit model → `.rmcontext/config.json` `models.<agent>` → `config/models.json` `agents.<agent>.override` → adaptive tier → agent default. An unsupported value falls back to `routing.fallbackTier`.
- Tiers and routing can be changed per project in `.rmcontext/config.json`, e.g. `{ "tiers": { "medium": "opus" }, "routing": { "enabled": true, "maxEscalations": 1 } }`.
- `rmc route stats` summarises past routing (metadata only: category, agent, tier, escalations, context reuse).
- To pin one agent to a model for this project, which turns off adaptive routing for that agent, set it in `.rmcontext/config.json` under `"models"`, e.g. `{ "models": { "project-manager": "opus" } }`. Valid values are `opus`, `sonnet`, `haiku`, `inherit` (use the main session's model), or a full `claude-…` model id.
- When delegating, the orchestrator passes this model to the subagent. If that model is unavailable, it retries with the main session's model.
- A subagent's model never changes the main Claude Code session model. Use `/model` for that.

If the user asked to change a value ($ARGUMENTS), edit `.rmcontext/config.json` accordingly (create the `models` key if missing), then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs" routing` again and show the result.
