# Changelog

## 0.5.2

### Changed
- **CLAUDE.md (policy 5):** new "Hooks are binding" rule: RM Context hook context (knowledge, model question, delegation suggestion, pending-change notice) is treated as an instruction, not background. Existing projects update through `rmc claude-md`.
- **`rmc init` and `.gitignore`:** init now adds `.rmcontext/` to the repository's own `.gitignore` (creating it if missing, appending without touching your lines or line endings, skipping if a rule exists), so the generated knowledge is not pushed. Remove the line to commit it. Files already tracked by git stay tracked (`git rm -r --cached .rmcontext`).
- **Main-session model confirmation:** on an Opus session with Sonnet-class work the prompt hook now has Claude ask once per task (Yes, switch to Sonnet / No, continue with Opus) before starting. Yes → `/model sonnet` is shown and Claude waits for the user; No → continues, not re-asked. Never switches automatically, never spawns an agent for a model, silent when the active model is unknown. CLAUDE.md managed section policy 4 (existing projects update via `rmc claude-md`).


## 0.5.1

### Added
- **Viewer:** *Database Intelligence* and *Mobile* pages (tables, columns, keys, indexes, procedures, parameters, dependencies, application usage, limitations, protected changes; mobile architecture, state, data layer, chains). Metadata only.
- **Viewer (Database Intelligence):** objects are split into tabs (Tables, Stored procedures, Views, Functions, Triggers, with counts), every item is clickable and opens a detail panel with its query (the stored definition; for tables the source DDL or a DDL generated from recorded metadata), columns/parameters, what it touches, what uses it and its application call sites. Definitions that are encrypted or were flagged for a secret are never shown; the panel says why. Definitions are capped at 20 000 characters in the viewer.

## 0.5.0

### Added — Database & Mobile Intelligence, protected schema changes, main-session model policy
- **`rmc database`** (`scripts/lib/database/`): secret-safe config detection (Web.config, appsettings, Laravel/NestJS `.env`, Prisma/TypeORM, Spring, Django, docker-compose) keeping only engine, host, database, profile and source; environment classification (LOCAL/DEV/TEST/STAGING/PRODUCTION/UNKNOWN from two agreeing signals or a user confirmation); SELECT-only catalog adapters for SQL Server, MySQL/MariaDB, PostgreSQL and SQLite (read-only `node:sqlite`); static fallback from SQL scripts; per-object knowledge under `.rmcontext/database/{backend,local}/` with hashes, provenance, history, removed-object marking and incremental refresh; procedure/table/view dependencies; application call-site mapping; `find` / `show`.
- **Read-only guard** (allow-list) on every discovery statement, in the CLI/adapter layer. A connection needs explicit approval of the exact target; credentials come only from environment variables the user names.
- **Protected changes:** DEV = migration only (no backup objects), STAGING = user-applied package (or a Claude apply with verified `_rmc_YYYYMMDD` backup + two approvals), PRODUCTION = strict (+ native backup attestation), UNKNOWN blocks. Approvals are exact phrases bound to environment, database, plan and stage; a mutation gate only sends statements registered in the approved plan; audit log holds hashes and metadata only; rollback script generated, never run automatically. `.rmcontext/backups/` is git-ignored.
- **`pre-bash` hook:** asks before approvals/protected steps, denies mutating database clients and, during an active change, direct clients and migration runners.
- **`rmc mobile`:** Android (Kotlin/Java), Flutter and React Native detection from build files and dependencies; architecture and state management with status, evidence, confidence and timestamp; local persistence kept separate from remote APIs; dependency chains from declared types only.
- **`rmc session-model`:** which model the MAIN session should run (Sonnet for coding, Opus for architecture/security) and what Claude Code allows: PARTIALLY SUPPORTED (user `/model`, `opusplan`); automatic switching by a plugin is UNSUPPORTED. RM Context recommends once per phase, never spawns an agent for a model, never records the desired model as the actual one.
- **Viewer:** new *Database Intelligence* and *Mobile* pages (tables with columns/keys/indexes, procedures with parameters and touched objects, application usage, limitations, protected changes; mobile architecture, state, data layer, chains). Metadata only: no definitions, no credentials.
- **CLAUDE.md policy 3:** direct-first, main-session model guidance, database & mobile knowledge, database safety.

