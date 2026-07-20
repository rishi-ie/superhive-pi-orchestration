/**
 * Cross-module rules for superhive-pi-orchestration.
 *
 * I am a Pi extension that runs only inside project-coordinator agents.
 * My world is the agent's settings file and the filesystem; I never call
 * back to Electron.
 *
 * 1. AGENT_KIND gating. I no-op for any agent whose `process.env.AGENT_KIND`
 *    is not strictly `'project-coordinator'`. Standard agents must never
 *    see my tools.
 * 2. Pure filesystem backing. My tools read the truth settings file
 *    `<agentRoot>/Superhive-pi-<foldername>.json` directly. I never open a
 *    socket, never spawn a subprocess, never call into Electron.
 * 3. Honest stubs. The 3 dispatch/inbox/send tools return `{ok:false,
 *    error:"mailbox not yet wired (Gap 2)"}` until Gap 2 lands. I never
 *    pretend to do work I can't do.
 * 4. Atomic writes. When I write back to the settings file, I use the
 *    same tmp+rename+counter-bump pattern as superhive-pi-truth so the
 *    watcher treats my writes correctly.
 * 5. No new cross-module contracts. I read the `project` block that
 *    `superhive-pi-truth/settings-schema.ts` declares. I do not add my own
 *    schema fields without coordinating with the truth module.
 * 6. The bundled copy at `general-kai/extensions/superhive-pi-orchestration`
 *    is synced from this repo. `diff -rq` must be empty before commit.
 */

export {};