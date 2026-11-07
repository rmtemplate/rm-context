---
name: database-intelligence
description: Database and mobile architecture intelligence for RM Context. Use before any database, stored-procedure, schema, migration, Android, Flutter or React Native work in an initialized repository, and whenever a schema or procedure change is requested.
---

# Database & Mobile Intelligence

Discovery is **read-only in every environment**. Enforcement lives in the `rmc` CLI, the database adapter, the execution policy and the Claude Code permission hook (`pre-bash`), not only in this text.

## Read before you implement
1. `rmc database status` — detected targets (engine, server, database, profile, environment; never credentials), migration framework, what is already known.
2. `rmc database find "<table|column|procedure|parameter>"`, then `rmc database show table|procedure|view <name>` (add `--definition` only when you need the body). Definitions, dependencies and application call sites are stored per object.
3. `rmc mobile find "<terms>"` / `rmc mobile show architecture|data-layer|dependencies` for Android, Flutter and React Native: actual pattern, state management, ViewModel/UseCase/Repository/DAO/API chains.
4. Reuse the existing repository, DAO, DTO, model, ViewModel, UseCase or composable. Do not recreate logic a stored procedure or service already holds. Do not swap Provider, Riverpod, BLoC or GetX, and do not force MVVM, without approval.
5. Knowledge missing or stale → targeted `rmc database discover|refresh` or `rmc mobile detect`. Never a full scan, never invented structure. A local mobile database is **not** the backend database.

## Connections
Never connect on your own. `rmc database discover --connect` prints the target (no credentials) and needs `--approve <target-id>`; credentials come only from environment variables the user names (`--cred-env user=ENV,password=ENV`). Only SELECT-only catalog queries are sent (`sys.*`, `information_schema`, `pg_catalog`, `sqlite_master`/PRAGMA). Without a connection use `rmc database catalog-sql` + `--catalog-file`, SQL scripts, migrations, DACPAC or schema dumps. Insufficient permission is reported as a limitation; never try other credentials or ask for elevated rights. Encrypted or dynamic SQL is recorded as unresolved.

## Schema or procedure changes
| Environment | Policy |
|---|---|
| UNKNOWN | blocked; `rmc database target confirm <id> <ENV>` after checking the identity |
| LOCAL / DEV / TEST | migration file in the project's own framework (with a down migration if supported), review, verify the target, then `rmc database apply <id>` runs the project's migration command. **No backup objects.** Destructive or data-loss migrations need an impact explanation and the `destructive` approval. |
| STAGING | prepare migration, rollback, impact and a checklist (`plan-change`, `package`). The user applies it. A Claude apply: backup plan → approval → `_rmc_YYYYMMDD` backup objects → verify → rollback script → final approval → run the reviewed migration → verify → audit. |
| PRODUCTION | strict; generate only unless the user explicitly asks. Apply additionally needs a database-native backup attestation (`native-backup`) for high-risk changes. A DEV/STAGING success or a QA pass is never approval. |

Approvals are exact phrases bound to environment, database, plan and stage (`APPROVE APPLY PRODUCTION <db> <CHG-id>`); the user confirms the `rmc database approve` call. Do not use `sqlcmd`, `psql`, `mysql`, `sqlite3` or a migration runner directly during a change — the hook denies it.

Backup names: `<object>_rmc_YYYYMMDD` (Asia/Jakarta), same database and schema; an existing name is never overwritten or dropped; a name over the engine's identifier limit stops the change. Procedures are backed up with `CREATE` under the new name (never executed); tables with an engine-specific strategy that is verified (structure and row count). Anything that cannot be preserved stops the change.
