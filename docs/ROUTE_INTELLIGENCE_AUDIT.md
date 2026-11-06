# Route Intelligence — Audit and Design

Status: Phase 1 deliverable (audit, adapter interface, normalized route model). Implementation notes for later phases are at the end. Every statement about current behaviour cites the 0.4.1 source.

## 1. Current implementation (0.4.1, before this change)

### 1.1 Pipeline

| Stage | Where | What it does |
|---|---|---|
| Inventory | `scripts/lib/ignore.mjs` (`listFiles`) | Walks the repository, honours `.gitignore`, built-in ignores (`node_modules`, `vendor`, build output…), `config.ignore`, a 1 MB size cap, and secret-path rules. |
| Language detection | `scripts/lib/extract.mjs:14` (`langOf`) | By extension/basename only. `java` covers `.java .kt .kts`; `cs` is C#. No Rust, no Kotlin-specific handling. |
| Per-file extraction | `scripts/lib/extract.mjs:80-396` (`EXTRACTORS`) | One regex extractor per language. Output `{decls, imports, routes, tables, dbUses, http, deps, infra, env, meta}` is cached per file in `.rmcontext/state/files.json` with size/mtime/sha1 (`scan.mjs:313-328`). |
| Graph build | `scripts/lib/scan.mjs:70` (`buildScanGraph`) | Rebuilds the whole scan-owned graph **in memory from the cache** on every scan. No file I/O. Agent/manual knowledge is merged back (`scan.mjs:345-363`). |
| Incremental refresh | `scan.mjs:304` (`scan({only})`), `context.mjs:267` (`applyPending`) | Only changed files are re-read and re-extracted; the graph is then rebuilt from the cache. `EXTRACTOR_VERSION` (`scan.mjs:9`) invalidates the cache when extractors change. |
| Viewer | `scripts/lib/viewer.mjs:14` (`FILE_KEYS`), `scripts/viewer/app.js:138` (`LISTS.apis`), `app.js:335` (`fileInfo`) | The API Explorer lists `api` nodes with method, path, location, link count and provenance. File details list `x.routes` from the cache and look up `api:${method} ${path}`. |
| Docs | `scripts/lib/docs.mjs:70` | The API spec template lists api nodes, implementing files and `calls` handlers, with a note that prefixes are not resolved. |

Important property for this work: because the graph is rebuilt from cached per-file facts, **anything resolved during graph build (cross-file constants, base classes, registration-function call sites) is re-evaluated automatically when any contributing file changes**, without re-reading unchanged files.

### 1.2 Route extraction coverage

| Language | Extractor | Patterns recognised (`extract.mjs`) | Prefix composition |
|---|---|---|---|
| JS/TS | `:95` | `app|router|server|api|routes?.get/post/…('literal')` (name-based receiver), Next.js `app/**/route.ts` verb exports (`:98`), Next.js `pages/api/**` (`:101`) | None. `app.use('/api', router)` ignored. |
| PHP | `:128` | `Route::get|post|…|resource|apiResource('path', [Ctrl::class, 'action'])` with handler resolution through PSR-4 (`scan.mjs:213-220`) | None. `Route::prefix()->group()` ignored. |
| Python | `:156-158` | `@x.get|post|…|route|api_route('path', methods=[…])`, Django `path()/re_path()` in `urls.py` | None. `APIRouter(prefix=)`, `include_router`, Blueprint `url_prefix`, Django `include()` ignored. |
| Go | `:170` | `.GET|POST|…|Get|Post|…|HandleFunc|Handle("literal")` on any receiver | None. Gin/Echo/Fiber `Group()`, Chi `Route()/Mount()` ignored. |
| Java/Kotlin | `:186-188` | `@Get|Post|Put|Patch|DeleteMapping("literal")` + the **first** `@RequestMapping("…")` in the file as base | Only one class prefix per file. No `@RequestMapping` methods, no no-arg mappings, no arrays, no JAX-RS, Micronaut, WebFlux functional, Vert.x, servlets. |
| Ruby | `:200-202` | `get|post|… 'path'` and `resources :x` in `routes.rb` | None. `namespace`/`scope` ignored; `resources` emitted as method `RESOURCE`. |
| C# | `:213` | `[HttpGet|Post|Put|Patch|Delete("literal")]` only | **None.** `[Route]` on the controller, `[HttpGet]` without a template, `[controller]` tokens, Minimal API (`MapGet`, `MapGroup`), legacy Web API are all missed. The spec's `UsersController` example yields only `GET /{id}`. |
| Rust | — | Not indexed (`langOf` has no `.rs`). | — |

