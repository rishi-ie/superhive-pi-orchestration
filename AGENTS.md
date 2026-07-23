/**
 * Cross-module rules for superhive-pi-orchestration.
 *
 * I am a Pi extension that runs inside project-context agents. My world is
 * the agent's settings file and the filesystem; I never call back to
 * Electron.
 *
 * The gate is now role-based: any project member loads the extension; the
 * tool set depends on the role. Members get a smaller tool set; the pure
 * filesystem rule still holds.
 *
 * 1. Project-member gate. I no-op for any agent whose settings file has
 *    no `project` block. The block carries `localPath` and
 *    `coordinatorAgentId`. The role is:
 *      - coordinator: AGENT_ID === project.coordinatorAgentId
 *      - member:      AGENT_ID !== project.coordinatorAgentId
 *    Standard agents (no project block) must never see my tools.
 * 2. Pure filesystem backing. My tools read the truth settings file
 *    `<agentRoot>/manage.json` directly. I never open
 *    a socket, never spawn a subprocess, never call into Electron. The
 *    mailbox files I read/write are:
 *      - <projectDir>/agent/chat.jsonl — the project chat (read/write)
 *      - <memberDir>/inbox.jsonl       — per-member direct-ask inbox
 *                                        (write by coord, read by member)
 *    The on-disk format is identical to `electron/mailbox-store.ts` so
 *    the main-process watcher treats my writes and IPC writes
 *    indistinguishably.
 * 3. Tool set per role.
 *      - coordinator: list_project_agents, get_agent_status, ask_member,
 *                     read_inbox, post_to_project, plan_tasks,
 *                     complete_task (7 tools)
 *      - member:      read_inbox, post_to_project (2 tools)
 *    Members never get `ask_member`, `plan_tasks`, or `complete_task` —
 *    workers don't direct-message other workers and don't plan work;
 *    they post to the project and let the coordinator route.
 * 4. `read_inbox` is role-aware.
 *      - coordinator: reads <projectDir>/agent/chat.jsonl, filters by
 *                     kind, excludes self + user, excludes entries
 *                     already delivered to self. Marks returned entries
 *                     as delivered (idempotent).
 *      - member:      reads <memberDir>/inbox.jsonl, status=pending.
 *                     Acks returned entries (idempotent).
 * 5. Atomic writes. When I write back to the settings file, I use the
 *    same tmp+rename+counter-bump pattern as superhive-pi-truth so the
 *    watcher treats my writes correctly. Mailbox appends use plain
 *    `appendFileSync` (atomic for writes < PIPE_BUF = 4096 bytes);
 *    mailbox status flips (`markChatDelivered`, `ackInboxMessage`) use
 *    tmp+rename.
 * 6. No new cross-module contracts. I read the `project` block that
 *    `superhive-pi-truth/settings-schema.ts` declares. I do not add my
 *    own schema fields without coordinating with the truth module.
 * 7. System-prompt injection.
 *      - coordinator: buildSystemPrompt writes the full CEO prompt to
 *                     settings.systemPrompt.
 *      - member:      buildRolePromptFragment('member') is appended to
 *                     the existing systemPrompt, marker-guarded so the
 *                     append is idempotent across session_starts. We
 *                     never overwrite the user's prompt.
 * 8. The bundled copy at `general-kai/extensions/superhive-pi-orchestration`
 *    is synced from this repo. `diff -rq` must be empty before commit.
 * 9. Cross-process file drop. `plan_tasks` writes a JSON file at
 *    `<coordDir>/tasks-plan.json`; `complete_task` appends a JSONL
 *    line at `<coordDir>/tasks-complete.jsonl`. The main process's
 *    `tasks-file-watcher` ingests both and truncates the files.
 *    The orchestrator never reaches into Electron.
 */

export {};
