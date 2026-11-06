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

**API node attributes (route intelligence).** `attrs` may also hold `language`, `framework`, `kind` (controller, minimal, registration, servlet, ...), `originalTemplate` (the route as written, before prefixes), `controller`, `handler`, `parameters` (`{name, in, type, optional}`), `requestBody`, `responseType`, `consumes`, `produces`, `auth`, `apiVersion`, `group`, `extractionMethod`, `resolutionStatus` (`complete|partial|unresolved`), `unresolved` (`[{knownPrefix, expression, reason}]`), `resolution` (the resolution steps) `declarations` (when several declarations produce the same method and path), `declKeys` (declaration identity used to remap agent edges when the id changes) and `conditional` (profile-specific configuration values that would change the path, never applied). C#/Java/Kotlin method nodes are `function:<file>#Class.method`. Entity → table edges from the typed linker need a mapping (`[Table]`, `ToTable`, DbSet name). The id stays `api:METHOD /path`; unresolved parts render as `{?expression}`. `scan.json` records `routes` (per-framework coverage) and `routeIdChanges` (old to new ids; agent edges and annotations follow the new id). Extraction lives in `scripts/lib/routes/`: `tokenize` > `structure` > adapters (`declarative` / `registration` strategies) > `engine` (per file, cached) > `resolve` (cross-file constants, base classes, call sites, config and conventional routes, at graph build time, so a prefix change re-resolves its dependents on every incremental refresh).

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

`routing.mjs` keeps agent selection and model selection separate.
- `rmc route --category <c> [--agent a] [--signals …]` maps the category to a default agent and a base tier (`config/models.json` `tasks`).
- `classify()` applies the signals:
  - high: security, architecture, irreversible, debugging, cross-module, modules ≥ 3
  - at least medium: ambiguous, code, modules = 2
  - low: trivial or retrieval, unless ambiguous or a high signal
- **Precedence:** `--model` → project `models.<agent>` → `agents.<agent>.override` → adaptive tier (`tiers`) → `agents.<agent>.model`.
- **Supported values:** those in `supportedModels`. A `claude-<family>-…` id is passed as its family alias, since Claude Code's Agent tool takes aliases. Anything else falls back to `tiers[routing.fallbackTier]`, or to `inherit`.
- **Escalation** (`--escalate R-id --reason … --handoff H-id`) needs:
  - an adaptive source and a tier below high
  - fewer than `maxEscalations` escalations
  - a route that was not already escalated
  - a reason not used before, and a hand-off
- **Metrics:** `state/routing.jsonl` holds one metadata record per route; `rmc route stats` summarises them.

Every route reports `mainSessionModelChanged: false`. Subagent models never change the main session's model.

### Delegation guard and notices (Claude Code)

- `rmc route --session-model <model>` adds `notice` (not stored in `routing.jsonl`): a switch notice (`routing.noticeLanguage`, `id` default / `en`), or a no-switch notice when the routed family equals the session's.
- `scripts/lib/delegation.mjs`, wired in `hooks/hooks.json`, guards `rmc:*` agents only:
  - `PreToolUse` (`Agent|Task`, `pre-agent`): denies `run_in_background`, and a concurrent second agent through a per-session lock in the OS temp dir (`rmc-delegation-<session>.json`, 2 h TTL). The lock is cleared by `PostToolUse`, `PostToolUseFailure`, `Stop` and `SessionStart`. `delegation.background = "allow"` or `RMC_ALLOW_BACKGROUND=1` disables both checks.
  - `PostToolUse` (`post-agent`): reads `<session transcript dir>/subagents/agent-<agentId>.meta.json` (`requestShape`) and `.jsonl` (the `message.model` of each assistant turn) and returns them as `additionalContext`. `pickedEffortModel` in the meta file is ignored: in Claude Code 2.1.319 it held the parent's model while the subagent ran on Haiku. No transcript → "could not be verified". Logged to `state/autocontext.jsonl` as `{event: 'delegation', agent, requested, actual, shape, tokens, ms}`, never the prompt.
- Verified live (Claude Code 2.1.319, headless, `--plugin-dir`): main session on Sonnet, `rmc:quick-qa` on Haiku, `requestShape: "foreground"`, 4/4 subagent turns on `claude-haiku-5-5`, the post-agent note reached the main session.

### Routing suggestions (suggest-first)

