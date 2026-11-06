# Integration Architecture

RM Context has two parts:
- **The core** does not depend on any AI platform. It is a Node.js CLI plus the `.rmcontext/` data it maintains.
- **Platform adapters** connect the core to a specific AI coding agent. Agent orchestration and model selection depend on what each platform supports.

```
                  ┌──────────────────────── RM Context Core ────────────────────────┐
                  │  scripts/rmc.mjs (Node.js ≥ 18.17, no dependencies)              │
                  │  Scanner · Context store (.rmcontext/) · Knowledge graph          │
                  │  Document engine (templates/catalog.json) · Plan, Gantt, health   │
                  │  Task classifier and model router (config/models.json, rmc route) │
                  └───────────────▲──────────────────▲──────────────────▲────────────┘
                                  │ shell calls      │                  │
        ┌─────────────────────────┴──┐   ┌───────────┴───────────┐   ┌──┴────────────────────┐
        │ Claude Code adapter        │   │ Codex adapter         │   │ OpenCode / Cursor     │
        │ Supported                  │   │ Planned               │   │ adapters — Planned    │
        │ agents/ skills/ commands/  │   │                       │   │                       │
        │ hooks/ .claude-plugin/     │   │                       │   │                       │
        └────────────────────────────┘   └───────────────────────┘   └───────────────────────┘
```

## What belongs where

| Concern | Core (shared) | Adapter (per platform) |
|---|---|---|
| Scanning, stack detection, incremental refresh | `scan.mjs`, `extract.mjs`, `ignore.mjs` | — |
| Graph, evidence, impact, RTM | `graph.mjs`, `project.mjs` | — |
| Documents, lifecycle, approval gate, export | `docs.mjs`, `templates/catalog.json` | — |
| Plan, Gantt, critical path, health | `pm.mjs` | — |
| Viewer | `viewer.mjs`, `viewer/` (template, app, graph core, compiled CSS) | — |
| Prompt retrieval and incremental refresh logic | `context.mjs` (`retrieve`, `recordChange`, `applyPending`), `rmc context` | — |
| Calling that logic automatically per session, prompt and turn | — | the platform's hooks (Claude Code: `scripts/hooks.mjs`, `hooks/hooks.json`) |
| Hand-offs between roles | `rmc handoff` | — |
| Task category → default agent and model tier | `config/models.json` `tasks`, `rmc route` | — |
| Role definitions (BA, SA, PM, Senior Engineer, DevOps, …) | role rules in `skills/*/SKILL.md` | the platform's agent format |
| Invoking an agent with a model | — | the platform's delegation mechanism |
| Slash commands and workflows | — | the platform's command format |
| Lifecycle hooks and session integration | — | the platform's hook mechanism |
| Tool permissions | — | the platform's permission model |

**Rule: business logic lives in the core.** An adapter only translates:
- the platform's agent invocation into a call to `rmc route`
- the platform's model selection into the value `rmc route` returns
- the platform's command or prompt format into the shared workflows

An adapter never re-implements scanning, validation, document rules or routing decisions.

## Adapter contract

An adapter is complete when it provides:

1. **CLI location.** Agents can find `scripts/rmc.mjs` and call it with a literal path.
2. **Role agents.** The nine roles, each loading its playbook from `skills/`.
3. **Delegation with a model.** Before delegating, the orchestrator runs `rmc route --agent <a> --category <c> [--signals …]`, then maps the returned tier to a model id the platform accepts. Example: `sonnet` in Claude Code, or `provider/model` in OpenCode.
4. **Escalation.** Re-delegate one subtask with `rmc route --escalate <R-id> --reason … --handoff <H-id>`, passing the hand-off.
5. **Commands or entry points.** The equivalents of `init`, `refresh`, `find`, `impact`, the role commands and workflows A–D.
6. **Honesty about the session model.** If the platform cannot change the main session's model, the adapter never claims it did.

Tier-to-model mapping lives in the `tiers` block of `config/models.json`, which a project can override in `.rmcontext/config.json`. For non-Claude platforms the adapter should add its own `supportedModels` list rather than reuse Claude aliases.

## Platform status

| Platform | Adapter | Mechanisms checked in the platform's documentation (November 2026) |
|---|---|---|
| Claude Code | **Supported**: `agents/`, `skills/`, `commands/`, `hooks/`, `.claude-plugin/` | Plugin marketplace; subagents take a `model` alias per delegation; `!` context injection; `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop` hooks (automatic context, verified in a headless session); `PreToolUse`/`PostToolUse` on `Agent` for foreground delegation and actual-model reporting (verified in a headless session) |
| OpenAI Codex | **Planned** | `AGENTS.md`; skills in `.agents/skills`; custom agents as TOML files in `.codex/agents/` with `name`, `description`, `developer_instructions` and optional `model` |
| OpenCode | **Planned** | Agents as Markdown in `.opencode/agents/` with `mode: subagent` and `model: provider/model`; commands in `.opencode/commands/`; subagents inherit the parent's model if none is set |
| Cursor | **Planned** | Rules and `AGENTS.md`; skills; subagents as Markdown in `.cursor/agents/` with `model: inherit` or a model id; hooks in `hooks.json` |

Automatic context is available only through Claude Code hooks. Another adapter can offer it by calling the same core functions from its own hook mechanism. Until that is built and tested, those platforms use `rmc context` and `rmc refresh` by hand.

The platform mechanisms above come from each platform's documentation and were **not** tested with RM Context. They are design inputs for the planned adapters, not compatibility claims. Platforms change quickly, so re-check them before building an adapter.

See the per-platform pages in [`docs/integrations/`](integrations/).
