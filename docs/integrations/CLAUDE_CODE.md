# Claude Code Integration

**Status: Supported.** Verified with Claude Code 2.1.318, using `claude plugin validate --strict` and headless end-to-end runs.

## Install

```text
/plugin marketplace add rmtemplate/rm-context
/plugin install rmc@rm-context-marketplace
```

Restart Claude Code when prompted. Commands are available as `/rmc:<name>`. Upgrading from a version with `/rm-context:<name>` commands: `claude plugin uninstall rm-context@rm-context-marketplace`, then install `rmc@rm-context-marketplace` (no alias; do not keep both). To update later, run `/plugin marketplace update rm-context-marketplace`.

## What the adapter contains

| Path | Purpose |
|---|---|
| `.claude-plugin/plugin.json`, `marketplace.json` | Plugin and marketplace metadata |
| `agents/*.md` | Nine agents: business-analyst, system-analyst, project-manager, senior-engineer, devops-engineer, architecture, qa, documentation, quick-qa |
| `skills/*/SKILL.md` | The team contract (`team-workflows`), the role playbooks and the documentation engine. Agents preload them through the `skills` frontmatter |
| `commands/*.md` | 29 slash commands. Each calls the core CLI through `${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs` |
| `hooks/hooks.json` | Automatic context through four hooks. `SessionStart` adds a compact summary and exports `RMC_CLI` so agents can locate the CLI. `UserPromptSubmit` adds relevant knowledge within a token budget. `PostToolUse` records file changes, and `Stop` runs one incremental refresh. A delegation guard on `Agent`/`Task` (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) keeps `rmc:*` agents in the foreground, one at a time, and reports the model that actually ran from the subagent transcript (see the README's *Foreground delegation and switch notices*). See the README's [Automatic context](../../README.md#automatic-context-claude-code) section. |

## Agent routing

The agent is chosen in one of these ways:
- **By the command.** `/rmc:fsd` goes to the Business Analyst, `/rmc:erd` to the System Analyst, and so on.
- **By the template catalog.** `/rmc:document <type>` goes to the template's owning agent.
- **By the category default.** `rmc route --category <c>` returns a default agent for each category.
- **Step by step in a workflow.** In `discover`, `feature` and `assess`, each step names its role.

Claude Code can also delegate to plugin agents on its own, based on their descriptions.

## Model routing

Before each delegation, the orchestrator (your main session) runs:

```bash
rmc route --agent business-analyst --category fsd
```

It then passes the returned `model` (`haiku`, `sonnet` or `opus`) to the Agent tool. The same agent can get different models for different tasks:

| Request | Agent | Category and signals | Model |
|---|---|---|---|
| "Generate an FSD for a booking feature" | Business Analyst | `fsd` | Sonnet |
| "Where is the users table written?" | Quick Q&A | `search` | Haiku |
| "Fix the typo in the error message" | Senior Engineer | `small-change`, `trivial` | Haiku |
| "Fix the off-by-one in pagination" | Senior Engineer | `bug-fix` | Sonnet |
| "Implement a payment gateway integration" | Senior Engineer | `complex-feature`, `security,code,modules:3` | Opus |

`rmc route categories` prints the full table. Escalation, precedence and configuration are described in the [README](../../README.md#adaptive-model-routing).

## Platform limitations

- **Only the delegated agent's model is set.** A plugin cannot change your main session's model; use `/model` for that. RM Context never claims it switched the session model.
- **The Agent tool takes aliases** (`opus`, `sonnet`, `haiku`). A full `claude-…` id in the configuration is passed as its family alias. If a model is unavailable on your account, the orchestrator retries once with its own model.
- **The main session does the classification.** The CLI turns the category and signals into a model deterministically, but choosing the category and signals is a judgement made by the main session.
- **Agent frontmatter `model` values** are only used when Claude Code delegates without a `model` parameter, for example on automatic delegation.
