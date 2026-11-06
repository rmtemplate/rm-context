---
name: software-engineering
description: Senior Software Engineer playbook for RM Context — verifying existing code before proposing change, technical design, ADRs, implementation plans, implementation, code review, security and performance review, refactoring plans, technical debt register, test strategy and engineering standards.
user-invocable: false
---

# Software Engineering Playbook

Follow the `team-workflows` contract.

## Verify before proposing
1. `rmc find <terms>` and `rmc impact "<node or file>"` to find the real code paths.
2. **Read the code** you will discuss or change: the handlers, models, tests and configuration. Cite `path:line`.
3. Identify existing conventions (framework, structure, error handling, validation, logging, test style) and follow them.
4. **Do not introduce a new framework or dependency** when the stack already covers the need. If one is needed, write an ADR with alternatives.

## Reuse first, smallest correct change
Work in this order: `.rmcontext/` knowledge, then targeted source inspection, then broader exploration only when necessary. Do not repeat source inspection an earlier stage already did.

Before writing something new, search the knowledge (`rmc find`) and the code for what already does it:
- **Frontend:** components, layouts, composables, API clients, stores, form/table/pagination/modal/dialog/dropdown components, validation, design tokens and CSS utilities.
- **Backend:** controllers, services, repositories, DTOs, entities, guards/middleware/decorators, validators/transformers, exception handling, export/upload/download services.
- **Shared code:** types, interfaces, enums, constants, formatters, date helpers, API response types, error definitions, configuration.
- **Database:** entities, schema, migrations, relations, indexes, query builders, repository functions.

Rules:
- Reuse it when its behaviour fits. Extend it when it nearly fits, after checking its consumers (`rmc impact`). Do not change shared code in a way that breaks another consumer.
- Do not re-define an existing DTO, type, interface, enum or constant, and do not copy business logic into a controller or the frontend when a service owns it.
- Do not add a component for a slightly different look, a service for logic that already has a home, a wrapper without a clear benefit, or a helper used once.
- No duplicate validation, state or API calls. No defensive code for conditions the existing contract already guarantees. No new file when the code belongs in an existing one. No dependency for something the stack already provides.
- If the existing code cannot be used, say why before writing the alternative.

Keep readability, type safety, needed error handling, authorization, business rules and the project's conventions. Short code must stay easy to read: no code golf.

These examples show the principle. Adapt them to the project's own abstractions.

```ts
// Use the project's API composable when it already handles auth, base URL, errors and mapping
const { data } = await useApi('/members', { query: { year: 2026 } })
// …not fetch('/api/members?year=2026') plus hand-written ok checks and json unwrapping.

// Use the existing DTO and service
async findAll(query: MemberQueryDto) { return this.memberService.findAll(query) }
// …not an inline { page?: number; limit?: number; search?: string } that re-defines MemberQueryDto,
// and not a new database query in the controller when membershipService.findById(id) exists.
```

```vue
<!-- The shared table already handles loading, pagination and errors -->
<BaseDataTable :columns="columns" :rows="members" :loading="loading" />
```

Report what you reused (with file), what you created and why, the files you changed, and any duplication you could not avoid.

## Deliverables → template types
| Deliverable | Type |
|---|---|
| Technical design | `technical-design`. "Existing Implementation" must cite evidence |
| Architecture decision | `adr`. Also upsert a `decision` node `ADR-xxx` linked `related_to` the affected modules |
| Implementation plan | `implementation-plan`. Paste relevant `rmc impact` rows; map steps to plan.json task ids |
| Code review report | `code-review`. Severity-ranked findings with `file:line`, plus checks run |
| Refactoring plan | `refactoring-plan` |
| Technical debt register | `tech-debt`. Also upsert `issue` nodes with `attrs.kind: "tech-debt"` |
| Test strategy / test cases | `test-strategy` / `test-cases` |
| Engineering standards | `engineering-standards`. Observed conventions with example locations |

## Implementing
- Small, verifiable steps. Run the project's own tests, lint, typecheck and build. Discover them from manifests (`context/tech-stack.md` lists npm scripts).
- Preserve public API contracts, data compatibility and business rules. For breaking changes, write a migration plan and get user confirmation.
- Afterwards:
  - `rmc refresh`
  - upsert `implements` edges from the changed files to the requirement ids, and `tested_by` edges to the new tests
  - add task evidence (commit sha or files) in plan.json, then `rmc pm validate`
- Report exactly which checks ran and their results. Never claim tests pass without running them.

## Review checklist
Correctness and edge cases · input validation · authentication and authorisation · injection (SQL, command, template) · secrets in code · error handling and logging (no sensitive data) · concurrency and idempotency · performance (N+1 queries, unbounded loops or queries, missing indexes) · backward compatibility · test coverage of changed behaviour · consistency with requirements (RTM) · needless duplication or abstraction (an existing component, function, DTO or type could have been reused).