### Added
- **Route intelligence engine** (`scripts/lib/routes/`). A dependency-free tokenizer and structural parser replace the C# and Java route regexes. Shared strategies cover declarative routing (class prefix + method annotations) and registration routing (fluent calls, groups, scopes, mounts, registration functions resolved through their call sites).
- **C#:** ASP.NET Core controllers (`[Route]` prefixes, `[controller]`/`[action]`/`[area]` tokens, `~/` overrides, inherited base-class prefixes, route constants across files, `[AcceptVerbs]`) and Minimal API (`MapGroup` nesting, extension-method endpoint modules, `MapMethods`, fallbacks, `RequireAuthorization`). Legacy ASP.NET Web API 2 (`RoutePrefix`, verb by method name, conventional `MapHttpRoute`/`MapControllerRoute` templates). WCF and ServiceStack are partial.
- **Java/Kotlin:** Spring MVC/WebFlux annotations (`${property}` placeholders from application.properties/yml, context-path, path and method arrays, superclass prefixes, constants; Feign and HttpExchange clients excluded), JAX-RS/Quarkus (`@ApplicationPath`), Micronaut. Spring WebFlux functional routing, Vert.x Web, servlets and Ktor are partial.
- **Route model:** each `api` node keeps its id (`api:METHOD /path`) and gains `attrs` for framework, language, original template, controller, handler, parameters, request body, response type, consumes/produces, auth, API version, resolution status and the unresolved parts (known prefix, expression, reason). Routes are `verified` only when fully resolved from literal or constant evidence.
- **Relationships:** route to handler (`calls`), handler to service through declared field/parameter types (interface to its single implementation), repository/DbSet to entity (`depends_on`, from explicit generic arguments), service to table/entity reads and writes. No links are made from name similarity.
- **Coverage report:** `scan.json` now has `routes` (per framework: files, controllers, registrations, routes, verified, inferred, unresolved, unsupported patterns with reasons) and `routeIdChanges`. When a route id changes because its prefix became resolvable, agent annotations and edges follow it.
- **`rmc api list | frameworks | coverage`:** routes with resolution status, the framework capability matrix, and the per-framework coverage from the last scan.
- Manifests: `pom.xml`, `build.gradle(.kts)` and `.csproj` dependencies. Rust (`rs`) files are indexed. Spring/Quarkus/Micronaut application config is read for path keys only; secret-like keys are never stored.
- Frameworks in other languages (Express, Koa, Hono, Next.js, NestJS, Fastify, Nuxt, AdonisJS, Laravel, Symfony, Slim, CodeIgniter, FastAPI, Flask, Django, DRF, Gin, Echo, Fiber, Chi, gorilla/mux, net/http, Rails, Sinatra, Axum, Actix, Rocket) are recognised and reported with an honest status. Their routes still come from the existing pattern extractor.

