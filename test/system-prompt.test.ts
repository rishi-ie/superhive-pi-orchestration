import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildCategoryFragment,
	buildRolePromptFragment,
	buildSystemPrompt,
	type ProjectAgentDefaultsShape,
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

test("buildSystemPrompt: includes project name and agent name in header", () => {
	const prompt = buildSystemPrompt(baseProject, { name: "Coordinator", role: "CEO" });
	assert.match(prompt, /Project Agent — Superhive/);
	assert.match(prompt, /\*\*Coordinator\*\*/);
	assert.match(prompt, /"Foo"/);
});

test("buildSystemPrompt: falls back to default agent name when missing", () => {
	const prompt = buildSystemPrompt(baseProject, {});
	assert.match(prompt, /Project Agent/);
});

test("buildSystemPrompt: includes mission description", () => {
	const prompt = buildSystemPrompt(baseProject, {});
	assert.match(prompt, /## Mission/);
	assert.match(prompt, /Build a thing that does X/);
});

test("buildSystemPrompt: shows placeholder when mission missing", () => {
	const prompt = buildSystemPrompt({ ...baseProject, description: "" }, {});
	assert.match(prompt, /no mission description set/);
});

test("buildSystemPrompt: empty team section when no members", () => {
	const prompt = buildSystemPrompt(baseProject, {});
	assert.match(prompt, /## Your Team/);
	assert.match(prompt, /no specialists assigned/);
});

test("buildSystemPrompt: renders singular 'specialist' for 1 member", () => {
	const prompt = buildSystemPrompt(
		{ ...baseProject, members: [populatedProject.members[0]!] },
		{},
	);
	assert.match(prompt, /lead 1 specialist\b/);
});

test("buildSystemPrompt: renders plural 'specialists' for 2+ members", () => {
	const prompt = buildSystemPrompt(populatedProject, {});
	assert.match(prompt, /lead 3 specialists/);
});

test("buildSystemPrompt: renders all member rows", () => {
	const prompt = buildSystemPrompt(populatedProject, {});
	assert.match(prompt, /\*\*Alice\*\*/);
	assert.match(prompt, /\*\*Bob\*\*/);
	assert.match(prompt, /\*\*Carol\*\*/);
});

test("buildSystemPrompt: handles member without optional fields gracefully", () => {
	const prompt = buildSystemPrompt(populatedProject, {});
	assert.match(prompt, /Bob\*\* — \(no role\)/);
	assert.match(prompt, /Carol\*\* — QA — model: \(no model\)/);
});

test("buildSystemPrompt: member row includes model and status", () => {
	const prompt = buildSystemPrompt(populatedProject, {});
	assert.match(prompt, /minimax\/MiniMax-M3/);
	assert.match(prompt, /anthropic\/claude-opus-4-5/);
	assert.match(prompt, /`active`/);
	assert.match(prompt, /`idle`/);
	assert.match(prompt, /`error`/);
});

test("buildSystemPrompt: tools section lists all 5 wired tools, no Gap 2 stubs", () => {
	const prompt = buildSystemPrompt(baseProject, {});
	assert.match(prompt, /## Your Tools/);
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
	const prompt = buildSystemPrompt(baseProject, {});
	assert.match(prompt, /## Mailbox/);
	assert.match(prompt, /\[mail\]/);
	assert.match(prompt, /read_inbox/);
});

test("buildSystemPrompt: includes decision style, escalation, boundaries", () => {
	const prompt = buildSystemPrompt(baseProject, {});
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
// Phase B: buildCategoryFragment — pure-function tests for the per-category
// guidance fragment appended to the coordinator's CEO prompt.
// ---------------------------------------------------------------------------

const sampleDefaults: ProjectAgentDefaultsShape = {
	version: 1,
	overlays: {
		research: {
			systemPromptAddition: "Prioritize literature reviews and citation hygiene.",
			skills: ["summarize", "research-paper-format"],
		},
		marketing: {
			systemPromptAddition: "Optimize for messaging clarity.",
			skills: ["copywriting-frameworks"],
		},
		general: {
			systemPromptAddition: "",
			skills: [],
		},
	},
};

test("buildCategoryFragment: returns empty string for null defaults", () => {
	assert.equal(buildCategoryFragment("research", null), "");
});

test("buildCategoryFragment: returns empty string for missing category", () => {
	assert.equal(buildCategoryFragment("research", {}), "");
	assert.equal(buildCategoryFragment("research", { overlays: {} }), "");
});

test("buildCategoryFragment: returns empty string for empty systemPromptAddition", () => {
	assert.equal(buildCategoryFragment("general", sampleDefaults), "");
});

test("buildCategoryFragment: returns empty string for empty/null/undefined category", () => {
	assert.equal(buildCategoryFragment("", sampleDefaults), "");
	assert.equal(buildCategoryFragment(undefined, sampleDefaults), "");
	assert.equal(buildCategoryFragment(null, sampleDefaults), "");
	assert.equal(buildCategoryFragment("  ", sampleDefaults), "");
});

test("buildCategoryFragment: returns markdown section with category heading + addition", () => {
	const fragment = buildCategoryFragment("research", sampleDefaults);
	assert.match(fragment, /^## Category Guidance \(research\)/);
	assert.match(fragment, /Prioritize literature reviews and citation hygiene\./);
});

test("buildCategoryFragment: lists overlay skills when present", () => {
	const fragment = buildCategoryFragment("research", sampleDefaults);
	assert.match(fragment, /Category-specific skills:/);
	assert.match(fragment, /- summarize/);
	assert.match(fragment, /- research-paper-format/);
});

test("buildCategoryFragment: omits skills section when overlay has no skills", () => {
	const fragment = buildCategoryFragment("marketing", sampleDefaults);
	assert.match(fragment, /Optimize for messaging clarity\./);
	assert.match(fragment, /Category-specific skills:/);
	assert.match(fragment, /- copywriting-frameworks/);
});

test("buildCategoryFragment: handles overlay with skills but missing systemPromptAddition", () => {
	const fragment = buildCategoryFragment("nosysprompt", {
		overlays: { nosysprompt: { skills: ["only-skills"] } },
	});
	// Empty systemPromptAddition → empty fragment (we don't render
	// skill-only fragments).
	assert.equal(fragment, "");
});

test("buildCategoryFragment: trims whitespace from category and addition", () => {
	const fragment = buildCategoryFragment("  research  ", {
		overlays: { research: { systemPromptAddition: "  trimmed body  " } },
	});
	assert.match(fragment, /## Category Guidance \(research\)/);
	assert.match(fragment, /trimmed body/);
	assert.doesNotMatch(fragment, /^ {2}/m);
});

test("buildCategoryFragment: is pure — same inputs always produce same output", () => {
	const a = buildCategoryFragment("research", sampleDefaults);
	const b = buildCategoryFragment("research", sampleDefaults);
	assert.equal(a, b);
});