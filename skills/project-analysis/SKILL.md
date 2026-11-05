---
name: project-analysis
description: Core Intelligence — initialize or refresh a repository's .rmcontext knowledge base with the deterministic rmc scanner, then add evidence-backed architecture, convention and business-rule notes. Use for first-time analysis, refreshes after code changes, and repository understanding.
---

# Core Intelligence

The scanner does the mechanical work deterministically. Agents add judgement on top of it.

## What `rmc init` / `rmc refresh` do (no LLM involved)
- List files using git (`ls-files`, honouring every `.gitignore`) or a fallback walker. Apply `.rmcontextignore` and the `ignore` patterns in `.rmcontext/config.json`.
- **Always exclude**:
  - secrets and credentials: `.env*` except example templates, keys and certificates, `.npmrc`/`.pypirc`/`.netrc`, credential and service-account files, tfstate/tfvars, database dumps and backups
  - dependency, build and cache directories, binaries and lockfiles, and files over `maxFileBytes`
- Re-read **only files whose size, mtime or hash changed** (`state/files.json`). Unchanged files reuse cached extraction.
- Extract with regex extractors:
  - code: imports, classes, functions and components (with line ranges); routes (Express-style, Next.js, Laravel, Flask/FastAPI, Django, Spring, Go routers, Rails, ASP.NET)
  - data: SQL, Laravel migrations and Prisma schemas (with columns and foreign keys); ORM entities; SQL and Prisma table reads and writes; outbound HTTP integrations
  - packages and infrastructure: package manifests; Dockerfiles, compose services and networks, CI pipelines, Kubernetes, Terraform, nginx; env-template variable **names**
- Rebuild the scan-owned graph and merge agent and manual knowledge. Agent items whose evidence file changed are marked `stale`.
- Write `manifest.json`, `INDEX.md` (generated block), `context/tech-stack.md`, `state/scan.json` (coverage, exclusions, limitations) and the viewer.

## What you add (architecture agent)
After a first scan, or when the generated facts show significant change:
1. Read `INDEX.md`, `context/tech-stack.md`, `state/scan.json` and `rmc graph stats`.
2. Read entry points, the main modules and representative files.
3. Write or update (never overwriting user-authored text, so check first):
   - `context/overview.md`: what the system does, its main users, its modules. Cite evidence.
   - `context/architecture.md`: layers, request flow, data flow and integrations, with a mermaid diagram and `path:line` citations.
   - `context/conventions.md`: naming, structure, error handling and testing patterns, with example locations.
   - `context/business-rules.md`: rules found in code (validation, calculations, state transitions), each with `path:line` and marked as code-observed.
4. Upsert what the scanner cannot see:
   - `feature` nodes grouping files and APIs
   - module descriptions
   - `calls` or `depends_on` edges you verified by reading, marked `verified` with evidence
5. Record limitations: dynamic routing, reflection, generated code, and areas you did not inspect.

## Rules
- Never read or record secret values.
- Never copy whole source files into context. Summarise and cite.
- Never claim a partial analysis is complete. State the coverage.
- Prefer `rmc refresh` over re-reading the repository. Use `rmc refresh --full` only if the cache is corrupted or the extractor changed.
