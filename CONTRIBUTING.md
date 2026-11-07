# Contributing to RM Context

Thanks for looking. RM Context is early and still being developed, and Claude Code is the only platform it has been tried with so far. Bug reports, ideas, documentation fixes and pull requests are all welcome.

## Ways to help

- **Report a bug or a rough edge.** Open an issue (see below for what to include).
- **Try it on another stack or platform** and tell me what broke. Route extraction, database discovery and the scanner all have language-specific parts that benefit from real projects.
- **Fix something small.** A typo, an unclear message, a missing test.
- **Propose something bigger** by opening an issue first, so we can agree on the direction before you spend time on it.

## Reporting an issue

Please include:

- the platform you use (and the Claude Code version, if relevant)
- your Node.js version
- the command you ran
- the output you saw, and what you expected

**Never paste secrets, credentials, connection strings or private source code.** If the output contains any, remove them first.

## Setup

RM Context is a zero-dependency Node.js CLI (Node 18.17 or newer, standard library only).

```bash
git clone https://github.com/rmtemplate/rm-context.git
cd rm-context
node scripts/rmc.mjs --help
```

There is nothing to install. Please do not add a runtime dependency without opening an issue first; staying dependency-free is a deliberate choice.

## Project layout

| Path | What it holds |
|---|---|
| `scripts/rmc.mjs` | The CLI entry point |
| `scripts/lib/` | The scanner, graph, routing, database, mobile and viewer modules |
| `scripts/hooks.mjs`, `hooks/` | The Claude Code hooks |
| `agents/`, `skills/`, `commands/` | The Claude Code agents, playbooks and slash commands |
| `tests/` | Tests (`node --test`) and fixtures |
| `docs/` | Architecture and design notes; start with `docs/ARCHITECTURE.md` |

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep the change small and focused. Prefer extending existing code to adding a new abstraction.
3. Add or update tests. Behaviour that is not tested is not considered supported.
4. Update `CHANGELOG.md` for anything a user would notice, and the README or `docs/` if behaviour or commands change.
5. Run the checks below, then open a pull request that explains what changed and why.

Some files (for example `scripts/rmc.mjs`, `scripts/lib/scan.mjs` and `scripts/lib/extract.mjs`) use CRLF line endings. Keep each file's existing line endings so the diff shows only your change.

I handle version bumps and releases, so please leave the version numbers alone.

## Running the checks

```bash
npm test          # the whole test suite
npm run validate  # Claude plugin validation (requires the claude CLI)
```

Notes:

- The full suite takes a few minutes. Run it with nothing else working in the same repository: one test compares the repository's own `.rmcontext/` telemetry before and after, and background activity can make it fail spuriously.
- To run one file: `node --test tests/<name>.test.mjs`.
- Tests must be self-contained. They use fixtures and fakes, never a real database server, network service or your own project.

## Ground rules

These apply to every contribution:

- **No secrets.** Nothing that stores, prints or sends passwords, tokens, API keys or full connection strings. Fixtures use obvious fake values.
- **Database safety.** Discovery stays read-only. Code must not run stored procedures, read user records or change data, and tests must not run real DDL against a database.
- **Be honest about what is verified.** Do not mark something as supported, verified or switched unless the code observed it. Prefer "recommended", "inferred" or "not verified" when that is the truth.
- **Don't invent knowledge.** Anything extracted from a project should carry its evidence (file, line, confidence).
- **Keep the CLI deterministic and light.** No model calls and no network access in the core CLI.

## Adding support for another platform or framework

Platform integrations and route adapters are meant to be added without changing the core graph schema. Start from `docs/ARCHITECTURE.md` and `docs/INTEGRATION_ARCHITECTURE.md`, and open an issue describing the platform so the integration can be scoped before you build it. A framework is only listed as supported once its representative tests pass.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
