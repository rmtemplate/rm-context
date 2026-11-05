# RM Context — Architecture & Data Contracts

## Principle

**Deterministic work lives in code; judgement lives in agents.** One zero-dependency Node CLI (`scripts/rmc.mjs`, Node ≥ 18.17, stdlib only) owns every structured write: scan, graph, documents registry, plan, viewer. Agents and commands call it and never hand-edit JSON. Every write is validated, and invalid data is refused with a readable error and exit code 2.

```
commands/  (29)  ──►  orchestrator (main session)  ──►  agents/ (9)  ──►  skills/ (9 playbooks)
                               │                              │
                               └──────────────► rmc CLI ◄─────┘
                                                   │
             scan.mjs · extract.mjs · ignore.mjs · graph.mjs · docs.mjs · pm.mjs · viewer.mjs · project.mjs
                                                   │
                                                   ▼
                                            <project>/.rmcontext/
```

| Module | Responsibility |
|---|---|
| `ignore.mjs` | File selection: git ls-files or a walker; .gitignore and .rmcontextignore; hard secret, binary and size exclusions; secret-content detection |
| `extract.mjs` | Per-file regex extractors: JS/TS, PHP, Python, Go, Java/Kotlin, Ruby, C#, SQL, Prisma, manifests, Dockerfile, Compose, CI, Kubernetes, Terraform, nginx, env templates, Procfile |
| `scan.mjs` | Incremental cache (size/mtime/sha1), scan graph build, merge with agent knowledge, stale/orphan handling, stack detection, INDEX and tech-stack generation |
| `graph.mjs` | Schema, validation, upsert, search, impact propagation, RTM, stats, legacy migration |
| `docs.mjs` | Template catalog, registry, lifecycle, validation rules, graph-backed prefill, HTML/PDF/DOCX export |
| `pm.mjs` | Plan schema and validation, evidence verification, progress, CPM critical path, Gantt (SVG/HTML/Mermaid), WBS, roadmap, health |
| `viewer.mjs` + `viewer/template.html` | Single-file offline viewer with embedded data |
| `project.mjs` | init, status, validate-all, find, impact report, RTM markdown, links, model routing, hand-offs |

## Storage layout (`<project>/.rmcontext/`)

```
manifest.json            schemaVersion, generator, project {id,name}, stack, scan {timestamp, commit, mode}
config.json              models {agent: alias|claude-id|inherit}, ignore [gitignore patterns], maxFileBytes
INDEX.md                 short navigational index (generated block + your notes)
.gitignore               ignores .local/ and state/files.json
context/                 tech-stack.md (generated) · overview / architecture / conventions / business-rules (agents)
business/ system/ engineering/ infrastructure/   free-form notes per layer
documents/
  registry.json          metadata for every document (see below)
  <layer>/<ID>-<slug>.md documents
  .history/<ID>/vN.md    previous versions
  exports/               html / pdf / docx exports
project-management/      plan.json · gantt.svg · gantt.html · impact-*.md · health-*.md
templates/               optional project overrides: catalog.json, <type>.md
graph/nodes.json, graph/edges.json
flows/ references/projects.json
viewer/index.html, viewer/graph.html
state/scan.json          last scan report (coverage, exclusions, limitations)
state/files.json         extraction cache (local, git-ignored)
state/handoffs.jsonl     agent hand-offs
.local/local.json        machine-local: CLI path, linked project paths (git-ignored)
```

Generated Markdown is fenced by `<!-- rmc:generated:start -->` and `<!-- rmc:generated:end -->`. Text outside the markers is never touched. A file without markers is treated as user-authored and is never overwritten.

## Graph schema

**Node**
```json
{ "id": "api:POST /users", "type": "api", "name": "POST /users",
  "origin": "scan|agent|manual", "confidence": "verified|inferred|manual",
  "evidence": [ { "file": "src/routes/users.js", "lines": [10, 14], "type": "route", "confidence": "verified" } ],
  "description": "optional", "attrs": { "method": "POST", "path": "/users" }, "tags": [], "stale": true }
```

**Edge**
```json
{ "id": "<source>|<type>|<target>", "source": "...", "target": "...", "type": "implements",
  "origin": "...", "confidence": "...", "evidence": [ ... ], "stale": true }
```

| Layer | Node types |
|---|---|
| business | stakeholder, business_requirement, business_process, business_rule, use_case, user_story |
| system | system, module, feature, requirement, api, database, table, entity, integration |
| engineering | file, class, function, component, dependency, test |
| infrastructure | server, container, service, network, environment, deployment, pipeline |
| project | project, milestone, sprint, task, risk, issue, assumption, question, decision, document |

