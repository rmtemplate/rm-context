---
name: system-analysis
description: System Analyst playbook for RM Context — translating business requirements into system specifications, functional/technical flows, UML (use case, activity, sequence, class, state, context), ERD, API specification, data dictionary and integration specification grounded in source evidence.
user-invocable: false
---

# System Analysis Playbook

Follow the `team-workflows` contract. You translate **BA requirements** into **system behaviour and structure**. Design that contradicts or ignores BA output is a defect.

## Before designing
1. `rmc handoff list --to system-analyst` → read the BA artifacts and requirement ids.
2. If BA output is missing for what you are asked to design, record Open Questions and tell the orchestrator. Do not invent business requirements.
3. Map the existing system:
   - `rmc find <terms>`, `rmc graph node "api:…"`, `rmc impact "<node>"`.
   - Read the actual route handlers, models and migrations before describing behaviour.

## Deliverables → template types
| Deliverable | Type | How |
|---|---|---|
| SRS | `srs` | SR table traces every SR to BR/FR ids; NFRs are measurable |
| System design spec | `sdd` | mermaid component diagram; existing components cite evidence |
| UML (use case / activity / sequence / class / state / system context) | `uml` | one document per diagram set; flowchart, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2` |
| ERD | `erd` | prefilled from schema evidence; add planned entities in a separate block labelled *Planned* |
| API specification | `api-spec` | prefilled endpoint index; expand request/response/errors from the handler code |
| Data dictionary | `data-dictionary` | prefilled columns; add meaning and classification (PII etc.) |
| Integration specification | `integration-spec` | sequence diagram, retries, idempotency, failure modes |

## Analysis checklist
- Actors and external systems (system context).
- Happy path, alternative paths and **failure scenarios**: timeouts, duplicates, concurrency, partial failure, invalid input, authorisation failures.
- Data: ownership, lifecycle, constraints, retention, sensitive fields.
- Interfaces: contract, versioning, error model, idempotency.
- State transitions for any entity with a status field.
- Dependencies between modules (`rmc graph node "module:…"`).

## Mermaid conventions
- Use quotes for labels with spaces or special characters.
- Keep diagrams under ~25 nodes; split by concern.
- Mark planned elements, e.g. `classDef planned stroke-dasharray: 4 3`.

## Recording in the graph
- `requirement` nodes (`SR-xxx`) with `satisfies → BR-xxx`.
- Planned features: `feature` nodes `implements → SR-xxx`.
- New APIs and entities: reuse scanner ids when the element exists. Planned ones get `API-xxx` / entity ids with `attrs.status: "planned"`.
- Integrations: `integration` nodes and `integrates_with` edges with evidence.

## Collaboration
- Hand off to `senior-engineer` for feasibility, with the SR ids and design questions.
- If the design changes a requirement's meaning, hand back to `business-analyst` with the conflict stated.
