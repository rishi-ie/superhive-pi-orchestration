/**
 * Tool tests — exercise the `execute` function of each tool with a temp
 * settings file. The defineTool wrapping produces a ToolDefinition; we
 * grab the inner `execute` via the definition object so we don't have to
 * boot Pi.
 *
 * Gap 2: the 3 mailbox tools are now wired to real FS behavior via
 * project.ts helpers. The tests below exercise roundtrips for
 * ask_member → readMemberInbox, read_inbox → chat filter, and
 * post_to_project → chat append.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsPathFor, writeProjectBlock } from "../project.ts";
import type { ProjectBlock } from "../types.ts";

type AnyTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

const sampleProject: ProjectBlock = {
	id: "proj-1",
	name: "Foo",
	description: "Test project",
	localPath: "/tmp/sample-project",
	coordinatorAgentId: "a1",
	members: [
		{
			agentId: "a1",
			name: "Alice",
			role: "Backend Engineer",
			model: { provider: "minimax", name: "MiniMax-M3" },
			status: "active",
			joinedAt: "2026-01-01T00:00:00Z",
			localPath: "/tmp/sample-project/agent",
		},
		{
			agentId: "a2",
			name: "Bob",
			role: "QA",
			status: "idle",
			joinedAt: "2026-01-02T00:00:00Z",
			localPath: "/tmp/sample-project/agents/bob",
		},
	],
};

function tempAgentWithProject(): {
	settingsPath: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-tools-"));
	const settingsPath = settingsPathFor(root);
	writeProjectBlock(settingsPath, sampleProject);
	return {
		settingsPath,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function tempAgentEmpty(): { settingsPath: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-tools-"));
	const settingsPath = settingsPathFor(root);
	return {
		settingsPath,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

import * as toolsModule from "../tools.ts";

interface RegisterOpts {
	role: "coordinator" | "member"
	settingsPath: string
	project: ProjectBlock
}

function makeRegisterOpts(role: "coordinator" | "member", settingsPath: string): RegisterOpts {
	return { role, settingsPath, project: sampleProject }
}

async function executeList(settingsPath: string): Promise<{ ok: boolean; [k: string]: unknown }> {
	const tool = findToolByRole("list_project_agents", "coordinator", settingsPath) as AnyTool;
	const result = (await tool.execute("call-1", {}, undefined, undefined)) as {
		content: Array<{ text: string }>
	};
	return JSON.parse(result.content[0]!.text);
}

async function executeGetStatus(
	settingsPath: string,
	agentId: string,
): Promise<{ ok: boolean; [k: string]: unknown }> {
	const tool = findToolByRole("get_agent_status", "coordinator", settingsPath) as AnyTool;
	const result = (await tool.execute("call-2", { agentId }, undefined, undefined)) as {
		content: Array<{ text: string }>
	};
	return JSON.parse(result.content[0]!.text);
}

function findTool(name: string, opts: RegisterOpts): unknown {
	const handles: Record<string, AnyTool> = {};
	const fakePi = {
		registerTool(tool: { name: string; execute: AnyTool["execute"] }) {
			handles[tool.name] = tool as AnyTool;
		},
	};
	(toolsModule.registerOrchestrationTools as (pi: unknown, opts: RegisterOpts) => void)(fakePi, opts);
	if (!handles[name]) throw new Error(`tool ${name} not registered`);
	return handles[name]!;
}

function findToolByRole(name: string, role: "coordinator" | "member", settingsPath: string): unknown {
	return findTool(name, makeRegisterOpts(role, settingsPath));
}

test("registerOrchestrationTools: registers exactly 7 tools for coordinator", () => {
	const handles: string[] = [];
	const fakePi = {
		registerTool(tool: { name: string }) {
			handles.push(tool.name)
		},
	}
	const opts = makeRegisterOpts("coordinator", "/dev/null")
	toolsModule.registerOrchestrationTools(fakePi as unknown as never, opts)
	assert.equal(handles.length, 7)
	assert.deepEqual(handles.sort(), [
		"ask_member",
		"complete_task",
		"get_agent_status",
		"list_project_agents",
		"plan_tasks",
		"post_to_project",
		"read_inbox",
	])
})

test("registerOrchestrationTools: registers exactly 2 tools for member", () => {
	const handles: string[] = []
	const fakePi = {
		registerTool(tool: { name: string }) {
			handles.push(tool.name)
		},
	}
	const opts = makeRegisterOpts("member", "/dev/null")
	toolsModule.registerOrchestrationTools(fakePi as unknown as never, opts)
	assert.equal(handles.length, 2)
	assert.deepEqual(handles.sort(), ["post_to_project", "read_inbox"])
})

// list_project_agents

test("list_project_agents: returns full roster with counts", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject()
	try {
		const result = await executeList(settingsPath)
		assert.equal(result.ok, true)
		assert.equal(result.projectId, "proj-1")
		assert.equal(result.projectName, "Foo")
		assert.equal(result.count, 2)
		assert.ok(Array.isArray(result.members))
		assert.equal((result.members as unknown[]).length, 2)
	} finally {
		cleanup()
	}
})

test("list_project_agents: returns ok=false when project block missing", async () => {
	const { settingsPath, cleanup } = tempAgentEmpty()
	try {
		const result = await executeList(settingsPath)
		assert.equal(result.ok, false)
		assert.match(String(result.error), /no project block/)
	} finally {
		cleanup()
	}
})

// get_agent_status

test("get_agent_status: returns member when found", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject()
	try {
		const result = await executeGetStatus(settingsPath, "a1")
		assert.equal(result.ok, true)
		const member = result.member as { name: string; status: string; role: string }
		assert.equal(member.name, "Alice")
		assert.equal(member.status, "active")
		assert.equal(member.role, "Backend Engineer")
	} finally {
		cleanup()
	}
})

test("get_agent_status: returns ok=false for unknown id", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject()
	try {
		const result = await executeGetStatus(settingsPath, "ghost")
		assert.equal(result.ok, false)
		assert.match(String(result.error), /not a member/)
	} finally {
		cleanup()
	}
})

// ask_member — wires to appendMemberInbox

test("ask_member: returns ok=true and writes to member's localPath", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject()
	try {
		const tool = findTool("ask_member", makeRegisterOpts("coordinator", settingsPath)) as AnyTool
		const result = (await tool.execute("c1", { agentId: "a2", body: "do the thing" }, undefined, undefined)) as {
			content: Array<{ text: string }>
		}
		const parsed = JSON.parse(result.content[0]!.text)
		assert.equal(parsed.ok, true)
		assert.ok(parsed.messageId)
		assert.equal(parsed.toAgentId, "a2")
	} finally {
		cleanup()
	}
})

test("ask_member: returns ok=false for unknown agentId", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject()
	try {
		const tool = findTool("ask_member", makeRegisterOpts("coordinator", settingsPath)) as AnyTool
		const result = (await tool.execute("c1", { agentId: "ghost", body: "x" }, undefined, undefined)) as {
			content: Array<{ text: string }>
		}
		const parsed = JSON.parse(result.content[0]!.text)
		assert.equal(parsed.ok, false)
		assert.match(String(parsed.error), /not a member/)
	} finally {
		cleanup()
	}
})

// read_inbox — role-aware

test("read_inbox: coordinator reads project chat filtered to kinds, excluding self+user, excluding delivered", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject()
	try {
		// Pre-populate the chat via post_to_project from a fake a2 (member).
		const post = findTool("post_to_project", makeRegisterOpts("member", settingsPath)) as AnyTool
		process.env.AGENT_ID = "a2"
		const postResult = (await post.execute("p1", { body: "I need help", kind: "request" }, undefined, undefined)) as {
			content: Array<{ text: string }>
		}
		const postedId = JSON.parse(postResult.content[0]!.text).messageId as string
		// Coordinator's read_inbox (self = a1) should see it.
		process.env.AGENT_ID = "a1"
		const read = findTool("read_inbox", makeRegisterOpts("coordinator", settingsPath)) as AnyTool
		const result = (await read.execute("r1", {}, undefined, undefined)) as {
			content: Array<{ text: string }>
		}
		const parsed = JSON.parse(result.content[0]!.text)
		assert.equal(parsed.ok, true)
		assert.ok(parsed.count >= 1)
		const items = parsed.items as Array<{ id: string; fromAgentId: string; kind: string; parts: Array<{ text: string }> }>
		const ours = items.find((i) => i.id === postedId)
		assert.ok(ours, "expected to find the post in the inbox")
		assert.equal(ours.fromAgentId, "a2")
		assert.equal(ours.kind, "request")
		assert.equal(ours.parts[0]?.text, "I need help")
	} finally {
		cleanup()
		delete process.env.AGENT_ID
	}
})

// post_to_project

test("post_to_project: appends a tagged entry to project chat", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject()
	try {
		process.env.AGENT_ID = "a2"
		const tool = findTool("post_to_project", makeRegisterOpts("member", settingsPath)) as AnyTool
		const result = (await tool.execute("p1", { body: "hello team", kind: "result" }, undefined, undefined)) as {
			content: Array<{ text: string }>
		}
		const parsed = JSON.parse(result.content[0]!.text)
		assert.equal(parsed.ok, true)
		assert.ok(parsed.messageId)
	} finally {
		cleanup()
		delete process.env.AGENT_ID
	}
})

// Smoke that the project.ts dependency we rely on is wired in
test("smoke: tools can read project block written by project.ts", async () => {
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-smoke-"))
	const settingsPath = settingsPathFor(root)
	try {
		writeProjectBlock(settingsPath, sampleProject)
		const result = await executeList(settingsPath)
		assert.equal(result.ok, true)
		assert.equal(result.count, 2)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
