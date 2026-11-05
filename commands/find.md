---
description: Search project knowledge — graph nodes with evidence, documents and context notes
argument-hint: "<topic, feature, file, API or table>"
allowed-tools: Bash(node:*)
---

Find RM Context knowledge for: $ARGUMENTS

**RM Context CLI** — always invoke it with this exact command line (written `rmc` below):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/rmc.mjs"`

Model routing: right before delegating, run `rmc route --agent quick-qa --category search [--signals …]`. Add signals only when they apply (see *Model routing* in the `team-workflows` skill). Pass its `model` to the Agent tool and show the user its routing block.

1. Run `rmc find $ARGUMENTS`.
2. If results are relevant, open only the top one or two referenced files or documents to answer precisely, with `path:line`. Use `rmc graph node "<id>"` for relationships.
3. If results are empty or the question is broad, delegate the lookup to `quick-qa` (`rm-context:quick-qa`) with the routed model. If it reports the question is too broad, suggest `/rm-context:architecture`.
4. Do not load the whole knowledge base or graph JSON.
