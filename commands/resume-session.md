---
description: Resume work from the last saved session state for the current branch.
---

# Resume Command

This command invokes the **session-manager** skill to reload context from the last active session for the current Git branch.

## Usage

`/resume-session [branch_name]`

## How it works

1.  **Identify Context**:
    - If `branch_name` is provided, use it.
    - If not, checks the current Git branch automatically.

2.  **Find Session**:
    - Looks for the most recent file matching `session-*-{repo}-{branch}.md`.
    - Example: `session-20250130*-backend-api-feat-login.md`

3.  **Load**:
    - Calls `session-manager` skill with action `load`.

## Example Output

```
> /resume-session

[Session Manager] Branch: feat/login-page
[Session Manager] Found latest session: session-202501301000-backend-feat-login.md. Load it into context.

**Session Resumed**
We are 60% done with **User Authentication Refactor**.
Last decision: Switch to JWT for session management.

[Context Loaded]
  - Read: src/api/routes.ts
  - Read: src/models/user.ts
```
