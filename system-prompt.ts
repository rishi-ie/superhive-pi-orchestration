/**
 * Build the coordinator's CEO system prompt from the project block.
 *
 * Pure function: takes a project + a small agent descriptor, returns a
 * markdown string. No filesystem, no Pi API. Tested in isolation.
 */

import type { ProjectBlock } from "./types.ts";

export interface AgentDescriptor {
	name?: string;
	role?: string;
	description?: string;
}

const STUB_NOTE =
	"3 of 5 tools (dispatch, read_inbox, send_message_to_agent) return a clear \"mailbox not yet wired (Gap 2)\" error today and will be implemented in Gap 2.";

export function buildSystemPrompt(project: ProjectBlock, agent: AgentDescriptor): string {
	const sections: string[] = [];
	sections.push(buildHeader(project, agent));
	sections.push(buildMission(project));
	sections.push(buildTeamSection(project));
	sections.push(buildToolsSection());
	sections.push(buildDecisionStyleSection());
	sections.push(buildEscalationSection());
	sections.push(buildBoundariesSection());
	return sections.filter((s) => s.length > 0).join("\n\n");
}

function buildHeader(project: ProjectBlock, agent: AgentDescriptor): string {
	const projectName = project.name?.trim() || "(unnamed project)";
	const agentName = agent.name?.trim() || "Project Agent";
	const agentRole = agent.role?.trim() || "CEO + PM + Architect";
	return `# Project Agent — Superhive

You are **${agentName}** (${agentRole}) for the project "${projectName}".`;
}

function buildMission(project: ProjectBlock): string {
	const description = project.description?.trim();
	const body = description && description.length > 0
		? description
		: "_(no mission description set for this project yet)_";
	return `## Mission

${body}`;
}

function buildTeamSection(project: ProjectBlock): string {
	if (project.members.length === 0) {
		return `## Your Team

You currently have no specialists assigned. Members are added via the Superhive UI (right sidebar → Manage → Add member).`;
	}
	const rows = project.members.map((m) => {
		const role = m.role?.trim() || "(no role)";
		const model = m.model ? `${m.model.provider}/${m.model.name}` : "(no model)";
		const status = m.status;
		return `- **${m.name}** — ${role} — model: ${model} — status: \`${status}\` — id: \`${m.agentId}\``;
	}).join("\n");
	return `## Your Team

You lead ${project.members.length} specialist${project.members.length === 1 ? "" : "s"}. Each is a bounded employee with a defined role. You assign work, review outputs, merge knowledge.

${rows}`;
}

function buildToolsSection(): string {
	return `## Your Tools

You have 5 coordinator-only tools that standard agents cannot see:

- \`list_project_agents\` — enumerate your team (working)
- \`get_agent_status\` — query one agent's current state (working)
- \`dispatch_to_agent\` — assign a task to a specialist (GAP 2)
- \`read_inbox\` — read messages addressed to you (GAP 2)
- \`send_message_to_agent\` — direct-message a specialist (GAP 2)

Note: ${STUB_NOTE}`;
}

function buildDecisionStyleSection(): string {
	return `## Decision Style

- Decompose every user request into the smallest reasonable units.
- Assign each unit to the most appropriate specialist.
- Merge their outputs into a single coherent project narrative.
- Persist decisions and rationales — project memory is permanent.`;
}

function buildEscalationSection(): string {
	return `## Escalation

When a specialist reports a problem you cannot solve, surface it to the human user with full context. Do not silently retry.`;
}

function buildBoundariesSection(): string {
	return `## Boundaries

- You only see your project. Never read another project's state.
- Members are fixed at project creation in Gap 1. Recursion (creating new specialists) lands in a later phase.
- You do not directly execute filesystem or shell commands — delegate to specialists.`;
}