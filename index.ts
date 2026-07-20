/**
 * superhive-pi-orchestration — entry point.
 *
 * On `session_start`:
 *   1. Gate on `process.env.AGENT_KIND === 'project-coordinator'`. Standard
 *      agents no-op (the 5 tools below must never reach their model context).
 *   2. Compute the truth settings file path from the Pi workspace cwd.
 *   3. Read the settings file. If the `project` block is missing, no-op.
 *   4. Build the CEO system prompt from the project block + agent identity.
 *   5. Write the prompt back to `settings.systemPrompt` (atomic write +
 *      writer-counter bump, mirroring truth's pattern).
 *   6. Register the 5 coordinator-only tools.
 *
 * Standard agents (AGENT_KIND !== 'project-coordinator') exit at step 1
 * with zero side effects.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	agentRootFromWorkspace,
	readProjectBlock,
	settingsPathFor,
	writeSettings,
} from "./project.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { registerOrchestrationTools } from "./tools.ts";

export default function superhivePiOrchestration(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.AGENT_KIND !== "project-coordinator") {
			return;
		}

		const workspace = ctx.cwd;
		if (!workspace) {
			// No cwd — cannot derive agent root. Skip silently.
			return;
		}

		const agentRoot = agentRootFromWorkspace(workspace);
		const settingsPath = settingsPathFor(agentRoot);

		const project = readProjectBlock(settingsPath);
		if (!project) {
			// Not a coordinator (no project block). Skip silently.
			return;
		}

		const settings = (await import("./project.ts")).readSettings(settingsPath);
		const agent = {
			name: settings?.name,
			role: settings?.role,
			description: settings?.description,
		};

		const prompt = buildSystemPrompt(project, agent);

		if (settings) {
			writeSettings(settingsPath, { ...settings, systemPrompt: prompt });
		}

		registerOrchestrationTools(pi, settingsPath);
	});
}