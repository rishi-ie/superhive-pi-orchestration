import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildRolePromptFragment,
	buildSystemPrompt,
	type PermissionsSnapshot,
	type SystemPromptInputs,
} from "../system-prompt.ts";
import type { ProjectBlock } from "../types.ts";

const baseProject: ProjectBlock = {
	id: "proj-1",
	name: "Foo",
	description: "Build a thing that does X",
	members: [],
};

const populatedProject: ProjectBlock = {
	id: "proj-2",
	name: "Bar",
	description: "Architect a system for Y",
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
			model: { provider: "anthropic", name: "claude-opus-4-5" },
			status: "idle",
			joinedAt: "2026-01-02T00:00:00Z",
		},
		{
			agentId: "a3",
			name: "Carol",
			role: "QA",
			status: "error",
			joinedAt: "2026-01-03T00:00:00Z",
		},
	],
};

// Default all-true permissions; tests override to exercise the
// Permissions section.
const defaultPermissions: PermissionsSnapshot = {
	filesystem: true,
	terminal: true,
	network: true,
};

// Default all-disabled behavior flags (autoCompaction / autoRetry).
// The Behavior section is omitted when nothing is disabled.
const defaultBehavior = {};

/**
 * Helper — assemble a baseline SystemPromptInputs with sensible
 * defaults. Tests override the fields they care about.
 */
function makeInputs(overrides: Partial<SystemPromptInputs> = {}): SystemPromptInputs {
	return {
		project: baseProject,
		agent: {},
		identity: {},
		permissions: defaultPermissions,
		behavior: defaultBehavior,
		skills: [],
		activeExtensions: {
			truth: true,
			telemetry: true,
			context: false,
			orchestration: true,
			plan: false,
			spawn: false,
		},
		planMode: null,
		spawnConfig: null,
		...overrides,
	};
}

test("buildSystemPrompt: includes project name and agent name in header", () => {
	const prompt = buildSystemPrompt(makeInputs({ agent: { name: "Coordinator", role: "CEO" } }));
	assert.match(prompt, /Project Agent — Superhive/);
	assert.match(prompt, /\*\*Coordinator\*\*/);
	assert.match(prompt, /"Foo"/);
});

test("buildSystemPrompt: falls back to default agent name when missing", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.match(prompt, /Project Agent/);
});

test("buildSystemPrompt: includes mission description", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.match(prompt, /## Mission/);
	assert.match(prompt, /Build a thing that does X/);
});

test("buildSystemPrompt: shows placeholder when mission missing", () => {
	const prompt = buildSystemPrompt(makeInputs({ project: { ...baseProject, description: "" } }));
	assert.match(prompt, /no mission description set/);
});

test("buildSystemPrompt: empty team section when no members", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.match(prompt, /## Your Team/);
	assert.match(prompt, /no specialists assigned/);
});

test("buildSystemPrompt: renders singular 'specialist' for 1 member", () => {
	const prompt = buildSystemPrompt(
		makeInputs({ project: { ...baseProject, members: [populatedProject.members[0]!] } }),
	);
	assert.match(prompt, /lead 1 specialist\b/);
});

test("buildSystemPrompt: renders plural 'specialists' for 2+ members", () => {
	const prompt = buildSystemPrompt(makeInputs({ project: populatedProject }));
	assert.match(prompt, /lead 3 specialists/);
});

test("buildSystemPrompt: renders all member rows", () => {
	const prompt = buildSystemPrompt(makeInputs({ project: populatedProject }));
	assert.match(prompt, /\*\*Alice\*\*/);
	assert.match(prompt, /\*\*Bob\*\*/);
	assert.match(prompt, /\*\*Carol\*\*/);
});

test("buildSystemPrompt: handles member without optional fields gracefully", () => {
	const prompt = buildSystemPrompt(makeInputs({ project: populatedProject }));
	assert.match(prompt, /Bob\*\* — \(no role\)/);
	assert.match(prompt, /Carol\*\* — QA — model: \(no model\)/);
});

test("buildSystemPrompt: member row includes model and status", () => {
	const prompt = buildSystemPrompt(makeInputs({ project: populatedProject }));
	assert.match(prompt, /minimax\/MiniMax-M3/);
	assert.match(prompt, /anthropic\/claude-opus-4-5/);
	assert.match(prompt, /`active`/);
	assert.match(prompt, /`idle`/);
	assert.match(prompt, /`error`/);
});

test("buildSystemPrompt: Tools — Orchestrator lists all 7 wired tools", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.match(prompt, /## Tools — Orchestrator/);
	assert.match(prompt, /list_project_agents/);
	assert.match(prompt, /get_agent_status/);
	assert.match(prompt, /ask_member/);
	assert.match(prompt, /read_inbox/);
	assert.match(prompt, /post_to_project/);
	assert.doesNotMatch(prompt, /dispatch_to_agent/);
	assert.doesNotMatch(prompt, /send_message_to_agent/);
	assert.doesNotMatch(prompt, /GAP 2/);
	assert.doesNotMatch(prompt, /mailbox not yet wired/);
});

