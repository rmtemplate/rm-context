<div align="center">

<img src="assets/banner.svg" width="100%" alt="RM Context — Your Project Intelligence, Connected." />

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-16161D)](#installation)
[![Version](https://img.shields.io/badge/version-0.3.0-5B4CF0)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-16161D)](LICENSE)

</div>

**RM Context** is a Claude Code plugin by **RM Template**. It puts a coordinated engineering team inside Claude Code: a Business Analyst, System Analyst, Project Manager, Senior Engineer and DevOps Engineer. The team works from one evidence-backed **Project Intelligence Graph**, so you can go from a business idea to requirements, system design, a plan, implementation, infrastructure and delivery tracking. Every step is traceable to source code.

- **Deterministic core.** A zero-dependency Node CLI (`rmc`) scans the repository incrementally, extracts routes, schemas, imports, services and pipelines with file and line evidence, and validates every write.
- **Professional team.** Five role agents plus QA, Documentation, Quick Q&A and an Architecture analyst. They share IDs, hand-offs and one knowledge base instead of writing isolated documents.
- **Documentation engine.** 49 templates (BRD, FSD, SIPOC, SRS, UML, ERD, API spec, WBS, Gantt, RAID, ADR, runbooks and more). Each has required sections, validation rules, versioning, an approval gate, and HTML/PDF/DOCX export.
- **Evidence-based delivery.** `plan.json` drives the Gantt chart, critical path and health reports. Progress counts only completed work whose evidence exists in the repository.
- **Offline viewer.** Knowledge graph, business, system, code, infrastructure and project views, plus search, filters, evidence links and impact highlighting.

## Requirements

| | |
|---|---|
| Claude Code | a version with plugin support (built and verified on 2.1.318) |
| Node.js | ≥ 18.17. The CLI uses only the standard library; there is nothing to `npm install` |
| git | optional. It gives exact `.gitignore` handling and commit evidence |
| Chrome / Chromium / Edge | optional, for PDF export (`RMC_CHROME` overrides detection) |
| pandoc | optional, for DOCX export |

## Installation

**From a GitHub marketplace.** Push this repository to GitHub, then in Claude Code:

```text
/plugin marketplace add <github-owner>/rm-context
/plugin install rm-context@rm-context-marketplace
```

The marketplace manifest (`.claude-plugin/marketplace.json`) lists the plugin with `source: "./"`, so the repository is both the marketplace and the plugin.

**Local development.**

```bash
cd /path/to/your-project
claude --plugin-dir /path/to/rm-context
```

## Quick start

```text
/rm-context:init                     scan the repo into .rmcontext/ and write architecture notes
/rm-context:viewer                   open the project viewer
/rm-context:assess                   full existing-project assessment by the whole team
/rm-context:feature <description>    BA → SA → plan → implement → QA → docs
/rm-context:impact <id|file>         what does this change affect?
```

## Commands

**Core**

| Command | What it does |
|---|---|
| `/rm-context:init` | Scans the repository (secrets excluded), builds the graph, index, tech stack and viewer, then the architecture agent writes evidence-backed context notes (`--quick` skips the agent) |
| `/rm-context:refresh` | Incremental refresh: re-reads only changed files, marks affected knowledge stale, flags documents for review, and has the documentation agent reconcile them |
| `/rm-context:status` | Freshness, graph coverage, documents, plan and validation summary |
| `/rm-context:find` | Searches graph nodes (with evidence), documents and context notes |
| `/rm-context:graph` | Builds and opens the knowledge graph view |
| `/rm-context:viewer` | Builds and opens the full project viewer |
| `/rm-context:link` | Registers another initialized repository as a reference project |
| `/rm-context:routing` | Shows or changes which model each agent uses |

**Professional teams**

| Command | Agent | Deliverables |
|---|---|---|
| `/rm-context:ba` | Business Analyst | BRD, FSD, SIPOC, process flows, stakeholder analysis, use cases, user stories, acceptance criteria, business rules, gap analysis, scope |
| `/rm-context:sa` | System Analyst | SRS, system design, UML, ERD, API spec, data dictionary, integration spec |
| `/rm-context:pm` | Project Manager | charter, WBS, Gantt, roadmap, sprint plan, RAID, RACI, status report, release plan, change log |
| `/rm-context:engineering` | Senior Engineer | technical design, ADR, implementation plan, implementation, code review, refactoring plan, tech debt, test strategy, standards |
| `/rm-context:devops` | DevOps Engineer | infrastructure architecture, deployment, CI/CD, env matrix, runbook, backup/DR, monitoring, security and deployment checklists, rollback plan, incident report |

**Workflows**

| Command | Flow |
|---|---|
| `/rm-context:discover` | A: new project discovery. BA → SA → Engineer (feasibility) → DevOps → PM |
| `/rm-context:feature` | B: feature development. BA → SA → Engineer plan → PM tasks → *your go-ahead* → implement → QA → docs → RTM |
| `/rm-context:assess` | C: existing project assessment. Scan → BA → SA → Engineer review ∥ DevOps → PM progress from evidence |
| `/rm-context:impact` | D: change impact. Requirements, modules, APIs, tables, files, infrastructure, tasks and documents affected |

**Documentation and analysis**

| Command | Output |
|---|---|
| `/rm-context:document` | Any template from the catalog, routed to its owning agent |
| `/rm-context:fsd` · `/rm-context:sipoc` · `/rm-context:srs` · `/rm-context:erd` · `/rm-context:adr` · `/rm-context:roadmap` | The named document |
| `/rm-context:rtm` | Requirement Traceability Matrix from the graph (`save` creates a document with gap analysis) |
| `/rm-context:gantt` | Gantt SVG and interactive HTML: hierarchy, dependencies, milestones, today line, planned vs actual, status filters, critical path |
| `/rm-context:review` | Engineering review of a change set or area |
| `/rm-context:architecture` | Architecture analysis grounded in evidence |
| `/rm-context:project-health` | RAG health report from explicit rules and repository evidence |

## How the team collaborates

Agents never pass work through free text alone. They share:
- **IDs:** BR-001 → UC-001 → SR-001 → `api:POST /users` → `file:src/routes/users.js` → `test:…` → T-004.
- **The graph:** `rmc graph upsert`, which validates every write.
- **Hand-offs:** `rmc handoff add`, carrying summary, artifacts, assumptions and open questions.

Every non-verified statement is classified as **Confirmed**, **Assumption**, **Open Question** or **Recommendation**. The validator enforces the `Basis` column on BA and SA requirement tables. No agent can approve a document: approval needs `--approved-by`, and agents are instructed to use it only when you explicitly approve.

The main session orchestrates. It delegates one role per step, passes the routed model, and runs roles in parallel only when their steps are independent. See [`skills/team-workflows/SKILL.md`](skills/team-workflows/SKILL.md).

## Model routing

| Agent | Default | Why |
|---|---|---|
| business-analyst, system-analyst, senior-engineer, devops-engineer, architecture | Opus | complex analysis and decisions |
| project-manager, qa, documentation | Sonnet | planning, verification, structured writing |
| quick-qa | Haiku | lightweight retrieval |

To override per project, edit `.rmcontext/config.json`, e.g. `{ "models": { "project-manager": "opus", "qa": "inherit" } }`. Values are the aliases `opus`, `sonnet` or `haiku`, a full `claude-…` id, or `inherit`, meaning the main session's model.

Commands pass the routed model when delegating. If that model is unavailable, they retry with the main session's model. **A subagent's model never changes your main session's model.** Use `/model` for that.

## Generated structure

```text
.rmcontext/
├── manifest.json  config.json  INDEX.md  .gitignore
├── context/              tech-stack.md (generated) · overview, architecture, conventions, business-rules (agents)
├── business/ system/ engineering/ infrastructure/
├── documents/            registry.json · <layer>/<ID>-<slug>.md · .history/ · exports/
├── project-management/   plan.json · gantt.svg · gantt.html · impact and health reports
├── templates/            optional project template overrides
├── graph/                nodes.json · edges.json
├── flows/  references/
├── viewer/               index.html · graph.html
├── state/                scan.json · handoffs.jsonl · files.json (local cache)
└── .local/               machine-local paths (git-ignored)
```

Commit `.rmcontext/`. Its own `.gitignore` keeps the machine-local cache and paths out. Full schemas are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Knowledge graph

There are 38 node types across five layers:
- **business:** stakeholder, requirement, process, rule, use case, user story
- **system:** system, module, feature, requirement, API, database, table, entity, integration
- **engineering:** file, class, function, component, dependency, test
- **infrastructure:** server, container, service, network, environment, deployment, pipeline
- **project:** project, milestone, sprint, task, risk, issue, assumption, question, decision, document

There are 12 relationship types: `belongs_to implements depends_on calls reads_from writes_to integrates_with deployed_on tested_by satisfies blocks related_to`. Each relationship carries **evidence** (file, line range, evidence type) and a **confidence** of `verified` (literal source fact), `inferred` (heuristic) or `manual` (stated by a person).

**Scanner coverage:**
- **JS/TS:** Express-style routes and Next.js routes; Prisma and SQL table use; outbound HTTP
- **PHP/Laravel:** routes with controller handlers via PSR-4; Eloquent models; migrations with columns and foreign keys
- **Python:** Flask/FastAPI/Django routes; SQLAlchemy/Django models
- **Go:** gin/echo/net-http routes
- **Java/Kotlin:** Spring mappings and JPA
- **Ruby:** Rails routes and models
- **C#:** ASP.NET attributes
- **Schemas:** SQL and Prisma
- **Packages:** npm, Composer, pip/pyproject, Go modules, Gems, Cargo
- **Infrastructure:** Dockerfile, Compose, GitHub/GitLab/other CI, Kubernetes, Terraform, nginx; env-template variable **names**

## Security

- **Never read or indexed:** `.env*` (except example templates, and those for names only), private keys and certificates, `.npmrc`/`.pypirc`/`.netrc`, credential and service-account files, tfstate/tfvars, database dumps and backups. Dependency, build, cache and binary files are skipped.
- `.gitignore` (all of them, via git), `.rmcontextignore` and `config.ignore` patterns are respected.
- Graph writes and document validation **reject secret-like content**: private keys, cloud and VCS tokens, JWTs, passwords in connection strings, and credential assignments.
- Generated content is wrapped in markers, so user-authored text is never overwritten. `rmc doc new` refuses to overwrite files.
- Machine-specific absolute paths stay in the git-ignored `.local/`.

## Limitations

- The extractors are regex-based, not AST-based. They miss dynamic or computed routes, router mount prefixes (`app.use('/api', router)`) and route groups, reflection, runtime registration and macros. Function-level `calls` edges are inferred from imported names only.
- Modules are inferred from directory structure. Features, business intent, planned design and infrastructure intent come from agents, not the scanner.
- The viewer is a static snapshot. Re-run `/rm-context:viewer` after changes. It is designed for graphs up to a few thousand nodes.
- Mermaid diagrams in HTML exports render only when the page can reach jsDelivr. PDF needs a Chromium-family browser and DOCX needs pandoc. The CLI reports clearly when one is missing.
- Model availability depends on your Claude Code version and account.

## Upgrading from 0.2.0

- Existing `.rmcontext/` folders are migrated on the next `rmc refresh`. Legacy node and edge types are mapped (`reads`→`reads_from`, `contains`→`belongs_to`, `external_service`→`integration`, …), and nothing is dropped.
- The `coding` agent is now `senior-engineer`. All 0.2.0 commands keep their names.
- The root `marketplace.json` duplicate was removed. Use `.claude-plugin/marketplace.json`.

## Development

```bash
npm test               # 31 tests: scanner, security exclusions, incremental refresh, graph rules, documents, plan/Gantt, viewer, plugin structure
npm run validate       # claude plugin validate --strict for the manifest, agents, skills and commands
node scripts/rmc.mjs help
```

To regenerate `.claude-plugin/icon.png` after editing `assets/icon.svg`, render it at 512×512 with a transparent background:

```bash
chrome --headless=new --default-background-color=00000000 --window-size=512,512 --screenshot=.claude-plugin/icon.png assets/icon-render.html
```

Further reading:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): schemas and contracts
- [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md): audit and phases
- [docs/IMPLEMENTATION_CHECKLIST.md](docs/IMPLEMENTATION_CHECKLIST.md): status
- [docs/BRANDING.md](docs/BRANDING.md): brand guidelines
- [CHANGELOG.md](CHANGELOG.md): release notes

## License

MIT. See [LICENSE](LICENSE).

<div align="center"><br><img src="assets/icon.svg" width="40" alt="" /><br><sub><b>RM Context</b> · by RM Template</sub></div>
