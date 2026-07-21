/**
 * Type contracts for superhive-pi-orchestration.
 *
 * These mirror the truth settings schema's `project` block. We duplicate
 * the types here (rather than importing from `superhive-pi-truth`) to keep
 * the extension's import surface minimal and to avoid a hard dep on the
 * truth module. The contract is the file format — both sides must agree.
 *
 * Gap 2 additions:
 *   - MemberRef.localPath — the member's <agentDir>, lets the coordinator's
 *     `ask_member` tool resolve where to write <memberDir>/inbox.jsonl.
 *   - ProjectBlock.localPath — the <projectDir>, lets members'
 *     `post_to_project` tool find <localPath>/agent/chat.jsonl.
 *   - ProjectBlock.coordinatorAgentId — explicit, so the extension can
 *     detect role (coordinator vs member) by comparing against AGENT_ID.
 */

export type MemberStatus = "idle" | "active" | "error";

export interface MemberRef {
	agentId: string;
	name: string;
	role?: string;
	model?: { provider: string; name: string };
	status: MemberStatus;
	joinedAt: string;
	localPath?: string;
}

export interface ProjectBlock {
	id: string;
	name: string;
	description: string;
	members: MemberRef[];
	localPath?: string;
	coordinatorAgentId?: string;
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

/** Mail message kind — used by tools and shared with the IPC layer. */
export type MailKind = "request" | "result" | "question" | "broadcast";

/** Single line in <projectDir>/agent/chat.jsonl. Mirrors main-process format. */
export interface ChatEntry {
	id: string;
	ts: number;
	role: "user" | "assistant";
	parts: Array<{ type: "text"; text: string }>;
	/** Set when the entry came from an agent (not the user). */
	fromAgentId?: string;
	fromAgentName?: string;
	kind?: MailKind;
	refMessageId?: string;
	/** Per-agent delivery tracking — coordinator populates on read_inbox. */
	deliveredTo?: string[];
}

/** Single line in <memberDir>/inbox.jsonl. Mirrors main-process format. */
export interface InboxEntry {
	id: string;
	ts: number;
	fromAgentId: string;
	toAgentId: string;
	kind: Exclude<MailKind, "broadcast">;
	body: string;
	refMessageId?: string;
	status: "pending" | "delivered" | "acked";
	deliveredAt?: number;
	ackedAt?: number;
}
