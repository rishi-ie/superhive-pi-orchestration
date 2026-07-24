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
 *
 * Phase B assertions:
 *   6. Coordinator with `identity.category = 'research'` + bundled defaults
 *      → systemPrompt gets a Category Guidance section + marker.
 *   7. Re-running session_start with same category → marker present, no
 *      double-append.
 *   8. Switching category from 'research' to 'marketing' → old fragment is
 *      stripped, new one appended, roleFragmentAppended flips to
 *      'category:marketing'.
 *   9. Removing identity.category entirely → fragment stripped, marker
 *      cleared back to 'coordinator'.
 *  10. Defaults file missing → no fragment appended (graceful degradation).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { orchestrationExtensionPathFor, settingsPathFor, writeProjectBlock, writeSettings } from "../project.ts";
import type { ProjectBlock } from "../types.ts";

import orchIndex, { assembleSystemPromptInputs, rebuildSystemPrompt } from "../index.ts";

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
	orchPath: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-smoke-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	const settingsPath = settingsPathFor(root);
	const orchPath = orchestrationExtensionPathFor(root);
	writeProjectBlock(settingsPath, project);
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	settings.name = "Coordinator";
	settings.role = "Project Lead";
	writeFileSync(settingsPath, JSON.stringify(settings, null, "\t") + "\n", "utf8");
	return {
		root,
		workspace,
		settingsPath,
		orchPath,
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

/**
 * Set up a fake `~/.superhive/project-agent-defaults.json` for the
 * duration of one test. Returns a cleanup function that restores the
 * original file (or removes the temp one if there wasn't one).
 *
 * The orchestrator reads the file directly via `process.env.HOME` —
 * we override HOME for the test, write to the new path, then restore.
 */
function withFakeDefaults(
	overrides: {
		version?: number;
		base?: Record<string, unknown>;
		overlays: Record<string, { systemPromptAddition?: string; skills?: string[] }>;
	},
	body: () => Promise<void>,
): Promise<void> {
	const originalHome = process.env.HOME;
	const fakeHome = mkdtempSync(join(tmpdir(), "superhive-orch-home-"));
	process.env.HOME = fakeHome;
	const fakePath = join(fakeHome, ".superhive", "project-agent-defaults.json");
	mkdirSync(join(fakeHome, ".superhive"), { recursive: true });
	writeFileSync(
		fakePath,
		JSON.stringify({ version: 1, base: {}, overlays: overrides.overlays }, null, "\t") + "\n",
		"utf8",
	);
	return body().finally(() => {
		rmSync(fakeHome, { recursive: true, force: true });
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
	});
}

function setIdentityCategory(settingsPath: string, category: string | undefined): void {
	const current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	const identity = (current.identity as Record<string, unknown> | undefined) ?? {};
	if (category === undefined) {
		delete identity.category;
	} else {
		identity.category = category;
	}
	current.identity = identity;
	writeSettings(settingsPath, current as Parameters<typeof writeSettings>[1]);
}

function getOrchPrompt(orchPath: string): { systemPrompt: string; roleFragmentAppended: string | null } {
	const raw = JSON.parse(readFileSync(orchPath, "utf8")) as {
		systemPrompt?: string;
		roleFragmentAppended?: string | null;
	};
	return {
		systemPrompt: raw.systemPrompt ?? "",
		roleFragmentAppended: raw.roleFragmentAppended ?? null,
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

test("smoke: coordinator (AGENT_ID === coordinatorAgentId) registers exactly 7 tools", async () => {
	const api = makeFakeAPI();
	const { workspace, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "alice");
		// Gap 3 added plan_tasks + complete_task → 7 total (was 5).
		assert.equal(api.registered.length, 7);
		const names = api.registered.map((t) => t.name).sort();
		assert.deepEqual(names, [
			"ask_member",
			"complete_task",
			"get_agent_status",
			"list_project_agents",
			"plan_tasks",
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
	const { workspace, orchPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "alice");
		const settings = JSON.parse(readFileSync(orchPath, "utf8"));
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
	const { workspace, orchPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		await runSessionStart(api, workspace, "bob");
		const after = JSON.parse(readFileSync(orchPath, "utf8"));
		const prompt = after.systemPrompt as string;
		assert.match(prompt, /superhive:role-fragment:member/);
		assert.match(prompt, /project member/i);
		assert.match(prompt, /read_inbox/);

		// Re-run session_start — marker is present, so no second append.
		const api2 = makeFakeAPI();
		await runSessionStart(api2, workspace, "bob");
		const again = JSON.parse(readFileSync(orchPath, "utf8"));
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

test("smoke: 'general' category (empty overlay) does NOT append a fragment", async () => {
	await withFakeDefaults({
		overlays: { general: { systemPromptAddition: "", skills: [] } },
	}, async () => {
		const api = makeFakeAPI();
		const { workspace, settingsPath, orchPath, cleanup } = tempAgentWithProject(sampleProject);
		try {
			setIdentityCategory(settingsPath, "general");
			await runSessionStart(api, workspace, "alice");
			const { systemPrompt, roleFragmentAppended } = getOrchPrompt(orchPath);
			assert.doesNotMatch(systemPrompt, /## Category Guidance/);
			assert.equal(roleFragmentAppended, "coordinator");
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// Phase J smoke tests — dynamic system prompt
// ---------------------------------------------------------------------------

/**
 * Drive the buildSystemPrompt inputs helper directly (the same
 * shape `rebuildSystemPrompt` uses internally). The smoke test
 * doesn't need to register the extension — we're testing the
 * pure-FS assembly path, not the file watchers.
 */
test("smoke: assembleSystemPromptInputs returns null when no project block", () => {
	const { root, cleanup } = tempAgentEmpty();
	try {
		const inputs = assembleSystemPromptInputs(settingsPathFor(root), root);
		assert.equal(inputs, null);
	} finally {
		cleanup();
	}
});

test("smoke: assembleSystemPromptInputs returns full snapshot for a project agent", () => {
	const { root, cleanup } = tempAgentWithProject(sampleProject);
	try {
		const inputs = assembleSystemPromptInputs(settingsPathFor(root), root);
		assert.ok(inputs, "expected non-null inputs");
		assert.equal(inputs!.project.id, sampleProject.id);
		assert.equal(inputs!.permissions.filesystem, true);
		assert.equal(inputs!.activeExtensions.orchestration, true);
		assert.equal(inputs!.activeExtensions.truth, true);
		assert.equal(inputs!.activeExtensions.spawn, false);
		assert.equal(inputs!.activeExtensions.plan, false);
	} finally {
		cleanup();
	}
});

test("smoke: rebuildSystemPrompt writes the CEO prompt with conditional sections", () => {
	const { root, cleanup } = tempAgentWithProject(sampleProject);
	try {
		const prompt = rebuildSystemPrompt(root);
		assert.ok(prompt, "expected non-null prompt");
		// Always-on sections
		assert.match(prompt!, /# Project Agent — Superhive/);
		assert.match(prompt!, /## Mission/);
		assert.match(prompt!, /## Your Team/);
		assert.match(prompt!, /## Tools — Orchestrator/);
		assert.match(prompt!, /## Mailbox/);
		assert.match(prompt!, /## Decision Style/);
		assert.match(prompt!, /## Escalation/);
		assert.match(prompt!, /## Boundaries/);
		assert.match(prompt!, /## Skills/);
		// Conditional: plan + spawn are off by default
		assert.doesNotMatch(prompt!, /## Tools — Plan/);
		assert.doesNotMatch(prompt!, /## Tools — Spawn/);
		// Permissions: all true by default → section omitted
		assert.doesNotMatch(prompt!, /^## Permissions$/m);
	} finally {
		cleanup();
	}
});

test("smoke: rebuildSystemPrompt adds Permissions section when network is off", () => {
	const { root, settingsPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		const current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		current.permissions = { filesystem: true, terminal: true, network: false };
		writeSettings(settingsPath, current as Parameters<typeof writeSettings>[1]);
		const prompt = rebuildSystemPrompt(root);
		assert.ok(prompt);
		assert.match(prompt!, /## Permissions/);
		assert.match(prompt!, /`network`/);
	} finally {
		cleanup();
	}
});

test("smoke: rebuildSystemPrompt adds Tools — Spawn section when spawn ext is on", () => {
	const { root, settingsPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		const current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		current.extensions = [
			"./extensions/superhive-pi-truth",
			"./extensions/superhive-pi-telemetry",
			"./extensions/superhive-pi-context",
			"./extensions/superhive-pi-orchestration",
			"./extensions/superhive-pi-plan",
			"./extensions/superhive-pi-spawn",
		];
		writeSettings(settingsPath, current as Parameters<typeof writeSettings>[1]);
		// Also write the spawn file with enabled: true
		writeFileSync(
			join(root, "superhive-pi-spawn.json"),
			JSON.stringify({ version: 1, enabled: true, allowedTemplates: null, requireApproval: false }),
			"utf8",
		);
		const prompt = rebuildSystemPrompt(root);
		assert.ok(prompt);
		assert.match(prompt!, /## Tools — Spawn/);
		assert.match(prompt!, /spawn_agent/);
		assert.match(prompt!, /any installed template/);
		// Spawn on → the Boundaries copy flips to "runtime"
		assert.match(prompt!, /You can spawn new specialists at runtime/);
	} finally {
		cleanup();
	}
});

test("smoke: rebuildSystemPrompt adds Tools — Plan section when plan ext is on", () => {
	const { root, settingsPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		const current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		current.extensions = [
			"./extensions/superhive-pi-truth",
			"./extensions/superhive-pi-telemetry",
			"./extensions/superhive-pi-context",
			"./extensions/superhive-pi-orchestration",
			"./extensions/superhive-pi-plan",
		];
		writeSettings(settingsPath, current as Parameters<typeof writeSettings>[1]);
		writeFileSync(
			join(root, "superhive-pi-plan.json"),
			JSON.stringify({
				version: 1,
				planMode: { defaultMode: "plan", thinkingLevel: "high" },
			}),
			"utf8",
		);
		const prompt = rebuildSystemPrompt(root);
		assert.ok(prompt);
		assert.match(prompt!, /## Tools — Plan/);
		assert.match(prompt!, /## Tasks/);
		assert.match(prompt!, /`plan`/); // defaultMode rendered
	} finally {
		cleanup();
	}
});

test("smoke: rebuildSystemPrompt is idempotent — re-running does NOT bump counter on no-change", () => {
	const { root, orchPath, cleanup } = tempAgentWithProject(sampleProject);
	try {
		// First build
		rebuildSystemPrompt(root);
		const first = readFileSync(orchPath, "utf8");
		const firstCounter = (JSON.parse(first) as { managedBy?: string }).managedBy;
		// Second build with the same state
		rebuildSystemPrompt(root);
		const second = readFileSync(orchPath, "utf8");
		const secondCounter = (JSON.parse(second) as { managedBy?: string }).managedBy;
		// deepEqualManaged path in writeOrchestrationExtension → no
		// counter bump when content matches.
		assert.equal(firstCounter, secondCounter, "counter should not bump on idempotent rebuild");
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// Phase B smoke tests — category fragment append / replace / strip
// ---------------------------------------------------------------------------

const RESEARCH_OVERLAY = {
	systemPromptAddition: "Prioritize literature reviews and citation hygiene.",
	skills: ["summarize", "research-paper-format"],
};

const MARKETING_OVERLAY = {
	systemPromptAddition: "Optimize for messaging clarity.",
	skills: ["copywriting-frameworks"],
};

test("smoke: coordinator with identity.category='research' gets category fragment", async () => {
	await withFakeDefaults({ overlays: { research: RESEARCH_OVERLAY } }, async () => {
		const api = makeFakeAPI();
		const { workspace, settingsPath, orchPath, cleanup } = tempAgentWithProject(sampleProject);
		try {
			setIdentityCategory(settingsPath, "research");
			await runSessionStart(api, workspace, "alice");
			const { systemPrompt, roleFragmentAppended } = getOrchPrompt(orchPath);
			assert.match(systemPrompt, /## Category Guidance \(research\)/);
			assert.match(systemPrompt, /Prioritize literature reviews/);
			assert.match(systemPrompt, /superhive:category-fragment:research\]/);
			assert.equal(roleFragmentAppended, "category:research");
		} finally {
			cleanup();
		}
	});
});

test("smoke: re-running session_start with same category does NOT double-append", async () => {
	await withFakeDefaults({ overlays: { research: RESEARCH_OVERLAY } }, async () => {
		const api = makeFakeAPI();
		const { workspace, settingsPath, orchPath, cleanup } = tempAgentWithProject(sampleProject);
		try {
			setIdentityCategory(settingsPath, "research");
			await runSessionStart(api, workspace, "alice");
			const first = getOrchPrompt(orchPath);

			const api2 = makeFakeAPI();
			await runSessionStart(api2, workspace, "alice");
			const second = getOrchPrompt(orchPath);

			const firstCount = first.systemPrompt.split("superhive:category-fragment:research").length - 1;
			const secondCount = second.systemPrompt.split("superhive:category-fragment:research").length - 1;
			assert.equal(firstCount, 1);
			assert.equal(secondCount, 1);
		} finally {
			cleanup();
		}
	});
});

test("smoke: changing category from research to marketing replaces the fragment", async () => {
	await withFakeDefaults({
		overlays: { research: RESEARCH_OVERLAY, marketing: MARKETING_OVERLAY },
	}, async () => {
		const api = makeFakeAPI();
		const { workspace, settingsPath, orchPath, cleanup } = tempAgentWithProject(sampleProject);
		try {
			// 1) Start with research
			setIdentityCategory(settingsPath, "research");
			await runSessionStart(api, workspace, "alice");
			const researchPrompt = getOrchPrompt(orchPath).systemPrompt;
			assert.match(researchPrompt, /Prioritize literature reviews/);
			assert.match(researchPrompt, /superhive:category-fragment:research\]/);

			// 2) Switch to marketing
			setIdentityCategory(settingsPath, "marketing");
			const api2 = makeFakeAPI();
			await runSessionStart(api2, workspace, "alice");
			const { systemPrompt, roleFragmentAppended } = getOrchPrompt(orchPath);
			assert.match(systemPrompt, /Optimize for messaging clarity/);
			assert.match(systemPrompt, /superhive:category-fragment:marketing\]/);
			assert.equal(roleFragmentAppended, "category:marketing");
			// Old research content must be stripped
			assert.doesNotMatch(systemPrompt, /Prioritize literature reviews/);
			assert.doesNotMatch(systemPrompt, /superhive:category-fragment:research\]/);
		} finally {
			cleanup();
		}
	});
});

test("smoke: removing identity.category strips the fragment + resets marker", async () => {
	await withFakeDefaults({ overlays: { research: RESEARCH_OVERLAY } }, async () => {
		const api = makeFakeAPI();
		const { workspace, settingsPath, orchPath, cleanup } = tempAgentWithProject(sampleProject);
		try {
			setIdentityCategory(settingsPath, "research");
			await runSessionStart(api, workspace, "alice");
			assert.match(getOrchPrompt(orchPath).systemPrompt, /Category Guidance/);

			setIdentityCategory(settingsPath, undefined);
			const api2 = makeFakeAPI();
			await runSessionStart(api2, workspace, "alice");
			const { systemPrompt, roleFragmentAppended } = getOrchPrompt(orchPath);
			assert.doesNotMatch(systemPrompt, /## Category Guidance/);
			assert.doesNotMatch(systemPrompt, /superhive:category-fragment:/);
			assert.equal(roleFragmentAppended, "coordinator");
		} finally {
			cleanup();
		}
	});
});

test("smoke: missing bundled defaults file → no fragment, no crash", async () => {
	// Point HOME at an empty dir so ~/.superhive/project-agent-defaults.json
	// doesn't exist. Doesn't use withFakeDefaults.
	const originalHome = process.env.HOME;
	const fakeHome = mkdtempSync(join(tmpdir(), "superhive-orch-empty-home-"));
	process.env.HOME = fakeHome;
	try {
		const api = makeFakeAPI();
		const { workspace, settingsPath, orchPath, cleanup } = tempAgentWithProject(sampleProject);
		try {
			setIdentityCategory(settingsPath, "research");
			await runSessionStart(api, workspace, "alice");
			const { systemPrompt, roleFragmentAppended } = getOrchPrompt(orchPath);
			assert.doesNotMatch(systemPrompt, /Category Guidance/);
			assert.equal(roleFragmentAppended, "coordinator");
		} finally {
			cleanup();
		}
	} finally {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(fakeHome, { recursive: true, force: true });
	}
});

test("smoke: 'general' category (empty overlay) does NOT append a fragment", async () => {
	await withFakeDefaults({
		overlays: { general: { systemPromptAddition: "", skills: [] } },
	}, async () => {
		const api = makeFakeAPI();
		const { workspace, settingsPath, orchPath, cleanup } = tempAgentWithProject(sampleProject);
		try {
			setIdentityCategory(settingsPath, "general");
			await runSessionStart(api, workspace, "alice");
			const { systemPrompt, roleFragmentAppended } = getOrchPrompt(orchPath);
			assert.doesNotMatch(systemPrompt, /## Category Guidance/);
			assert.equal(roleFragmentAppended, "coordinator");
		} finally {
			cleanup();
		}
	});
});

// Reference homedir so the import is not pruned even when smoke tests
// (above) sometimes set process.env.HOME themselves.
void homedir;

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
