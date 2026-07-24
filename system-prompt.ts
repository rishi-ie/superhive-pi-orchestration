/**
 * Build the project-context system prompt from a config snapshot.
 *
 * Pure function: takes a `SystemPromptInputs` describing the agent's
 * current state (project block, identity, permissions, behavior,
 * skills, active extensions, plan mode, spawn config, defaults) and
 * returns a markdown string. No filesystem, no Pi API. Tested in
 * isolation.
 *
 * Phase J (dynamic system prompt):
 *   The prompt is now data-driven. Sections appear/disappear based
 *   on what's currently enabled in the agent's Manage tab. The
 *   orchestrator's `rebuildSystemPrompt` (in index.ts) re-runs this
 *   function on every relevant file change and re-writes the orch
 *   file's `systemPrompt` field, which the truth cascade mirrors to
 *   `settings.json`. The `before_agent_start` event handler injects
 *   the new prompt into the running session on the next turn — no
 *   `/reload` required.
 *
 * History:
 *   - Gap 2: prompt built only for coordinator; members get a
 *     one-line role fragment via `buildRolePromptFragment`.
 *   - Phase B: per-category `systemPromptAddition` fragments
 *     appended via `buildCategoryFragment`.
 *   - Phase J: full data-driven refactor; sections conditional on
 *     permissions, behavior, skills, active extensions.
 */

import type { MemberRef, ProjectBlock } from "./types.ts";

export interface AgentDescriptor {
	name?: string;
	role?: string;
	description?: string;
}

/**
 * Minimal shape of `manage.json.permissions` — read by the rebuild
 * to drive the explicit Permissions section. We mirror truth's
 * shape but don't import the full schema.
 */
export interface PermissionsSnapshot {
	filesystem?: boolean;
	terminal?: boolean;
	network?: boolean;
}

/**
 * Minimal shape of `manage.json.behavior` — drives the Behavior
 * section. Only the fields we surface in the prompt.
 */
export interface BehaviorSnapshot {
	autoCompaction?: boolean;
	autoRetry?: boolean;
}

/**
 * Minimal shape of `superhive-pi-plan.json.planMode` — used by the
 * Plan Tools section to render the configured default mode.
 */
export interface PlanModeSnapshot {
	defaultMode: string;
	thinkingLevel: string;
	defaultPlanTools?: string[];
}

/**
 * Minimal shape of `superhive-pi-spawn.json` — used by the Spawn
 * Tools section to render the allowed-templates list.
 */
export interface SpawnConfigSnapshot {
	allowedTemplates: string[] | null;
	requireApproval: boolean;
}

/**
 * The full input to `buildSystemPrompt`. The orchestrator's
 * `rebuildSystemPrompt` assembles this from manage.json + the
 * relevant per-extension truth files.
 */
