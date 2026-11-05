---
name: documentation-engine
description: How RM Context documents are created, filled, validated, versioned, approved and exported (Markdown + Mermaid + JSON registry metadata, HTML/PDF/DOCX export). Use whenever creating or updating any professional document in .rmcontext/documents/.
---

# Documentation Engine

## Lifecycle
```
rmc doc new <type> --title "…" --author <agent> [--nodes BR-001,api:POST /users] [--sources src/a.js,db/schema.sql]
   → .rmcontext/documents/<layer>/<ID>-<slug>.md   (status Draft, version 1)
edit every section (keep the "## Heading" lines; guidance lives in <!-- guide --> comments)
rmc doc validate <ID>                          → fix every error
rmc doc status <ID> "Under Review"             → only when it validates
rmc doc status <ID> Approved --approved-by "…" → ONLY after explicit user approval
rmc doc revise <ID> --note "…"                 → after editing an existing doc: snapshots vN to documents/.history/<ID>/, bumps version; revising an Approved doc returns it to Under Review
rmc doc regenerate <ID>                        → refresh the graph/plan-generated block (new version)
rmc doc export <ID> --format html|pdf|docx     → documents/exports/
```
`rmc doc types` lists all templates with their rules. Statuses: Draft · Under Review · Approved · Superseded · Archived.

## Metadata
`documents/registry.json` holds the structured metadata for every document: id, type, title, path, layer, status, version, author agent, created and updated timestamps, approvedBy/At, `sources` (repository files), `nodes` (graph ids) and `history`. The table between `rmc:meta` markers at the top of each Markdown file is regenerated from the registry. Do not edit it by hand.

`sources` and `nodes` drive traceability:
- `rmc refresh` flags a document **needs review** when one of its source files changes.
- `rmc impact` lists documents linked to affected nodes.

## Validation rules (enforced by `rmc doc validate`)
- Every required section is present and non-empty. Comments don't count as content.
- No placeholder text (`{{…}}`, "lorem ipsum", "TODO: fill", "[insert …]").
- No secret-like content.
- Type rules:
  - `basis`: requirement/rule tables have a **Basis** column with Confirmed / Assumption / Open Question / Recommendation.
  - `evidence`: at least one `path/file.ext:line` citation or registered sources.
  - `mermaid[:kind]`: a Mermaid diagram (of that kind) is present.
  - `plan`: plan.json exists.
  - `adr-status`: the Status section states Proposed, Accepted, Deprecated or Superseded.

## Generated (prefilled) types
`erd`, `api-spec`, `data-dictionary`, `rtm`, `infrastructure-design`, `cicd-spec`, `env-matrix`, `raid-log`, `wbs`, `gantt` and `roadmap` start with content generated from the graph or plan, between `rmc:generated` markers. Keep that block. Add analysis around it. If the data was wrong, fix the graph or plan, then run `rmc doc regenerate <ID>` (it snapshots the old version and bumps the version) rather than editing generated rows.

## Writing standard
- Write for a reader who was not in the conversation: define terms, state scope, and link ids.
- Prefer tables for requirements, rules, risks and inventories. Put prose where reasoning is needed.
- If information is unavailable, write it as an **Open Question** or **Assumption**. Never use filler.
- Mermaid: quote labels with spaces or special characters; keep each diagram small enough to read.

## Customising templates
A project can add or override types in `.rmcontext/templates/catalog.json` (same shape as the plugin's `templates/catalog.json`). It can also supply a full Markdown body in `.rmcontext/templates/<type>.md`, where `{{title}}` and `{{id}}` are substituted. Validation still uses the catalog's required sections.

## Export notes
- **HTML:** always available. Mermaid renders when the page can load the pinned `mermaid@10.9.1` from jsDelivr; offline, diagrams stay readable as source.
- **PDF:** needs Chrome, Chromium or Edge (auto-detected, or set `RMC_CHROME`).
- **DOCX:** needs `pandoc`. Mermaid diagrams appear as code blocks.

When a tool is missing, the CLI says so. Report that to the user rather than claiming the export succeeded.
