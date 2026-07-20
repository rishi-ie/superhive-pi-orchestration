# superhive-pi-orchestration

Coordinator-only Pi extension for project lead agents.

## What it does

On `session_start`, when `process.env.AGENT_KIND === 'project-coordinator'`:

1. Reads the coordinator's truth settings file (`<agentRoot>/Superhive-pi-<foldername>.json`)
2. If a `project` block is present, builds the CEO system prompt from the
   project name, description, and live member roster
3. Writes the prompt back to `settings.systemPrompt`
4. Registers 5 LLM-callable tools that standard agents never see

## The 5 tools

| Tool | Status | Behavior |
|---|---|---|
| `list_project_agents` | Working | Returns `project.members[]` from the truth settings |
| `get_agent_status` | Working | Returns one member's `{status, model, role}` |
| `dispatch_to_agent` | Gap 2 stub | Returns `{ok:false, error:"mailbox not yet wired (Gap 2)"}` |
| `read_inbox` | Gap 2 stub | Same |
| `send_message_to_agent` | Gap 2 stub | Same |

## Module rules

See `AGENTS.md` in this repo.

## Bundle sync

The runtime copy at `general-kai/extensions/superhive-pi-orchestration` must stay in lockstep:

```bash
diff -rq superhive-pi-orchestration general-kai/extensions/superhive-pi-orchestration
```

Run before every commit. Empty output = sync OK.