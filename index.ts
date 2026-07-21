/**
 * superhive-pi-orchestration — entry point.
 *
 * Gap 2 change: the gate is no longer "AGENT_KIND === 'project-coordinator'".
 * The extension now loads for any project member and detects role by
 * comparing AGENT_ID against settings.project.coordinatorAgentId.
 *
 * On `session_start`:
 *   1. Read the truth settings file. If the `project` block is missing,
 *      no-op (the agent isn't a project member).
 *   2. Determine role:
 *        - isCoordinator: AGENT_ID === project.coordinatorAgentId
 *        - isMember:      AGENT_ID !== project.coordinatorAgentId
 *   3. If isCoordinator: build the CEO system prompt and write it back
 *      to `settings.systemPrompt`. Register all 5 tools.
 *   4. If isMember: append a one-line role fragment to the existing
 *      `settings.systemPrompt` (idempotent — marker-guarded). Register
 *      only `read_inbox` and `post_to_project`.
 *
 * Standalone agents (no project block) exit at step 1 with zero side
 * effects. The orchestrator's tools never reach their model context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	agentRootFromWorkspace,
	readProjectBlock,
	settingsPathFor,
	readSettings,
	writeSettings,
} from "./project.ts";
import { buildRolePromptFragment, buildSystemPrompt } from "./system-prompt.ts";
import { registerOrchestrationTools } from "./tools.ts";

// Marker in the systemPrompt that records which role's fragment is appended.
// Used to keep the append idempotent across session_starts.
const ROLE_FRAGMENT_MARKER = "\n[superhive:role-fragment:";

export default function superhivePiOrchestration(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const workspace = ctx.cwd;
		if (!workspace) {
			// No cwd — cannot derive agent root. Skip silently.
			return;
		}

		const agentRoot = agentRootFromWorkspace(workspace);
		const settingsPath = settingsPathFor(agentRoot);

		const project = readProjectBlock(settingsPath);
		if (!project || !project.localPath || !project.coordinatorAgentId) {
			// Not a project member (no project block, or missing
			// coordinatorAgentId from an older settings file).
			return;
		}

		const selfAgentId = process.env.AGENT_ID;
		if (!selfAgentId) {
			// The main process should always inject AGENT_ID; if it's
			// missing, this is a config bug. Skip without side effects.
			return;
		}

		const isCoordinator = project.coordinatorAgentId === selfAgentId;
		const role = isCoordinator ? "coordinator" : "member";

		if (isCoordinator) {
			// Build the CEO system prompt and write it back to the
			// settings file. Members keep the standard agent prompt
			// (with the role fragment appended — see below).
			const settings = readSettings(settingsPath);
			const agent = {
				name: settings?.name,
				role: settings?.role,
				description: settings?.description,
			};
			const prompt = buildSystemPrompt(project, agent);
			if (settings) {
				writeSettings(settingsPath, { ...settings, systemPrompt: prompt });
			}
		} else {
			// Member: append a one-line role fragment to systemPrompt
			// (idempotent). We never overwrite the user's prompt; we
			// just add ours after it, with a marker so subsequent
			// session_starts no-op.
			const settings = readSettings(settingsPath);
			if (settings) {
				const current = settings.systemPrompt ?? "";
				const marker = `${ROLE_FRAGMENT_MARKER}${role}]`;
				if (!current.includes(marker)) {
					const fragment = buildRolePromptFragment(role);
					const next = current
						? `${current}\n\n${fragment}${marker}`
						: `${fragment}${marker}`;
					writeSettings(settingsPath, { ...settings, systemPrompt: next });
				}
			}
		}

		registerOrchestrationTools(pi, { role, settingsPath, project });
	});
}
