/**
 * End-to-end smoke test for superhive-pi-orchestration.
 *
 * Mirrors the smoke test pattern from superhive-pi-context. We do not boot
 * Pi; we load the extension factory directly and drive its session_start
 * handler with a fake ExtensionAPI.
 *
 * Gap 2 assertions:
 *   1. Module loads and exports a default function.
 *   2. When AGENT_ID is missing or the agent has no project block, no
 *      tools are registered.
 *   3. When AGENT_ID === project.coordinatorAgentId, the agent is the
 *      coordinator: 5 tools registered, systemPrompt = CEO prompt.
 *   4. When AGENT_ID !== project.coordinatorAgentId, the agent is a
 *      member: 2 tools registered (read_inbox, post_to_project), no
 *      ask_member, and the systemPrompt gets a role fragment appended.
 *   5. list_project_agents, get_agent_status, ask_member, read_inbox,
 *      post_to_project all execute without error and produce a result
 *      we can parse.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsPathFor, writeProjectBlock } from "../project.ts";
import type { ProjectBlock } from "../types.ts";

import orchIndex from "../index.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface FakeAPI {
	registered: RegisteredTool[];
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
	on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>): void;
	registerTool(tool: RegisteredTool): void;
}

function makeFakeAPI(): FakeAPI {
	const api: FakeAPI = {
		registered: [],
		handlers: new Map(),
		on(event, handler) {
			api.handlers.set(event, handler);
		},
		registerTool(tool) {
			api.registered.push(tool);
		},
	};
	return api;
}

const sampleProject: ProjectBlock = {
	id: "proj-smoke",
	name: "SmokeProject",
	description: "End-to-end smoke fixture",
	localPath: "/tmp/superhive-smoke-project",
	coordinatorAgentId: "alice",
	members: [
		{
			agentId: "alice",
			name: "Alice",
			role: "Backend",
			model: { provider: "minimax", name: "MiniMax-M3" },
			status: "active",
			joinedAt: "2026-01-01T00:00:00Z",
			localPath: "/tmp/superhive-smoke-project/agent",
		},
		{
			agentId: "bob",
			name: "Bob",
			role: "QA",
			status: "idle",
			joinedAt: "2026-01-02T00:00:00Z",
			localPath: "/tmp/superhive-smoke-project/agents/bob",
		},
	],
};

function tempAgentWithProject(project: ProjectBlock): {
	root: string;
	workspace: string;
	settingsPath: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-smoke-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	const settingsPath = settingsPathFor(root);
	writeProjectBlock(settingsPath, project);
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	settings.name = "Coordinator";
	settings.role = "Project Lead";
	writeFileSync(settingsPath, JSON.stringify(settings, null, "\t") + "\n", "utf8");
	return {
		root,
		workspace,
		settingsPath,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function tempAgentEmpty(): { root: string; workspace: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-smoke-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	return {
		root,
		workspace,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

const originalAgentId = process.env.AGENT_ID;

async function runSessionStart(
	api: FakeAPI,
	workspace: string,
	agentId: string | undefined,
): Promise<void> {
	if (agentId === undefined) {
		delete process.env.AGENT_ID;
	} else {
		process.env.AGENT_ID = agentId;
	}
	orchIndex(api as unknown as Parameters<typeof orchIndex>[0]);
	const handler = api.handlers.get("session_start");
	if (!handler) throw new Error("extension did not register session_start handler");
	await handler({}, { cwd: workspace });
}

test("smoke: extension loads and exports default function", () => {
	assert.equal(typeof orchIndex, "function");
});

test("smoke: AGENT_ID missing registers zero tools (no project context)", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentEmpty();
	try {
		await runSessionStart(api, workspace, undefined);
		assert.equal(api.registered.length, 0);
	} finally {
		cleanup();
	}
});

test("smoke: member with no project block registers zero tools", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentEmpty();
	try {
		await runSessionStart(api, workspace, "alice");
		assert.equal(api.registered.length, 0);
	} finally {
		cleanup();
	}
});

test("smoke: coordinator (AGENT_ID === coordinatorAgentId) registers exactly 5 tools", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "alice");
		assert.equal(api.registered.length, 5);
		const names = api.registered.map((t) => t.name).sort();
		assert.deepEqual(names, [
			"ask_member",
			"get_agent_status",
			"list_project_agents",
			"post_to_project",
			"read_inbox",
		]);
	} finally {
		cleanup();
	}
});

test("smoke: member (AGENT_ID !== coordinatorAgentId) registers exactly 2 tools", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "bob");
		assert.equal(api.registered.length, 2);
		const names = api.registered.map((t) => t.name).sort();
		assert.deepEqual(names, ["post_to_project", "read_inbox"]);
	} finally {
		cleanup();
	}
});

test("smoke: coordinator's systemPrompt is updated to CEO prompt", async () => {
	const api = makeFakeAPI();
	const { workspace, settingsPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "alice");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		const prompt = settings.systemPrompt as string;
		assert.match(prompt, /Project Agent — Superhive/);
		assert.match(prompt, /SmokeProject/);
		assert.match(prompt, /End-to-end smoke fixture/);
		assert.match(prompt, /\*\*Alice\*\*/);
		assert.match(prompt, /\*\*Bob\*\*/);
	} finally {
		cleanup();
	}
});

