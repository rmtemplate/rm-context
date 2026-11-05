<div align="center">

<img src="assets/banner.svg" width="100%" alt="RM Context — Your Project Intelligence, Connected." />

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-16161D)](#installation)
[![Version](https://img.shields.io/badge/version-0.3.0-5B4CF0)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-16161D)](LICENSE)

</div>

**RM Context** gives Claude Code a full engineering team: a Business Analyst, System Analyst, Project Manager, Senior Engineer and DevOps Engineer. They all work from one knowledge graph of your project, built from your source code. You can take an idea through requirements, design, a plan, implementation and delivery tracking, and trace every step back to a file and line in your repository.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Usage guide](#usage-guide)
- [Command reference](#command-reference)
- [Configuration](#configuration)
- [What gets created in your project](#what-gets-created-in-your-project)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## Requirements

| | |
|---|---|
| **Claude Code** | Required. Any version with plugin support |
| **Node.js 18.17 or newer** | Required. There is nothing else to install |
| git | Optional. Gives more accurate `.gitignore` handling and commit evidence |
| Chrome, Chromium or Edge | Optional. Needed only for PDF export |
| pandoc | Optional. Needed only for DOCX export |

## Installation

In Claude Code, run:

```text
/plugin marketplace add rmtemplate/rm-context
/plugin install rm-context@rm-context-marketplace
```

Restart Claude Code when prompted. Every command then starts with `/rm-context:`.

To update later, run `/plugin marketplace update rm-context-marketplace` and then reinstall the plugin.

## Getting started

Open Claude Code in the root folder of your project, then run:

```text
/rm-context:init
```

This scans the repository and writes a `.rmcontext/` folder into it. The folder holds:
- the project graph: files, modules, APIs, database tables, dependencies, tests, containers and pipelines
- a tech-stack summary
- architecture notes
- an interactive viewer

Secrets are never read (see [Security and privacy](#security-and-privacy)).

Open the viewer to see the result:

```text
/rm-context:viewer
```

As the project changes, keep the graph current:

```text
/rm-context:refresh
```

The refresh only re-reads changed files. Knowledge and documents linked to those files are flagged for review.

## Usage guide

### Understand an existing project

```text
/rm-context:assess
```

The whole team reviews the project in turn:
- the Business Analyst infers business functionality from the code
- the System Analyst maps APIs, data and integrations
- the Senior Engineer reviews architecture and code quality
- the DevOps Engineer reviews deployment and infrastructure
- the Project Manager reports actual progress, based on evidence

Add a focus to narrow it, e.g. `/rm-context:assess billing module`.

For a single area or question:

```text
/rm-context:architecture how is authentication handled?
/rm-context:find invoices
```

### Start a new project from an idea

```text
/rm-context:discover A booking platform for small clinics
```

The team works through the idea in order:
1. **Business Analyst:** objectives, stakeholders, scope and business requirements.
2. **System Analyst:** system requirements and data and API design.
3. **Senior Engineer:** feasibility and the key technical decisions.
4. **DevOps Engineer:** environments and deployment needs.
5. **Project Manager:** the work breakdown, milestones and roadmap.

When something can't be decided without you, the team stops and asks.

### Build a feature end to end

```text
/rm-context:feature Customers can reset their password by email
```

The work runs in order:
1. Requirements and acceptance criteria.
2. Functional and technical design.
3. An implementation plan based on what the change affects.
4. Tasks in the project plan.
5. **The team waits for your go-ahead.**
6. Implementation, independent QA and document updates.
7. The traceability matrix is updated.

### Check what a change will affect

```text
/rm-context:impact BR-003
/rm-context:impact src/services/billing.js
/rm-context:impact --changed
```

`--changed` uses your uncommitted changes. The report lists everything affected: business requirements, modules, APIs, database tables, files, infrastructure, plan tasks and documents. It also says how confident each link is.

### Work with one role directly

Ask a specific role for a specific deliverable:

```text
/rm-context:ba Write the BRD for customer onboarding
/rm-context:sa Design the API for BR-001 and BR-002
/rm-context:pm Plan the registration feature
/rm-context:engineering Write an implementation plan for the payment retry logic
/rm-context:devops Write a deployment runbook for production
```

### Create documents

Use a shortcut for common documents:

```text
/rm-context:fsd Registration
/rm-context:srs Patient portal
/rm-context:erd
/rm-context:sipoc Order fulfilment
/rm-context:adr Use PostgreSQL instead of MySQL
/rm-context:roadmap 2027
```

Any of the 49 templates is available through `/rm-context:document <type> <title>`, e.g. `/rm-context:document raid-log Release 1`.

| Area | Templates |
|---|---|
| Business | brd, fsd, sipoc, process-flow, stakeholder-analysis, use-case, user-story, acceptance-criteria, rtm, business-rules, gap-analysis, scope |
| System | srs, sdd, uml, erd, api-spec, data-dictionary, integration-spec |
| Project management | project-charter, wbs, gantt, roadmap, sprint-plan, raid-log, raci, status-report, release-plan, change-log |
| Engineering | technical-design, adr, code-review, tech-debt, test-strategy, test-cases, implementation-plan, refactoring-plan, engineering-standards |
| Infrastructure | infrastructure-design, deployment-architecture, cicd-spec, env-matrix, runbook, backup-recovery, security-checklist, deployment-checklist, rollback-plan, monitoring, incident-report |

**How documents work:**
- Documents are saved in `.rmcontext/documents/`. Each has an ID (e.g. `FSD-001`), a version, an author and a status: Draft, Under Review, Approved, Superseded or Archived.
- Some documents start pre-filled from your code or plan: ERD, API spec, data dictionary, RTM, infrastructure, CI/CD, environment matrix, RAID, WBS, Gantt and roadmap.
- Statements that can't be proven from the code are labelled **Confirmed**, **Assumption**, **Open Question** or **Recommendation**.
- Editing a document keeps the previous version in its history.

**Approving.** Agents never approve documents. To approve one, say so in chat, e.g. *"Approve FSD-001, approved by Jane Doe"*. Editing an approved document sends it back to Under Review.

**Exporting.** Ask in chat, e.g. *"Export FSD-001 as PDF"*. Formats are HTML, PDF and DOCX. Exports are saved in `.rmcontext/documents/exports/`.

### Plan and track delivery

```text
/rm-context:pm Plan the MVP
/rm-context:gantt
/rm-context:project-health
/rm-context:rtm
```

- **The plan** is saved in `.rmcontext/project-management/plan.json` and holds tasks, milestones, dependencies and sprints.
- **Dates are never invented.** A date stays `TBD` until you provide it.
- **The Gantt chart** shows the hierarchy, dependencies, milestones, a today line, planned vs actual dates and the critical path, with status filters. It is saved as SVG and interactive HTML.
- **Progress** counts only completed tasks whose evidence exists in the repository: files, tests or commits. It is reported as *verified*, *reported* and *planned*, and is never calculated from elapsed time.
- **`/rm-context:project-health`** gives a red/amber/green report from explicit rules. Add `save` to keep the report.
- **`/rm-context:rtm`** shows which requirements are implemented and tested. Add `save` to create an RTM document with a gap analysis.

### Review code

```text
/rm-context:review
/rm-context:review src/payments
```

With no argument, it reviews your uncommitted changes. You can also give a path, module or branch.

### Explore with the viewer

`/rm-context:viewer` opens one HTML file that works offline. It has these views:
- **Overview**
- **Knowledge graph**
- **Business:** requirements, processes, use cases
- **System:** modules, APIs, data
- **Code:** files, classes, functions, tests
- **Infrastructure:** containers, services, pipelines
- **Project:** plan and Gantt
- **Documents**

You can search, filter by type and by confidence, and zoom and pan. Click any item to see its details and source evidence, open the file in VS Code, or highlight everything it affects. `/rm-context:graph` opens the graph view directly.

The viewer is a snapshot. Run `/rm-context:viewer` again after a refresh.

### Connect related repositories

```text
/rm-context:link ../billing-service
```

This registers another repository as a reference project, so the team can follow cross-project relationships. The other repository must have been initialised with `/rm-context:init`.

## Command reference

| Command | Purpose |
|---|---|
| `/rm-context:init` | Scan the project and set up `.rmcontext/`. `--quick` skips the architecture write-up |
| `/rm-context:refresh` | Update the graph from changed files. `--full` rescans everything |
| `/rm-context:status` | Freshness, coverage, documents, plan and validation summary |
| `/rm-context:find` | Search the graph, documents and notes |
| `/rm-context:graph` | Open the knowledge graph |
| `/rm-context:viewer` | Open the full project viewer |
| `/rm-context:link` | Register a related repository |
| `/rm-context:routing` | Show or change which model each agent uses |
| `/rm-context:discover` | New project discovery |
| `/rm-context:feature` | Feature development, end to end |
| `/rm-context:assess` | Existing project assessment |
| `/rm-context:impact` | Change impact analysis |
| `/rm-context:ba` | Business Analyst |
| `/rm-context:sa` | System Analyst |
| `/rm-context:pm` | Project Manager |
| `/rm-context:engineering` | Senior Engineer |
| `/rm-context:devops` | DevOps Engineer |
| `/rm-context:document` | Any document template |
| `/rm-context:fsd` | Functional Specification |
| `/rm-context:sipoc` | SIPOC diagram |
| `/rm-context:srs` | Software Requirements Specification |
| `/rm-context:erd` | Entity relationship diagram |
| `/rm-context:adr` | Architecture Decision Record |
| `/rm-context:roadmap` | Roadmap |
| `/rm-context:rtm` | Requirement Traceability Matrix |
| `/rm-context:gantt` | Gantt chart |
| `/rm-context:review` | Code review |
| `/rm-context:architecture` | Architecture analysis |
| `/rm-context:project-health` | Project health report |

## Configuration

Project settings live in `.rmcontext/config.json`.

### Models per agent

| Agent | Default model |
|---|---|
| business-analyst, system-analyst, senior-engineer, devops-engineer, architecture | Opus |
| project-manager, qa, documentation | Sonnet |
| quick-qa | Haiku |

To change a model, edit `models`, or ask `/rm-context:routing` to do it:

```json
{ "models": { "project-manager": "opus", "qa": "inherit" } }
```

Valid values:
- `opus`, `sonnet` or `haiku`
- a full `claude-…` model id
- `inherit`, which uses your current session model

If a model isn't available on your account, the agent falls back to your session model. Agent models never change your main session model; use `/model` for that.

### Excluding files

Add gitignore-style patterns in either place:

```json
{ "ignore": ["legacy/**", "*.generated.ts"], "maxFileBytes": 1000000 }
```

You can also put patterns in a `.rmcontextignore` file at the project root. Files larger than `maxFileBytes` are skipped.

## What gets created in your project

```text
.rmcontext/
├── INDEX.md              start here: a short map of the project
├── config.json           your settings
├── context/              tech stack, overview, architecture, conventions
├── documents/            all documents, their history and exports
├── project-management/   plan.json, Gantt chart, impact and health reports
├── graph/                the knowledge graph
├── viewer/               index.html: open it in any browser
└── state/, .local/       scan state and machine-local data
```

Commit `.rmcontext/` so your team shares the same context. Its own `.gitignore` keeps machine-specific files out.

You can add your own notes to `INDEX.md` and the context files. Refreshes only replace the sections the plugin generated.

## Security and privacy

- **Never read or indexed:**
  - `.env` files. Templates such as `.env.example` are read for variable names only.
  - Private keys and certificates.
  - Credential and service-account files, `.npmrc` and `.netrc`.
  - Terraform state and variables.
  - Database dumps and backups.
- **Skipped:** dependencies, build output, caches and binary files.
- **Respected:** your `.gitignore`, `.rmcontextignore` and `config.json` ignore patterns.
- **Blocked:** generated documents and graph data that contain secret-like content, such as keys, tokens, or passwords in connection strings, are refused.
- Your own text is never overwritten without your confirmation.
- Documents are only approved when you say so.

## Troubleshooting

| Problem | Fix |
|---|---|
| "RM Context is not initialized" | Run `/rm-context:init` in the project root |
| Results look outdated | Run `/rm-context:refresh`. For a clean rebuild, run `/rm-context:refresh --full` |
| PDF export fails | Install Chrome, Chromium or Edge, or set `RMC_CHROME` to the browser's path |
| DOCX export fails | Install [pandoc](https://pandoc.org/installing.html) |
| Mermaid diagrams don't render in HTML exports | The page needs internet access to load Mermaid. Offline, diagrams are shown as source |
| An agent reports a model is unavailable | Set that agent to `inherit` with `/rm-context:routing` |
| Node.js not found | Install Node.js 18.17 or newer and restart Claude Code |

## Limitations

- **Pattern-based scanning.** Code is scanned with pattern matching, not full parsing. Some routes are missed: dynamic routes, router prefixes such as `app.use('/api', router)`, route groups, and runtime registration. Links the scanner guesses are marked *inferred*.
- **Business knowledge comes from the agents.** Business intent, planned designs and features are written by the agents, not detected in code.
- **The viewer works best up to a few thousand items.**

**Supported stacks:**
- **Languages and frameworks:** JavaScript/TypeScript (Express-style, Next.js, Prisma), PHP/Laravel, Python (Flask, FastAPI, Django, SQLAlchemy), Go, Java/Kotlin (Spring, JPA), Ruby on Rails and C# (ASP.NET)
- **Schemas:** SQL and Prisma
- **Package files:** npm, Composer, pip, Go modules, Bundler and Cargo
- **Infrastructure:** Docker, Compose, CI pipelines, Kubernetes, Terraform and nginx

## License

MIT. See [LICENSE](LICENSE).

<div align="center"><br><img src="assets/icon.svg" width="40" alt="" /><br><sub><b>RM Context</b> · by RM Template</sub></div>
