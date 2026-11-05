# Implementation Checklist

Status: ✅ done and verified · 🟡 done with a documented limitation · ⬜ not done

Verification legend:
- **T**: automated test in `tests/`
- **R**: real headless Claude Code run
- **V**: `claude plugin validate --strict`
- **M**: manual visual check (headless Chrome screenshot)

## Phase 1 — Foundation
| Item | Status | Verified by |
|---|---|---|
| Repository audit (`docs/PRODUCT_AUDIT.md`) | ✅ | — |
| Plugin architecture: CLI core + agents + skills + commands + hook | ✅ | V, T |
| Branding: logo, light/dark, icon, banner, PNG icon, `docs/BRANDING.md` | ✅ | T (vector-only, 512px), M |
| Standardised `.rmcontext/` schema and migration from 0.2.0 | ✅ | T |
| Agent communication contract (IDs, hand-offs, rules) | ✅ | R (hand-off recorded by BA) |

## Phase 2 — Professional teams
| Item | Status | Verified by |
|---|---|---|
| BA, SA, PM, Senior Engineer, DevOps agents (+ QA, Documentation, Quick-QA, Architecture) | ✅ | V, T (consistency); R (BA end to end) |
| Team playbook skills preloaded into agents | ✅ | R (documentation agent reported both skills in context) |
| Workflows A–D as commands (`discover`, `feature`, `assess`, `impact`) | 🟡 | V, T. Only BA has run end to end; the multi-role workflows have not been run in full |
| Model routing config, per-project override, fallback | ✅ | T, R (override `business-analyst: sonnet` applied) |

## Phase 3 — Documentation engine
| Item | Status | Verified by |
|---|---|---|
| 49 templates with required sections and rules | ✅ | T |
| Registry metadata, versions, history, status lifecycle, approval gate | ✅ | T |
| Graph-backed prefill (ERD, API, dictionary, RTM, infra, CI/CD, env, RAID, WBS, Gantt, roadmap) and regenerate | ✅ | T |
| Export HTML | ✅ | T |
| Export PDF | 🟡 | Manual run on WSL with Windows Chrome. Needs a Chromium-family browser |
| Export DOCX | 🟡 | The clear error without pandoc was verified; conversion itself is untested here (pandoc not installed) |

## Phase 4 — Project management
| Item | Status | Verified by |
|---|---|---|
| plan.json schema and validation | ✅ | T |
| Progress: verified / reported / planned | ✅ | T |
| Critical path (CPM) | ✅ | T |
| Gantt SVG + HTML (filters, today, planned vs actual, dependencies, milestones) | ✅ | T, M |
| Roadmap, WBS, Mermaid gantt, health report | ✅ | T |

## Phase 5 — Unified graph and viewer
| Item | Status | Verified by |
|---|---|---|
| 38 node types and 12 edge types with evidence and confidence | ✅ | T |
| Impact analysis (CLI report and viewer highlight) | ✅ | T |
| RTM (honest about inferred test links) | ✅ | T |
| Viewer: overview, graph, layer views, project, documents, search, filters, detail, evidence links, zoom/pan, legend, stats | ✅ | T (data embedding and script parse), M |

## Phase 6 — Validation and release
| Item | Status | Verified by |
|---|---|---|
| Test suite (31 tests) | ✅ | `npm test` |
| Strict plugin validation | ✅ | V (also inside the suite) |
| README, ARCHITECTURE, CHANGELOG, LICENSE, marketplace metadata | ✅ | T (README documents every command; versions consistent) |

## Remaining work (not done)
- ⬜ Run the full multi-agent workflows (`discover`, `feature`, `assess`) end to end on a real project and tune the prompts from the results.
- ⬜ AST-based extractors (e.g. TypeScript compiler API, tree-sitter) to resolve router mount prefixes, route groups and precise call graphs.
- ⬜ Viewer performance for graphs well above ~5k nodes (Web Worker layout, level-of-detail).
- ⬜ An eval suite (`claude plugin eval`) for agent behaviour: classification discipline, no approvals, no secret exposure.
- ⬜ Publishing: push to GitHub, then `claude plugin tag` for the release tag.
