---
name: session-manager
description: Manage session context persistence using time-stamped files for repo/branch.
---

# Session Manager

This skill handles the lifecycle of a coding session's memory, ensuring context is preserved across CLI runs and preserved per-branch.

## File Structure

Sessions are stored in `$HOME/.claude/sessions/` within the project root.
**Naming Convention:** `session-{YYYYMMDDHHMM}-{repo}-{branch}.md`

Example: `session-202501301430-backend-api-feat-login.md`

## Actions

### 1. Update Session (Save/Sync)

**Trigger:**
- When `[AUTO-SYNC]` signal is received
- When `/checkpoint` is run
- At the end of a session (`SessionEnd`)

**Instructions:**
1.  **Identify Context**:
    - **Repo**: Run `basename $(git rev-parse --show-toplevel)` (or folder name).
    - **Branch**: Run `git branch --show-current` (sanitize slashes `/` to `-`).
    - **Time**: Current time in `YYYYMMDDHHMM`.

2.  **Determine Target File**:
    - List files matching: `session-*-{repo}-{branch}.md`.
    - Sort by modification time.
    - **Logic**:
        - If the latest file was modified **less than 1 hour ago**, assume it belongs to the *current* working session -> **Update it**.
        - If the latest file is older (or none exists) -> **Create a NEW file** using current timestamp.

3.  **Analyze & Write**:
    - **Status**: Completion percentage.
    - **Decision Log**: Key architectural decisions.
    - **Technical Debt**: Hacks/TODOs.
    - **Next Steps**: Explicit instructions.
    - **Active Context**: List of files currently being modified.

**Template:**

```markdown
# Session State: [Repo] / [Branch]
**Session ID:** session-[Time]-[Repo]-[Branch]
**Last Updated:** [Date Time]
**Status:** [XX]% Complete

## Current Focus
[Brief description]

## Decision Log
- [Decision 1]
- [Decision 2]

## Technical Debt & TODOs
- [ ] [Item 1]

## Active Context (Files)
- `src/path/to/file1.ts`

## Next Steps
1. [Step 1]
```

### 2. Load Session (Resume)

**Trigger:**
- `/resume-session` command
- `[SessionStart]` signal

**Instructions:**
1.  **Identify Context** (Repo/Branch).
2.  **Find Latest**: Find the *most recent* file matching `session-*-{repo}-{branch}.md`.
3.  **Load**:
    - Read the file.
    - Summarize state to user.
    - **Action**: Automatically `Read` the files in "Active Context".