Verified by running the current extractor mentally against the request's examples: the C# controller example produces one route (`GET /{id}`) instead of three; the Minimal API example produces zero; the Spring example produces `GET /api/users/{id}` only (no-arg `@GetMapping`/`@PostMapping` are missed).

### 1.3 Framework recognition

`scan.mjs:14` (`FRAMEWORKS`) maps manifest dependencies to names for the tech-stack note only: Express, Fastify, Koa, NestJS, Next.js, Nuxt, Laravel, Symfony, Django, Flask, FastAPI, Rails, Gin, Echo, Fiber, plus non-routing libraries. **No .NET or JVM manifest is read** (`.csproj`, `pom.xml`, `build.gradle(.kts)` are not manifests in `langOf`), so ASP.NET Core, Spring, Quarkus, Micronaut are never detected. Framework detection is not connected to route extraction at all: extractors run by language regardless of framework.

### 1.4 Graph representation of routes

- Node: `api:${METHOD} ${path}`, type `api`, `origin: scan`, `confidence: verified`, `attrs {method, path}`, evidence `{file, lines:[l,l], type:'route'}` (`scan.mjs:209-211`).
- Edges: `file implements api` (verified), `api belongs_to module` (inferred), PHP only: `api calls function` (handler, verified).
- `LEGACY_NODES` (`graph.mjs:30`) already migrates 0.2.0 `route`/`endpoint` node types to `api`.

### 1.5 Known limitations and missing relationships

1. Regex over raw text: comments and string contents are not excluded (a commented-out `[HttpGet("x")]` produces a route).
2. No prefix composition except one Spring `@RequestMapping` per file; no route groups, mounts, constants, base classes, configuration prefixes.
3. Every route is marked `verified` even when the path is known to be partial; there is no `resolutionStatus`, no record of what could not be resolved.
4. No language/framework attribution, no parameters, no request/response types, no auth.
5. Handlers are linked only for Laravel. C#/Java methods are not even extracted as declarations, so a handler node cannot exist.
6. No route → service → repository → entity chain. File-level `reads_from`/`writes_to` exist only from SQL strings and Prisma calls.
7. When a framework is present but its routing style is unsupported, the scanner silently returns zero routes.

### 1.6 Existing extractors that are retained

The JS (Express name-based receivers, Next.js file routes), PHP Laravel, Python decorator/Django, Go verb, and Ruby `routes.rb` extractors work for literal declarations and are covered by existing tests (`tests/core.test.mjs`, `tests/extract.test.mjs`). They are kept as the fallback/primary for those ecosystems and wrapped by framework adapters so their output gains framework, confidence and resolution metadata. Their paths are preserved exactly so existing `api:` ids stay stable.

## 2. Parser strategy