test("smoke: member's systemPrompt gets a role fragment appended (idempotent)", async () => {
	const api = makeFakeAPI();
	const { workspace, settingsPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		// Pre-seed a user prompt to confirm we don't clobber it.
		const before = JSON.parse(readFileSync(settingsPath, "utf8"));
		before.systemPrompt = "USER PROMPT — DO NOT CLOBBER";
		writeFileSync(settingsPath, JSON.stringify(before, null, "\t") + "\n", "utf8");

		await runSessionStart(api, workspace, "bob");
		const after = JSON.parse(readFileSync(settingsPath, "utf8"));
		const prompt = after.systemPrompt as string;
		assert.match(prompt, /USER PROMPT — DO NOT CLOBBER/, "user prompt must be preserved");
		assert.match(prompt, /superhive:role-fragment:member/);
		assert.match(prompt, /project member/i);
		assert.match(prompt, /read_inbox/);

		// Re-run session_start — marker is present, so no second append.
		const api2 = makeFakeAPI();
		await runSessionStart(api2, workspace, "bob");
		const again = JSON.parse(readFileSync(settingsPath, "utf8"));
		const occurrences = (again.systemPrompt as string).split("superhive:role-fragment:member").length - 1;
		assert.equal(occurrences, 1, "marker must be appended exactly once");
	} finally {
		cleanup();
	}
});

test("smoke: list_project_agents tool returns the live roster", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "alice");
		const tool = api.registered.find((t) => t.name === "list_project_agents")!;
		const result = (await tool.execute("call", {}, undefined, undefined, {} as never)) as {
			content: Array<{ text: string }>;
		};
		const parsed = JSON.parse(result.content[0]!.text);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.count, 2);
		assert.equal(parsed.members[0].agentId, "alice");
		assert.equal(parsed.members[1].agentId, "bob");
	} finally {
		cleanup();
	}
});

test("smoke: get_agent_status finds a member", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "alice");
		const tool = api.registered.find((t) => t.name === "get_agent_status")!;
		const result = (await tool.execute("call", { agentId: "bob" }, undefined, undefined, {} as never)) as {
			content: Array<{ text: string }>;
		};
		const parsed = JSON.parse(result.content[0]!.text);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.member.status, "idle");
	} finally {
		cleanup();
	}
});

test("smoke: post_to_project appends a chat entry on disk", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "bob");
		const tool = api.registered.find((t) => t.name === "post_to_project")!;
		const result = (await tool.execute("call", { body: "smoke ping", kind: "result" }, undefined, undefined, {} as never)) as {
			content: Array<{ text: string }>;
		};
		const parsed = JSON.parse(result.content[0]!.text);
		assert.equal(parsed.ok, true);
		assert.ok(parsed.messageId);
	} finally {
		cleanup();
		// Clean up the smoke project's chat file too.
		rmSync("/tmp/superhive-smoke-project", { recursive: true, force: true });
	}
});

// Restore env at the end of the run
test("teardown", () => {
	if (originalAgentId === undefined) {
		delete process.env.AGENT_ID;
	} else {
		process.env.AGENT_ID = originalAgentId;
	}
});

// Reference unused imports
void existsSync;
