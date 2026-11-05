---
name: project-management
description: Project Manager playbook for RM Context — plan.json schema, WBS, Gantt, roadmap, sprint planning, RAID, RACI, status and health reports, release plans and change control, with progress measured from verified implementation evidence (never from elapsed time).
user-invocable: false
---

# Project Management Playbook

Follow the `team-workflows` contract. **The plan is data**: `.rmcontext/project-management/plan.json`. Documents (WBS, Gantt, roadmap) are generated from it, so fix the data, not the rendered output.

## plan.json schema
```json
{
  "schemaVersion": 2,
  "project": { "name": "…", "start": "YYYY-MM-DD | TBD" },
  "sprints": [ { "id": "S1", "name": "Sprint 1", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } ],
  "tasks": [ {
    "id": "T-001", "name": "…", "description": "…", "parent": "P1 | null",
    "owner": "role or team", "start": "YYYY-MM-DD | TBD", "end": "YYYY-MM-DD | TBD",
    "duration": 5, "dependencies": ["T-000"], "priority": "Critical|High|Medium|Low",
    "status": "Planned|In Progress|Blocked|Completed|Cancelled", "milestone": false,
    "actualStart": "YYYY-MM-DD", "actualEnd": "YYYY-MM-DD", "progress": 0,
    "evidence": [ { "type": "commit|file|test|pr|user", "ref": "sha | path | URL | who confirmed", "note": "…" } ],
    "sprint": "S1", "nodes": ["BR-001", "api:POST /users"], "blockedBy": "reason"
  } ]
}
```
- Duration is in calendar days, inclusive of start and end. Milestones have start = end and duration 0.
- Dependencies are finish-to-start: a task starts after every dependency ends.
- `nodes` links tasks to requirements and code. This is what makes `rmc impact` reach the plan.

## Rules
1. **No invented dates.** Use dates only from the user or from evidence (commit dates for completed work: `git log -1 --format=%cs <sha>`). Everything else is `TBD`.
2. **No unverified completion.** A task is `Completed` only with evidence: a commit, file, test or PR, or `user` with who confirmed it. Find evidence with `git log --oneline -- <path>`, `rmc find`, test files and the graph.
3. **Actual vs planned are different numbers.** Report `rmc pm progress`: *verified* (evidence exists), *reported* (adds in-progress estimates) and *planned* (schedule baseline). Never present planned or elapsed time as progress.
4. Status meanings:
   - `Planned`: not started.
   - `In Progress`: work evidence exists or the owner said so.
   - `Blocked`: needs `blockedBy` or an incomplete dependency.
   - `Completed`: evidence and `actualEnd`.
5. Run `rmc pm validate` after every edit and fix all errors. It checks ids, dates, durations, finish-to-start consistency, cycles, parent envelopes, sprint references and completion evidence.

## Deliverables
| Deliverable | How |
|---|---|
| WBS | build the task hierarchy (`parent`), then `rmc doc new wbs` |
| Gantt | `rmc pm gantt` → `project-management/gantt.svg` and `gantt.html` (filters, today line, planned vs actual, critical path). Document form: `rmc doc new gantt` |
| Critical path | computed automatically when durations and dependencies are known; unscheduled leaf tasks are set aside and listed |
| Roadmap / milestones | milestones in plan.json, then `rmc doc new roadmap` |
| Sprint plan / backlog | `sprints[]` and task `sprint`, then `rmc doc new sprint-plan` |
| RAID log | `risk`/`assumption`/`issue`/`question` nodes in the graph, then `rmc doc new raid-log` |
| RACI | `rmc doc new raci`: exactly one Accountable per row |
| Project charter, release plan, change request log | `project-charter`, `release-plan`, `change-log` |
| Status report | `rmc doc new status-report`, pasting `rmc pm progress` |
| Health report | `rmc pm health` (RAG computed from explicit rules) |

## Change control
For each change request, run `rmc impact "<node>"`. Record the CR in the change log with the impact report path. Update affected tasks and dates only after the user accepts the change.
