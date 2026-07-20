# Implementation notes — superhive-pi-orchestration

## What this extension does

Turns the project-coordinator agent from a labeled Pi subprocess into a real runtime role. Specifically:

- On `session_start`, gated by `process.env.AGENT_KIND === 'project-coordinator'`, the extension reads the coordinator's truth settings file (`<agentRoot>/Superhive-pi-<foldername>.json`).
- If a `project` block is present, the extension builds a CEO system prompt from `{projectName, projectDescription, members[]}` and writes it back to `settings.systemPrompt`.
- 5 LLM-callable tools are registered: 2 read live state from the truth file, 3 return honest Gap 2 stubs.

## How it fits with the rest of Superhive

This extension is the missing runtime half of Gap 1 (`superhive/GAPS.md`). The other half — Electron writing the `project` block and keeping member statuses fresh — lives in `superhive/electron/`.

The `AGENT_KIND` env var is set at spawn time by `superhive/electron/general-kai-runtime.ts:558-571`.

The status-mirror helper (`superhive/electron/project-status-mirror.ts`) calls `patchMemberStatus` from this extension's `project.ts` to keep `project.members[].status` current as members start/stop.

## Files

```
index.ts          session_start handler, gate, register
tools.ts          5 defineTool() definitions
project.ts        readProjectBlock, writeProjectBlock, patchMemberStatus, addMember, removeMember
system-prompt.ts  pure builder for the CEO prompt
types.ts          ProjectBlock, MemberRef, CoordinatorSettingsShape
test/
  system-prompt.test.ts
  project.test.ts
  tools.test.ts
  smoke.ts        end-to-end: registers extension, drives session_start, asserts tool registration and prompt write
```

## Tests

```
cd superhive-pi-orchestration
node --import tsx --test test/system-prompt.test.ts test/project.test.ts test/tools.test.ts
node --import tsx test/smoke.ts   # not via test runner — runs as standalone
```

50 unit + smoke tests cover prompt composition, project block read/write atomicity, AGENT_KIND gating, tool registration counts, and Gap 2 stub honesty.

## Bundle sync

```
diff -rq superhive-pi-orchestration general-kai/extensions/superhive-pi-orchestration
```

Empty output = sync OK. Lockfile excluded (`Only in superhive-pi-orchestration: package-lock.json` is expected).

## Known limitations (deferred)

- 3 of 5 tools (dispatch, read_inbox, send_message_to_agent) return Gap 2 stub errors. Implementation lands in Gap 2.
- Telemetry-driven status changes do not patch `project.members[].status`. Coordinator tools see slightly stale data until next session_start for those paths. Gap 2 wires telemetry → status-mirror.
- No recursive specialist creation (Gap 6). Members are fixed at project creation.