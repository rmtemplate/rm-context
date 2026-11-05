# Cursor Integration

**Status: Planned.** There is no Cursor adapter yet. Agents, commands, automatic agent routing and model routing are **not** available in Cursor.

## What works today

The core CLI is plain Node.js, so you can run it yourself in a terminal. See [CLI usage](../../README.md#cli-usage). Cursor can then read the generated `.rmcontext/` files. This has not been tested inside Cursor.

Cursor's documentation lists `.claude/agents/` as a compatible location for subagents. RM Context's agent files were **not** written or tested for Cursor:
- their `model` values are Claude aliases
- they rely on Claude Code skills preloading

Do not expect them to work there unchanged.

## Planned adapter design

| RM Context concept | Cursor mechanism (from Cursor documentation) |
|---|---|
| Orchestration rules | Project rules or `AGENTS.md` |
| Role playbooks | Skills (`SKILL.md`) |
| Role agents | Subagents as Markdown in `.cursor/agents/`, with `name`, `description`, `model` (`inherit` or a model id) and `readonly` |
| Lifecycle | Hooks in `hooks.json` |
| Model tiers | A `tiers` mapping to Cursor model ids in `.rmcontext/config.json` |

**Open design question:** whether the parent agent can choose a model per delegation, or only per subagent file.

This must be verified before this integration is marked Partial or Supported. See [Integration Architecture](../INTEGRATION_ARCHITECTURE.md).
