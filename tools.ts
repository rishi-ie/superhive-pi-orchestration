/**
 * Orchestration tools, registered for both project coordinators and
 * project members. The set of tools depends on the role:
 *   - coordinator: all 7 tools
 *       (list_project_agents, get_agent_status, ask_member, read_inbox,
 *        post_to_project, plan_tasks, complete_task)
 *   - member: 2 tools
 *       (read_inbox, post_to_project)
 *
 * Gap 2: the 3 mailbox tools (ask_member, read_inbox, post_to_project) are
 * wired to the pure-FS helpers in project.ts. The on-disk format matches
 * `electron/mailbox-store.ts` so the main-process watcher treats
 * orchestrator writes and main-process IPC writes indistinguishably.
 *
 * Gap 3: plan_tasks + complete_task (coordinator-only) write JSON/JSONL
 * files to <coordDir>/. The main process's tasks-file-watcher ingests
 * them into db.tasks.json and truncates the files. The orchestrator
 * never reaches into Electron (AGENTS.md rule 2) — file drop only.
 *
 * Role-aware behavior:
 *   - read_inbox (coordinator): reads <projectDir>/agent/chat.jsonl,
 *       filters by kind, excludes self+user, excludes already-delivered.
 *   - read_inbox (member):      reads <memberDir>/inbox.jsonl, status=pending.
 *   - post_to_project:          same on both — appends to project chat.
 *   - ask_member, plan_tasks, complete_task: coordinator-only.
 */

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ackInboxMessage,
	appendMemberInbox,
	appendProjectChat,
	appendTaskComplete,
	findMemberById,
	markChatDelivered,
	readMemberInbox,
	readProjectChat,
	readProjectBlock,
	readSettings,
	writeTaskPlan,
} from "./project.ts";
import type { ChatEntry, InboxEntry, MailKind, MemberRef, ProjectBlock } from "./types.ts";

function jsonResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

export interface RegisterOpts {
	role: "coordinator" | "member";
	settingsPath: string;
	project: ProjectBlock;
}

export function registerOrchestrationTools(pi: ExtensionAPI, opts: RegisterOpts): void {
	if (opts.role === "coordinator") {
		pi.registerTool(listProjectAgents(opts.settingsPath));
		pi.registerTool(getAgentStatus(opts.settingsPath));
		pi.registerTool(askMember(opts));
		pi.registerTool(readInbox(opts));
		pi.registerTool(postToProject(opts));
		pi.registerTool(planTasks(opts));      // Gap 3
		pi.registerTool(completeTask(opts));   // Gap 3
	} else {
		pi.registerTool(readInbox(opts));
		pi.registerTool(postToProject(opts));
	}
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
// 3. ask_member — coordinator-only, writes to member's inbox.jsonl
// ---------------------------------------------------------------------------

const AskMemberParams = Type.Object({
	agentId: Type.String({ description: "Target specialist's agentId" }),
	body: Type.String({ description: "Question or task for the specialist" }),
	kind: Type.Optional(
		Type.Union([Type.Literal("request"), Type.Literal("question"), Type.Literal("result")], {
			description: "Message kind (default 'request')",
		}),
	),
});

function askMember(opts: RegisterOpts) {
	return defineTool({
		name: "ask_member",
		label: "Ask Member",
		description:
			"Send a direct ask to a specific member agent. The member's runtime wakes and reads its inbox. Use this to delegate a question to a specialist who can answer it.",
		parameters: AskMemberParams,

		async execute(_id, params) {
			if (opts.role !== "coordinator") {
				return jsonResult({
					ok: false,
					error: "ask_member is coordinator-only; workers post to the project chat instead",
				});
			}
			const member: MemberRef | undefined = findMemberById(opts.project, params.agentId);
			if (!member) {
				return jsonResult({
					ok: false,
					error: `agentId ${params.agentId} is not a member of project ${opts.project.id}`,
				});
			}
			if (!member.localPath) {
				return jsonResult({
					ok: false,
					error: `member ${params.agentId} has no localPath; cannot write inbox`,
				});
			}
			const selfAgentId = process.env.AGENT_ID ?? "";
			const entry: InboxEntry = {
				id: randomUUID(),
				ts: Date.now(),
				fromAgentId: selfAgentId,
				toAgentId: params.agentId,
				kind: (params.kind as InboxEntry["kind"]) ?? "request",
				body: params.body,
				refMessageId: undefined,
				status: "pending",
			};
			appendMemberInbox(member.localPath, entry);
			return jsonResult({ ok: true, messageId: entry.id, toAgentId: params.agentId });
		},
	});
}

// ---------------------------------------------------------------------------
// 4. read_inbox — role-aware: coord reads chat, member reads own inbox
// ---------------------------------------------------------------------------

const ReadInboxParams = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Max messages to return (default 50)" })),
	markAsRead: Type.Optional(
		Type.Boolean({ description: "If true, mark returned messages as read (default true)" }),
	),
});

