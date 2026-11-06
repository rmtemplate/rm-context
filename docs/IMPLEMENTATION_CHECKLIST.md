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
| Test suite (42 tests) | ✅ | `npm test` |
| Strict plugin validation | ✅ | V (also inside the suite) |
| README, ARCHITECTURE, CHANGELOG, LICENSE, marketplace metadata | ✅ | T (README documents every command; versions consistent) |

## Adaptive model routing
| Item | Status | Verified by |
|---|---|---|
| Agent and model selection separated (`rmc route`, task categories) | ✅ | T |
| Tiers low/medium/high, complexity signals, override and de-escalation | ✅ | T |
| Precedence: user → project → agent override → adaptive → default; unsupported → fallback | ✅ | T |
| Escalation with hand-off reuse, limits, no repeats | ✅ | T |
| Metadata-only metrics (`rmc route stats`) | ✅ | T |
| Commands route through `rmc route` | ✅ | T; R (`/rm-context:fsd`: the main session on Opus routed the BA to `sonnet`, and the subagent ran on claude-sonnet-5-5) |
| Main session model never reported as changed | ✅ | T |

## Platform positioning
| Platform | Core CLI | Agents and routing | Status |
|---|---|---|---|
| Terminal (standalone CLI) | ✅ verified by the test suite | — | Supported |
| Claude Code | ✅ | ✅ verified headless | Supported |
| OpenAI Codex | manual use, untested in platform | ⬜ | Planned |
| OpenCode | manual use, untested in platform | ⬜ | Planned |
| Cursor | manual use, untested in platform | ⬜ | Planned |

Docs: README (platform-independent), `docs/INTEGRATION_ARCHITECTURE.md`, `docs/integrations/*.md`. All links and CLI examples were checked.

## Smart viewer, graph performance, automatic context
| Item | Status | Verified by |
|---|---|---|
| Single offline file, compiled Tailwind and tokens, no CDN or network calls | ✅ | T (`viewer.test.mjs`) |
| Sidebar groups with inline icons; empty sections hidden | ✅ | T; B |
| Overview with real metrics | ✅ | B (screenshot) |
| File explorer: virtualized lazy tree; symbols, imports, routes, tables, callers, callees, requirements, tests, docs, evidence; Extracted vs Inferred | ✅ | T (headless DOM check); B |
| Explorers (modules, code, dependencies, API, database, infrastructure, integrations, requirements), documents, Gantt, hand-offs, notes, search, context status, settings | ✅ | T (no script errors on main routes at 1400 px and 390 px) |
| Eight graph presets plus Everything; find, filters, zoom, pan, fit, reset, focus and depth, hide unrelated, path tracing, impact, back and breadcrumbs, list view | ✅ | T (core functions); B |
| Responsive: icon rail (tablet), drawer and bottom sheet (phone), keyboard and focus rings | ✅ | B (screenshots at 1400, 820 and 390 px) |
| Baseline benchmark before changes; after: repo, 2k and 10k | ✅ | M (`tests/bench/.out/baseline*.json`, `after.json`) |
| Canvas batching and culling, module clusters, deterministic cached layout, Web Worker plus fallback, indexed search | ✅ | T (determinism and 10k timing); M (worker answered on `file://` in Edge: 3,487 nodes in 289 ms) |
| Viewer impact equals `rmc impact` | ✅ | T |
| SessionStart summary; no `.rmcontext/` handled | ✅ | T; R |
| Prompt retrieval: relevant only, budget respected, prompt never stored, secrets never injected | ✅ | T; R (121 tokens, 5 ms) |
| `autoContext` config; disable via config or `RMC_AUTO_CONTEXT=0`; CLI unaffected | ✅ | T |
| PostToolUse change capture; Stop coalesced targeted refresh; git and fingerprint modes; no loop; no full scan; approved docs flagged only | ✅ | T; R |
| `rmc context` diagnostics; Context Status page | ✅ | T; B |
| Tests pass on Linux (WSL) and Windows | ✅ | T (63/63 on Windows) |

Legend for this section: T = automated test, R = real Claude Code headless session, B = headless browser, M = measured.

## Route intelligence

