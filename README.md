<div align="center">

<img src="assets/banner.svg" width="100%" alt="RM Context — Your Project Intelligence Layer for AI Coding Agents." />

**RM Context** · by [RM Template](https://rmtemplate.com)

*Your Project Intelligence Layer for AI Coding Agents.*

[![Website](https://img.shields.io/badge/web-rmtemplate.com-5B4CF0)](https://rmtemplate.com)
[![Version](https://img.shields.io/badge/version-0.3.0-16161D)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518.17-16161D)](#quick-start)
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
| Viewer | Offline HTML with graph, layer, project and document views |
| Routing | Task category → default agent and model tier, with escalation and metrics |

## Supported AI platforms

| Platform | Status | Details |
|---|---|---|
| Any terminal (core CLI) | **Supported** | [CLI usage](#cli-usage) |
| Claude Code | **Supported** | [docs/integrations/CLAUDE_CODE.md](docs/integrations/CLAUDE_CODE.md) |
| OpenAI Codex | **Planned** | [docs/integrations/CODEX.md](docs/integrations/CODEX.md) |
| OpenCode | **Planned** | [docs/integrations/OPENCODE.md](docs/integrations/OPENCODE.md) |
| Cursor | **Planned** | [docs/integrations/CURSOR.md](docs/integrations/CURSOR.md) |

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

## Knowledge graph and viewer

- **Graph layers:**
  - **Business:** stakeholders, requirements, processes, rules, use cases, stories
  - **System:** modules, APIs, tables, entities, integrations
  - **Engineering:** files, classes, functions, components, dependencies, tests
  - **Infrastructure:** containers, services, pipelines, environments
  - **Project:** milestones, tasks, risks, decisions, documents
- **Relationships:** `belongs_to`, `implements`, `depends_on`, `calls`, `reads_from`, `writes_to`, `integrates_with`, `deployed_on`, `tested_by`, `satisfies`, `blocks`, `related_to`.
- **Viewer:** `rmc viewer --open` builds one offline HTML file. It has overview, graph, business, system, code, infrastructure, project and documents views. You can search, filter by type and confidence, follow evidence links (including into VS Code), highlight impact, and switch between light and dark themes.

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

## Quick start

**Requirements:** Node.js 18.17 or newer. git is optional; it gives exact `.gitignore` handling and commit evidence.

```bash
git clone https://github.com/rmtemplate/rm-context.git ~/rm-context
alias rmc='node ~/rm-context/scripts/rmc.mjs'   # PowerShell: function rmc { node $HOME\rm-context\scripts\rmc.mjs @args }

cd /path/to/your-project
rmc init                    # scan the repository into .rmcontext/
rmc find users              # search graph nodes, documents and notes
rmc impact src/routes/users.js
rmc viewer --open           # open the offline viewer
```

Using Claude Code? See [Platform-specific installation](#platform-specific-installation).

## Platform-specific installation

**Claude Code (supported)**

```text
/plugin marketplace add rmtemplate/rm-context
/plugin install rm-context@rm-context-marketplace
```

Then, in your project, run `/rm-context:init`. Details are in [docs/integrations/CLAUDE_CODE.md](docs/integrations/CLAUDE_CODE.md).

| Claude Code command | Purpose |
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

**Codex, OpenCode and Cursor (planned).** There is no adapter yet. You can use the [core CLI](#cli-usage) in a terminal alongside them. See [docs/integrations/](docs/integrations/).

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
├── state/                scan report · hand-offs · routing metrics · local cache
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
- **Routing metrics hold metadata only.** No prompts and no source code are stored.

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
| Hooks and session integration | — | Supported (SessionStart) | Planned | Planned | Planned |
| Installation | `git clone` | Plugin marketplace | Manual CLI | Manual CLI | Manual CLI |

¹ You run the CLI yourself in a terminal, and the platform reads the generated files. There is no adapter and it has not been tested inside the platform.
² Without an agent, the CLI creates templates, pre-fills sections from the graph or plan, then validates, versions and exports. You write the analysis.

## Limitations

- **Pattern-based extraction, not a full parser.** Dynamic routes, router mount prefixes (`app.use('/api', router)`), route groups and runtime registration can be missed. Heuristic links are marked `inferred`.
- **Business intent comes from agents or people.** It is never inferred automatically from code.
- **The model is applied only where the platform supports it.** No integration changes your main session's model.
- **External tools for some exports.** PDF needs Chrome, Chromium or Edge (or set `RMC_CHROME`). DOCX needs pandoc. Mermaid in HTML exports needs network access to render.
- **The viewer is a snapshot.** Rebuild it after a refresh. It works best up to a few thousand nodes.

## Roadmap

- Adapters for OpenAI Codex, OpenCode and Cursor, following [the integration architecture](docs/INTEGRATION_ARCHITECTURE.md).
- Parser-based extractors for more precise routes and call graphs.
- A packaged CLI install.
- Viewer performance for very large graphs.

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
