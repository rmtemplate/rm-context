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
Correctness and edge cases · input validation · authentication and authorisation · injection (SQL, command, template) · secrets in code · error handling and logging (no sensitive data) · concurrency and idempotency · performance (N+1 queries, unbounded loops or queries, missing indexes) · backward compatibility · test coverage of changed behaviour · consistency with requirements (RTM).
