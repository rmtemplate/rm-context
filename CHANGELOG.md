# Changelog

## Unreleased

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
