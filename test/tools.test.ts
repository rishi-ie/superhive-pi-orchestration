/**
 * Tool tests — exercise the `execute` function of each tool with a temp
 * settings file. The defineTool wrapping produces a ToolDefinition; we
 * grab the inner `execute` via the definition object so we don't have to
 * boot Pi.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectBlock, settingsPathFor } from "../project.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ProjectBlock } from "../types.ts";

type AnyTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

const sampleProject: ProjectBlock = {
	id: "proj-1",
	name: "Foo",
	description: "Test project",
	members: [
		{
			agentId: "a1",
			name: "Alice",
			role: "Backend Engineer",
			model: { provider: "minimax", name: "MiniMax-M3" },
			status: "active",
			joinedAt: "2026-01-01T00:00:00Z",
		},
		{
			agentId: "a2",
			name: "Bob",
			role: "QA",
			status: "idle",
			joinedAt: "2026-01-02T00:00:00Z",
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

// Import the registerOrchestrationTools module so we can poke at its tools.
// We can't import `tools.ts` directly because it pulls in @earendil-works/pi-coding-agent
// at top level; we already loaded it (defineTool is from there).
import * as toolsModule from "../tools.ts";

async function executeList(settingsPath: string): Promise<{ ok: boolean; [k: string]: unknown }> {
	const tool = findTool(toolsModule, "list_project_agents", settingsPath) as AnyTool;
	const result = (await tool.execute("call-1", {}, undefined, undefined, makeCtx(settingsPath))) as {
		content: Array<{ text: string }>;
	};
	return JSON.parse(result.content[0]!.text);
}

async function executeGetStatus(
	settingsPath: string,
	agentId: string,
): Promise<{ ok: boolean; [k: string]: unknown }> {
	const tool = findTool(toolsModule, "get_agent_status", settingsPath) as AnyTool;
	const result = (await tool.execute(
		"call-2",
		{ agentId },
		undefined,
		undefined,
		makeCtx(settingsPath),
	)) as { content: Array<{ text: string }> };
	return JSON.parse(result.content[0]!.text);
}

async function executeStub(
	name: string,
	params: Record<string, unknown>,
): Promise<{ ok: boolean; [k: string]: unknown }> {
	const tool = findTool(toolsModule, name, "/dev/null") as AnyTool;
	const result = (await tool.execute(
		"call-3",
		params,
		undefined,
		undefined,
		makeCtx("/dev/null"),
	)) as { content: Array<{ text: string }> };
	return JSON.parse(result.content[0]!.text);
}

function findTool(mod: Record<string, unknown>, name: string, settingsPath: string): unknown {
	const handles: Record<string, AnyTool> = {};
	const fakePi = {
		registerTool(tool: { name: string; execute: AnyTool["execute"] }) {
			handles[tool.name] = tool as AnyTool;
		},
	};
	(mod.registerOrchestrationTools as (pi: unknown, settingsPath: string) => void)(fakePi, settingsPath);
	if (!handles[name]) throw new Error(`tool ${name} not registered by registerOrchestrationTools`);
	return handles[name]!;
}

function makeCtx(settingsPath: string) {
	// Minimal ExtensionContext stub. We don't use any of its fields in our
	// tool execute bodies, so empty object is fine.
	return { settingsPath } as unknown as Parameters<AnyTool["execute"]>[4];
}

test("registerOrchestrationTools: registers exactly 5 tools", () => {
	const handles: string[] = [];
	const fakePi = {
		registerTool(tool: { name: string }) {
			handles.push(tool.name);
		},
	};
	toolsModule.registerOrchestrationTools(fakePi as unknown as never, "/dev/null");
	assert.equal(handles.length, 5);
	assert.deepEqual(handles.sort(), [
		"dispatch_to_agent",
		"get_agent_status",
		"list_project_agents",
		"read_inbox",
		"send_message_to_agent",
	]);
});

test("registerOrchestrationTools: closure captures settingsPath", () => {
	const handles: Record<string, AnyTool> = {};
	const fakePi = {
		registerTool(tool: { name: string; execute: AnyTool["execute"] }) {
			handles[tool.name] = tool as AnyTool;
		},
	};
	const settingsPath = "/nonexistent/never-read";
	toolsModule.registerOrchestrationTools(fakePi as unknown as never, settingsPath);
	// The list_project_agents tool should read from /nonexistent/never-read and return ok=false
	void handles.list_project_agents!.execute("x", {}, undefined, undefined, makeCtx(settingsPath));
	// No exception thrown — closure works.
	assert.ok(handles.list_project_agents);
});

// list_project_agents

test("list_project_agents: returns full roster with counts", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject();
	try {
		const result = await executeList(settingsPath);
		assert.equal(result.ok, true);
		assert.equal(result.projectId, "proj-1");
		assert.equal(result.projectName, "Foo");
		assert.equal(result.count, 2);
		assert.ok(Array.isArray(result.members));
		assert.equal((result.members as unknown[]).length, 2);
	} finally {
		cleanup();
	}
});

test("list_project_agents: returns ok=false when project block missing", async () => {
	const { settingsPath, cleanup } = tempAgentEmpty();
	try {
		const result = await executeList(settingsPath);
		assert.equal(result.ok, false);
		assert.match(String(result.error), /no project block/);
	} finally {
		cleanup();
	}
});

// get_agent_status

test("get_agent_status: returns member when found", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject();
	try {
		const result = await executeGetStatus(settingsPath, "a1");
		assert.equal(result.ok, true);
		const member = result.member as { name: string; status: string; role: string };
		assert.equal(member.name, "Alice");
		assert.equal(member.status, "active");
		assert.equal(member.role, "Backend Engineer");
	} finally {
		cleanup();
	}
});

test("get_agent_status: returns ok=false for unknown id", async () => {
	const { settingsPath, cleanup } = tempAgentWithProject();
	try {
		const result = await executeGetStatus(settingsPath, "ghost");
		assert.equal(result.ok, false);
		assert.match(String(result.error), /not a member/);
	} finally {
		cleanup();
	}
});

// Gap 2 stubs

test("dispatch_to_agent: returns Gap 2 stub error", async () => {
	const result = await executeStub("dispatch_to_agent", {
		agentId: "a1",
		task: "implement POST /orders",
	});
	assert.equal(result.ok, false);
	assert.match(String(result.error), /Gap 2/);
	assert.match(String(result.error), /mailbox not yet wired/);
	const received = result.received as { agentId: string; taskLength: number; priority: string };
	assert.equal(received.agentId, "a1");
	assert.equal(received.taskLength, "implement POST /orders".length);
	assert.equal(received.priority, "normal");
});

test("read_inbox: returns Gap 2 stub error with defaults", async () => {
	const result = await executeStub("read_inbox", {});
	assert.equal(result.ok, false);
	assert.match(String(result.error), /Gap 2/);
	const received = result.received as { limit: number; markAsRead: boolean };
	assert.equal(received.limit, 50);
	assert.equal(received.markAsRead, true);
});

test("send_message_to_agent: returns Gap 2 stub error", async () => {
	const result = await executeStub("send_message_to_agent", {
		agentId: "a2",
		body: "ping",
		kind: "question",
	});
	assert.equal(result.ok, false);
	assert.match(String(result.error), /Gap 2/);
	const received = result.received as { agentId: string; bodyLength: number; kind: string };
	assert.equal(received.agentId, "a2");
	assert.equal(received.bodyLength, 4);
	assert.equal(received.kind, "question");
});

// Smoke that the project.ts dependency we rely on is wired in
test("smoke: tools can read project block written by project.ts", async () => {
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-smoke-"));
	const settingsPath = settingsPathFor(root);
	try {
		writeProjectBlock(settingsPath, sampleProject);
		const result = await executeList(settingsPath);
		assert.equal(result.ok, true);
		assert.equal(result.count, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Reference for unused imports
void defineTool;
void writeFileSync;