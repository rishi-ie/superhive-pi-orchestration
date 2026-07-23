/**
 * Project block read/write helpers + Gap 2 mailbox FS helpers.
 *
 * The per-agent truth split puts the coordinator's `project` block on
 * `<agentRoot>/manage.json`. The orchestrator extension is a read/write
 * consumer of that block (writes go through the same atomic-write
 * pattern truth uses, so the truth watcher doesn't loop).
 *
 * Identifiers (name/description) live in manage.json's `identity` block.
 * The system-prompt edit on coordinator session_start still lands in
 * `settings.json` (where the runtime reads it).
 *
 * Gap 2 mailbox: the orchestrator writes the same on-disk format as the
 * main-process `electron/mailbox-store.ts`. Two files:
 *   - <projectDir>/agent/chat.jsonl  (project chat — coord and members append)
 *   - <memberDir>/inbox.jsonl        (per-member direct-ask inbox — coord writes)
 *
 * Ponytail: this extension runs inside a Pi subprocess, so we cannot
 * import from the main process. We duplicate the on-disk pattern (jsonl
 * append, tmp+rename rewrite) here. Format is identical so the watcher
 * treats orchestrator writes and main-process writes indistinguishably.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ChatEntry,
	CoordinatorSettingsShape,
	InboxEntry,
	MailKind,
	ManageFileShape,
	MemberRef,
	MemberStatus,
	ProjectBlock,
	TaskCompleteEntry,
	TaskPlan,
} from "./types.ts";

const MANAGED_BY_PREFIX = "superhive-pi-truth@1#";

/**
 * Resolve manage.json. Mirrors
 * superhive-pi-truth/settings-schema.ts::truthPathsForAgentDir.manage.
 */
export function settingsPathFor(agentRoot: string): string {
	return join(agentRoot, "manage.json");
}

/**
 * Resolve settings.json (where the runtime's systemPrompt lives).
 */
export function settingsJsonPathFor(agentRoot: string): string {
	return join(agentRoot, "settings.json");
}

/**
 * Resolve the agent root from a Pi workspace cwd.
 * The workspace is `<agentRoot>/workspace`, so the agent root is the parent.
 */
export function agentRootFromWorkspace(workspace: string): string {
	return dirname(workspace.replace(/\/+$/, ""));
}

/**
 * Read manage.json as a loose shape. Returns null if missing or unreadable.
 * The orchestrator only reads `identity.{name,description}` and `project`.
 */
export function readSettings(settingsPath: string): ManageFileShape | null {
	if (!existsSync(settingsPath)) return null;
	try {
		const raw = readFileSync(settingsPath, "utf8");
		return JSON.parse(raw) as ManageFileShape;
	} catch {
		return null;
	}
}

/**
 * Read settings.json (the runtime essentials). Only used by the
 * coordinator session_start to load + write back the CEO prompt.
 */
export function readSettingsJson(settingsJsonPath: string): CoordinatorSettingsShape | null {
	if (!existsSync(settingsJsonPath)) return null;
	try {
		const raw = readFileSync(settingsJsonPath, "utf8");
		return JSON.parse(raw) as CoordinatorSettingsShape;
	} catch {
		return null;
	}
}

/**
 * Atomic write of manage.json with writer-counter bump. Mirrors
 * superhive-pi-truth/file-io.ts::writeManage.
 */
export function writeSettings(settingsPath: string, settings: ManageFileShape): void {
	const current = readSettings(settingsPath) ?? {};
	const prevCounter = parseCounter(current.managedBy as string | undefined);
	const nextCounter = prevCounter + 1;
	const next = {
		...settings,
		managedBy: `${MANAGED_BY_PREFIX}${nextCounter}`,
		lastModified: new Date().toISOString(),
	};
	const serialized = `${JSON.stringify(next, null, "\t")}\n`;
	const tmp = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, serialized, "utf8");
	try {
		renameSync(tmp, settingsPath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw err;
	}
}

/**
 * Atomic write of settings.json (for the systemPrompt flow only).
 */
