/**
 * Type contracts for superhive-pi-orchestration.
 *
 * These mirror the truth settings schema's `project` block. We duplicate
 * the types here (rather than importing from `superhive-pi-truth`) to keep
 * the extension's import surface minimal and to avoid a hard dep on the
 * truth module. The contract is the file format — both sides must agree.
 */

export type MemberStatus = "idle" | "active" | "error";

export interface MemberRef {
	agentId: string;
	name: string;
	role?: string;
	model?: { provider: string; name: string };
	status: MemberStatus;
	joinedAt: string;
}

export interface ProjectBlock {
	id: string;
	name: string;
	description: string;
	members: MemberRef[];
}

/**
 * Minimal shape of the truth settings file we care about. We do not import
 * the full `SettingsFile` from truth because (a) it would create a build
 * dep and (b) the truth module is bundled into the agent independently.
 */
export interface CoordinatorSettingsShape {
	name?: string;
	description?: string;
	role?: string;
	systemPrompt?: string;
	project?: ProjectBlock;
	managedBy?: string;
	lastModified?: string;
}