- **`/rmc` command namespace.** The plugin id is now `rmc`: commands are `/rmc:<name>`, agents `rmc:<agent>`, skills `rmc:<skill>`. The CLI (`rmc`), the marketplace (`rm-context-marketplace`) and `.rmcontext/` are unchanged. Upgrade: uninstall `rm-context@rm-context-marketplace`, install `rmc@rm-context-marketplace` (no alias is possible; keeping both runs every hook twice).
- **Foreground delegation guard (Claude Code hooks).** `PreToolUse` denies `rmc:*` agents with `run_in_background` and a second `rmc:*` agent while one is running (opt out per project with `delegation.background = "allow"`). `PostToolUse` reads the subagent transcript and reports the model that actually ran and Claude Code's `requestShape`; when it cannot be read, the main session is told not to claim the switch. Delegations are logged as metadata only.
- **Routing suggestions for ordinary prompts (suggest-first).** The `UserPromptSubmit` hook classifies each prompt in an initialized project with deterministic keyword rules (English + Indonesian), resolves agent and model with the existing `rmc route` precedence, and adds one line of about 50 tokens (`RM Context suggests <Role> (<Model>) for this <task>…`) when the confidence reaches `routing.suggestMinConfidence` (0.7). Greetings, general questions, simple lookups and non-project prompts get none. Claude decides whether to delegate: the hook never calls Agent, blocks or changes the model. `routing.autoSuggest` (default `true`) turns it off.
- **`rmc route --suggested`** reuses the current prompt's classification (same session via `RMC_SESSION_ID`, same project, current prompt, 30-minute expiry; a new prompt or Stop ends it). Route records gain `promptId`, `suggestionId` and `followsSuggestion`.
- **SessionStart delegation policy:** a short line stating that suggestions are advice, simple lookups are answered directly, delegation goes through `rmc route --suggested` in the foreground one agent at a time, and a direct answer claims no delegation. `autoContext.sessionContextTokens` default 250 → 330 to fit it.
- **`rmc route stats`** adds suggestions generated / followed / ignored (direct response) / different agent / outcome unknown, delegations through `rmc route` vs direct, actual model verified vs unavailable, foreground / background detected / mode unknown, and background or concurrent calls rejected. Events are linked by session, prompt and suggestion ids; a suggestion counts as followed only when the suggested agent ran for that prompt. No prompt text is stored.
- **Delegation notices.** `rmc route --session-model <model>` prints `Notice: Perpindahan ke model <Model>, karena bertugas sebagai <Role>.`, or a no-switch notice when the subagent uses the main session's model. `routing.noticeLanguage`: `id` (default) or `en`. Commands and the team-workflows skill show it before delegating and run roles one at a time.

