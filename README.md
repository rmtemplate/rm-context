<div align="center">

<img src="assets/banner.svg" width="100%" alt="RM Context — Your Project Intelligence Layer for AI Coding Agents." />

**RM Context** · by [RM Template](https://rmtemplate.com)

*Your Project Intelligence Layer for AI Coding Agents.*

[![Website](https://img.shields.io/badge/web-rmtemplate.com-5B4CF0)](https://rmtemplate.com)
[![Version](https://img.shields.io/badge/version-0.3.0-16161D)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518.17-16161D)](#standalone-cli)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-16161D)](docs/integrations/CLAUDE_CODE.md)
[![License](https://img.shields.io/badge/license-MIT-16161D)](LICENSE)

</div>

## Introduction

RM Context is a project intelligence toolkit for AI coding agents. It scans your repository into a knowledge base that lives in the repository itself (`.rmcontext/`). From there it provides:
- a knowledge graph backed by source evidence
- professional documents
- delivery plans
- an offline viewer

The core is a dependency-free Node.js CLI that works with any editor or agent. Platform integrations add specialised agents, automatic agent routing and adaptive model routing on top. **Claude Code is the integration available today**; others are planned (see [Supported AI platforms](#supported-ai-platforms)).

## Why RM Context?

- **Agents forget; repositories don't.** Knowledge about the project is kept in versioned files instead of being rediscovered every session.
- **Claims carry evidence.** Every fact in the graph points to a file and line, with a confidence of `verified`, `inferred` or `manual`.
- **One shared model of the project.** Requirements, design, code, infrastructure and plan are linked, so you can trace a business requirement to the code, tests and tasks behind it, and see what a change affects.
- **Cost-aware.** Each delegated task gets the smallest model tier that can do it well.

## Core capabilities

| Area | What you get |
|---|---|
| Scanning | Incremental scan, stack detection, routes, schemas, imports, dependencies, containers and pipelines, with secret exclusion |
| Knowledge graph | 38 node types across business, system, engineering, infrastructure and project layers; 12 relationship types; impact analysis; traceability |
| Documents | 49 templates with validation, versions, an approval gate, and HTML, PDF and DOCX export |
| Project management | Plan validation, Gantt chart, critical path, WBS, roadmap, progress based on evidence, health report |
| Viewer | Offline single-file project viewer: overview, file explorer, code, API and database explorers, eight graph views for large graphs |
| Automatic context | Claude Code hooks add a compact project summary per session, relevant knowledge per prompt, and one incremental refresh per turn |
| Routing | Task category → default agent and model tier, with escalation and metrics |

## Supported AI platforms

| Platform | Status | Details |
|---|---|---|
| Any terminal (core CLI) | **Supported** | [CLI usage](#cli-usage) |
| Claude Code | **Supported** | [docs/integrations/CLAUDE_CODE.md](docs/integrations/CLAUDE_CODE.md) |
| OpenAI Codex | **Planned** adapter · experimental manual setup | [docs/integrations/CODEX.md](docs/integrations/CODEX.md) |
| OpenCode | **Planned** adapter · experimental manual setup | [docs/integrations/OPENCODE.md](docs/integrations/OPENCODE.md) |
| Cursor | **Planned** adapter · experimental manual setup | [docs/integrations/CURSOR.md](docs/integrations/CURSOR.md) |

The full breakdown is in the [compatibility matrix](#compatibility-matrix).

## Architecture overview

```
RM Context Core  (platform-independent)
  CLI · Scanner · Context store · Knowledge graph · Document engine · Plan & Gantt · Task classifier · Model router
        ▲ shell calls
Platform adapters  (platform-specific)
  Claude Code (supported) · Codex · OpenCode · Cursor (planned)
  agents · commands · model selection · hooks · permissions
```

Business logic lives in the core. Adapters translate a platform's agent invocation and model selection into the shared workflow. See [docs/INTEGRATION_ARCHITECTURE.md](docs/INTEGRATION_ARCHITECTURE.md).

## Professional AI teams

*Requires a platform adapter: currently Claude Code.*

| Agent | Delivers |
|---|---|
| Business Analyst | BRD, FSD, SIPOC, process flows, stakeholder analysis, use cases, user stories, acceptance criteria, business rules, gap analysis |
| System Analyst | SRS, system design, UML, ERD, API spec, data dictionary, integration spec |
| Project Manager | Charter, WBS, Gantt, roadmap, sprint plan, RAID, RACI, status report, release plan |
| Senior Engineer | Technical design, ADR, implementation plan, implementation, code review, refactoring, tech debt, test strategy |
| DevOps Engineer | Infrastructure design, deployment, CI/CD, environment matrix, runbook, backup and recovery, monitoring, security and rollback |
| Architecture · QA · Documentation · Quick Q&A | Repository analysis, independent verification, document upkeep, quick lookups |

**How the agents work together:**
- They share IDs (`BR-001` → `SR-001` → `api:POST /users` → `T-004`) and pass structured hand-offs.
- Every unverified statement is labelled **Confirmed**, **Assumption**, **Open Question** or **Recommendation**.
- No agent can approve a document.

## Automatic agent routing

*Requires a platform adapter: currently Claude Code.*

The agent is picked from the work being done:
- **Role commands** go to their role: `/rm-context:fsd` goes to the Business Analyst.
- **Templates** go to their owner: `/rm-context:document <type>` routes by the template catalog.
- **Workflows** route each step to its role: `discover`, `feature`, `assess`.
- **Task categories** have a default agent: `rmc route --category <c>`.

## Adaptive model routing

Choosing the agent and choosing the model are separate decisions. The CLI picks a tier from the task category and its complexity signals:

| Request | Agent | Model |
|---|---|---|
| "Generate an FSD for a booking feature" | Business Analyst | Sonnet (medium) |
| "Where are users created?" | Quick Q&A | Haiku (low) |
| "Implement a complex payment gateway" | Senior Engineer | Opus (high) |

```bash
rmc route --category fsd
rmc route --category complex-feature --signals security,code,modules:3
rmc route categories            # categories, tiers and signals
```

- **Complexity signals:**
  - `security`, `architecture`, `irreversible`, `debugging`, `cross-module` and `modules:3`+ raise the task to **high**.
  - `ambiguous`, `code` and `modules:2` keep it at least **medium**.
  - `trivial` or `retrieval` lower it to **low**, unless a high signal is present.
- **Precedence:**
  1. The user's explicit `--model`.
  2. The project override `.rmcontext/config.json` → `models.<agent>`.
  3. The agent override `config/models.json` → `agents.<agent>.override`.
  4. The adaptive tier.
  5. The agent default.

  Unsupported values fall back to `routing.fallbackTier`.
- **Escalation.** `rmc route --escalate <R-id> --reason "…" --handoff <H-id>` moves one subtask up a tier, at most `maxEscalations` times, and carries the previous agent's hand-off forward so the work isn't repeated.
- **Metrics.** `rmc route stats` reports routes by tier, agent and category, plus escalations, context reuse and agents per workflow. Only metadata is stored; never prompts or code.

**Platform limits.** RM Context recommends a model for each delegated agent. Applying it depends on the platform. In Claude Code, the model is set on the subagent; **your main session's model never changes** (use `/model` for that). Without an adapter, `rmc route` is a recommendation only.

## Persistent project knowledge

`rmc init` creates `.rmcontext/` in your repository. `rmc refresh` re-reads only changed files. Knowledge and documents linked to those files are flagged for review. Commit the folder so your whole team and every agent share the same context.

## Automatic context (Claude Code)

In Claude Code the plugin keeps the agent informed without extra commands. Four hooks drive it:

| Hook | What happens |
|---|---|
| `SessionStart` | Adds a compact summary: project, stack, last scan, graph size, pending changes. About 100–250 tokens. |
| `UserPromptSubmit` | Finds the modules, APIs, functions, tables, tests, infrastructure, documents and notes relevant to the prompt and adds them with source locations. The default limit is 1,200 tokens. Prompts that match nothing add nothing. |
| `PostToolUse` | Records files changed by `Write`, `Edit`, `MultiEdit` or `NotebookEdit`, or by a Bash command that may change files. Read-only commands are ignored. |
| `Stop` | Runs one incremental refresh for everything changed in the turn. Changed files are found from the recorded paths, `git status`, or file fingerprints in non-git projects. You see a one-line summary, e.g. `RM Context updated · 2 file(s) · modules: src/services · graph +1/~1/-0 nodes … · full scan not required`. |

What the hooks never do:
- call a model
- scan the whole repository for a prompt
- store prompt text
- inject anything that looks like a secret
- rewrite approved documents

Documents whose sources changed are only marked for review. Changes to `.rmcontext/` never trigger a refresh, so the refresh cannot loop. Without `.rmcontext/`, the session summary suggests `/rm-context:init`, and nothing is scanned automatically.

Adjust it in `.rmcontext/config.json`:

```json
{ "autoContext": { "enabled": true, "sessionStart": true, "promptRetrieval": true, "incrementalRefresh": true,
                   "maxContextTokens": 1200, "sessionContextTokens": 250, "maxResults": 8, "minimumRelevance": 0.45 } }
```

To turn it off, set `"enabled": false` or set the environment variable `RMC_AUTO_CONTEXT=0`. The CLI and commands keep working. `rmc context status` shows usage, average tokens and latency, the last refresh, and hook errors. `rmc context "<prompt>"` shows what would be added for a prompt.

These hooks exist only in Claude Code. Other platforms can run the same retrieval by hand with `rmc context`.

## Knowledge graph and viewer

- **Graph layers:**
  - **Business:** stakeholders, requirements, processes, rules, use cases, stories
  - **System:** modules, APIs, tables, entities, integrations
  - **Engineering:** files, classes, functions, components, dependencies, tests
  - **Infrastructure:** containers, services, pipelines, environments
  - **Project:** milestones, tasks, risks, decisions, documents
- **Relationships:** `belongs_to`, `implements`, `depends_on`, `calls`, `reads_from`, `writes_to`, `integrates_with`, `deployed_on`, `tested_by`, `satisfies`, `blocks`, `related_to`.
### Project viewer

`rmc viewer --open` builds `.rmcontext/viewer/index.html`. It is one file that opens offline: the CSS is compiled in, and nothing is loaded from the network.

- **Navigation:**
  - The sidebar groups sections into Workspace, Code Intelligence, Architecture, Project Knowledge and Utilities. Sections without data are hidden.
  - On a tablet the sidebar collapses to icons. On a phone it becomes a drawer, and details open as a bottom sheet.
  - Keyboard: `/` searches and `Esc` closes. Arrow keys move through the tree and lists.
- **Overview:** real counts (files, lines, modules, functions, APIs, tables, tests), the share of extracted and inferred relationships, the stack, the largest modules, and freshness: last scan, last automatic refresh, stale items and documents needing review.
- **File explorer:**
  - A virtualized tree with lazy folders.
  - For each file: symbols, imports and what they resolve to, importers, routes, tables, external calls, callers, callees, requirements, tests, documents and evidence.
  - Every relationship is labelled **Extracted** (read from source) or **Inferred** (a heuristic to verify).
- **Explorers:** Modules, Functions & Classes, Dependencies, APIs, Database, Infrastructure, Integrations and Business Requirements, plus Technical Documents, Project Management (Gantt), Agent Handoffs, Notes, Search, Context Status and Settings.
- **Graph views:** Project, Module, File dependency, Function call, API, Database, Infrastructure, Traceability and Everything.
- **Graph tools:**
  - Find in graph, type filters and provenance filters.
  - Zoom, pan, fit and reset.
  - Focus on a neighbourhood of 1–3 hops, with an option to hide unrelated nodes.
  - Shortest-path tracing, change impact (same rules as `rmc impact`), and back and breadcrumb history.
  - An accessible list view as an alternative to the canvas.
- **Large graphs:**
  - Rendering is on canvas. Graphs over 1,200 nodes start as module clusters; click a cluster to expand it.
  - Layout is deterministic. It runs in a Web Worker (synchronous fallback) and is cached per view.
  - Search uses a prefix index. Only what is on screen is drawn.

Measured in headless Edge on synthetic graphs (old viewer → new viewer):

| Graph | Layout | Redraw | Search | Select | Load |
|---|---|---|---|---|---|
| 2,000 nodes | 200 → 90 ms | 4.0 → 1.6 ms | 3.5 → 1.2 ms | 20 → 18 ms | 82 → 125 ms |
| 10,000 nodes | 1,406 → 284 ms | 14.2 → 3.9 ms | 11.9 → 4.9 ms | 43 → 18 ms | 202 → 349 ms |

The layout figures are the synchronous worst case. In normal use the layout runs off the main thread, and reopening a view uses the cached layout (1–2 ms). A 10,000-node graph first appears as 86 module clusters in about 40 ms. Load time is higher than before because the viewer now embeds file details, notes and hand-offs.

## Documentation engine

```bash
rmc doc types                                              # 49 templates
rmc doc new fsd --title "User registration" --author user  # Draft, v1
rmc doc validate FSD-001
rmc doc status FSD-001 "Under Review"
rmc doc status FSD-001 Approved --approved-by "Jane Doe"
rmc doc export FSD-001 --format pdf                        # html | pdf | docx
```

- **Areas:** business (BRD, FSD, SIPOC, RTM…), system (SRS, ERD, UML, API spec…), project management (WBS, Gantt, roadmap, RAID…), engineering (ADR, technical design, test strategy…) and infrastructure (runbook, CI/CD, rollback plan…).
- **Pre-filled from the graph or plan:** ERD, API spec, data dictionary, RTM, infrastructure, CI/CD, environment matrix, RAID, WBS, Gantt and roadmap.
- **Validation checks:**
  - required sections
  - placeholder text
  - secrets
  - the evidence citations and Basis columns the template requires
- **Lifecycle:** Draft → Under Review → Approved → Superseded or Archived. Revising an approved document returns it to review, and every version is kept.

## Project management tools

```bash
rmc pm init       # create .rmcontext/project-management/plan.json
rmc pm validate   # dates, dependencies, cycles, completion evidence
rmc pm gantt      # gantt.svg + interactive gantt.html (critical path, today line, planned vs actual)
rmc pm progress   # verified · reported · planned
rmc pm health     # red / amber / green from explicit rules
```

- **Dates are never invented.** An unknown date is `TBD`.
- **Completion needs evidence.** A task counts as complete only with evidence (a file, test or commit) and an actual end date.
- **Verified progress** counts only work whose evidence exists in the repository.

The plan schema is in [skills/project-management/SKILL.md](skills/project-management/SKILL.md).

## Installation

RM Context provides a standalone CLI and platform-specific integration instructions. Choose your preferred development environment below.

<details open>
<summary><strong>Claude Code</strong> — Supported</summary>

<br>

**Prerequisites**
- Claude Code with plugin support.
- Node.js 18.17 or newer.

**Install from the marketplace.** Run these inside Claude Code:

```text
/plugin marketplace add rmtemplate/rm-context
/plugin install rm-context@rm-context-marketplace
```

Or run them from a terminal:

```bash
claude plugin marketplace add rmtemplate/rm-context
claude plugin install rm-context@rm-context-marketplace
```

Restart Claude Code when prompted. To update later, run `/plugin marketplace update rm-context-marketplace`.

**Local development install.** Load the plugin from a local clone without installing it:

```bash
git clone https://github.com/rmtemplate/rm-context.git ~/rm-context
cd /path/to/your-project
claude --plugin-dir ~/rm-context
```

**Verify the install.**
- Run `claude plugin list`. It should show `rm-context@rm-context-marketplace` with status *enabled*.
- Or run `/rm-context:status` inside a project. It reports the project status, or says the project is not initialized yet.

**First commands**

```text
/rm-context:init                     scan the project into .rmcontext/
/rm-context:viewer                   open the offline viewer
/rm-context:assess                   team assessment of an existing project
/rm-context:feature <description>    feature from requirements to verified code
/rm-context:fsd <title>              Functional Specification (Business Analyst)
```

**Limitations**
- Adaptive routing sets the model of delegated agents only; your main session model never changes.
- PDF export needs Chrome, Chromium or Edge. DOCX export needs pandoc.

See [docs/integrations/CLAUDE_CODE.md](docs/integrations/CLAUDE_CODE.md).

</details>

<details>
<summary><strong>OpenAI Codex</strong> — Experimental / Not Yet Verified</summary>

<br>

There is no native RM Context adapter for Codex. This is a manual workflow: you run the [standalone CLI](#standalone-cli) yourself, and Codex reads `.rmcontext/` through its project instructions. It has not been tested in Codex.

**Prerequisites**
- [Codex CLI](https://github.com/openai/codex): `npm install -g @openai/codex`
- Node.js 18.17 or newer.
- A clone of RM Context, as in [Standalone CLI](#standalone-cli).

**1. Build the project knowledge.**

```bash
cd /path/to/your-project
node ~/rm-context/scripts/rmc.mjs init
```

**2. Point Codex at it.** Codex reads `AGENTS.md` from the project root (and nested folders) at the start of a session. Add the [project instructions snippet](#project-instructions-for-other-ai-agents) to your project's `AGENTS.md`.

**3. Work as usual.**
- Ask Codex to search with `rmc find`, check `rmc impact` before edits, and run `rmc refresh` after edits.
- Documents are in `.rmcontext/documents/`, and the plan is in `.rmcontext/project-management/`.
- Whether Codex may run the CLI depends on your sandbox and approval settings.

**Optional and untested: role playbooks as skills.** Codex loads skills from `.agents/skills/<name>/SKILL.md`. You can copy folders from `~/rm-context/skills/` there. They were written for Claude Code and may reference Claude-specific behaviour.

**Still needs a native adapter**
- the RM Context agents
- automatic agent switching
- adaptive model routing
- slash commands and hooks

Codex supports custom agents (TOML files in `.codex/agents/` with an optional `model`), but RM Context does not ship them yet. See [docs/integrations/CODEX.md](docs/integrations/CODEX.md).

</details>

<details>
<summary><strong>OpenCode</strong> — Experimental / Not Yet Verified</summary>

<br>

There is no native RM Context adapter for OpenCode. This is a manual workflow using the [standalone CLI](#standalone-cli). It has not been tested in OpenCode.

**Prerequisites**
- [OpenCode](https://opencode.ai/docs/): `curl -fsSL https://opencode.ai/install | bash`, or `npm install -g opencode-ai`
- Node.js 18.17 or newer.
- A clone of RM Context, as in [Standalone CLI](#standalone-cli).

**1. Build the project knowledge.**

```bash
cd /path/to/your-project
node ~/rm-context/scripts/rmc.mjs init
```

**2. Point OpenCode at it.** OpenCode reads `AGENTS.md` from the project root. Add the [project instructions snippet](#project-instructions-for-other-ai-agents) to it. To also load the generated index on every session, list it in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": [".rmcontext/INDEX.md"]
}
```

**3. Optional and untested: an RM Context command.** Create `.opencode/commands/rmc-find.md`, then run `/rmc-find <terms>`:

```markdown
---
description: Search RM Context project knowledge
---

Run `node ~/rm-context/scripts/rmc.mjs find $ARGUMENTS`, read the cited files, and answer with path:line evidence.
```

**4. Optional and untested: an experimental agent.** Create `.opencode/agents/rm-analyst.md`:

```markdown
---
description: Answers questions about this project using RM Context knowledge in .rmcontext/
mode: subagent
---

Use .rmcontext/INDEX.md and `node ~/rm-context/scripts/rmc.mjs find|impact` before reading source. Cite path:line. Never edit .rmcontext/graph or documents/registry.json by hand.
```

You can add `model: provider/model-id` to pin a model. Permission fields differ between OpenCode versions, so check the [agents docs](https://opencode.ai/docs/agents/).

**Still needs a native adapter**
- the RM Context role agents
- automatic agent switching
- adaptive model routing per delegation

See [docs/integrations/OPENCODE.md](docs/integrations/OPENCODE.md).

</details>

<details>
<summary><strong>Cursor</strong> — Experimental / Not Yet Verified</summary>

<br>

There is no native RM Context adapter for Cursor. This is a manual workflow using the [standalone CLI](#standalone-cli). It has not been tested in Cursor.

**Prerequisites**
- [Cursor](https://cursor.com/docs).
- Node.js 18.17 or newer.
- A clone of RM Context, as in [Standalone CLI](#standalone-cli).

**1. Build the project knowledge.**

```bash
cd /path/to/your-project
node ~/rm-context/scripts/rmc.mjs init
```

**2. Point Cursor at it.** Cursor reads `AGENTS.md` from the project root, and project rules from `.cursor/rules/*.mdc`. Either add the [project instructions snippet](#project-instructions-for-other-ai-agents) to `AGENTS.md`, or create `.cursor/rules/rm-context.mdc` with this frontmatter followed by the snippet:

```markdown
---
description: RM Context project knowledge in .rmcontext/ and how to query it
alwaysApply: true
---
```

The rule must use the `.mdc` extension. A plain `.md` file in `.cursor/rules/` is ignored.

**3. Optional and untested: a command.** Cursor lists Markdown files in `.cursor/commands/` as `/` commands. This feature is in beta. For example, `.cursor/commands/rmc-impact.md` could contain:

```markdown
Run `node ~/rm-context/scripts/rmc.mjs impact <the file or id I give>` and summarise the affected APIs, tables, tests, tasks and documents.
```

**Note on agents.** Cursor's documentation lists `.claude/agents/` as a compatible subagent location. RM Context's agents have **not** been verified in Cursor: their `model` values are Claude aliases, and they rely on Claude Code skill preloading.

**Still needs a native adapter**
- the RM Context role agents
- automatic agent switching
- adaptive model routing
- hooks

See [docs/integrations/CURSOR.md](docs/integrations/CURSOR.md).

</details>

> **Compatibility notice.** RM Context Core and its standalone CLI are designed to be platform-independent. Native agent orchestration, automatic agent switching, and adaptive model routing depend on platform-specific integrations. Experimental setup instructions are provided for exploration and have not yet been validated.

### Standalone CLI

Use RM Context without any AI coding agent.

**Prerequisites**
- Node.js 18.17 or newer. There are no other dependencies and nothing to `npm install`.
- git is optional; it gives exact `.gitignore` handling and commit evidence.

```bash
git clone https://github.com/rmtemplate/rm-context.git ~/rm-context
alias rmc='node ~/rm-context/scripts/rmc.mjs'   # PowerShell: function rmc { node $HOME\rm-context\scripts\rmc.mjs @args }
```

Run commands from your project folder, or pass `--root <dir>`.

```bash
rmc init                                          # create .rmcontext/ and run the first full scan
rmc refresh                                       # rescan changed files only (--full rescans everything)
rmc status                                        # freshness, coverage, documents, plan
rmc find users                                    # search graph nodes, documents and notes
rmc doc new fsd --title "User registration" --author user
rmc doc validate FSD-001
rmc pm init                                       # create project-management/plan.json, then add tasks
rmc pm gantt                                      # gantt.svg + interactive gantt.html
rmc pm health                                     # health report from plan and repository evidence
rmc viewer --open                                 # build and open the offline viewer
```

The full reference is in [CLI usage](#cli-usage), or run `rmc help`.

#### Project instructions for other AI agents

Add this to `AGENTS.md`, or to a rule file, so an agent uses the generated knowledge. Replace `~/rm-context` with your clone's path if it differs.

```markdown
## RM Context
This project keeps derived project knowledge in `.rmcontext/` (RM Context).
- Start with `.rmcontext/INDEX.md` and `.rmcontext/context/`.
- Search: `node ~/rm-context/scripts/rmc.mjs find <terms>`
- Before changing code: `node ~/rm-context/scripts/rmc.mjs impact <file or id>`
- After changing code: `node ~/rm-context/scripts/rmc.mjs refresh`
- Documents are in `.rmcontext/documents/`; the plan is in `.rmcontext/project-management/plan.json`.
- Create documents with `rmc doc new <type> --title "…" --author user` and check them with `rmc doc validate <id>`.
- Never mark a document Approved unless the user explicitly approves it.
- Do not hand-edit `.rmcontext/graph/`, `documents/registry.json` or `state/`; use the CLI.
- Never open `.env` files, private keys or database dumps.
```

## CLI usage

Run `rmc help` for the full reference. All commands run in the current directory, or in the directory given with `--root <dir>`.

| Command | Purpose |
|---|---|
| `rmc init` · `rmc refresh [--full]` | Create `.rmcontext/` and scan, or rescan only changed files |
| `rmc status [--json]` · `rmc validate` | Freshness and coverage; validate manifest, config, graph, documents and plan |
| `rmc find <terms…>` | Search the graph, documents and context notes |
| `rmc impact <id\|file> [--changed] [--out file.md]` | Change impact report |
| `rmc graph stats \| node <id> \| upsert <file.json> \| validate` | Graph queries and validated writes |
| `rmc rtm [--out file.md]` | Requirement Traceability Matrix |
| `rmc link <path>` | Register another RM Context project |
| `rmc viewer [--open] [--view graph]` | Build or open the viewer |
| `rmc doc types \| new \| validate \| revise \| regenerate \| status \| export \| list` | Documents |
| `rmc pm init \| validate \| progress \| gantt \| mermaid \| health` | Plan, Gantt and health |
| `rmc routing` · `rmc route …` | Agent defaults; adaptive model choice, escalation, stats |
| `rmc handoff add <file.json> \| list [--to agent]` | Structured hand-offs between roles |
| `rmc context "<prompt>" [--max-tokens n] [--json]` · `rmc context status` | Preview the knowledge added for a prompt; automatic-context diagnostics |

## Claude Code commands

| Command | Purpose |
|---|---|
| `/rm-context:init` · `/rm-context:refresh` · `/rm-context:status` | Set up, update and inspect `.rmcontext/` |
| `/rm-context:find` · `/rm-context:impact` | Search and change impact |
| `/rm-context:graph` · `/rm-context:viewer` | Open the viewer |
| `/rm-context:link` | Register a related repository |
| `/rm-context:routing` | Show agent defaults, tiers and categories |
| `/rm-context:discover` · `/rm-context:feature` · `/rm-context:assess` | Workflows: new project, feature end to end, assessment of an existing project |
| `/rm-context:ba` · `/rm-context:sa` · `/rm-context:pm` · `/rm-context:engineering` · `/rm-context:devops` | Work with one role |
| `/rm-context:document` · `/rm-context:fsd` · `/rm-context:sipoc` · `/rm-context:srs` · `/rm-context:erd` · `/rm-context:adr` · `/rm-context:roadmap` · `/rm-context:rtm` · `/rm-context:gantt` | Documents and plans |
| `/rm-context:review` · `/rm-context:architecture` · `/rm-context:project-health` | Code review, architecture analysis, health report |

To approve a document, say so in chat, e.g. *"Approve FSD-001, approved by Jane Doe"*. Agents never approve on their own.

## Configuration

**Project settings: `.rmcontext/config.json`.** `rmc init` creates this file:

```json
{ "schemaVersion": 2, "models": {}, "ignore": [], "maxFileBytes": 1000000 }
```

| Key | Meaning |
|---|---|
| `models` | Pin an agent to a model for this project, e.g. `{ "project-manager": "opus" }`. This turns off adaptive routing for that agent. Values: `opus`, `sonnet`, `haiku`, `inherit`, or a `claude-…` id |
| `ignore` | Extra gitignore-style patterns to skip, e.g. `["legacy/**"]`. A `.rmcontextignore` file at the project root works too |
| `maxFileBytes` | Files larger than this are skipped |
| `routing` | Overrides plugin routing settings, e.g. `{ "enabled": false }` or `{ "maxEscalations": 2 }` |
| `tiers` | Overrides the tier → model mapping, e.g. `{ "medium": "opus" }` |
| `autoContext` | Automatic context settings for Claude Code. See [Automatic context](#automatic-context-claude-code) |

**Plugin defaults: `config/models.json`.**

```json
{
  "routing": { "enabled": true, "defaultTier": "medium", "fallbackTier": "medium", "allowEscalation": true, "maxEscalations": 1 },
  "tiers": { "low": "haiku", "medium": "sonnet", "high": "opus" },
  "supportedModels": ["opus", "sonnet", "haiku", "inherit"]
}
```

The same file also holds:
- `agents`: each agent's default model, used when a delegation has no category, plus an optional `override` that pins the agent
- `tasks`: each category's tier and default agent

## Project storage structure

```text
.rmcontext/
├── INDEX.md              short map of the project (your notes are kept)
├── config.json           project settings
├── manifest.json         schema version, stack, last scan
├── context/              tech stack, overview, architecture, conventions
├── documents/            registry.json · <layer>/<ID>-<slug>.md · .history/ · exports/
├── project-management/   plan.json · gantt.svg · gantt.html · impact and health reports
├── graph/                nodes.json · edges.json
├── viewer/               index.html (opens offline)
├── references/           linked projects
├── state/                scan report · hand-offs · routing metrics · local cache · last refresh · auto-context log (metadata only)
└── .local/               machine-specific paths (git-ignored)
```

## Security and privacy

- **Never read or indexed:**
  - `.env` files. Example templates are read for variable names only.
  - Private keys and certificates.
  - Credential and service-account files, `.npmrc` and `.netrc`.
  - Terraform state and variables.
  - Database dumps and backups.
- **Skipped:** dependencies, build output, caches and binary files.
- **Respected:** `.gitignore`, `.rmcontextignore` and `config.ignore`.
- **Refused:** graph writes and documents that contain secret-like content (keys, tokens, passwords in connection strings).
- **Your text is preserved.** Generated sections are fenced by markers; text outside them, and files without markers, are never overwritten.
- **Approval is yours.** Documents become Approved only with an explicit `--approved-by`.
- **Routing metrics and the auto-context log hold metadata only.** No prompt text and no source code are stored.
- **Injected context and the viewer are filtered.** Lines that look like credentials are dropped from prompt context, and from the notes and hand-offs embedded in the viewer.

## Compatibility matrix

**Status key:**
- **Supported:** implemented and verified.
- **Partial:** some functionality works, with documented limitations.
- **Planned:** not implemented.

| Capability | Terminal (CLI) | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| Core CLI | Supported | Supported | Partial¹ | Partial¹ | Partial¹ |
| Project context (`.rmcontext/`) | Supported | Supported | Partial¹ | Partial¹ | Partial¹ |
| Knowledge graph and viewer | Supported | Supported | Partial¹ | Partial¹ | Partial¹ |
| Document generation | Supported² | Supported | Partial¹ ² | Partial¹ ² | Partial¹ ² |
| Professional agents | — | Supported | Planned | Planned | Planned |
| Automatic agent routing | — | Supported | Planned | Planned | Planned |
| Adaptive model routing | Recommendation only | Supported (subagents) | Planned | Planned | Planned |
| Hooks and session integration | — | Supported (SessionStart, UserPromptSubmit, PostToolUse, Stop) | Planned | Planned | Planned |
| Automatic context per prompt | Manual (`rmc context`) | Supported | Planned | Planned | Planned |
| Automatic incremental refresh | Manual (`rmc refresh`) | Supported | Planned | Planned | Planned |
| Installation | `git clone` | Plugin marketplace | Manual CLI | Manual CLI | Manual CLI |

¹ You run the CLI yourself in a terminal, and the platform reads the generated files. There is no adapter and it has not been tested inside the platform.
² Without an agent, the CLI creates templates, pre-fills sections from the graph or plan, then validates, versions and exports. You write the analysis.

## Limitations

- **Pattern-based extraction, not a full parser.** Dynamic routes, router mount prefixes (`app.use('/api', router)`), route groups and runtime registration can be missed. Heuristic links are marked `inferred`.
- **Business intent comes from agents or people.** It is never inferred automatically from code.
- **The model is applied only where the platform supports it.** No integration changes your main session's model.
- **External tools for some exports.** PDF needs Chrome, Chromium or Edge (or set `RMC_CHROME`). DOCX needs pandoc. Mermaid in HTML exports needs network access to render.
- **The viewer is a snapshot.** Rebuild it after a refresh. It was measured up to 10,000 nodes. Rendering every node of a very large view at once is slower than the module-cluster default.
- **Prompt retrieval is lexical.** It matches identifiers, paths and a built-in list of synonyms, including Indonesian terms. It does not understand meaning the way a model does.

## Roadmap

- Adapters for OpenAI Codex, OpenCode and Cursor, following [the integration architecture](docs/INTEGRATION_ARCHITECTURE.md).
- Parser-based extractors for more precise routes and call graphs.
- A packaged CLI install.
- Automatic context for other platforms, where they offer equivalent hooks.

## Contributing

Issues and pull requests are welcome at [github.com/rmtemplate/rm-context](https://github.com/rmtemplate/rm-context). Please describe:
- the platform you use
- your Node.js version
- the command you ran
- the output you saw

Never include secrets or private source code in issues. For other enquiries, visit [rmtemplate.com](https://rmtemplate.com).

## License

MIT. See [LICENSE](LICENSE).

<div align="center"><br><img src="assets/icon.svg" width="40" alt="" /><br><sub><b>RM Context</b> · by <a href="https://rmtemplate.com">RM Template</a></sub></div>