function readInbox(opts: RegisterOpts) {
	return defineTool({
		name: "read_inbox",
		label: "Read Inbox",
		description:
			opts.role === "coordinator"
				? "Read pending messages in the project chat. Returns worker posts addressed to you, excluding your own messages and ones you've already read. Use this to see what your team needs."
				: "Read pending direct asks in your inbox. Returns the latest entries from the project agent.",
		parameters: ReadInboxParams,

		async execute(_id, params) {
			const limit = params.limit ?? 50;
			const markAsRead = params.markAsRead ?? true;
			const selfAgentId = process.env.AGENT_ID ?? "";

			if (opts.role === "coordinator") {
				if (!opts.project.localPath) {
					return jsonResult({ ok: false, error: "project has no localPath" });
				}
				const entries = readProjectChat(opts.project.localPath, {
					limit,
					kinds: ["request", "question", "broadcast", "result"],
					excludeFromAgentIds: [selfAgentId, null], // null = user
					excludeDeliveredTo: [selfAgentId],
				});
				if (markAsRead) {
					for (const e of entries) {
						markChatDelivered(opts.project.localPath, e.id, selfAgentId);
					}
				}
				return jsonResult({ ok: true, count: entries.length, items: entries });
			}

			// role === 'member'
			const self = findMemberById(opts.project, selfAgentId);
			const selfDir = self?.localPath ?? dirname(opts.settingsPath);
			const items = readMemberInbox(selfDir, { limit, status: ["pending"] });
			if (markAsRead) {
				for (const item of items) {
					ackInboxMessage(selfDir, item.id);
				}
			}
			return jsonResult({ ok: true, count: items.length, items });
		},
	});
}

// ---------------------------------------------------------------------------
// 5. post_to_project — append to project chat
// ---------------------------------------------------------------------------

const PostToProjectParams = Type.Object({
	body: Type.String({ description: "Message body" }),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("request"),
				Type.Literal("question"),
				Type.Literal("result"),
				Type.Literal("broadcast"),
			],
			{ description: "Message kind (default 'request')" },
		),
	),
	refMessageId: Type.Optional(
		Type.String({ description: "If this is a reply, the messageId being replied to" }),
	),
});

function postToProject(opts: RegisterOpts) {
	return defineTool({
		name: "post_to_project",
		label: "Post To Project",
		description:
			"Append a message to the project chat. Visible to the user, the coordinator, and other agents. Use this to ask a question, post a result, or broadcast an update.",
		parameters: PostToProjectParams,

		async execute(_id, params) {
			if (!opts.project.localPath) {
				return jsonResult({ ok: false, error: "project has no localPath" });
			}
			const settings = readSettings(opts.settingsPath);
			const entry: ChatEntry = {
				id: randomUUID(),
				ts: Date.now(),
				role: "assistant",
				parts: [{ type: "text", text: params.body }],
				fromAgentId: process.env.AGENT_ID ?? undefined,
				fromAgentName: settings?.identity?.name,
				kind: (params.kind as MailKind) ?? "request",
				refMessageId: params.refMessageId,
			};
			appendProjectChat(opts.project.localPath, entry);
			return jsonResult({ ok: true, messageId: entry.id });
		},
	});
}

export type { ProjectBlock, MailKind };

// ---------------------------------------------------------------------------
// 6. plan_tasks — coordinator-only. Writes a TaskPlan to <coordDir>/tasks-plan.json.
//    Main-process tailer ingests into db.tasks.json and truncates the file.
// ---------------------------------------------------------------------------

const PlanTasksParams = Type.Object({
  tasks: Type.Array(
    Type.Object({
      title: Type.String({ description: "Short, imperative: 'Add login form'" }),
      description: Type.Optional(Type.String({ description: "Long-form context" })),
      dependencies: Type.Optional(
        Type.Array(Type.String({ description: "Title of another task this depends on" })),
      ),
      assignedAgent: Type.String({
        description: "Member's name (must match a roster entry in the project block)",
      }),
    }),
    { minItems: 1 },
  ),
})

function planTasks(opts: RegisterOpts) {
  return defineTool({
    name: "plan_tasks",
    label: "Plan Tasks",
    description:
      "Break a complex request into a dependency graph of tasks. " +
      "Each task gets dispatched to its assignedAgent when its dependencies " +
      "are done. The main process ingests this plan asynchronously and the " +
      "right-panel 'Active tasks' accordion will show the work. " +
      "Returns the count of plan entries written — the actual task ids are " +
      "assigned by the main process and visible in the next read_inbox or " +
      "post_to_project exchange.",
    parameters: PlanTasksParams,

    async execute(_id, params) {
      const coordDir = dirname(opts.settingsPath)
      const plan = {
        tasks: params.tasks.map((t) => ({
          title: t.title,
          description: t.description,
          dependencies: t.dependencies,
          assignedAgent: t.assignedAgent,
        })),
      }
      writeTaskPlan(coordDir, plan)
      return jsonResult({
        written: plan.tasks.length,
        note: "Plan written; main process ingests asynchronously. Task ids are assigned by the main process and will surface in the next read_inbox.",
      })
    },
  })
}

// ---------------------------------------------------------------------------
// 7. complete_task — coordinator-only. Appends a TaskCompleteEntry to
//    <coordDir>/tasks-complete.jsonl. Main-process tailer ingests as
//    changeStatus('completed', { outcome: summary }) and truncates.
// ---------------------------------------------------------------------------

const CompleteTaskParams = Type.Object({
  taskId: Type.String({ description: "The task's id (from read_inbox context)" }),
  summary: Type.Optional(Type.String({ description: "What was delivered" })),
})

function completeTask(opts: RegisterOpts) {
  return defineTool({
    name: "complete_task",
    label: "Complete Task",
    description:
      "Mark a task as completed with a brief outcome summary. Call this " +
      "after the assigned worker has posted a result to the project chat " +
      "and you've read it via read_inbox. The main process ingests the " +
      "completion asynchronously and the task moves to the bottom of the " +
      "Active tasks accordion (dimmed).",
    parameters: CompleteTaskParams,

    async execute(_id, params) {
      const coordDir = dirname(opts.settingsPath)
      appendTaskComplete(coordDir, {
        taskId: params.taskId,
        summary: params.summary,
        ts: Date.now(),
      })
      return jsonResult({ ok: true, taskId: params.taskId, status: "completed" })
    },
  })
}
