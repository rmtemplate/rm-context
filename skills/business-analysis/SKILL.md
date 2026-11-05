---
name: business-analysis
description: Business Analyst playbook for RM Context — eliciting objectives, stakeholders, requirements, processes and rules, and producing BRD, FSD, SIPOC, process flows, stakeholder analysis, use cases, user stories, acceptance criteria, business rules catalog, gap analysis, scope and RTM with Confirmed/Assumption/Open Question/Recommendation classification.
user-invocable: false
---

# Business Analysis Playbook

Follow the `team-workflows` contract. Your job is to turn business intent into **traceable, classified requirements** that the System Analyst can design against.

## Sources, in order of authority
1. What the user said in this conversation → **Confirmed**.
2. Existing approved documents (`rmc doc list`) → Confirmed, citing the document id.
3. Source code evidence → **Confirmed** for "the system does X" (cite `path:line`). Only **Assumption** for "the business wants X".
4. Your domain knowledge → **Recommendation** or **Assumption**, never Confirmed.

Before writing, run `rmc find <domain terms>` and `rmc handoff list --to business-analyst`.

## Elicitation checklist
- Business objective: problem, desired outcome, measurable target, deadline driver.
- Stakeholders: roles affected, decision-makers, approvers (roles; personal names only if the user gave them).
- Scope: in scope / out of scope / undecided.
- Processes: trigger, actors, steps, decisions, exceptions, outputs.
- Rules: calculations, validations, eligibility, limits, state transitions.
- Non-functional: volumes, response times, availability, security/privacy, audit, accessibility, localisation.
- Constraints, assumptions, risks and dependencies.

If a blocking question is unanswered (scope or objective unclear), stop and return the questions instead of drafting a speculative document.

## Deliverables → template types
| Deliverable | `rmc doc new` type | Notes |
|---|---|---|
| Business Requirement Document | `brd` | BR table: `ID, Requirement, Priority, Basis, Source` |
| Functional Specification | `fsd` | FR table traces to BR ids |
| SIPOC | `sipoc` | 4–7 process steps |
| Business process flow | `process-flow` | mermaid `flowchart`, As-Is with evidence and To-Be |
| Stakeholder analysis | `stakeholder-analysis` | power/interest |
| Use case | `use-case` | one use case per document |
| User stories | `user-story` | INVEST stories with Given/When/Then |
| Acceptance criteria | `acceptance-criteria` | include negative paths |
| Business rules catalog | `business-rules` | "Enforced in" column cites code or is empty |
| Gap analysis | `gap-analysis` | current (evidence) vs target |
| Scope definition | `scope` | |
| RTM | `rtm` | prefilled from the graph, so record links first |

## Recording in the graph
For every requirement, rule, process, stakeholder and use case you document, upsert a node with the same id. Set `attrs.basis` to the classification and `attrs.priority` when known. Link it:
- `use_case satisfies business_requirement`
- `business_rule related_to business_requirement`
- existing code that already implements a requirement: `file|api implements BR-xxx`. Use confidence `inferred` unless the code unambiguously implements it, and always include evidence.

Then run `rmc rtm` to check coverage and list untraced requirements under *Gaps*.

## Quality bar
- Each requirement is a single, testable, implementation-neutral statement ("The system shall …"), not a solution.
- No requirement exists without a source (user, document or evidence).
- Every Assumption has a validation action; every Open Question has someone to ask.
- `rmc doc validate <id>` passes before you hand off.
- Hand off to `system-analyst` with the requirement ids and open questions.
