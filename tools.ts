/**
 * Coordinator-only orchestration tools.
 *
 * 5 tools, gated to `project-coordinator` agents via conditional registration
 * in `index.ts`. 2 read live state from the truth settings file. 3 return
 * honest Gap 2 stubs so the LLM sees the real failure mode instead of
 * silently no-op'ing.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readProjectBlock } from "./project.ts";
import type { ProjectBlock } from "./types.ts";

const GAP2_ERROR =
	"mailbox not yet wired (Gap 2). This tool will be implemented when Gap 2 lands — see superhive/GAPS.md.";

function jsonResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

export function registerOrchestrationTools(pi: ExtensionAPI, settingsPath: string): void {
	pi.registerTool(listProjectAgents(settingsPath));
	pi.registerTool(getAgentStatus(settingsPath));
	pi.registerTool(dispatchToAgent());
	pi.registerTool(readInbox());
	pi.registerTool(sendMessageToAgent());
}

// ---------------------------------------------------------------------------
// 1. list_project_agents — returns the live roster
// ---------------------------------------------------------------------------

function listProjectAgents(settingsPath: string) {
	return defineTool({
		name: "list_project_agents",
		label: "List Project Agents",
		description:
			"Return all specialist agents assigned to this project, with their id, name, role, model, and current status. Use this to enumerate your team before dispatching work.",
		parameters: Type.Object({}),

		async execute(_id, _params) {
			const project = readProjectBlock(settingsPath);
			if (!project) {
				return jsonResult({ ok: false, error: "no project block on disk" });
			}
			return jsonResult({
				ok: true,
				projectId: project.id,
				projectName: project.name,
				count: project.members.length,
				members: project.members,
			});
		},
	});
}

// ---------------------------------------------------------------------------
// 2. get_agent_status — looks up one member by id
// ---------------------------------------------------------------------------

const GetAgentStatusParams = Type.Object({
	agentId: Type.String({ description: "The agentId of the specialist to look up" }),
});

function getAgentStatus(settingsPath: string) {
	return defineTool({
		name: "get_agent_status",
		label: "Get Agent Status",
		description:
			"Return the current status, model, and role for one specialist by agentId. Use this to confirm a worker is idle before dispatching.",
		parameters: GetAgentStatusParams,

		async execute(_id, params) {
			const project = readProjectBlock(settingsPath);
			if (!project) {
				return jsonResult({ ok: false, error: "no project block on disk" });
			}
			const member = project.members.find((m) => m.agentId === params.agentId);
			if (!member) {
				return jsonResult({
					ok: false,
					error: `agentId ${params.agentId} is not a member of project ${project.id}`,
				});
			}
			return jsonResult({ ok: true, member });
		},
	});
}

// ---------------------------------------------------------------------------
// 3. dispatch_to_agent — Gap 2 stub
// ---------------------------------------------------------------------------

const DispatchParams = Type.Object({
	agentId: Type.String({ description: "Target specialist's agentId" }),
	task: Type.String({ description: "The task description to send" }),
	priority: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")], {
			description: "Task priority (default 'normal')",
		}),
	),
});

function dispatchToAgent() {
	return defineTool({
		name: "dispatch_to_agent",
		label: "Dispatch To Agent",
		description:
			"[GAP 2 STUB] Assign a task to a specialist. Returns an error in Gap 1 because the mailbox substrate is not yet wired. Replace this stub when Gap 2 lands.",
		parameters: DispatchParams,

		async execute(_id, params) {
			return jsonResult({
				ok: false,
				error: GAP2_ERROR,
				hint: "wanted to dispatch",
				received: {
					agentId: params.agentId,
					taskLength: params.task.length,
					priority: params.priority ?? "normal",
				},
			});
		},
	});
}

// ---------------------------------------------------------------------------
// 4. read_inbox — Gap 2 stub
// ---------------------------------------------------------------------------

const ReadInboxParams = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Max messages to return (default 50)" })),
	markAsRead: Type.Optional(
		Type.Boolean({ description: "If true, mark returned messages as read (default true)" }),
	),
});

function readInbox() {
	return defineTool({
		name: "read_inbox",
		label: "Read Inbox",
		description:
			"[GAP 2 STUB] Read messages addressed to this coordinator. Returns an error in Gap 1 because the mailbox substrate is not yet wired.",
		parameters: ReadInboxParams,

		async execute(_id, params) {
			return jsonResult({
				ok: false,
				error: GAP2_ERROR,
				hint: "wanted to read inbox",
				received: { limit: params.limit ?? 50, markAsRead: params.markAsRead ?? true },
			});
		},
	});
}

// ---------------------------------------------------------------------------
// 5. send_message_to_agent — Gap 2 stub
// ---------------------------------------------------------------------------

const SendMessageParams = Type.Object({
	agentId: Type.String({ description: "Target specialist's agentId" }),
	body: Type.String({ description: "Message body" }),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("question"),
				Type.Literal("result"),
				Type.Literal("request"),
				Type.Literal("broadcast"),
			],
			{ description: "Message kind (default 'request')" },
		),
	),
});

function sendMessageToAgent() {
	return defineTool({
		name: "send_message_to_agent",
		label: "Send Message To Agent",
		description:
			"[GAP 2 STUB] Send a direct message to a specialist. Returns an error in Gap 1 because the mailbox substrate is not yet wired.",
		parameters: SendMessageParams,

		async execute(_id, params) {
			return jsonResult({
				ok: false,
				error: GAP2_ERROR,
				hint: "wanted to send message",
				received: {
					agentId: params.agentId,
					bodyLength: params.body.length,
					kind: params.kind ?? "request",
				},
			});
		},
	});
}

export type { ProjectBlock };