export interface SystemPromptInputs {
	project: ProjectBlock;
	agent: AgentDescriptor;
	identity: { category?: string };
	permissions: PermissionsSnapshot;
	behavior: BehaviorSnapshot;
	skills: string[];
	activeExtensions: {
		truth: boolean;
		telemetry: boolean;
		context: boolean;
		orchestration: boolean;
		plan: boolean;
		spawn: boolean;
	};
	planMode: PlanModeSnapshot | null;
	spawnConfig: SpawnConfigSnapshot | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full system prompt from the inputs. Returns "" when the
 * project block is missing (caller should not invoke the prompt
 * builder for non-project agents; the role-fragment path covers
 * member agents).
 */
export function buildSystemPrompt(inputs: SystemPromptInputs): string {
	const sections: string[] = [
		buildHeaderSection(inputs),
		buildMissionSection(inputs),
		buildTeamSection(inputs),
		// Tools sections — one per enabled ext. Skipped when not
		// active so toggles in the Manage tab take effect on the
		// next prompt rebuild.
		buildOrchestratorToolsSection(inputs),
		inputs.activeExtensions.plan ? buildPlanToolsSection(inputs) : "",
		inputs.activeExtensions.spawn ? buildSpawnToolsSection(inputs) : "",
		inputs.activeExtensions.context ? buildContextToolsSection(inputs) : "",
		// Mailbox + Tasks are coordinator-core but Tasks is plan-
		// specific (plan_tasks / complete_task are plan ext tools).
		buildMailboxSection(),
		inputs.activeExtensions.plan ? buildTasksSection() : "",
		buildDecisionStyleSection(),
		buildEscalationSection(),
		buildBoundariesSection(inputs),
		buildPermissionsSection(inputs),
		buildBehaviorSection(inputs),
		buildSkillsSection(inputs),
	];
	return sections.filter((s) => s.length > 0).join("\n\n");
}

/**
 * A short role-specific instruction injected alongside the standard
 * agent prompt. Tells the agent what to do when a `[mail]` wake
 * prompt appears.
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

// ---------------------------------------------------------------------------
// Section builders — one per section in the final prompt
// ---------------------------------------------------------------------------

function buildHeaderSection(inputs: SystemPromptInputs): string {
	const projectName = inputs.project.name?.trim() || "(unnamed project)";
	const agentName = inputs.agent.name?.trim() || "Project Agent";
	const agentRole = inputs.agent.role?.trim() || "CEO + PM + Architect";
	return `# Project Agent — Superhive

You are **${agentName}** (${agentRole}) for the project "${projectName}".`;
}

function buildMissionSection(inputs: SystemPromptInputs): string {
	const description = inputs.project.description?.trim();
	const body = description && description.length > 0
		? description
		: "_(no mission description set for this project yet)_";
	return `## Mission

${body}`;
}

function buildTeamSection(inputs: SystemPromptInputs): string {
	if (inputs.project.members.length === 0) {
		return `## Your Team

You currently have no specialists assigned. Members are added via the Superhive UI (right sidebar → Manage → Add member).`;
	}
	const rows = inputs.project.members
		.map((m: MemberRef) => renderMemberRow(m))
		.join("\n");
	return `## Your Team

You lead ${inputs.project.members.length} specialist${inputs.project.members.length === 1 ? "" : "s"}. Each is a bounded employee with a defined role. You assign work, review outputs, merge knowledge.

${rows}`;
}

function renderMemberRow(m: MemberRef): string {
	const role = m.role?.trim() || "(no role)";
	const model = m.model ? `${m.model.provider}/${m.model.name}` : "(no model)";
	const status = m.status;
	return `- **${m.name}** — ${role} — model: ${model} — status: \`${status}\` — id: \`${m.agentId}\``;
}

/**
 * Coordinator-core tools. Always present (the orchestrator is the
 * canonical coordinator identity).
 */
function buildOrchestratorToolsSection(_inputs: SystemPromptInputs): string {
	return `## Tools — Orchestrator

You have 7 coordinator-only tools that standard agents cannot see:

- \`list_project_agents\` — enumerate your team
- \`get_agent_status\` — query one agent's current state
- \`ask_member\` — private-ask a specific specialist (writes to their inbox)
- \`read_inbox\` — read pending project-chat messages from your team
- \`post_to_project\` — append a message to the shared project chat`;
}

/**
 * Plan tools. Renders only when the plan ext is loaded AND the
 * per-agent plan file has a planMode block.
 */
function buildPlanToolsSection(inputs: SystemPromptInputs): string {
	const mode = inputs.planMode?.defaultMode ?? "auto";
	return `## Tools — Plan

You have 2 plan-mode tools that the plan extension exposes:

- \`plan_tasks\` — break complex work into a dependency graph; each task is dispatched to its assigned worker once its dependencies complete
- \`complete_task\` — mark a task done after reading the worker's \`result\` from the project chat

Default mode: \`${mode}\`.`;
}

/**
 * Spawn tools. Renders only when the spawn ext is loaded AND
 * the per-agent spawn file has \`enabled: true\`.
 */
function buildSpawnToolsSection(inputs: SystemPromptInputs): string {
	const allowed = inputs.spawnConfig?.allowedTemplates;
	const allowedText = allowed === null || allowed === undefined
		? "any installed template"
		: allowed.length === 0
			? "_(none — toggle the extension off to disable spawning)_"
			: allowed.join(", ");
	const approvalText = inputs.spawnConfig?.requireApproval
		? "The user must approve each spawn before the new agent is created."
		: "Spawns proceed without a permission ask.";
	return `## Tools — Spawn

You have 1 spawn tool exposed by the spawn extension:

- \`spawn_agent({ template, name?, role? })\` — spawn a new regular agent on the fly, auto-bound to this project but not started

Available templates: ${allowedText}.

${approvalText}`;
}

/**
 * Context tools. Renders only when the context ext is loaded.
 */
function buildContextToolsSection(_inputs: SystemPromptInputs): string {
	return `## Tools — Context

The context extension is loaded. You can use the \`context_compaction\` skill to summarize and prune long conversation contexts. The context graph at \`<agentDir>/context/\` tracks nodes + edges; use \`context_status\` (if exposed) to inspect.`;
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

/**
 * Boundaries — the "Recursion available" line flips on when the
 * spawn ext is active. Otherwise the existing "lands in a later
 * phase" line stays.
 */
function buildBoundariesSection(inputs: SystemPromptInputs): string {
	const recursionLine = inputs.activeExtensions.spawn
		? "You can spawn new specialists at runtime via `spawn_agent`; the new agent is auto-bound to this project but is not started automatically (start it from AgentsListView)."
		: "Recursion (creating new specialists) lands in a later phase. To enable spawning, toggle `superhive-pi-spawn` in the Manage tab.";
	return `## Boundaries

- You only see your project. Never read another project's state.
- ${recursionLine}
- You do not directly execute filesystem or shell commands — delegate to specialists.`;
}

/**
 * Permissions section — renders only when at least one permission
 * is false. Tells the model which capabilities are off so it
 * doesn't try to use them.
 */
function buildPermissionsSection(inputs: SystemPromptInputs): string {
	const disabled: string[] = [];
	if (inputs.permissions.filesystem === false) disabled.push("filesystem");
	if (inputs.permissions.terminal === false) disabled.push("terminal");
	if (inputs.permissions.network === false) disabled.push("network");
	if (disabled.length === 0) return "";
	return `## Permissions

You **cannot** use: ${disabled.map((d) => `\`${d}\``).join(", ")}. Delegate these to specialists that have them enabled.`;
}

/**
 * Behavior section — renders only when auto-compaction or
 * auto-retry is disabled. Heads up the model about the runtime
 * behavior.
 */
function buildBehaviorSection(inputs: SystemPromptInputs): string {
	const flags: string[] = [];
	if (inputs.behavior.autoCompaction === false) {
		flags.push("- **auto-compaction is OFF** — context will grow without trimming. Use the `context_compaction` skill manually when context gets long.");
	}
	if (inputs.behavior.autoRetry === false) {
		flags.push("- **auto-retry is OFF** — tool / provider failures will not be retried automatically. Surface them to the user instead.");
	}
	if (flags.length === 0) return "";
	return `## Behavior

${flags.join("\n")}`;
}

/**
 * Skills section — always present, lists the actual skills in
 * `manage.skills`. Reflects user changes (removed bundled skills
 * drop off, added custom skills surface).
 */
function buildSkillsSection(inputs: SystemPromptInputs): string {
	if (inputs.skills.length === 0) {
		return `## Skills

_(no skills installed for this agent)_`;
	}
	return `## Skills

You have these skills available (loaded as \`./skills/<name>/SKILL.md\`):

${inputs.skills.map((s) => `- \`${s}\``).join("\n")}`;
}