test("buildSystemPrompt: includes Mailbox section with [mail] instructions", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.match(prompt, /## Mailbox/);
	assert.match(prompt, /\[mail\]/);
	assert.match(prompt, /read_inbox/);
});

test("buildSystemPrompt: includes decision style, escalation, boundaries", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.match(prompt, /## Decision Style/);
	assert.match(prompt, /## Escalation/);
	assert.match(prompt, /## Boundaries/);
	assert.match(prompt, /project memory is permanent/);
	assert.match(prompt, /Do not silently retry/);
});

test("buildRolePromptFragment: coordinator fragment mentions [mail] and read_inbox", () => {
	const fragment = buildRolePromptFragment("coordinator");
	assert.match(fragment, /project agent/i);
	assert.match(fragment, /\[mail\]/);
	assert.match(fragment, /read_inbox/);
	assert.match(fragment, /post_to_project|ask_member/);
});

test("buildRolePromptFragment: member fragment mentions [mail] and read_inbox", () => {
	const fragment = buildRolePromptFragment("member");
	assert.match(fragment, /project member/i);
	assert.match(fragment, /\[mail\]/);
	assert.match(fragment, /read_inbox/);
	assert.match(fragment, /post_to_project/);
	assert.doesNotMatch(fragment, /ask_member/);
});

// ---------------------------------------------------------------------------
// Phase J: dynamic system prompt — conditional sections driven by
// inputs (permissions, behavior, skills, active extensions).
// ---------------------------------------------------------------------------

test("Phase J: Permissions section is omitted when all 3 are true", () => {
	const prompt = buildSystemPrompt(makeInputs({ permissions: defaultPermissions }));
	assert.doesNotMatch(prompt, /## Permissions/);
});

test("Phase J: Permissions section appears when network: false", () => {
	const prompt = buildSystemPrompt(
		makeInputs({ permissions: { filesystem: true, terminal: true, network: false } }),
	);
	assert.match(prompt, /## Permissions/);
	assert.match(prompt, /\*\*cannot\*\* use: .*`network`/);
	assert.doesNotMatch(prompt, /`filesystem`/);
	assert.doesNotMatch(prompt, /`terminal`/);
});

test("Phase J: Permissions section lists multiple disabled permissions", () => {
	const prompt = buildSystemPrompt(
		makeInputs({ permissions: { filesystem: false, terminal: false, network: true } }),
	);
	assert.match(prompt, /## Permissions/);
	assert.match(prompt, /`filesystem`/);
	assert.match(prompt, /`terminal`/);
	assert.doesNotMatch(prompt, /`network`/);
});

test("Phase J: Behavior section is omitted when nothing is disabled", () => {
	const prompt = buildSystemPrompt(makeInputs({ behavior: {} }));
	assert.doesNotMatch(prompt, /## Behavior/);
});

test("Phase J: Behavior section appears when autoCompaction: false", () => {
	const prompt = buildSystemPrompt(
		makeInputs({ behavior: { autoCompaction: false } }),
	);
	assert.match(prompt, /## Behavior/);
	assert.match(prompt, /auto-compaction is OFF/);
	assert.doesNotMatch(prompt, /auto-retry is OFF/);
});

test("Phase J: Behavior section appears when autoRetry: false", () => {
	const prompt = buildSystemPrompt(makeInputs({ behavior: { autoRetry: false } }));
	assert.match(prompt, /## Behavior/);
	assert.match(prompt, /auto-retry is OFF/);
	assert.doesNotMatch(prompt, /auto-compaction is OFF/);
});

test("Phase J: Behavior section lists multiple disabled flags", () => {
	const prompt = buildSystemPrompt(
		makeInputs({ behavior: { autoCompaction: false, autoRetry: false } }),
	);
	assert.match(prompt, /auto-compaction is OFF/);
	assert.match(prompt, /auto-retry is OFF/);
});

test("Phase J: Skills section always renders, listing actual skills", () => {
	const prompt = buildSystemPrompt(
		makeInputs({ skills: ["plan", "ask-user", "self-config"] }),
	);
	assert.match(prompt, /## Skills/);
	assert.match(prompt, /- `plan`/);
	assert.match(prompt, /- `ask-user`/);
	assert.match(prompt, /- `self-config`/);
});

test("Phase J: Skills section shows empty-state hint when no skills installed", () => {
	const prompt = buildSystemPrompt(makeInputs({ skills: [] }));
	assert.match(prompt, /## Skills/);
	assert.match(prompt, /no skills installed/);
});

test("Phase J: Tools — Plan section appears only when plan ext is active", () => {
	const prompt = buildSystemPrompt(
		makeInputs({
			activeExtensions: { ...makeInputs().activeExtensions, plan: true },
			planMode: { defaultMode: "plan", thinkingLevel: "high" },
		}),
	);
	assert.match(prompt, /## Tools — Plan/);
	assert.match(prompt, /plan_tasks/);
	assert.match(prompt, /complete_task/);
	assert.match(prompt, /`plan`/); // defaultMode rendered
});

test("Phase J: Tools — Plan section is omitted when plan ext is inactive", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.doesNotMatch(prompt, /## Tools — Plan/);
});

test("Phase J: Tasks section is omitted when plan ext is inactive", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.doesNotMatch(prompt, /^## Tasks$/m);
});

test("Phase J: Tasks section appears when plan ext is active", () => {
	const prompt = buildSystemPrompt(
		makeInputs({
			activeExtensions: { ...makeInputs().activeExtensions, plan: true },
		}),
	);
	assert.match(prompt, /^## Tasks$/m);
	assert.match(prompt, /plan_tasks/);
});

test("Phase J: Tools — Spawn section appears only when spawn ext is active", () => {
	const prompt = buildSystemPrompt(
		makeInputs({
			activeExtensions: { ...makeInputs().activeExtensions, spawn: true },
			spawnConfig: { allowedTemplates: ["research", "general"], requireApproval: false },
		}),
	);
	assert.match(prompt, /## Tools — Spawn/);
	assert.match(prompt, /spawn_agent/);
	assert.match(prompt, /research, general/);
	assert.match(prompt, /Spawns proceed without/);
});

test("Phase J: Tools — Spawn section shows allow-all when allowedTemplates is null", () => {
	const prompt = buildSystemPrompt(
		makeInputs({
			activeExtensions: { ...makeInputs().activeExtensions, spawn: true },
			spawnConfig: { allowedTemplates: null, requireApproval: false },
		}),
	);
	assert.match(prompt, /## Tools — Spawn/);
	assert.match(prompt, /any installed template/);
});

test("Phase J: Tools — Spawn section shows require-approval when set", () => {
	const prompt = buildSystemPrompt(
		makeInputs({
			activeExtensions: { ...makeInputs().activeExtensions, spawn: true },
			spawnConfig: { allowedTemplates: null, requireApproval: true },
		}),
	);
	assert.match(prompt, /must approve each spawn/);
});

test("Phase J: Tools — Spawn section is omitted when spawn ext is inactive", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.doesNotMatch(prompt, /## Tools — Spawn/);
});

test("Phase J: Tools — Context section appears only when context ext is active", () => {
	const prompt = buildSystemPrompt(
		makeInputs({
			activeExtensions: { ...makeInputs().activeExtensions, context: true },
		}),
	);
	assert.match(prompt, /## Tools — Context/);
	assert.match(prompt, /context_compaction/);
});

test("Phase J: Tools — Context section is omitted when context ext is inactive", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.doesNotMatch(prompt, /## Tools — Context/);
});

test("Phase J: Boundaries section mentions 'later phase' when spawn is off", () => {
	const prompt = buildSystemPrompt(makeInputs());
	assert.match(prompt, /## Boundaries/);
	assert.match(prompt, /lands in a later phase/);
	assert.doesNotMatch(prompt, /You can spawn new specialists at runtime/);
});

test("Phase J: Boundaries section mentions 'runtime' when spawn is on", () => {
	const prompt = buildSystemPrompt(
		makeInputs({
			activeExtensions: { ...makeInputs().activeExtensions, spawn: true },
			spawnConfig: { allowedTemplates: null, requireApproval: false },
		}),
	);
	assert.match(prompt, /## Boundaries/);
	assert.match(prompt, /You can spawn new specialists at runtime via `spawn_agent`/);
	assert.doesNotMatch(prompt, /lands in a later phase/);
});

test("Phase J: all sections appear when everything is enabled", () => {
	const prompt = buildSystemPrompt(
		makeInputs({
			permissions: { filesystem: true, terminal: true, network: true },
			behavior: {},
			skills: ["plan", "ask-user"],
			activeExtensions: {
				truth: true,
				telemetry: true,
				context: true,
				orchestration: true,
				plan: true,
				spawn: true,
			},
			planMode: { defaultMode: "auto", thinkingLevel: "inherit" },
			spawnConfig: { allowedTemplates: null, requireApproval: false },
		}),
	);
	assert.match(prompt, /# Project Agent — Superhive/);
	assert.match(prompt, /## Mission/);
	assert.match(prompt, /## Your Team/);
	assert.match(prompt, /## Tools — Orchestrator/);
	assert.match(prompt, /## Tools — Plan/);
	assert.match(prompt, /## Tools — Spawn/);
	assert.match(prompt, /## Tools — Context/);
	assert.match(prompt, /## Mailbox/);
	assert.match(prompt, /## Tasks/);
	assert.match(prompt, /## Project Overview Reporting/);
	assert.match(prompt, /set_project_current_work/);
	assert.match(prompt, /## Decision Style/);
	assert.match(prompt, /## Escalation/);
	assert.match(prompt, /## Boundaries/);
	assert.match(prompt, /## Skills/);
	// Permissions + Behavior are omitted (all on, nothing disabled).
	assert.doesNotMatch(prompt, /^## Permissions$/m);
	assert.doesNotMatch(prompt, /^## Behavior$/m);
});
