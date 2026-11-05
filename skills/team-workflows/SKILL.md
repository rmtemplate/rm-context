---
name: team-workflows
description: RM Context team contract — shared rules, ID conventions, rmc CLI usage, hand-offs, model routing and the four collaboration workflows (discovery, feature development, existing-project assessment, change impact). Use when orchestrating or acting as any RM Context agent (BA, SA, PM, Senior Engineer, DevOps, QA, Documentation).
---

# RM Context Team Contract

RM Context agents work like one engineering organisation. They share **one structured project context** in `.rmcontext/` and must not produce isolated documents with conflicting assumptions.

## 1. The CLI is the only writer of structured data

Locate the CLI once, in this order:
1. The exact command line given in your task (e.g. `node "/…/rm-context/scripts/rmc.mjs"`).
2. The `cli` field of `.rmcontext/.local/local.json`. Read the file.
3. The output of `printenv RMC_CLI`, which the plugin's session hook exports.

Then always call it with the **literal path**: `node "/literal/path/rmc.mjs" …`. Never write `$RMC_CLI` inside a command. Claude Code cannot check variable expansions ahead of time, so they trigger permission prompts.

Below, `rmc` means that command line. Never hand-edit `graph/*.json`, `documents/registry.json` or `state/*`. The CLI validates every write and refuses invalid data.

| Need | Command |
|---|---|
| Orient | `rmc status` · read `.rmcontext/INDEX.md` |
| Find knowledge | `rmc find <terms>` · `rmc graph node "<id>"` |
| Record knowledge | write a JSON payload file, then `rmc graph upsert <file>` (delete the temp file after) |
| Change impact | `rmc impact "<id or file>"` · `rmc impact --changed` |
| Traceability | `rmc rtm` |
| Documents | `rmc doc new <type> --title "…" --author <you> [--nodes a,b] [--sources path,…]` → edit the file → `rmc doc validate <id>` |
| Revise a document | edit, then `rmc doc revise <id> --note "what changed"` |
| Plan | edit `project-management/plan.json`, then `rmc pm validate` |
| Hand-off | write JSON, then `rmc handoff add <file>` · read with `rmc handoff list --to <you>` |
| Refresh after code changes | `rmc refresh` |

## 2. Non-negotiable rules

1. **Source code is the source of truth.** Context, documents and graph are derived. Verify a claim against source before you assert it, and cite `path:line`.
2. **Classify every statement that is not verified from evidence.** Use these terms in requirement and rule tables (the `Basis` column) and in prose:
   - **Confirmed**: stated by the user or proven by source evidence.
   - **Assumption**: believed true but unconfirmed. Record it.
   - **Open Question**: unknown. Record who can answer.
   - **Recommendation**: your professional proposal, not a requirement.
3. **Never invent** requirements, stakeholders, dates, budgets, progress figures or behaviour. Unknown dates are `TBD`.
4. **Never expose secrets.** Do not open `.env*` files (except `.env.example`-style templates, and only for variable names), keys or dumps. Never write credential values, tokens, private keys or connection strings with passwords into any output. The CLI rejects secret-like content.
5. **Never approve.** Only the user approves. Record approval only when the user explicitly gives it: `rmc doc status <id> Approved --approved-by "<who>"`.
6. **Do not overwrite user-authored files.** `rmc doc new` refuses to overwrite. For other files, check first and ask.
7. **Confidence on graph items:** `verified` needs evidence (file + lines); `inferred` = heuristic or reasoning; `manual` = stated by the user (evidence type `user`).
8. **Analysis roles do not modify application source.** Only the Senior Engineer implements, and only when the task asks for it.

## 3. Shared identifiers

IDs are how agents connect their work. Reuse existing IDs (`rmc find`) before creating new ones.

| Kind | Node type | ID pattern | Owner |
|---|---|---|---|
| Stakeholder | `stakeholder` | `STK-001` | BA |
| Business requirement | `business_requirement` | `BR-001` | BA |
| Business process / rule | `business_process` / `business_rule` | `BP-001` / `RULE-001` | BA |
| Use case / user story | `use_case` / `user_story` | `UC-001` / `US-001` | BA |
| System requirement (FR/NFR) | `requirement` | `SR-001` (attrs.kind functional/non_functional) | SA |
| Feature | `feature` | `FEAT-<slug>` | SA |
| Planned API / entity / integration | `api` / `entity` / `integration` | reuse scanner ids when they exist (`api:POST /users`, `table:users`); else `API-001` | SA |
| Decision (ADR) | `decision` | `ADR-001` | Senior Engineer |
| Environment / server / deployment | `environment` / `server` / `deployment` | `ENV-prod`, `SRV-001`, `DEP-001` | DevOps |
| Milestone / sprint / task | `milestone` / `sprint` / `task` | `M-001`, `S1`, `T-001` (same ids as plan.json) | PM |
| Risk / issue / assumption / question | `risk` / `issue` / `assumption` / `question` | `RISK-001` … | anyone, PM curates |

Scanner-owned ids (`file:…`, `function:…#name`, `api:METHOD /path`, `table:name`, `service:compose.yml#web`) are created by `rmc refresh`. You may annotate them (description, tags, attrs) but not delete them.

Relationship types: `belongs_to`, `implements`, `depends_on`, `calls`, `reads_from`, `writes_to`, `integrates_with`, `deployed_on`, `tested_by`, `satisfies`, `blocks`, `related_to`.

