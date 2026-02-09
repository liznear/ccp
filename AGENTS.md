# CCP Plugin Notes

## Hooks

- Plugin hooks are defined in `~/.claude/plugins/marketplaces/ccp/hooks/hooks.json`, but **they do not apply automatically**.
- Claude Code only executes hooks that are registered in a settings file:
  - User scope: `~/.claude/settings.json`
  - Project scope: `.claude/settings.json`
  - Local scope: `.claude/settings.local.json`
- To enable the CCP hooks, the settings file must include a `hooks` section that mirrors the plugin’s `hooks.json`.

## Context Sync Hook

- `hooks/context-sync.js` runs on the **PreToolUse** hook and only reads the transcript.
- It uses `CLAUDE_TRANSCRIPT_PATH` and counts `"type":"user"` occurrences to determine when to提醒 sync.
- It does **not** write any session files. To persist sessions, run the `session-manager` skill.

## Setup Command

- The `/setup` command only configures the custom statusline by default.
- If you want hooks enabled, the setup flow must also write the `hooks` section into the chosen settings file.
