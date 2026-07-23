/**
 * Build the project-context system prompt from the project block.
 *
 * Pure function: takes a project + a small agent descriptor, returns a
 * markdown string. No filesystem, no Pi API. Tested in isolation.
 *
 * Gap 2: the prompt is built only for the coordinator. Members keep the
 * standard Pi agent prompt — they get the mailbox tools but no CEO frame.
 * The role-aware `[mail]` instruction is in `buildRolePromptFragment`.
 *
 * Phase B: per-category `systemPromptAddition` fragments are appended
 * via `buildCategoryFragment`. The bundled defaults JSON (read by
 * `readProjectAgentDefaults` in project.ts) provides the overlay map;
 * this function is pure and accepts the parsed shape directly.
 */

import type { ProjectBlock } from "./types.ts";

export interface AgentDescriptor {
	name?: string;
	role?: string;
	description?: string;
}

/**
 * Minimal shape of `~/.superhive/project-agent-defaults.json` that
 * `buildCategoryFragment` consumes. We only model the keys we read;
 * full schema lives in superhive-pi-truth/settings-schema.ts and the
 * bundled JSON file shipped by superhive/.
 */
export interface ProjectAgentDefaultsOverlay {
	systemPromptAddition?: string;
	skills?: string[];
}

export interface ProjectAgentDefaultsShape {
	version?: number;
	base?: unknown;
	overlays?: Record<string, ProjectAgentDefaultsOverlay>;
}

export function buildSystemPrompt(project: ProjectBlock, agent: AgentDescriptor): string {
	const sections: string[] = [];
	sections.push(buildHeader(project, agent));
	sections.push(buildMission(project));
	sections.push(buildTeamSection(project));
	sections.push(buildToolsSection());
	sections.push(buildMailboxSection());
	sections.push(buildTasksSection());
	sections.push(buildDecisionStyleSection());
	sections.push(buildEscalationSection());
	sections.push(buildBoundariesSection());
	return sections.filter((s) => s.length > 0).join("\n\n");
}

/**
 * A short role-specific instruction injected alongside the standard agent
 * prompt. Tells the agent what to do when a `[mail]` wake prompt appears.
 */
export function buildRolePromptFragment(role: "coordinator" | "member"): string {
	if (role === "coordinator") {
		return [
			"You are the project agent.",
			"When your session shows `[mail] New message from ...` or `[mail] You have a new direct ask`, call `read_inbox` to inspect.",
			"Then either `post_to_project` to reply in the shared chat or `ask_member` to private-ask a specific teammate.",
		].join(" ");
	}
	return [
		"You are a project member.",
		"When your session shows `[mail] You have a new direct ask`, call `read_inbox` to see the coordinator's question.",
		"Then `post_to_project` to reply in the shared project chat so the coordinator and user can see it.",
	].join(" ");
}

/**
 * Build the per-category guidance fragment appended to the coordinator's
 * system prompt. Pulled from the bundled defaults JSON at
 * `~/.superhive/project-agent-defaults.json` (parsed shape passed in by
 * the caller — see `readProjectAgentDefaults` in project.ts).
 *
 * Returns "" when:
 *   - `category` is missing/empty
 *   - `defaults` is null (file missing/corrupt)
 *   - the overlay for `category` is missing
 *   - the overlay's `systemPromptAddition` is empty/whitespace
 *
 * The marker guard for idempotency lives in the caller (index.ts). This
 * function is pure: same inputs → same output, no FS, no Pi API.
 *
 * Output shape (markdown):
 *   ## Category Guidance (<category>)
 *
 *   <systemPromptAddition>
 *
 *   Category-specific skills:
 *   - <skill>
 *   - <skill>
 *
 * Skills line is omitted when the overlay has none.
 */
export function buildCategoryFragment(
	category: string | undefined | null,
	defaults: ProjectAgentDefaultsShape | null,
): string {
	const trimmed = category?.trim();
	if (!trimmed) return "";
	if (!defaults) return "";

	const overlay = defaults.overlays?.[trimmed];
	if (!overlay) return "";

	const addition = overlay.systemPromptAddition?.trim();
	if (!addition) return "";

	const skills = overlay.skills ?? [];
	const skillsSection = skills.length > 0
		? `\n\nCategory-specific skills:\n${skills.map((s) => `- ${s}`).join("\n")}`
		: "";

	return `## Category Guidance (${trimmed})\n\n${addition}${skillsSection}`;
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

- \`list_project_agents\` — enumerate your team
- \`get_agent_status\` — query one agent's current state
- \`ask_member\` — private-ask a specific specialist (writes to their inbox)
- \`read_inbox\` — read pending project-chat messages from your team
- \`post_to_project\` — append a message to the shared project chat`;
}

function buildMailboxSection(): string {
	return `## Mailbox

When a worker posts in the project chat, the main process injects a \`[mail]\` prompt into your session. Call \`read_inbox\` to fetch pending entries, then either reply in chat (visible to the user) or \`ask_member\` (private, wakes that worker).`;
}

function buildTasksSection(): string {
	return `## Tasks

Use \`plan_tasks\` to break complex work into a dependency graph. Each task gets dispatched to its assigned worker when its dependencies are done. The main process runs a 5s polling loop that picks ready tasks and calls \`runtime.send\` with a "Task <id>: <title>" prompt. One task per project is dispatched per tick (serial).

After a worker posts a \`result\` to the project chat and you have read it via \`read_inbox\`, call \`complete_task(taskId, summary)\` to mark the task done. The right-panel "Active tasks" accordion updates on the next \`tasks:changed\` event.

Workers are not told about the plan — they only see their own task prompt. They post back to the project chat when done.`;
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