Edge types: `belongs_to implements depends_on calls reads_from writes_to integrates_with deployed_on tested_by satisfies blocks related_to`.
Evidence types: `declaration import route schema config call test doc commit user`.

Validation rules:
- unique ids, known types, both endpoints exist, no self-loops
- repository-relative evidence paths, valid line ranges
- `verified` requires evidence, unless origin is `manual`
- endpoint constraints: `tested_by → test`; `deployed_on → infrastructure`; `satisfies → business|system`; `blocks` between project items
- no secret-like content

Ownership:
- `rmc refresh` rebuilds `origin: scan` items from the cache and keeps everything else.
- An agent or manual item whose evidence file changed is marked `stale`.
- Agent edges whose endpoint disappeared are dropped and reported in `state/scan.json`.
- Agents may annotate scan nodes (description, tags, attrs) but cannot delete them.

**Impact propagation**: for each edge type, whether a change at the source affects the target (forward) and/or the reverse:

| Edge | fwd | back |
|---|---|---|
| belongs_to | ✓ | start node only |
| implements, satisfies, writes_to, integrates_with, deployed_on | ✓ | ✓ |
| depends_on, calls, reads_from | | ✓ |
| tested_by, blocks | ✓ | |
| related_to | start only | start only |

The project root is never traversed. The default depth is 4. Each result carries its hop count, the hop that reached it, and the weakest confidence along the path.

## Documents registry

```json
{ "id": "FSD-001", "type": "fsd", "title": "Registration", "path": "documents/business/FSD-001-registration.md",
  "layer": "business", "status": "Draft|Under Review|Approved|Superseded|Archived", "version": 2,
  "author": "business-analyst", "createdAt": "…", "updatedAt": "…", "approvedBy": "…", "approvedAt": "…",
  "sources": ["src/routes/users.js"], "nodes": ["BR-001"], "needsReview": true, "supersededBy": "FSD-002",
  "history": [ { "version": 1, "at": "…", "author": "…", "status": "Draft", "note": "Created from template" } ] }
```

Template catalog: `templates/catalog.json`. Each type defines its title, layer, owning agent, id prefix, rules, an optional `generated` source, and its sections (heading, guidance, optional flag). Rules: `basis`, `evidence`, `mermaid[:kind]`, `plan`, `adr-status`. Placeholder and secret checks apply to all types.

Lifecycle guards:
- Under Review and Approved require a valid document.
- Approved requires `--approved-by`.
- Revising an Approved document clears the approval.

## Plan schema

See `skills/project-management/SKILL.md`. Validation covers:
- ids, status and priority enums
- `YYYY-MM-DD | TBD` dates, end ≥ start, duration consistency, single-date milestones
- existing dependencies and parents, no dependency or parent cycles, finish-to-start date consistency
- sprint references, summary-task envelopes
- completion requires evidence, `actualEnd` and progress 100
- overdue warnings

Progress, computed over leaf tasks (duration-weighted when every duration is known):
- **verified**: completed tasks whose file, test or commit evidence exists in the repo
- **reported**: also counts in-progress estimates
- **planned**: the schedule baseline as of today

## Hand-off schema

`state/handoffs.jsonl`, one JSON object per line:
`{ id, at, from, to, workflow, summary, artifacts[], decisions[], assumptions[], openQuestions[], nodes[] }`

## Model routing

`config/models.json` holds the plugin defaults, matching the agent frontmatter. `.rmcontext/config.json` `models` holds the project overrides. Valid values are `opus|sonnet|haiku|inherit|claude-*`. Commands inject `rmc routing --agent <name>` and pass `model` to the Agent tool. `inherit` and the fallback both mean the orchestrator passes its own model alias. Subagent models never change the main session model.

## Plugin wiring

- `hooks/hooks.json`: a SessionStart hook appends `export RMC_CLI=…/scripts/rmc.mjs` to `$CLAUDE_ENV_FILE`. Agents resolve it with `printenv RMC_CLI` and then call the literal path, because `$VAR` inside a command triggers a permission prompt.
- Commands reference `${CLAUDE_PLUGIN_ROOT}` (substituted to a literal path) and use `!` context injection.
- Agents preload their playbooks via the `skills` frontmatter. They are also told to load them with the Skill tool if they are absent.

Verified at runtime with Claude Code 2.1.318 (headless `claude -p --plugin-dir`):
- the `${CLAUDE_PLUGIN_ROOT}` substitution and `!` injection in `/rm-context:routing`
- the `documentation` agent receiving the `team-workflows` and `documentation-engine` skills preloaded
- `RMC_CLI` exported by the hook
