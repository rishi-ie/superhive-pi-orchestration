/**
 * End-to-end smoke test for superhive-pi-orchestration.
 *
 * Mirrors the smoke test pattern from superhive-pi-context. We do not boot
 * Pi; we load the extension factory directly and drive its session_start
 * handler with a fake ExtensionAPI.
 *
 * Assertions:
 *   1. Module loads and exports a default function.
 *   2. When AGENT_KIND !== 'project-coordinator', no tools are registered.
 *   3. When AGENT_KIND === 'project-coordinator' but no project block,
 *      no tools are registered and no write occurs.
 *   4. When AGENT_KIND === 'project-coordinator' and project block exists,
 *      exactly 5 tools are registered and settings.systemPrompt is updated.
 *   5. list_project_agents returns the roster; get_agent_status returns
 *      a member; the 3 stubs return Gap 2 errors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsPathFor, writeProjectBlock, readProjectBlock } from "../project.ts";
import type { ProjectBlock } from "../types.ts";

// Load the extension entry point
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
	members: [
		{
			agentId: "alice",
			name: "Alice",
			role: "Backend",
			model: { provider: "minimax", name: "MiniMax-M3" },
			status: "active",
			joinedAt: "2026-01-01T00:00:00Z",
		},
		{
			agentId: "bob",
			name: "Bob",
			role: "QA",
			status: "idle",
			joinedAt: "2026-01-02T00:00:00Z",
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
	// Seed name/description so the prompt has agent identity
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

const originalKind = process.env.AGENT_KIND;

async function runSessionStart(
	api: FakeAPI,
	workspace: string,
	kind: string | undefined,
): Promise<void> {
	if (kind === undefined) {
		delete process.env.AGENT_KIND;
	} else {
		process.env.AGENT_KIND = kind;
	}
	orchIndex(api as unknown as Parameters<typeof orchIndex>[0]);
	const handler = api.handlers.get("session_start");
	if (!handler) throw new Error("extension did not register session_start handler");
	await handler({}, { cwd: workspace });
}

test("smoke: extension loads and exports default function", () => {
	assert.equal(typeof orchIndex, "function");
});

test("smoke: AGENT_KIND=standard registers zero tools", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentEmpty();
	try {
		await runSessionStart(api, workspace, "standard");
		assert.equal(api.registered.length, 0);
	} finally {
		cleanup();
	}
});

test("smoke: AGENT_KIND missing registers zero tools", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentEmpty();
	try {
		await runSessionStart(api, workspace, undefined);
		assert.equal(api.registered.length, 0);
	} finally {
		cleanup();
	}
});

test("smoke: coordinator with no project block registers zero tools", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentEmpty();
	try {
		await runSessionStart(api, workspace, "project-coordinator");
		assert.equal(api.registered.length, 0);
	} finally {
		cleanup();
	}
});

test("smoke: coordinator with project block registers exactly 5 tools", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "project-coordinator");
		assert.equal(api.registered.length, 5);
		const names = api.registered.map((t) => t.name).sort();
		assert.deepEqual(names, [
			"dispatch_to_agent",
			"get_agent_status",
			"list_project_agents",
			"read_inbox",
			"send_message_to_agent",
		]);
	} finally {
		cleanup();
	}
});

test("smoke: coordinator's systemPrompt is updated to CEO prompt", async () => {
	const api = makeFakeAPI();
	const { workspace, settingsPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "project-coordinator");
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

test("smoke: settings write bumped the writer counter", async () => {
	const api = makeFakeAPI();
	const { workspace, settingsPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		const before = JSON.parse(readFileSync(settingsPath, "utf8"));
		const beforeCounter = Number((before.managedBy as string).split("#")[1] ?? "0");
		await runSessionStart(api, workspace, "project-coordinator");
		const after = JSON.parse(readFileSync(settingsPath, "utf8"));
		const afterCounter = Number((after.managedBy as string).split("#")[1] ?? "0");
		assert.equal(afterCounter, beforeCounter + 1);
	} finally {
		cleanup();
	}
});

test("smoke: list_project_agents tool returns the live roster", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "project-coordinator");
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
		await runSessionStart(api, workspace, "project-coordinator");
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

test("smoke: dispatch_to_agent returns Gap 2 error", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "project-coordinator");
		const tool = api.registered.find((t) => t.name === "dispatch_to_agent")!;
		const result = (await tool.execute(
			"call",
			{ agentId: "alice", task: "do thing" },
			undefined,
			undefined,
			{} as never,
		)) as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0]!.text);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Gap 2/);
	} finally {
		cleanup();
	}
});

test("smoke: standard agent's settings file is not touched", async () => {
	const api = makeFakeAPI();
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-smoke-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	const settingsPath = settingsPathFor(root);
	const before = { name: "Standard Agent" };
	writeFileSync(settingsPath, JSON.stringify(before), "utf8");
	try {
		await runSessionStart(api, workspace, "standard");
		assert.ok(existsSync(settingsPath));
		const after = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(after, before);
		assert.equal(api.registered.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Restore env at the end of the run
test("teardown", () => {
	if (originalKind === undefined) {
		delete process.env.AGENT_KIND;
	} else {
		process.env.AGENT_KIND = originalKind;
	}
});

// Reference unused imports
void readProjectBlock;
void existsSync;