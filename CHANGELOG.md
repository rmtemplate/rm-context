# Changelog

## 0.3.0 — 2026-11-06

Evolves RM Context from a prompt-only codebase-notes plugin into a project-intelligence and engineering-team platform.

### Added
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
- **New brand identity:** an R drawn as a graph, with logo, light/dark lockups, icon, banner and 512px PNG listing icon; `docs/BRANDING.md`.

### Changed
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
