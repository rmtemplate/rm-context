# OpenAI Codex Integration

**Status: Planned.** There is no Codex adapter yet. Agents, commands, automatic agent routing and model routing are **not** available in Codex.

## What works today

For step-by-step experimental setup instructions (not yet verified), open the **OpenAI Codex** section under [README › Installation](../../README.md#installation).

The core CLI is plain Node.js, so you can run it yourself in a terminal next to Codex. See [CLI usage](../../README.md#cli-usage). Codex can then read what it produces:
- `.rmcontext/INDEX.md`
- `context/`
- `documents/`
- `project-management/`

This has not been tested inside Codex. Whether Codex may run the CLI itself depends on your sandbox and approval settings.

## Planned adapter design

| RM Context concept | Codex mechanism (from Codex documentation) |
|---|---|
| Orchestration rules and CLI location | `AGENTS.md` in the project |
| Role playbooks | Skills in `.agents/skills/<name>/SKILL.md` |
| Role agents | Custom agents as TOML files in `.codex/agents/`, with `name`, `description` and `developer_instructions` |
| Per-delegation model | The agent file's `model`, or a model given when spawning |
| Model tiers | A `tiers` mapping to Codex model ids in `.rmcontext/config.json` |

**Open design questions:**
- Whether a model can be set per spawn rather than only per agent file. If only per agent file, adaptive routing would need one agent file per tier.
- How to package the adapter for distribution.

Both must be verified before this integration is marked Partial or Supported. See [Integration Architecture](../INTEGRATION_ARCHITECTURE.md).