| Item | Status | Evidence |
|---|---|---|
| Audit before changes (`docs/ROUTE_INTELLIGENCE_AUDIT.md`), adapter interface, normalized route model | ✅ | doc |
| Tokenizer + structural parser, declarative and registration strategies, capability registry | ✅ | T |
| ASP.NET Core controllers + Minimal API (nested MapGroup, extension modules), Web API 2 conventional routes | ✅ | T (`tests/fixtures/routes/dotnet-shop`) |
| Spring MVC/WebFlux annotations, JAX-RS, Micronaut; partial WebFlux functional, Vert.x, servlets, Ktor | ✅ | T (`spring-shop`, `jvm-misc`) |
| Route > handler > service > repository > entity relationships from declared types only | ✅ | T |
| Coverage report in scan.json, `rmc api`, route id remap for agent edges, incremental re-resolution | ✅ | T (CLI refresh test) |
| Independent QA fixes B1–B11 (TC-001): QA suite 29/29, per-bug regression tests, both in `npm test` | ✅ | T (`routes-qa.test.mjs`, `routes.test.mjs`) |
| Independent QA re-run (TC-002): new fixtures `qa2/`, B12–B16 found and fixed (function-id remap + `EXTRACTOR_VERSION` 5, inherited `${…}`, case-insensitive EF tables, per-framework entity conventions with reasons) | ✅ | T (`routes-qa2.test.mjs` 20/20) |
| `/rmc` namespace (plugin id `rmc`), all references migrated, no alias (documented upgrade path) | ✅ | T (`delegation.test.mjs`); R (headless `claude -p /rmc:status --plugin-dir .`: 29 `/rmc:*` commands, 9 `rmc:*` agents loaded) |
| Foreground, one-at-a-time delegation guard; switch notice; actual model from the subagent transcript | ✅ | T (`delegation.test.mjs`); R (headless run: Sonnet main → `rmc:quick-qa` on `claude-haiku-5-5`, `requestShape: foreground`) |
| Suggest-first routing for ordinary prompts: deterministic classifier, ~50-token suggestion, SessionStart policy, `rmc route --suggested` reuse (session + project + prompt, 30 min), `routing.autoSuggest` | ✅ | T (`suggest.test.mjs`); R (3 headless runs: direct answer, followed via `rmc route --suggested` → `rmc:quick-qa` on `claude-haiku-5-5` foreground, general prompt without suggestion) |
| `rmc route stats`: suggestions generated/followed/ignored/unknown, route vs direct delegations, verified vs unavailable model, foreground, rejected background/concurrent | ✅ | T (`suggest.test.mjs`); R (stats of the live runs) |
| Long-prompt retrieval (top-6 normalisation + tf weighting), fixtures `tests/fixtures/prompts/retrieval.json` | ✅ | T (`suggest.test.mjs`, `autocontext.test.mjs`) |
| Test telemetry isolation (isolated cwd, `RMC_SESSION_ID` cleared, repo telemetry fingerprint asserted per hook test file) | ✅ | T |
| Dev files tracked in git (`tests/` without `tests/bench/.out/`, `package.json`, `docs/ARCHITECTURE.md`, this checklist); fixture file `tests/fixtures/node-app/ignored-dir/x.js` force-added because the fixture's own `.gitignore` ignores it and `core.test.mjs` needs it present | ✅ | T (fresh-copy `npm test` from the tracked file set) |
| Viewer smoke test under WSL with Windows Chrome: the test built `file:///wsl.localhost/…` from the UNC path, so Chrome loaded nothing and the run failed. Now it uses `file://wsl.localhost/…`; assertions unchanged. The run takes about 47 s through WSL interop | ✅ | T (`viewer.test.mjs` 9/9 on WSL + Windows Chrome) |
| Routing benchmark & efficiency: route origin, distribution (route ≠ suggestion ≠ delegation, deduped by id), requested vs actual model with `unverified`, delegation status; controlled benchmark runs (plan without `--approve`, clean `git HEAD` copy, separate headless sessions, alternating order, usage checked against `modelUsage`); manual evaluation; validity reasons; VERIFIED / INSUFFICIENT DATA / NOT COMPARABLE profiles; token vs cost savings apart; advisory recommendation that leaves routing unchanged | ✅ | T (`benchmark.test.mjs`, stand-in `claude`); R (see final report) |
| Routing cost & token efficiency: transcript usage collector (once per message id, sidechains skipped), per-prompt main usage + delegation usage joined by prompt id, pricing registry (exact ids, dated versions, cache/long-prompt/fast/geo rates), cost, direct vs delegated (controlled / observational / unavailable), `rmc route usage \| cost \| report \| baseline`, stats block | ✅ | T (`efficiency.test.mjs`); R (live headless runs, see final report) |
| Structural adapters for JS/TS, PHP, Python, Go, Ruby, Rust (recognised only; the older pattern extractor still supplies routes) | ⬜ | none |
| Viewer API Explorer columns/filters for framework, status, confidence; unresolved parts in node details | ⬜ | none |

## Remaining work (not done)
- ⬜ Codex, OpenCode and Cursor adapters (see docs/INTEGRATION_ARCHITECTURE.md).
- ⬜ Run the full multi-agent workflows (`discover`, `feature`, `assess`) end to end on a real project and tune the prompts from the results.
- ⬜ AST-based extractors (e.g. TypeScript compiler API, tree-sitter) to resolve router mount prefixes, route groups and precise call graphs.
- ⬜ Viewer: load time grew with the embedded data (10k nodes: 202 → 349 ms). Lazy-decoding file details would recover it.
- ⬜ Prompt retrieval is lexical. Measure precision on real projects and tune `minimumRelevance` and the synonym lists.
- ⬜ An eval suite (`claude plugin eval`) for agent behaviour: classification discipline, no approvals, no secret exposure.
- ⬜ Publishing: push to GitHub, then `claude plugin tag` for the release tag.