- `classifyPrompt(prompt, { hits, projectName })` (`routing.mjs`) uses deterministic keyword rules (EN + ID). The earliest specific intent in the prompt wins, and generic investigation is a fallback. It also extracts complexity signals (`cross-module`, `architecture`, `security`, `debugging`, `irreversible`, `code`). A cross-module or architectural investigation becomes `architecture`, and a cross-module feature becomes `complex-feature`. Direct responses: fewer than 4 words, a command, a greeting, a general question without a project reference, or a simple lookup. Confidence is 0.5 for an intent, +0.3 for a project reference (project nouns, identifiers, paths, the project name), and +0.1 per retrieval hit up to 0.2.
- `suggestForPrompt` runs `route(…, { record: false })` with the classified category and signals, so agent and model follow the normal precedence (user → project → agent override → adaptive tier → agent default). Output is one line of about 50 tokens. Decision `complex` = high tier.
- Turn state, `delegation.mjs`: `os.tmpdir()/rmc-session-<sid>.json` holds `{ sessionModel?, turn: { id, at, root, suggestion, route, agents[] } }`, metadata only.
  - The prompt hook ends the previous turn (outcome event) and starts a new one.
  - `rmc route` records `route` on it when `RMC_SESSION_ID` (exported by SessionStart) matches, the root matches and it is under 30 minutes old.
  - `post-agent` appends the agent. Stop ends the turn: `followed` if the suggested agent ran, `other-agent` if a different rmc agent ran, `direct` if none ran.
  - `rmc route --suggested` uses only the current turn's suggestion, never an earlier prompt's or another session's or project's.
- Events in `state/autocontext.jsonl`: `suggestion`, `suggestion-outcome`, `delegation` (now with `sid`, `promptId`, `suggestionId`, `followed`, `routeId`) and `delegation-denied` (`kind: background | concurrent`). `routeStats` combines them with `routing.jsonl`. `autocontext.jsonl` is trimmed to its last 500 lines past 256 KB, so its counts cover the retained window.
- SessionStart: `input.model` is stored as the session model when Claude Code provides it. Claude Code 2.1.319 headless did not, so the same-model note in the suggestion is then omitted, and the notice relies on `--session-model` from Claude.
- Retrieval: the relevance denominator is the sum of the top `TOP_TERMS` (6) known-term weights, and term weight is `1 + ln(tf)`.
- Hook cost: the prompt hook takes 45 → 55 ms on Linux FS for the node-app fixture (process included). `readHandoffs` moved to `util.mjs` so the hook path does not load `project.mjs`, docs or pm.
- Verified live, in three headless runs on the node-app fixture (Sonnet main):
  1. Suggestion injected; Claude answered directly; outcome `direct`.
  2. Asked to delegate: `rmc route --suggested --session-model claude-sonnet-5-5`, Notice shown as printed, `rmc:quick-qa` with `model: haiku`, `run_in_background: false`, actual `claude-haiku-5-5`, `requestShape: foreground`, outcome `followed`, `routeId` linked.
  3. General question: no suggestion.


The core/adapter split is described in [INTEGRATION_ARCHITECTURE.md](INTEGRATION_ARCHITECTURE.md).

## Viewer

`buildViewer` (`scripts/lib/viewer.mjs`) writes one HTML file from four sources in `scripts/viewer/`:
- **`template.html`:** the app shell.
- **`viewer.css`:** compiled Tailwind and design tokens. It is committed, and its first line holds a hash of its sources (`app.js`, `template.html`, `input.css`, `tailwind.config.cjs`). `buildViewer` compares the hash. When the sources changed, it rebuilds the CSS automatically with `npx tailwindcss@3.4.17` (about 3 s, once). If `npx` is unavailable, it warns and uses the last compiled CSS. An unmodified plugin never runs Tailwind.
- **`graph-core.mjs`:** pure functions inlined with `export` stripped. They are imported directly by the Node tests, and `layout` is serialised into the Web Worker with `Function.prototype.toString`.
  - `buildIndex` builds CSR adjacency.
  - `neighborhood`, `shortestPath` and `impactOf` traverse the graph. `impactOf` uses the same propagation as `rmc impact` and never enters project nodes.
  - `tokenize`, `buildSearch` and `search` provide a sorted token index with prefix lookups by binary search.
  - `layout` is a deterministic force layout on typed arrays with uniform-grid repulsion. It seeds groups on a golden-angle spiral and supports warm starts.
- **`app.js`:** routing, pages, the details panel and the canvas graph.