- **Routing cost & token efficiency** (`scripts/lib/usage.mjs`, `scripts/lib/efficiency.mjs`, `config/pricing.json`).
  - Actual token usage is read from Claude Code transcripts: each API call is counted once by message id; sidechain lines are skipped for the main session.
  - Main-session usage is recorded per prompt (`turn-usage` event: the transcript slice from the prompt hook's offset to Stop), with delegation-issuing calls reported as overhead.
  - Each delegation records its subagent's cumulative usage, `agentId` and `delegationId`.
  - Pricing registry: exact model ids, 5m/1h cache-write and cache-read rates, Haiku 5.5 long-prompt, fast-mode and US-geo rates, effective date, source and pricing version. Historical usage is priced by date.
  - New commands `rmc route usage | cost | report` and `rmc route baseline --direct <P-id> --delegated <P-id>` (controlled comparison).
  - `rmc route stats` adds a Routing efficiency block.
  - Direct vs delegated savings are labelled Controlled, Observational estimate or Unavailable.
  - The delegation event's `tokens` field is unchanged, for compatibility. It is Claude Code's last-call context size, so analytics do not use it.
- **`/rmc:run <task>`: sequential workflows** (`scripts/lib/workflow.mjs`, `commands/run.md`, `rmc workflow …`).
  - **Planner.** Picks the smallest sufficient workflow: main session only, one specialist, analysis → implementation → verification, or security analysis → change → QA. Models come from the existing route precedence.
  - **State machine.** `plan` / `start` / `done` / `finish` / `cancel`.
    - A stage passes only with its agent's recorded run and a structured hand-off; verification also needs all acceptance criteria.
    - A failed verification returns to implementation (`maxQaLoops`); other failures are retried (`maxAttempts`) with at most one escalation.
    - A failed, missing or cancelled stage blocks completion.
  - **Knowledge packages per stage.** Role-specific retrieval, acceptance criteria, the previous hand-off, `[inferred]` / `[stale]` labels, delivered to the agent by a new **SubagentStart** hook. `retrieve()` gains `sections` and `changed` options.
  - **Hooks.**
    - PreToolUse allows only the started stage's agent and model during a workflow.
    - PreToolUse denies agents started inside RM Context agents (`agent_id` + `agent_type`).
    - A new **SubagentStop** hook records completion and full usage from `agent_transcript_path` and releases the one-agent lock. A background launch no longer releases it at PostToolUse or Stop, and PostToolUse and SubagentStop never log the same run twice.
    - Stop reports an unfinished workflow as unfinished.
  - **Telemetry.** `workflow` and `workflow-stage` events: requested and actual model, mode, attempt, escalations, package tokens, knowledge hits and stale references, hand-off tokens, failure reason. Turn usage is tagged with workflow ids. `rmc workflow status` shows per-stage tokens and cost.
  - **Write-back.** On finish: incremental re-scan of changed files, plus a summary hand-off linking the stage hand-offs.
  - New task category `verification` (Quick QA, low tier). Suggest-first for ordinary prompts is unchanged.
- **Routing benchmark & efficiency intelligence** (`scripts/lib/benchmark.mjs`, `config/benchmark.json`).
  - Routes record `origin` (`command`, `workflow`, `suggested`, `manual`; older records show `unknown`) and the user-requested model. Slash commands pass `--origin command`.
  - `rmc route stats` adds a routing distribution: routes by origin, agent, tier and model; suggestions, routes, delegations and direct responses counted separately, once per id; requested vs actual subagent model, with `unverified` when the transcript could not be read; delegation status and foreground/background.
  - Delegation events add `status` (`completed`, `started`, `failed`); failed `rmc:*` agent calls are logged. Analytics deduplicate events by id.
  - `rmc route benchmark run --task <file> --main-model <id>`: controlled pairs. It prints a plan and runs only with `--approve`, then starts two headless `claude -p` sessions in fresh copies of `git HEAD`, in alternating order. Usage is checked against Claude Code's totals. Only the task fingerprint, the commit and metrics are stored.
  - `rmc route benchmark evaluate`: manual quality evaluation (completion, criteria, correctness, missing findings, false positives, rework, acceptance); unequal quality invalidates the pair.
  - `rmc route benchmark [report]` and `rmc route efficiency`: pair validity with reasons, profiles per category / complexity / main model / subagent model, VERIFIED (≥ 3 valid pairs) / INSUFFICIENT DATA / NOT COMPARABLE. Token and cost savings are reported separately.
  - `rmc route` prints an advisory efficiency line once benchmarks exist; the routed model never changes.
  - **Changed:** `rmc route baseline` now records a *declared* pair, shown but never verified; older `baselines.jsonl` entries are read the same way. The observational estimate stays in `rmc route report` and is never used for recommendations. The savings line moved from `rmc route stats` to `rmc route report` / `rmc route benchmark report`.

### Added (CLAUDE.md strategies, existing-project policy update, targeted retrieval)
- **CLAUDE.md strategy.** `/rmc:init` asks Combine (recommended) or Replace Entire File when a CLAUDE.md exists without the section.
  - Replace needs `--confirm` and backs the old file up to `.rmcontext/backups/` first.
  - `--claude-md skip` cancels. The choice is remembered as `claudeMdStrategy`, and a remembered replace is never applied again.
  - The non-interactive default is combine.
  - The marker carries a policy version (`CLAUDE_POLICY` 2; the first section counts as 1). `rmc claude-md --check` reports `missing / unmanaged / outdated / modified / duplicate / current` and never writes.
- **Policy update for initialized projects.** `rmc init` (and `/rmc:init`) on an initialized project:
  - no longer rescans
  - updates the CLAUDE.md section and indexes only that file
  - keeps knowledge, documents, hand-offs, workflows, telemetry and model overrides
  - reports schema and extractor status, the kept overrides and stale files

  `rmc init --full` still rescans. Agents, skills, commands and the model policy come from the active plugin; nothing is copied into projects.
- **Targeted retrieval** for stage packages.
  - It ranks per subtask, acceptance criterion and explicit identifier, merges and deduplicates the hits, and adds reuse candidates from the dependency graph in a *Reusable implementations* section.
  - It respects confidence, freshness and lifecycle, and never pads results.
  - `rmc workflow context <W> <S> --diagnostics` shows the counts, identifiers, eliminations by reason, reuse candidates and package size. Telemetry keeps counts only.
- **Behaviour change.** `rmc init` on an initialized project used to run a full scan. It is now a policy update; use `--full` for the old behaviour. `rmc claude-md --check` now prints the state instead of a would-* action.

### Changed (role-aware model routing)
- **Complexity is not a model.** `rmc route` still computes a complexity tier (low/medium/high), and each agent's role policy (`roles` in `config/models.json`) now maps it to a model. Opus is a role's deep model, used only at high and only under that role's conditions (see the README table).
  - Senior Engineer codes on Sonnet at every complexity. Opus is only for security-critical analysis (`sensitive`) or a fundamental architecture trade-off in `security`, `adr` or `code-review` tasks.
  - Architecture and System Analyst use Opus for architecture, cross-system or ambiguous high-complexity work.
  - QA stays on Sonnet, with Opus for security-critical verification. Quick QA uses Haiku. Documentation and PM use Haiku for simple updates.
  - The Senior Engineer, System Analyst and Business Analyst agent defaults are now Sonnet.
- The main session model is never a routing source, so an Opus main session no longer implies Opus subagents. An explicit `--model` (for example "use Opus for every stage") and project `models` / `tiers` / `roles` overrides still win.
  - Routes and workflow stages record `basis` (why the model was chosen). `tier` is always the task's complexity, never derived from the model.
  - The workflow report adds Tier, Escalated and a *Model selection* list. Requested and actual (transcript) models stay separate.
- New signal `sensitive` (auth, authorization, payment, credentials, personal data), at least medium.
- Escalation goes to the next stronger model the role allows, and a role on its strongest model is not escalated. A context-gap reason is refused: retry with context instead. `workflow done --escalate` with such a reason retries on the same model.
- **Changed test expectations** (they encoded "high = Opus"):
  - complex feature, refactor and security-touching fixes → Sonnet
  - the notice for an Opus session delegating to the Senior Engineer is now a switch to Sonnet
  - the BA default is Sonnet
  - a trivial Senior Engineer change is Sonnet, not Haiku
  - the security workflow's implementation stage is Sonnet
  - the benchmark advisory for a user-chosen model is looked up by the task's complexity

### Added (CLAUDE.md, knowledge-first and reuse-first policy)
- `rmc init` writes a managed RM Context section (about 2,000 characters; roughly 560 tokens by the 3.5 characters per token estimate) into the project's `CLAUDE.md`, creating the file if needed. It covers knowledge first, provenance and freshness, reuse first, the smallest correct change, `/rmc:run` only for multi-stage work, hand-offs, and verification gates.
  - It uses stable markers and is idempotent. Duplicates collapse, and user text and line endings are kept.
  - New command: `rmc claude-md [--check]`. Opt out with `--no-claude-md` or `claudeMd: false`. The global `CLAUDE.md` is never touched.
- **Workflow packages:**
  - The knowledge-first policy: start from the hand-off and knowledge, re-read only `[stale]` files, and inspect only what is not covered.
  - Targeted exploration when no knowledge matches.
  - A smallest-correct-change, reuse-first implement goal, and a duplication check in the verify goal.
- **Implement hand-offs:** `reused`, `created`, `inspected` and `explorationReason`. Created names that already exist in the graph are flagged to QA and in the report as possible duplicates.
- **Agent instructions:** Senior Engineer, System Analyst, QA, Quick QA, `software-engineering` (*Reuse first, smallest correct change*, with examples) and `team-workflows` (role policy table, knowledge-first order).

### Fixed (`/rmc:run` planner and verification gate, smoke test W-mw5509w45u2)
- A task that asked to analyse, implement a documentation fix and verify it was planned as a single Documentation stage, with no verification, although it had 3 acceptance criteria. The cause: the first matching keyword ("dokumentasi") decided the category, and `stagesFor('doc-update')` ignored code and criteria.
  - The planner now reads the task's intents (analysis, change, verification, code reference): analysis + change + verification → System Analyst → Senior Engineer → Quick QA.
  - Documentation stays one stage unless it touches code or asks for verification.
  - Acceptance criteria always add a verification stage.
- Engine invariant: `rmc workflow finish` refuses a workflow with criteria, an implementation stage or a planned verification stage until a verification stage has passed and every criterion is verified.
  - Criteria are verified only by the QA hand-off's per-criterion `{id, status, evidence}` results. A `pass` verdict, a successful agent run or a `--criteria` count alone no longer pass verification.
  - Per-criterion results and evidence are kept in the workflow (`checks`) and the QA hand-off, and shown by `rmc workflow status` / `finish`.

### Fixed (routing and retrieval)
- Long prompts got no retrieved context: relevance was diluted by every known word in the prompt. It is now normalised over the six most discriminative terms, and repeated words weigh more (1 + ln tf). `minimumRelevance` is unchanged, and short prompts score as before. Fixtures: `tests/fixtures/prompts/retrieval.json`.
- Tests that ran hooks without a `cwd` wrote telemetry into this repository's own `.rmcontext/state`. Hooks in tests now run from an isolated temp directory, `RMC_SESSION_ID` is cleared, and each hook test file asserts that the repository telemetry is unchanged.
- English notices now read `Switching to <Model>, acting as <Role>.` and `Delegating to <Role> with <Model>, same as the main session model.` An unverifiable delegation reports `Delegation started; actual model not yet verified.`

### Fixed (independent QA re-run, TC-002)
- Agent edges on C#/Java/Kotlin methods were orphaned after the switch to class-qualified ids, and unchanged files kept stale extraction (mixed ids, B3 not applied). `EXTRACTOR_VERSION` 5 re-reads every file once, and old `file#method` ids are remapped to the single `file#Class.method` (reported as `functionIdChanges`).
- Actions inherited by a Spring controller whose prefix uses `${…}` kept the raw placeholder and were marked verified.
- EF Core mappings missed PascalCase schema tables (`CREATE TABLE Invoices`); table matching is now case-insensitive and skips tables that differ only by case.
- Entity → table conventions are per framework, exact, inferred and carry their reason in the evidence `ref`: JPA singular snake_case, Laravel/Rails plural snake_case, Django `<app>_<model>`; SQLAlchemy without `__tablename__` gets no edge. Explicit names (`$table`, `@Table`, `__tablename__`, `[Table]`, `ToTable`) are verified and exact. JPA entities no longer link to a pluralised table.

### Fixed (independent QA, TC-001)
- Spring profile files (`application-<profile>.yml`) no longer override the default configuration; their values are recorded as conditional alternatives (`attrs.conditional`).
- Java/C# actions with generic, nested, qualified, array or `object` return types, or named `list`/`select`/`export`/…, were dropped.
- JAX-RS sub-resource classes are composed through their locator's return type (inferred) instead of appearing as verified root routes.
- Agent edges on routes whose id changes are remapped by declaration identity (`attrs.declKeys`), including multi-prefix controllers and path arrays.
- Partial C# controllers take the `[Route]` of their other part; without one the route is partial/inferred.
- Actions inherited from abstract base controllers (ASP.NET Core, Spring) are listed for each derived controller.
- `${placeholder}` keys resolve regardless of their name; entity → table links in the C#/Java linker come only from `[Table]`, `ToTable` or the DbSet name.
- Path parameters with nested-brace constraints; clearer reason for local variables in route templates.

### Changed
- C#/Java/Kotlin method nodes are class-qualified: `function:<file>#Class.method`.
- `EXTRACTOR_VERSION` 5: the next refresh re-reads every file once.
- C# and Java methods are indexed as `function` nodes (`file#Method`, with `@line` when a name repeats in a file).

## 0.4.1 — 2026-11-06

### Added
- **Document reader in the viewer.** Technical documents open inside the viewer instead of as raw Markdown.
- **Mermaid diagrams render offline.** ERDs, flowcharts, sequence diagrams and Gantt charts render in documents and notes. Mermaid 10.9.1 (MIT) is vendored with the plugin and embedded only when a diagram exists; it is evaluated only when a diagram is shown.
- Notes and documents render tables, ordered lists, quotes and code blocks.

### Fixed
- Notes saved with a UTF-8 BOM showed their first heading as plain text.
- The generator version recorded in manifests now matches the plugin version.

## 0.4.0 — 2026-11-06

### Added
- **Smart project viewer.** A new single-file offline viewer.
  - Tailwind CSS compiled at build time and inlined (no CDN), with design tokens for light and dark themes.
  - A sidebar with inline Lucide-compatible icons. Sections without data are hidden.
  - Responsive: icon rail on tablets, drawer and bottom-sheet details on phones.
  - Hash routing and keyboard navigation.
- **File explorer.** A virtualized tree with lazy folders. Each file shows symbols, imports and their resolution, importers, routes, tables, external calls, callers, callees, requirements, tests, documents and evidence, each labelled Extracted or Inferred.
- **Explorers** for modules, functions and classes, dependencies, APIs, database, infrastructure, integrations and business requirements. Also new pages for agent hand-offs, notes, search, context status and settings.
- **Eight graph views** (Project, Module, File dependency, Function call, API, Database, Infrastructure, Traceability) plus Everything. Tools:
  - find in graph, type and provenance filters
  - focus on a neighbourhood of 1–3 hops, with the option to hide unrelated nodes
  - shortest-path tracing and change impact, using the same rules as `rmc impact`
  - back and breadcrumb history
  - an accessible list view
- **Graph performance.**
  - Canvas rendering with batched paths and viewport culling.
  - Graphs over 1,200 nodes start as module clusters.
  - Deterministic typed-array layout in a Web Worker, with a synchronous fallback. Layouts are cached per view.
  - Indexed, debounced search.
  - At 10,000 nodes (headless Edge): layout 1,406 → 284 ms (synchronous worst case), redraw 14.2 → 3.9 ms, search 11.9 → 4.9 ms, select 43 → 18 ms. Load time rose from 202 to 349 ms because more data is embedded.
- **Automatic context (Claude Code hooks).**
  - `SessionStart` adds a compact summary.
  - `UserPromptSubmit` adds deterministic, budgeted retrieval: 1,200 tokens by default, nothing for irrelevant prompts.
  - `PostToolUse` records file changes.
  - `Stop` runs one coalesced incremental refresh. It uses git status or fingerprints, never a full scan, and never loops on `.rmcontext/` writes.
  - Approved documents are flagged for review, never rewritten.
  - Configure it with `autoContext` in `.rmcontext/config.json`. Disable it with `"enabled": false` or `RMC_AUTO_CONTEXT=0`.
- `rmc context "<prompt>"` and `rmc context status` diagnostics.
- `rmc refresh` reports a graph delta and short-circuits when nothing changed.

### Changed
- `graph.html` now opens `index.html#/graph`. Old `#graph`-style links still work.
- `RMC_CLI` is exported with forward slashes, so it works when sourced by bash on Windows.

## 0.3.0 — 2026-11-06

Evolves RM Context from a prompt-only codebase-notes plugin into a platform-independent project intelligence toolkit for AI coding agents, with Claude Code as the first supported integration.

*Your Project Intelligence Layer for AI Coding Agents.* · [rmtemplate.com](https://rmtemplate.com)

### Added
- **Adaptive model routing (`rmc route`).** Agent and model are chosen separately. Task categories map to low (Haiku), medium (Sonnet) and high (Opus) tiers, and complexity signals raise or lower the tier.
  - Precedence: explicit user model → project override → agent override → adaptive tier → agent default, with a configured fallback for unsupported models.
  - Escalation moves one subtask up a tier, carries the previous hand-off, and is capped by `maxEscalations`.
  - Metadata-only metrics via `rmc route stats`.
  - Every delegating command now routes through it.
- **Platform-independent positioning.** The core CLI is documented as the primary entry point. New `docs/INTEGRATION_ARCHITECTURE.md` describes the core/adapter split. Per-platform pages in `docs/integrations/` cover Claude Code (Supported) and Codex, OpenCode and Cursor (Planned), with an honest compatibility matrix.
- **Deterministic core CLI** (`scripts/rmc.mjs`, zero dependencies). It handles incremental scanning (size/mtime/sha1 cache), secret, binary and ignore handling, and regex extractors for 9 languages plus schema, package-manifest and infrastructure formats. It also builds an evidence-backed graph and generates INDEX, tech stack and a scan report.
- **Unified Project Intelligence Graph:**
  - 38 node types across business, system, engineering, infrastructure and project layers; 12 relationship types
  - evidence (file, line range, type) and confidence (verified/inferred/manual) on every item
  - validation, safe upsert, stale tracking and orphan removal
  - search, impact analysis and RTM
- **Professional team agents:** `business-analyst`, `system-analyst`, `project-manager`, `senior-engineer` and `devops-engineer`, alongside the rewritten `architecture`, `qa`, `documentation` and `quick-qa`. Team playbook skills are preloaded via `skills` frontmatter, and a shared `team-workflows` contract covers IDs, hand-offs and workflows A–D.
- **Documentation engine:** a 49-template catalog with required sections and validation rules (`basis`, `evidence`, `mermaid`, `plan`, `adr-status`, placeholders, secrets). It includes a JSON registry, versioning with history snapshots and an approval gate (`--approved-by`). Graph-backed prefill covers ERD, API, data dictionary, RTM, infrastructure, CI/CD, env matrix, RAID, WBS, Gantt and roadmap. Export to HTML (always), PDF (Chromium-family browser) and DOCX (pandoc).
- **Project management:**
  - `plan.json` schema with strict validation (dates, durations, finish-to-start, cycles, completion evidence)
  - progress that separates verified, reported and planned
  - CPM critical path
  - Gantt as SVG and interactive HTML, plus Mermaid
  - WBS, roadmap and a rule-based health report
- **Offline interactive viewer:**
  - overview, knowledge graph, and business/system/code/infrastructure/project views
  - search, type and confidence filters, a detail panel with evidence links (file and VS Code)
  - client-side impact highlighting, Gantt, documents, light/dark themes
- **Commands:** `discover`, `feature`, `assess`, `impact`, `ba`, `sa`, `pm`, `engineering`, `devops`, `document`, `fsd`, `sipoc`, `srs`, `erd`, `gantt`, `roadmap`, `rtm`, `adr`, `review`, `architecture`, `project-health`, `routing`.
- **Model routing:** `config/models.json` defaults, per-project overrides in `.rmcontext/config.json`, and fallback to the main session model.
- **SessionStart hook** exporting `RMC_CLI` for subagents.
- **Website:** links to [rmtemplate.com](https://rmtemplate.com) in the README, plugin metadata and viewer.
- **New brand identity:** an R drawn as a graph, with logo, light/dark lockups, icon, banner and 512px PNG listing icon; `docs/BRANDING.md`.

### Changed
- `config/models.json` gains `routing`, `tiers`, `supportedModels` and `tasks`. Existing `agents` defaults and project `models` overrides are kept.
- `init`, `refresh`, `status`, `find`, `graph`, `viewer` and `link` now run real CLI operations instead of asking the model to generate artifacts. The viewer is no longer hand-written by the LLM on every call.
- Graph vocabulary aligned to the new schema. Legacy 0.2.0 graphs are migrated automatically on refresh.
- The marketplace entry uses `source: "./"`; the placeholder GitHub username is gone.

### Removed
- `agents/coding.md`, merged into `senior-engineer`.
- The duplicate root `marketplace.json`.

### Known limitations
See *Limitations* in the README. In short:
- Extraction is regex-based. Router mount prefixes and route groups are not resolved.
- The viewer is a snapshot.
- PDF and DOCX export need external tools.