export function writeSettingsJson(settingsJsonPath: string, settings: CoordinatorSettingsShape): void {
	const current = readSettingsJson(settingsJsonPath) ?? {};
	const prevCounter = parseCounter(current.managedBy as string | undefined);
	const nextCounter = prevCounter + 1;
	const next = {
		...settings,
		managedBy: `${MANAGED_BY_PREFIX}${nextCounter}`,
		lastModified: new Date().toISOString(),
	};
	const serialized = `${JSON.stringify(next, null, "\t")}\n`;
	const tmp = `${settingsJsonPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, serialized, "utf8");
	try {
		renameSync(tmp, settingsJsonPath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw err;
	}
}

/**
 * Read just the `project` block from manage.json. Returns null if missing.
 */
export function readProjectBlock(settingsPath: string): ProjectBlock | null {
	const settings = readSettings(settingsPath);
	return settings?.project ?? null;
}

/**
 * Replace the project block on disk. Preserves all other manage.json fields.
 */
export function writeProjectBlock(settingsPath: string, project: ProjectBlock): void {
	const current = readSettings(settingsPath) ?? {};
	writeSettings(settingsPath, { ...current, project });
}

/**
 * Update one member's status. No-op if the member is not on the roster.
 * Returns true if a mutation occurred.
 */
export function patchMemberStatus(
	settingsPath: string,
	agentId: string,
	status: MemberStatus,
): boolean {
	const current = readSettings(settingsPath);
	if (!current?.project) return false;
	const idx = current.project.members.findIndex((m) => m.agentId === agentId);
	if (idx === -1) return false;
	const members = current.project.members.slice();
	const existing = members[idx];
	if (!existing || existing.status === status) return false;
	members[idx] = { ...existing, status };
	writeProjectBlock(settingsPath, { ...current.project, members });
	return true;
}

/**
 * Append a member to the project roster. No-op if the agent is already a member.
 * Returns true if a mutation occurred.
 */
export function addMember(settingsPath: string, member: MemberRef): boolean {
	const current = readSettings(settingsPath);
	if (!current?.project) return false;
	if (current.project.members.some((m) => m.agentId === member.agentId)) return false;
	const members = [...current.project.members, member];
	writeProjectBlock(settingsPath, { ...current.project, members });
	return true;
}

/**
 * Remove a member from the project roster. No-op if the agent is not a member.
 * Returns true if a mutation occurred.
 */
export function removeMember(settingsPath: string, agentId: string): boolean {
	const current = readSettings(settingsPath);
	if (!current?.project) return false;
	const next = current.project.members.filter((m) => m.agentId !== agentId);
	if (next.length === current.project.members.length) return false;
	writeProjectBlock(settingsPath, { ...current.project, members: next });
	return true;
}

/**
 * Find a member on the project roster by id. Pure — no FS.
 */
export function findMemberById(project: ProjectBlock, agentId: string): MemberRef | undefined {
	return project.members.find((m) => m.agentId === agentId);
}

function parseCounter(managedBy: string | undefined): number {
	if (!managedBy) return 0;
	const idx = managedBy.indexOf("#");
	if (idx === -1) return 0;
	const n = Number.parseInt(managedBy.slice(idx + 1), 10);
	return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Gap 2 mailbox — project chat (<projectDir>/agent/chat.jsonl)
// ---------------------------------------------------------------------------

function chatFilePath(projectDir: string): string {
	return join(projectDir, "agent", "chat.jsonl");
}

function ensureDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Append a tagged entry to the project chat. Atomic for single-line writes
 * on POSIX (writes < PIPE_BUF = 4096 bytes).
 */
export function appendProjectChat(projectDir: string, entry: ChatEntry): void {
	const path = chatFilePath(projectDir);
	ensureDir(path);
	appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

export interface ReadProjectChatOpts {
	limit?: number;
	sinceTs?: number;
	kinds?: MailKind[];
	excludeFromAgentIds?: Array<string | null>;
	excludeDeliveredTo?: string[];
}

/**
 * Read the project chat, returning the most recent N entries that match
 * the filter. Malformed lines are skipped (logged, not thrown).
 */
export function readProjectChat(projectDir: string, opts: ReadProjectChatOpts = {}): ChatEntry[] {
	const path = chatFilePath(projectDir);
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");
	const lines = raw.split("\n");
	const entries: ChatEntry[] = [];
	for (const line of lines) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as ChatEntry);
		} catch {
			// skip malformed — main-process watcher does the same
		}
	}

	let filtered = entries
	if (opts.sinceTs !== undefined) {
		filtered = filtered.filter((e) => e.ts >= (opts.sinceTs ?? 0))
	}
	if (opts.kinds && opts.kinds.length > 0) {
		const allowed = new Set(opts.kinds)
		filtered = filtered.filter((e) => e.kind && allowed.has(e.kind))
	}
	if (opts.excludeFromAgentIds && opts.excludeFromAgentIds.length > 0) {
		const excluded = new Set<string | null>(opts.excludeFromAgentIds)
		filtered = filtered.filter((e) => {
			const fromId = e.fromAgentId ?? null
			return !excluded.has(fromId)
		})
	}
	if (opts.excludeDeliveredTo && opts.excludeDeliveredTo.length > 0) {
		const set = new Set(opts.excludeDeliveredTo)
		filtered = filtered.filter((e) => {
			if (!e.deliveredTo) return true
			return !e.deliveredTo.some((id) => set.has(id))
		})
	}
	if (opts.limit !== undefined && opts.limit > 0) {
		filtered = filtered.slice(-opts.limit)
	}
	return filtered
}

/**
 * Add agentId to a chat entry's `deliveredTo[]` (idempotent).
 */
export function markChatDelivered(projectDir: string, messageId: string, agentId: string): boolean {
	const path = chatFilePath(projectDir)
	if (!existsSync(path)) return false
	const raw = readFileSync(path, "utf8")
	const lines = raw.split("\n")
	let mutated = false
	const out: string[] = []
	for (const line of lines) {
		if (!line) {
			out.push(line)
			continue
		}
		try {
			const parsed = JSON.parse(line) as ChatEntry
			if (parsed.id === messageId) {
				const delivered = parsed.deliveredTo ?? []
				if (!delivered.includes(agentId)) {
					parsed.deliveredTo = [...delivered, agentId]
					mutated = true
				}
			}
			out.push(JSON.stringify(parsed))
		} catch {
			out.push(line)
		}
	}
	if (!mutated) return false
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
	writeFileSync(tmp, out.join("\n") + "\n", "utf8")
	try {
		renameSync(tmp, path)
	} catch (err) {
		try {
			unlinkSync(tmp)
		} catch {
			// ignore
		}
		throw err
	}
	return true
}

// ---------------------------------------------------------------------------
// Gap 2 mailbox — member inbox (<memberDir>/inbox.jsonl)
// ---------------------------------------------------------------------------

function inboxFilePath(memberDir: string): string {
	return join(memberDir, "inbox.jsonl")
}

/**
 * Append a direct-ask entry to a member's inbox. Atomic for single-line writes.
 */
export function appendMemberInbox(memberDir: string, entry: InboxEntry): void {
	const path = inboxFilePath(memberDir)
	ensureDir(path)
	appendFileSync(path, JSON.stringify(entry) + "\n", "utf8")
}

export interface ReadMemberInboxOpts {
	limit?: number
	status?: InboxEntry["status"][]
	kinds?: InboxEntry["kind"][]
}

export type InboxStatus = InboxEntry["status"]

/**
 * Read a member's inbox, returning entries that match the filter.
 */
export function readMemberInbox(memberDir: string, opts: ReadMemberInboxOpts = {}): InboxEntry[] {
	const path = inboxFilePath(memberDir)
	if (!existsSync(path)) return []
	const raw = readFileSync(path, "utf8")
	const lines = raw.split("\n")
	const entries: InboxEntry[] = []
	for (const line of lines) {
		if (!line) continue
		try {
			entries.push(JSON.parse(line) as InboxEntry)
		} catch {
			// skip malformed
		}
	}

	let filtered = entries
	if (opts.status && opts.status.length > 0) {
		const allowed = new Set(opts.status)
		filtered = filtered.filter((e) => allowed.has(e.status))
	}
	if (opts.kinds && opts.kinds.length > 0) {
		const allowed = new Set(opts.kinds)
		filtered = filtered.filter((e) => allowed.has(e.kind))
	}
	if (opts.limit !== undefined && opts.limit > 0) {
		filtered = filtered.slice(-opts.limit)
	}
	return filtered
}

/**
 * Flip a specific inbox entry's status from `pending` to `acked`.
 */
export function ackInboxMessage(memberDir: string, messageId: string): boolean {
	const path = inboxFilePath(memberDir)
	if (!existsSync(path)) return false
	const raw = readFileSync(path, "utf8")
	const lines = raw.split("\n")
	let mutated = false
	const out: string[] = []
	for (const line of lines) {
		if (!line) {
			out.push(line)
			continue
		}
		try {
			const parsed = JSON.parse(line) as InboxEntry
			if (parsed.id === messageId && parsed.status !== "acked") {
				parsed.status = "acked"
				parsed.ackedAt = Date.now()
				mutated = true
			}
			out.push(JSON.stringify(parsed))
		} catch {
			out.push(line)
		}
	}
	if (!mutated) return false
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
	writeFileSync(tmp, out.join("\n") + "\n", "utf8")
	try {
		renameSync(tmp, path)
	} catch (err) {
		try {
			unlinkSync(tmp)
		} catch {
			// ignore
		}
		throw err
	}
	return true
}

// ---------------------------------------------------------------------------
// Gap 3: plan + complete file drop helpers
// ---------------------------------------------------------------------------

/**
 * Write a plan to `<coordDir>/tasks-plan.json` (atomic: tmp + rename).
 */
export function writeTaskPlan(coordDir: string, plan: TaskPlan): void {
  const target = join(coordDir, "tasks-plan.json")
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(plan, null, 2), "utf8")
  try {
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

/**
 * Append a completion entry to `<coordDir>/tasks-complete.jsonl`.
 */
export function appendTaskComplete(coordDir: string, entry: TaskCompleteEntry): void {
  const target = join(coordDir, "tasks-complete.jsonl")
  appendFileSync(target, JSON.stringify(entry) + "\n", "utf8")
}
