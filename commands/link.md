---
description: Register another RM Context-initialized repository as a reference project
argument-hint: "<path to the other repository>"
allowed-tools: Bash(node:*)
---

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Run `rmc link "$ARGUMENTS"` and report the result.
- The portable reference (id, name, stack) goes to `.rmcontext/references/projects.json`, which can be committed.
- The machine-specific path goes to `.rmcontext/.local/local.json`, which is git-ignored.
- Linked projects are reference-only: query them with `rmc find <terms> --root "<path>"` and never copy their rules blindly.
If the target has no `.rmcontext/`, tell the user to run `/rmc:init` there first.
