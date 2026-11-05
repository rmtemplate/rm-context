# Changelog

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