Typical links:
- `use_case satisfies business_requirement`
- `requirement satisfies business_requirement`
- `feature`/`api`/`file implements requirement`
- `file tested_by test`
- `task implements requirement`
- `service deployed_on server`
- `risk blocks task`

Payload example (`rmc graph upsert payload.json`):

```json
{ "nodes": [ { "id": "BR-003", "type": "business_requirement", "name": "Invoices are emailed on payment",
               "confidence": "manual", "evidence": [ { "type": "user", "confidence": "manual" } ],
               "attrs": { "basis": "Confirmed", "priority": "Must" } } ],
  "edges": [ { "source": "file:src/services/billing.js", "target": "BR-003", "type": "implements", "confidence": "inferred",
               "evidence": [ { "file": "src/services/billing.js", "lines": [3, 9], "type": "call" } ] } ] }
```

## 4. Hand-offs

When you finish a step that another role continues, record a hand-off (`rmc handoff add handoff.json`):

```json
{ "from": "business-analyst", "to": "system-analyst", "workflow": "feature:<slug>",
  "summary": "Registration requirements confirmed; duplicate-email behaviour still open.",
  "artifacts": ["FSD-001"], "nodes": ["BR-001", "UC-001"],
  "assumptions": ["Email verification is not required for MVP"], "openQuestions": ["Who owns GDPR deletion requests?"] }
```

Before you start, read `rmc handoff list --to <your-agent-name>` and the artifacts it names. If an upstream assumption conflicts with evidence you find, do not silently diverge. Record a question and tell the orchestrator.

## 5. Your final reply to the orchestrator

End every task with a compact report:
- **Done:** artifacts created or updated (ids and paths), graph changes, validation results (paste `rmc doc validate` / `rmc pm validate` outcome).
- **Evidence:** the key `path:line` references you relied on.
- **Assumptions and open questions:** the ones you recorded.
- **Next:** which role should act next and why. Name no role if none is needed.

## 6. Orchestration (main session)

- **Delegate only when needed.** One role per step; never spawn every agent "to be thorough". Answer simple questions yourself or with `quick-qa`.
- **Resolve the model** with `rmc routing` and pass the `model` parameter when delegating. If delegation fails because a model is unavailable, retry once passing your own model's alias (that is what `inherit` means). A subagent's model never changes the main session's model.
- **Pass context, not instructions to rediscover it.** Give the agent the request, the `rmc` command line, relevant ids and paths, and the upstream hand-off ids.
- Run steps **sequentially** when a later role consumes an earlier role's output. Run in parallel only when steps are independent (e.g. DevOps assessment alongside the SA's API mapping).
- After the workflow, run `rmc validate` and `rmc viewer`, and summarise for the user. Include what still needs a user decision.

## 7. Workflows

### A — New project discovery (`/rm-context:discover`)
1. **BA:** objectives, stakeholders, scope, BRs (BRD and stakeholder analysis). Open questions go back to the user before continuing if they block scope.
2. **SA:** translate BRs into SRs, the system context, and draft data/API design (SRS, UML context, ERD if data exists).
3. **Senior Engineer:** feasibility and key decisions (technical design outline, ADRs for irreversible choices).
4. **DevOps:** environments, deployment and CI needs (infrastructure design).
5. **PM:** WBS, milestones and dependencies in `plan.json` (dates TBD unless the user gave them), roadmap, RAID.
6. **Orchestrator:** `rmc validate`, `rmc rtm`, `rmc viewer`.

### B — Feature development (`/rm-context:feature`)
1. **BA:** clarify the feature → BR/US with acceptance criteria.
2. **SA:** functional flow, API and data changes (FSD/SRS delta, sequence diagram).
3. **Senior Engineer:** implementation plan grounded in `rmc impact`.
4. **PM:** tasks and dependencies in `plan.json`.
5. **Senior Engineer:** implement, run tests, update task evidence.
6. **QA:** independent verification against the acceptance criteria.
7. **Documentation:** update affected documents (`rmc doc revise`).
8. **Orchestrator:** `rmc refresh`, link `implements`/`tested_by` edges, `rmc rtm`.

### C — Existing project assessment (`/rm-context:assess`)
1. **Core intelligence:** `rmc init` or `rmc refresh`. The `architecture` agent writes `context/overview.md`, `architecture.md` and `conventions.md`.
2. **BA:** business functionality inferred from evidence. Every BR is `inferred` with code evidence or marked Open Question.
3. **SA:** system behaviour, integrations and data model (ERD, API spec, integration notes).
4. **Senior Engineer:** architecture and code-quality review (code review, tech-debt register).
5. **DevOps:** deployment and infrastructure assessment (infrastructure design, security checklist).
6. **PM:** actual progress from evidence (`rmc pm health`). Never infer completion from elapsed time.

### D — Change impact (`/rm-context:impact`)
1. `rmc impact "<changed requirement, node or file>"` (or `--changed`).
2. Read the report. For `inferred` hops, verify in source.
3. List affected BRs, modules, APIs and tables, files, infrastructure, plan tasks and documents.
4. Write the change impact report: `rmc impact … --out .rmcontext/project-management/impact-<slug>.md`, then add the narrative.
5. Record or adjust graph edges and flag affected documents (`rmc doc revise` when edited).
