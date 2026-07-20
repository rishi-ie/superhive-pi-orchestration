/**
 * Project block read/write helpers.
 *
 * The coordinator's truth settings file (`<agentRoot>/Superhive-pi-<foldername>.json`)
 * holds an optional `project` block that this extension reads and mutates.
 *
 * Mutations follow truth's atomic-write pattern (tmp + rename + writer-counter
 * bump) so the truth watcher treats self-writes correctly and external writes
 * (status-mirror helper from Electron) trigger our re-read on the next
 * session_start.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import type { CoordinatorSettingsShape, MemberRef, MemberStatus, ProjectBlock } from "./types.ts";

const MANAGED_BY_PREFIX = "superhive-pi-truth@1#";

/**
 * Resolve the settings file path for an agent root.
 * Mirrors superhive-pi-truth/settings-schema.ts::settingsFilePathFor.
 */
export function settingsPathFor(agentRoot: string): string {
	const folder = basename(agentRoot);
	return join(agentRoot, `Superhive-pi-${folder}.json`);
}

/**
 * Resolve the agent root from a Pi workspace cwd.
 * The workspace is `<agentRoot>/workspace`, so the agent root is the parent.
 */
export function agentRootFromWorkspace(workspace: string): string {
	return dirname(workspace.replace(/\/+$/, ""));
}

/**
 * Read the full coordinator settings (or whatever shape is on disk).
 * Returns null if the file is missing or unreadable.
 */
export function readSettings(settingsPath: string): CoordinatorSettingsShape | null {
	if (!existsSync(settingsPath)) return null;
	try {
		const raw = readFileSync(settingsPath, "utf8");
		return JSON.parse(raw) as CoordinatorSettingsShape;
	} catch {
		return null;
	}
}

/**
 * Read just the `project` block. Returns null if the file is missing,
 * unreadable, or has no project block (i.e. this agent is not a coordinator).
 */
export function readProjectBlock(settingsPath: string): ProjectBlock | null {
	const settings = readSettings(settingsPath);
	return settings?.project ?? null;
}

/**
 * Atomic write of the full settings object with writer-counter bump.
 * Mirrors superhive-pi-truth/file-io.ts::writeSettings so the truth watcher
 * recognises our writes as self-writes and skips the diff.
 */
export function writeSettings(settingsPath: string, settings: CoordinatorSettingsShape): void {
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
 * Replace the project block on disk. Preserves all other fields.
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

function parseCounter(managedBy: string | undefined): number {
	if (!managedBy) return 0;
	const idx = managedBy.indexOf("#");
	if (idx === -1) return 0;
	const n = Number.parseInt(managedBy.slice(idx + 1), 10);
	return Number.isFinite(n) ? n : 0;
}