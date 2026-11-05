# OpenCode Integration

**Status: Planned.** There is no OpenCode adapter yet. Agents, commands, automatic agent routing and model routing are **not** available in OpenCode.

## What works today

The core CLI is plain Node.js, so you can run it yourself in a terminal. See [CLI usage](../../README.md#cli-usage). OpenCode can then read the generated `.rmcontext/` files. This has not been tested inside OpenCode.

## Planned adapter design

| RM Context concept | OpenCode mechanism (from OpenCode documentation) |
|---|---|
| Role agents | Markdown agents in `.opencode/agents/` with `mode: subagent`, a `description` and permissions |
| Per-agent model | `model: provider/model` in the agent frontmatter. Without one, a subagent inherits the parent's model |
| Commands and workflows | Markdown commands in `.opencode/commands/`, which can set `agent`, `model` and `subagent` |
| Model tiers | A `tiers` mapping to `provider/model` values in `.rmcontext/config.json` |

**Open design question:** whether the orchestrator can choose a model per delegation or only per agent definition. If only per agent definition, adaptive routing would need one agent per tier.

This must be verified before this integration is marked Partial or Supported. See [Integration Architecture](../INTEGRATION_ARCHITECTURE.md).
