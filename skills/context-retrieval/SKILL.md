---
name: context-retrieval
description: Retrieve the smallest relevant subset of .rmcontext knowledge for a task (rmc find / graph node / impact) and verify important facts against current source. Use before answering project questions or starting focused work in an initialized repository.
---

# Context Retrieval

1. `rmc status`: if it reports STALE, run `rmc refresh` first (it is incremental and cheap).
2. Read `.rmcontext/INDEX.md` (short, navigational).
3. `rmc find <terms>` returns graph nodes with evidence locations, matching documents and matching lines in context notes.
4. Drill into one node: `rmc graph node "<id>"` shows incoming and outgoing relationships with confidence.
5. Need the blast radius? `rmc impact "<id or file>"`.
6. Open only the documents and source files those results point to. **Never load `graph/*.json` wholesale.**
7. Verify any fact you will act on against the current source, especially items marked `inferred` or `stale`.
8. Linked projects (`references/projects.json`) are reference-only. Query one with `rmc find <terms> --root "<its path from .rmcontext/.local/local.json>"`.
9. Return a compact summary: the facts, the `path:line` references you used, and anything missing or stale.
