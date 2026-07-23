/**
 * superhive-pi-orchestration — entry point.
 *
 * Gap 2 change: the gate is no longer "AGENT_KIND === 'project-coordinator'".
 * The extension now loads for any project member and detects role by
 * comparing AGENT_ID against project.coordinatorAgentId.
 *
 * 4-file truth split:
 *   - manage.json holds the `project` block + identity.{name,description}
 *   - settings.json holds the runtime systemPrompt
 *
 * On `session_start`:
 *   1. Read manage.json. If `project` is missing, no-op.
 *   2. Determine role by AGENT_ID === project.coordinatorAgentId.
 *   3. Coordinator: build the CEO prompt and write it back to
 *      settings.json's systemPrompt. Register all 7 tools.
 *   4. Member: append a one-line role fragment to settings.json's
 *      systemPrompt (idempotent — marker-guarded). Register only
 *      read_inbox + post_to_project.
 *
 * Standalone agents (no project block) exit at step 1 with zero side
 * effects. The orchestrator's tools never reach their model context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	agentRootFromWorkspace,
	readProjectBlock,
	readSettings,
	readSettingsJson,
	settingsJsonPathFor,
	settingsPathFor,
	writeSettingsJson,
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
		const managePath = settingsPathFor(agentRoot);
		const settingsJsonPath = settingsJsonPathFor(agentRoot);

		const project = readProjectBlock(managePath);
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
			// Build the CEO system prompt and write it back to settings.json.
			// Identity fields come from manage.json; the prompt itself lands
			// in settings.json so the runtime reads it on session_start.
			const manage = readSettings(managePath);
			const agent = {
				name: manage?.identity?.name,
				description: manage?.identity?.description,
			};
			const prompt = buildSystemPrompt(project, agent);
			const settingsJson = readSettingsJson(settingsJsonPath);
			if (settingsJson) {
				writeSettingsJson(settingsJsonPath, { ...settingsJson, systemPrompt: prompt });
			}
		} else {
			// Member: append a one-line role fragment to settings.json's
			// systemPrompt (idempotent).
			const settingsJson = readSettingsJson(settingsJsonPath);
			if (settingsJson) {
				const current = settingsJson.systemPrompt ?? "";
				const marker = `${ROLE_FRAGMENT_MARKER}${role}]`;
				if (!current.includes(marker)) {
					const fragment = buildRolePromptFragment(role);
					const next = current
						? `${current}\n\n${fragment}${marker}`
						: `${fragment}${marker}`;
					writeSettingsJson(settingsJsonPath, { ...settingsJson, systemPrompt: next });
				}
			}
		}

		registerOrchestrationTools(pi, { role, settingsPath: managePath, project });
	});
}
