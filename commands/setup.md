---
description: Configure the statusline script in Claude Code settings.
---

# Setup Command

This command interactively configures the custom statusline script for Claude Code.

## Usage

`/setup`

## How it works

1. **Choose Scope**: Prompts you to select the settings scope:
   - **user** (recommended): Updates `~/.claude/settings.json` - applies to all Claude Code sessions
   - **project**: Updates `.claude/settings.json` - applies only to this project
   - **local**: Updates `.claude/settings.local.json` - applies only to this project, ignored by git

2. **Backup**: Creates a backup of the target settings file (e.g., `settings.json.bak`) before making changes.

3. **Configure**: Updates the `statusLine` configuration to use the custom script:
   ```json
   {
     "type": "command",
     "command": "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"
   }
   ```

4. **Permissions**: Ensures the statusline script is executable (`chmod +x`).

5. **Preserves Settings**: Merges with existing settings - does not remove any other configurations.

## What it updates

The command sets or updates the `statusLine` key in your chosen settings file to point to the plugin's custom statusline script. The `${CLAUDE_PLUGIN_ROOT}` environment variable ensures the path resolves correctly regardless of where the plugin is installed.

## Example

```
> /setup

Which settings scope would you like to configure?
1. user (recommended) - ~/.claude/settings.json
2. project - .claude/settings.json
3. local - .claude/settings.local.json

Enter choice (1-3) [default: 1]: 1

✓ Backed up settings.json to settings.json.bak
✓ Updated statusLine configuration
✓ Made scripts/statusline.js executable

Statusline configured successfully! Restart Claude Code to see the changes.
```

## Troubleshooting

If the statusline doesn't appear after restarting:
- Ensure the script is executable: `ls -l scripts/statusline.js` (should show `-rwxr-xr-x`)
- Check that `${CLAUDE_PLUGIN_ROOT}` is set correctly in your environment
- Verify the settings file contains valid JSON

---

## Implementation Instructions

When this command is invoked, follow these steps:

1. **Prompt for scope selection** using AskUserQuestion:
   - Question: "Which settings scope would you like to configure?"
   - Options:
     - "user (recommended)" - Updates ~/.claude/settings.json
     - "project" - Updates .claude/settings.json in current project
     - "local" - Updates .claude/settings.local.json in current project
   - Default suggestion: "user (recommended)"
   - Multi-select: false

2. **Determine target settings file path** based on user choice:
   - user: `${HOME}/.claude/settings.json`
   - project: `${PROJECT_ROOT}/.claude/settings.json`
   - local: `${PROJECT_ROOT}/.claude/settings.local.json`

3. **Check if file exists**:
   - If file exists: Read the existing JSON content
   - If file does not exist: Start with an empty object `{}`

4. **Validate JSON** (if file exists):
   - Parse the file content as JSON
   - If parsing fails, abort with error: "Failed to parse settings file. Please check that it contains valid JSON."

5. **Create backup** (if file exists):
   - Create backup path by appending `.bak` to original path
   - Use Bash to copy: `cp "${target_path}" "${backup_path}"`
   - Inform user: "✓ Backed up ${filename} to ${filename}.bak"

6. **Update statusLine configuration**:
   - Create or update the `statusLine` key in the settings object:
     ```json
     {
       "statusLine": {
         "type": "command",
         "command": "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"
       }
     }
     ```
   - Merge with existing settings (preserve all other keys)

7. **Write updated settings** to the target file using Write tool

8. **Ensure script is executable**:
   - Use Bash: `chmod +x "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"`
   - Verify: `ls -l "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"` shows executable permissions

9. **Report success** with confirmation message:
   ```
   ✓ Backed up settings.json to settings.json.bak
   ✓ Updated statusLine configuration
   ✓ Made scripts/statusline.js executable

   Statusline configured successfully! Restart Claude Code to see the changes.
   ```

## Important Notes

- Always preserve existing settings when merging - only update the `statusLine` key
- Use `${CLAUDE_PLUGIN_ROOT}` environment variable in the command path to ensure portability
- Create backups before any modification to prevent accidental data loss
- Abort with clear error message if JSON parsing fails
- Ensure directory exists before writing settings file
