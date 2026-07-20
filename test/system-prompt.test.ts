import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../system-prompt.ts";
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

test("buildSystemPrompt: tools section mentions Gap 2 stubs honestly", () => {
	const prompt = buildSystemPrompt(baseProject, {});
	assert.match(prompt, /## Your Tools/);
	assert.match(prompt, /list_project_agents/);
	assert.match(prompt, /get_agent_status/);
	assert.match(prompt, /dispatch_to_agent/);
	assert.match(prompt, /read_inbox/);
	assert.match(prompt, /send_message_to_agent/);
	assert.match(prompt, /GAP 2/);
	assert.match(prompt, /mailbox not yet wired/);
});

test("buildSystemPrompt: includes decision style, escalation, boundaries", () => {
	const prompt = buildSystemPrompt(baseProject, {});
	assert.match(prompt, /## Decision Style/);
	assert.match(prompt, /## Escalation/);
	assert.match(prompt, /## Boundaries/);
	assert.match(prompt, /project memory is permanent/);
	assert.match(prompt, /Do not silently retry/);
});