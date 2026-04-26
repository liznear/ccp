---
description: Open a browser-based code review for local changes; address any submitted comments
argument-hint: "[git-target]   (default: HEAD)"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

!bun run ${CLAUDE_PLUGIN_ROOT}/scripts/show-changes.ts $ARGUMENTS

The command above started a browser-based web review of the local changes against the given git target (or `HEAD` if none was given) and blocked until the user either submitted comments or cancelled.

Inspect the output:

- If a `=== SHOW-CHANGES COMMENTS (JSON) ===` block is present, parse the JSON array between the markers. Each entry has `{ file, line, side: "old" | "new", comment }`. Treat these as review feedback the user wants addressed: read the relevant code, make the requested changes, and verify (run tests/typecheck where natural). When done, summarize what you changed per comment.
- If the JSON array is empty, or the output says `Cancelled — no comments submitted.`, do nothing further and just acknowledge.
- If the command failed (e.g. invalid git target), report the error and stop.
