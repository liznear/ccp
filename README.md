# Custom Claude Code Plugin

This is your personal Claude Code plugin for custom agents, commands, skills, and more.

## Directory Structure

```
custom-plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin metadata
├── agents/                  # Custom agents (subagents for Task tool)
│   └── example-agent.md
├── commands/                # Custom commands (/command-name)
│   └── example-command.md
├── skills/                  # Custom skills (complex commands)
├── hooks/                   # Lifecycle hooks
├── rules/                   # Global rules and guidelines
└── contexts/                # Context configurations
```

## Creating Custom Agents

Agents are markdown files in the `agents/` directory with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: ["Read", "Write", "Bash"]
model: sonnet  # or opus, haiku
---

Your agent instructions here...
```

## Creating Custom Commands

Commands are markdown files in the `commands/` directory:

```markdown
---
name: my-command
description: What this command does
---

Command instructions that will be loaded when user types /my-command
```

## Creating Custom Skills

Skills are more complex than commands, stored in `skills/` directory with this structure:

```
skills/
└── my-skill/
    ├── skill.md           # Main skill prompt
    ├── examples/          # Usage examples
    ├── references/        # Reference documentation
    └── scripts/           # Helper scripts
```

## Creating Hooks

Hooks are scripts that run at specific lifecycle events. Place them in `hooks/`:

- `pre-session-start.js` - Runs before session starts
- `post-session-start.js` - Runs after session starts
- `pre-tool-call.js` - Runs before each tool call
- `post-tool-call.js` - Runs after each tool call
- `user-prompt-submit.js` - Runs when user submits a prompt

## Creating Rules

Rules are markdown files in `rules/` that provide global context to all sessions:

```markdown
# My Custom Rule

This rule applies to all Claude Code sessions.

## Guidelines

- Rule 1
- Rule 2
```

## Enabling Your Plugin

This plugin is automatically linked by home-manager to `~/.config/claude/plugins/my-custom-plugin/`

To use your custom components:
- Agents: Use via Task tool with `subagent_type: "my-agent"`
- Commands: Run with `/my-command`
- Skills: Reference via skill invocation
- Hooks: Automatically run at lifecycle events
- Rules: Automatically included in context