| Option | Precision | Cost | Decision |
|---|---|---|---|
| Roslyn (C#) | Full semantic model | Needs the .NET SDK, a separate process, project restore; slow; not available on most machines | **Not used by default.** Recorded as a possible optional adapter. |
| JavaParser / javac tree API | Full AST | Needs a JVM and a jar | **Not used by default.** |
| tree-sitter (node bindings or WASM) | Concrete syntax tree for many languages | Native build or ~1–3 MB WASM per grammar; adds npm dependencies; breaks the zero-dependency contract | **Not bundled.** Status: Planned optional parser. |
| Hand-written tokenizer + structural parser (plain JS) | Exact on lexical structure: strings, comments, nesting, annotations/attributes/decorators, class/method boundaries, call chains, lambda bodies | Zero dependencies, deterministic, a few ms per file | **Chosen as the default.** |
| Regex over raw text | Literal-only | Lowest | Kept as a supplementary fallback for file-based conventions (Next.js, Nuxt), Django `urls.py`, Rails `routes.rb`, Laravel. |

Reasoning: route declarations in every prioritised framework are **syntactic** (attributes/annotations with string literals, fluent calls with literal templates, constants). Resolving them needs correct lexical handling (strings vs comments vs code), bracket matching and scope (which class/method/lambda a call is in), not type inference. A tokenizer-based structural parser gets these right without a runtime. Where real semantics are needed (e.g. a prefix computed at runtime), the engine records the unresolved expression instead of guessing. An optional external parser can be added later behind the same adapter interface; the fallback is always the built-in parser, so a missing SDK never breaks a scan.

Fallback limitations (documented in README): no type inference beyond declared field/parameter types, no overload resolution, no macro/source-generator expansion, no evaluation of non-constant expressions, partial-class merging by name only.

## 3. Proposed architecture

```
scripts/lib/routes/
  tokenize.mjs     Lexer for C-family languages, Python, Ruby, PHP (strings, comments, interpolation flags, lines)
  structure.mjs    Structural parser: brackets, annotations/attributes/decorators, classes, members, parameters,
                   fields, call chains, assignments, constants, lambda/block scopes
  model.mjs        Normalized route model: PathExpr, path joining/normalisation, parameter extraction,
                   API version detection, confidence and resolution status
  registry.mjs     Framework capability registry: id, language, status, detection markers, patterns, limitations
  engine.mjs       Per-file entry point: language → detected frameworks → adapters → route facts
  resolve.mjs      Graph-build-time resolver: cross-file constants, base-class prefixes, registration-function
                   call sites, configuration prefixes, conventional routes, handler→service→repository→entity links,
                   coverage report
  adapters/
    csharp.mjs     aspnet-core (controllers + Minimal API), aspnet-webapi (legacy); detection for ServiceStack, Nancy, WCF
    java.mjs       spring (MVC + WebFlux annotations), webflux-functional, jax-rs (incl. Quarkus/RESTEasy), micronaut,
                   vertx, servlet; Kotlin Spring/Micronaut; Ktor
    js.mjs         express, nestjs, fastify, koa, hono, nextjs, nuxt
    php.mjs        laravel, symfony
    python.mjs     fastapi, flask, django
    go.mjs         net/http, gin, echo, fiber, chi
    ruby.mjs       rails, sinatra
    rust.mjs       axum, actix-web, rocket
```

Conceptual mapping to the requested engine:

| Requested component | Implementation |
|---|---|
| Language Detection | `langOf` (extended with Rust) |
| Framework Detection | `registry.mjs` markers evaluated per file (imports/usings, annotations, base types, factory calls) + manifest dependencies (`.csproj`, `pom.xml`, `build.gradle`) for project-level reporting |
| AST / Parser Layer | `tokenize.mjs` + `structure.mjs` |
| Framework Adapter Registry | `registry.mjs` |
| Route Normalizer | `model.mjs` |
| Route Relationship Resolver | `resolve.mjs` |
| Evidence Validator | `model.mjs` (`finalize`): confidence is `verified` only when every path part came from a literal or exactly-resolved constant/call site; graph validation (`graph.mjs`) still enforces evidence on verified items |
| Graph Integration | `scan.mjs` `buildScanGraph` consumes resolved routes |

### 3.1 Shared extraction strategies (no duplication across adapters)

Adapters are mostly **tables** that parameterise three shared strategies:

1. **Declarative (annotated)** — class-level prefix annotation/attribute + method-level verb annotations. Used by ASP.NET Core/Web API controllers, Spring, JAX-RS/Quarkus, Micronaut, NestJS, Symfony, Actix/Rocket. The adapter supplies: prefix annotation names, verb annotation → method map, how to read path/method arguments, parameter-annotation → location map, auth annotations, token replacement and override rules.
2. **Registration (fluent)** — calls like `x.MapGet("/p", h)`, `r.GET("/p", h)`, `router.get('/p', h)` with group variables (`var g = x.MapGroup("/api")`, `v1 := r.Group("/v1")`), mounts (`app.use('/api', router)`), nested block scopes (`r.Route("/api", func(r) {...})`, Ktor `route("/api") {...}`, `Route::prefix('api')->group(fn)`), and registration functions whose router parameter is supplied by a caller elsewhere (C# extension methods, Go `func register(rg *gin.RouterGroup)`). The adapter supplies verb function names, group/mount function names and root factories.
3. **Convention / file-system** — Next.js, Nuxt, Django `urls.py`, Rails `routes.rb`, ASP.NET conventional routes (`MapControllerRoute`, `MapHttpRoute`). Kept close to the existing regex extractors.

### 3.2 Adapter interface

```js
// One entry in registry.mjs
{
  id: 'aspnet-core',                 // stable framework id used in graph attrs
  name: 'ASP.NET Core',
  language: 'csharp',                // language family id
  langs: ['cs'],                     // langOf() values the adapter applies to
  status: 'supported',               // supported | partial | detected | planned
  detect(file) → evidence | null,    // file = { rel, text, tokens, structure }; evidence = { line, marker }
  extract(file, ctx) → {             // ctx = shared helpers (model, structure, strategies)
    routes: RouteFact[],             // normalized facts (see 3.3)
    groups?: GroupFact[],            // exported prefixes for cross-file use (registration functions, base classes)
    issues?: Issue[],                // unsupported or unresolvable patterns seen: { line, pattern, reason }
  },
  patterns: ['[Route] on controllers', ...],  // supported syntax, shown in the capability report
  limitations: ['...'],
}
```

Capabilities requested in the brief map to the interface as follows: framework identification → `detect`; route discovery, HTTP method extraction, route prefix resolution, parameter extraction, controller/handler identification, group/middleware discovery → fields of `RouteFact`; route-to-service relationships → `handler.calls` consumed by the resolver; confidence and evidence → `finalize()` in `model.mjs`.

Frameworks without an extractor (status `detected`/`planned`) still have `detect`, so the report can say "detected, routes not extracted" instead of silently returning nothing.

### 3.3 Normalized route model

Per-file facts are cached in `files.json` under `x.routes` (the existing key, so old consumers keep working: `method`, `path`, `line` keep their meaning). New fields are additive:

```jsonc
{
  "method": "GET",                       // one fact per method; ANY when the framework matches all methods
  "path": "/api/users/{id}",             // best local resolution; unresolved parts appear as {?expr}
  "line": 20, "end": 24,                 // declaration evidence
  "framework": "aspnet-core", "language": "csharp",
  "kind": "http",                        // http | servlet | websocket | fallback
  "template": "{id}",                    // original method-level template, as written
  "expr": [ {"lit": "/api/users"}, {"ref": "ApiRoutes.Users"}, {"param": "MapUsers#0"}, {"base": "BaseApiController"}, {"dyn": "GetPrefix()", "reason": "method call"} ],
                                         // present only when global resolution is still needed
  "controller": "UsersController", "handler": "GetById",
  "handlerLine": 20,
  "params": [ {"name": "id", "type": "int", "in": "path", "constraint": "int", "optional": false} ],
  "requestBody": "CreateUserDto", "responseType": "ActionResult<UserDto>",
  "consumes": ["application/json"], "produces": ["application/json"],
  "auth": "Authorize(Roles=Admin)", "apiVersion": "1.0", "group": "users",
  "calls": [ {"type": "IUserService", "method": "GetById", "line": 22} ],   // typed member calls inside the handler
  "extraction": "structural",            // structural | convention | regex
  "status": "complete"                   // complete | partial | unresolved (before global resolution)
}
```

After resolution in `buildScanGraph`, each route becomes (or merges into) an `api` node:

| Graph field | Value |
|---|---|
| `id` | `api:${method} ${resolvedPath}` — same format as 0.4.1. Unresolved parts are written `{?expression}` so the id never pretends to be complete. |
| `confidence` | `verified` only when `resolutionStatus = complete` and every part came from source literals, exact constant references or exact call sites; otherwise `inferred`. |
| `attrs.method`, `attrs.path` | unchanged meaning |
| `attrs.language`, `framework`, `originalTemplate`, `controller`, `handler`, `parameters`, `requestBody`, `responseType`, `consumes`, `produces`, `auth`, `apiVersion`, `group`, `kind`, `extractionMethod`, `resolutionStatus` (`complete`/`partial`/`unresolved`), `unresolved` (`[{knownPrefix, expression, reason}]`), `resolution` (steps such as `constant ApiRoutes.Users (src/ApiRoutes.cs:4)`) | new, populated only from evidence |

### 3.4 Relationship mapping onto the existing edge vocabulary

The brief lists `exposes, handled_by, calls, depends_on, reads_from, writes_to, returns, tested_by`. To avoid a second route model and keep every existing graph valid, they map onto the existing `EDGE_TYPES` (`graph.mjs:15`):

| Requested | Graph edge | Confidence rule |
|---|---|---|
| exposes | `file implements api` (unchanged) | verified |
| handled_by | `api calls function:<file>#<handler>` (the Laravel precedent, `scan.mjs:220`) | verified (same declaration) |
| calls (handler → service → repository) | `function calls function` | inferred: resolved through declared field/parameter types, never through name similarity |
| depends_on (repository → entity) | `class depends_on entity` from explicit generic arguments (`JpaRepository<User, Long>`, `DbSet<User>`) | verified (explicit type argument in source) |
| reads_from / writes_to | `function reads_from|writes_to table` from repository/DbSet calls on a resolved entity | inferred |
| returns | `attrs.responseType` (no edge; a type name is not a graph node) | — |
| tested_by | unchanged file-level edge | inferred |

No new node or edge types are introduced, so 0.4.x graphs validate unchanged.

### 3.5 Id stability and migration

Better resolution changes some ids (e.g. a C# route that was `api:GET /{id}` becomes `api:GET /api/users/{id}`). `scan()` will remap agent/manual edges from a removed scan `api` node to the new node declared at the same file and line, and report the remaps in `state/scan.json` (`routeIdChanges`). Routes whose resolution did not change keep their ids exactly; existing Express/Laravel/Flask/Go fixtures keep their 0.4.1 ids.

## 4. Incremental behaviour

- Per-file route facts are cached with the existing size/mtime/sha1 cache; `EXTRACTOR_VERSION` is bumped once so caches rebuild.
- Cross-file resolution happens during the in-memory graph build, so a change to a shared prefix (constant class, base controller, registration function, `application.properties`, `@ApplicationPath`) re-resolves every dependent route without re-reading the dependent files.
- Deleted or changed files drop their facts; stale routes disappear from the scan graph; agent items whose evidence is in a touched file are flagged stale (existing behaviour).
- Hooks stay cheap: the Stop hook keeps calling `scan({only})`; no new work per prompt.

## 5. Viewer and reporting

- API Explorer: columns for method, resolved path, language, framework, handler, confidence, resolution status; filters for language, framework, method, module, controller, confidence, resolution status; details show parameters, request/response types, auth, unresolved reasons, and the handler → service → repository → entity chain.
- File details list the resolved `api` nodes declared in the file, not only raw facts.
- `rmc api` (report), `rmc api list`, `rmc api frameworks` (capability matrix), `--json`. (`rmc route` is already the model-routing command.)
- `state/scan.json` gains a `routes` summary per language/framework: controllers, registration declarations, extracted, unresolved, unsupported patterns, verified/inferred counts, limitations.

## 6. Test plan

Fixtures under `tests/fixtures/routes/<framework>/…` with realistic layouts (controllers/, Program.cs, services, repositories, entities, config). Tests assert exact route sets, parameters, line ranges, confidence and resolution status, relationship edges, incremental re-resolution after a shared prefix changes, deletion of stale routes, graph validation, and id remapping. A framework is marked **Supported** only with multiple passing representative tests; otherwise **Partial**, **Detected Only** or **Planned**.

## Implementation status (Unreleased)

Implemented as proposed above for C# and Java/Kotlin. Fixtures and tests: `tests/fixtures/routes/{dotnet-shop,spring-shop,jvm-misc}`, `tests/routes.test.mjs` (12 tests, including an incremental CLI refresh that changes a shared route constant, deletes a controller and checks that agent edges follow the remapped route id). Other languages are recognised by detection-only registry entries (`scripts/lib/routes/adapters/{js,php,python,go,ruby,rust}.mjs`); their routes still come from the pattern extractor in `scripts/lib/extract.mjs`, tagged `extractionMethod: regex`, `resolutionStatus: partial`. Not done yet: structural adapters for those languages, and the viewer API Explorer filters.

## QA fixes (TC-001, independent QA of C# and Java/Kotlin)

QA suite `tests/routes-qa.test.mjs`: 15/29 before, **29/29 after**. Regression tests per bug are in `tests/routes.test.mjs` (fixture `tests/fixtures/routes/regress/`). Both files are part of `npm test`.

| Bug | Fix | Status (tests) |
|---|---|---|
| B1 profile config | Only `application.properties`/`application.yml` (default profile) resolve placeholders and context-path; properties beat yml, application beats bootstrap. `application-<profile>.*` values are recorded on the route as `attrs.conditional` (`profile`, `key`, `value`, `file`, `line`) and in the resolution steps; a key defined only in a profile leaves the route partial/inferred with that reason. | Fixed: QA-J-01/03/06/07, regression B1 |
| B2 generic return types | A soft-keyword method name (`list`, `select`, `export`, `match`, `from`, …) is a declaration after `>`, `]` or `?`; the annotation scan no longer stops at commas inside generic arguments (`Map<String, List<X>>`, `Dictionary<string, object>`). | Fixed: QA-J-08/11, regression B2/B3 |
| B3 C# `object` | `object` is a type keyword only in Kotlin. Positional records are no longer indexed as functions. | Fixed: QA-CS-14/16, regression B2/B3 |
| B4 JAX-RS sub-resources | A class without class `@Path` gets its prefix from locator methods whose declared return type is that class (composed cross-file, marked inferred). A locator returning an unseen class is reported as an unsupported pattern. | Fixed: QA-J-09, regression B4 |
| B5 agent edges on id change | Each api node stores `attrs.declKeys` (file, line, method, controller.handler, local template, ordinal). A vanished id moves only when exactly one new route has the same declaration key; otherwise its agent edges are reported as orphaned. Graphs without `declKeys` use the previous file:line + method rule. | Fixed: regression B5 (CLI: prefix change, multi-prefix controller, unrelated edge kept, controller deletion, no dangling edges) |
| B6 partial classes | A `partial` controller part without `[Route]` takes the prefix of the other part(s) of the same class (verified only when exactly one part declares it); with no such part the route is partial/inferred. | Fixed: QA-CS-07, regression B6 |
| B7 inherited actions | Actions on abstract base controllers (ASP.NET Core, Spring) are templates instantiated for every controller whose declared base chain reaches the base; tokens use the derived name; overrides are not duplicated; a base with no derived controller is reported. | Fixed: QA-CS-06, QA-J-05, regression B7 |
| B8 placeholders | Any non-secret key with a path-shaped value is stored, so `${app.paths.admin}` resolves; the missing-key reason now says what was searched. | Fixed: QA-J-04, regression B8 |
| B9 entity → table | In the C#/Java typed linker, entity → table comes only from `[Table("x")]` (verified), `Entity<T>().ToTable("x")` (verified) or the EF Core default, the DbSet property name (inferred, exact match). Reads/writes target that mapped table, else the entity. | Fixed: regression B9 |
| B10 nested-brace constraints | Path parameters are parsed with balanced braces. | Fixed: QA-CS-03 |
| B11 local-variable reason | Unqualified lower-case identifiers report "a local variable or parameter". | Fixed: regression B8/B11 |

**QA expectations amended** (stricter, not weaker): QA-CS-14 and QA-CS-16 matched `/#Find$/`, `/#Get$/` and `/#Charge$/`. Method ids were `file#Method` with `@line` for repeats, so the bare `#Charge` was **UserService**.Charge (the never-injected class) and the bare `#Find` was the interface method: the original CS-16 assertion could only pass through the forbidden link. Method ids are now class-qualified (`file#Class.method`), and the assertions match `OrdersController.Get`, `OrderService.Find` and `PaymentService.Charge`, plus an explicit "never UserService" check.

**Remaining known limitations:** legacy (non-structural) extractors for Laravel, Rails, Django and JPA `@Entity` without `@Table` still map entities to tables by their naming conventions (marked inferred); EF `ToTable` is recognised only inside the DbContext class body; Spring profile activation (`spring.profiles.active`, `@Profile`) is not evaluated, by design.

## QA re-run (TC-002)

An independent re-run after the B1–B11 fixes, by the main session (not the implementer), with new fixtures `tests/fixtures/routes/qa2/{dotnet,jvm}` and `tests/routes-qa2.test.mjs`. Expectations were fixed before the engine ran. Before fixes: 12/16 pass. Findings were recorded in TC-002 before any change.

| Bug | Severity | Finding | Fix | Status |
|---|---|---|---|---|
| B12 | High | Method ids became class-qualified without an `EXTRACTOR_VERSION` bump: unchanged files kept stale decls (mixed ids, B3 not applied to them); agent edges on methods were orphaned and dropped when a file changed. Only graphs built by the unreleased 5ced6de are affected; 0.4.1 had no C#/Java/Kotlin function nodes. | `EXTRACTOR_VERSION` 5; old `file#method` ids remap to the single `file#Class.method` in the same file (`functionIdChanges` in scan.json); zero or several candidates → reported as orphaned, never guessed. | PASS (QA2-INC-01) |
| B13 | High | Actions inherited by a Spring controller kept `${catalog.base}` literally and were verified. | Class-level `@RequestMapping` prefixes used for inheritance go through the same placeholder parser as the controller's own. | PASS (QA2-J-03) |
| B14 | Medium | EF mappings looked tables up in lower case only, so PascalCase schema tables never matched. | Case-insensitive table lookup; no edge when two tables differ only by case. | PASS (QA2-CS-07) |
| B15 | Medium | Inferred entity → table edges had no reason. | Evidence `ref` names the mapping: `[Table("x")]`, `Entity<T>().ToTable("x")`, `EF Core default: …`, `JPA default naming …`, `Laravel …`, `Rails …`, `Django …`, `explicit table name …`. | PASS (QA2-CS-07, QA2-J-07, QA2-ENT-*) |
| B16 | Medium | The legacy convention mapper pluralised for every language (JPA `Item` → `items`). | Per-framework exact conventions: JPA singular snake_case; Laravel/Rails plural snake_case; Django `<app>_<model>`; SQLAlchemy without `__tablename__`: no edge. Conventions stay `inferred`; explicit names `verified`. | PASS (QA2-J-07, QA2-ENT-01…04) |

Test-authoring corrections (QA side, recorded in TC-002): table ids keep schema casing, so QA2 compares them case-insensitively; C# top-level-statement local functions (`Program.cs`) have no containing class, so they are excluded from the "no unqualified method id" check. No implementer test or round-1 QA expectation was changed in this round.