Embedded data (`DATA`):
- graph nodes (at most 5 evidence entries each) and edges
- `state/files.json` extraction results (imports, declarations, routes, database uses, http calls, tables)
- the document registry, RTM status, plan, progress and critical path
- valid hand-offs and context notes, with credential-like lines dropped
- `contextStatus()`

All `<` characters are escaped, so the data cannot close the script element.

Graph pipeline:
1. `buildModel()` selects nodes for the preset, focus, path or impact.
2. Above 1,200 nodes, nodes in collapsed modules become one cluster node each, with aggregated edges.
3. `runLayout()` uses a cached layout (memory, then `localStorage` with try/catch) if one exists. Otherwise models of 400 or more items go to the worker, and smaller ones lay out synchronously. A worker error falls back to synchronous layout.
4. `draw()` culls to the viewport, batches edges into one `Path2D` per style and nodes into one per colour, and caps labels per frame.
5. A spatial hash makes hit testing O(1).

Benchmark: `node tests/bench/run.mjs <label> [repo|2000|10000]` (local only). `#bench` mode records timings on `<body data-bench>`.

## Automatic context

`scripts/hooks.mjs <event>` reads the hook JSON from stdin, never fails the session (always exits 0), and logs errors to `state/autocontext.jsonl`.
- **session-start:** `sessionSummary()`, plus the `RMC_CLI` export.
- **prompt:** `retrieve()`.
  - Query terms: identifiers split on camelCase, stopwords removed, Indonesian → English synonyms (weight 0.9) and related concepts (weight 0.7).
  - Only terms present in the graph vocabulary with document frequency ≤ 25% count. Each is weighted by IDF.
  - Hits must have a score of at least `minimumRelevance`. Infrastructure intent adds infrastructure nodes.
  - Then relevant documents, notes and one-hop neighbours, filled into sections until `maxContextTokens` (estimate: characters ÷ 3.5).
  - The result is dropped if `findSecrets` matches anything.
  - The log records `{at, event, terms, hits, tokens, ms}` only.
- **post-tool:** `recordChange()` appends `{file}` for Write and Edit tools, or `{bash:true}` for a possibly mutating Bash command, to `state/pending-changes.jsonl`. It skips paths outside the root, `.rmcontext/` and `.git/`, and read-only pipelines.
- **stop:** `applyPending()`.
  1. Claims the pending file atomically by renaming it, so concurrent Stop hooks never refresh twice.
  2. Resolves Bash changes with `git status --porcelain -z`, or with a fingerprint incremental scan in non-git projects.
  3. Runs `scan(root, { only })` and `flagStaleDocuments`.
  4. Writes `state/last-refresh.json`.
  5. Shows a `systemMessage` only when something changed.
  It skips when `stop_hook_active` is set.

Config: `autoContext` in `.rmcontext/config.json` (defaults in `AUTO_DEFAULTS`). `RMC_AUTO_CONTEXT=0` disables it.

## Plugin wiring

- `hooks/hooks.json` registers four hooks, all running `node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks.mjs" <event>`:
  - `SessionStart` (timeout 15 s): also appends `export RMC_CLI=…/scripts/rmc.mjs` (forward slashes) to `$CLAUDE_ENV_FILE`. Agents resolve it with `printenv RMC_CLI` and then call the literal path, because `$VAR` inside a command triggers a permission prompt.
  - `UserPromptSubmit` (10 s).
  - `PostToolUse` with matcher `Write|Edit|MultiEdit|NotebookEdit|Bash` (5 s).
  - `Stop` (60 s).
- Commands reference `${CLAUDE_PLUGIN_ROOT}` (substituted to a literal path) and use `!` context injection.
- Agents preload their playbooks via the `skills` frontmatter. They are also told to load them with the Skill tool if they are absent.

Verified at runtime with Claude Code 2.1.318 (headless `claude -p --plugin-dir`):
- the `${CLAUDE_PLUGIN_ROOT}` substitution and `!` injection in `/rmc:routing`
- the `documentation` agent receiving the `team-workflows` and `documentation-engine` skills preloaded
- `RMC_CLI` exported by the hook
- automatic context, on a git-initialised copy of the node-app fixture, prompting Haiku to add a function with Edit:
  - `SessionStart` injected the summary
  - `UserPromptSubmit` injected 121 tokens in 5 ms
  - `PostToolUse` recorded the edit
  - `Stop` ran one targeted refresh in 38 ms (graph +1 node, `refundOrder`; `fullScan: false`)
  - total session cost: $0.006
