import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentRootFromWorkspace,
	addMember,
	patchMemberStatus,
	readProjectBlock,
	readSettings,
	removeMember,
	settingsPathFor,
	writeProjectBlock,
	writeSettings,
} from "../project.ts";
import type { MemberRef, ProjectBlock } from "../types.ts";

function tempAgentDir(): { root: string; settingsPath: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "superhive-orch-test-"));
	const settingsPath = settingsPathFor(root);
	return {
		root,
		settingsPath,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

const sampleMember: MemberRef = {
	agentId: "a1",
	name: "Alice",
	role: "Backend Engineer",
	model: { provider: "minimax", name: "MiniMax-M3" },
	status: "idle",
	joinedAt: "2026-01-01T00:00:00Z",
};

const secondMember: MemberRef = {
	agentId: "a2",
	name: "Bob",
	role: "QA",
	status: "idle",
	joinedAt: "2026-01-02T00:00:00Z",
};

const sampleProject: ProjectBlock = {
	id: "proj-1",
	name: "Foo",
	description: "Test project",
	members: [sampleMember],
};

test("settingsPathFor: derives path from agent root basename", () => {
	const { root, cleanup } = tempAgentDir();
	try {
		const p = settingsPathFor(root);
		const folder = root.split("/").pop();
		assert.equal(p, join(root, `Superhive-pi-${folder}.json`));
	} finally {
		cleanup();
	}
});

test("agentRootFromWorkspace: strips /workspace suffix", () => {
	const root = agentRootFromWorkspace("/foo/bar/workspace");
	assert.equal(root, "/foo/bar");
});

test("agentRootFromWorkspace: handles trailing slash", () => {
	const root = agentRootFromWorkspace("/foo/bar/workspace/");
	assert.equal(root, "/foo/bar");
});

test("readSettings: returns null when file missing", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		assert.equal(readSettings(settingsPath), null);
		assert.equal(readProjectBlock(settingsPath), null);
	} finally {
		cleanup();
	}
});

test("readProjectBlock: returns null when project block missing", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeFileSync(settingsPath, JSON.stringify({ name: "no project" }), "utf8");
		assert.equal(readProjectBlock(settingsPath), null);
	} finally {
		cleanup();
	}
});

test("writeSettings: creates file and bumps counter on each write", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeSettings(settingsPath, { name: "v1" });
		const first = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(first.name, "v1");
		assert.match(first.managedBy, /^superhive-pi-truth@1#1$/);

		writeSettings(settingsPath, { name: "v2" });
		const second = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(second.name, "v2");
		assert.match(second.managedBy, /^superhive-pi-truth@1#2$/);
		assert.ok(second.lastModified);
	} finally {
		cleanup();
	}
});

test("writeProjectBlock: round-trips through readProjectBlock", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeProjectBlock(settingsPath, sampleProject);
		const got = readProjectBlock(settingsPath);
		assert.deepEqual(got, sampleProject);
	} finally {
		cleanup();
	}
});

test("writeProjectBlock: preserves other settings fields", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeSettings(settingsPath, { name: "Coordinator", description: "The boss" });
		writeProjectBlock(settingsPath, sampleProject);
		const settings = readSettings(settingsPath);
		assert.equal(settings?.name, "Coordinator");
		assert.equal(settings?.description, "The boss");
		assert.deepEqual(settings?.project, sampleProject);
	} finally {
		cleanup();
	}
});

test("patchMemberStatus: updates status for existing member", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeProjectBlock(settingsPath, sampleProject);
		const changed = patchMemberStatus(settingsPath, "a1", "active");
		assert.equal(changed, true);
		const got = readProjectBlock(settingsPath);
		assert.equal(got?.members[0]?.status, "active");
	} finally {
		cleanup();
	}
});

test("patchMemberStatus: no-op for unknown member", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeProjectBlock(settingsPath, sampleProject);
		const changed = patchMemberStatus(settingsPath, "ghost", "active");
		assert.equal(changed, false);
	} finally {
		cleanup();
	}
});

test("patchMemberStatus: no-op when status unchanged", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeProjectBlock(settingsPath, sampleProject);
		const changed = patchMemberStatus(settingsPath, "a1", "idle");
		assert.equal(changed, false);
	} finally {
		cleanup();
	}
});

test("addMember: appends new member", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeProjectBlock(settingsPath, sampleProject);
		const changed = addMember(settingsPath, secondMember);
		assert.equal(changed, true);
		const got = readProjectBlock(settingsPath);
		assert.equal(got?.members.length, 2);
		assert.equal(got?.members[1]?.agentId, "a2");
	} finally {
		cleanup();
	}
});

test("addMember: no-op for duplicate", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeProjectBlock(settingsPath, sampleProject);
		const changed = addMember(settingsPath, sampleMember);
		assert.equal(changed, false);
	} finally {
		cleanup();
	}
});

test("removeMember: drops the matching member", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeProjectBlock(settingsPath, { ...sampleProject, members: [sampleMember, secondMember] });
		const changed = removeMember(settingsPath, "a1");
		assert.equal(changed, true);
		const got = readProjectBlock(settingsPath);
		assert.equal(got?.members.length, 1);
		assert.equal(got?.members[0]?.agentId, "a2");
	} finally {
		cleanup();
	}
});

test("removeMember: no-op for unknown member", () => {
	const { settingsPath, cleanup } = tempAgentDir();
	try {
		writeProjectBlock(settingsPath, sampleProject);
		const changed = removeMember(settingsPath, "ghost");
		assert.equal(changed, false);
	} finally {
		cleanup();
	}
});

test("atomic write: leaves no .tmp files behind", () => {
	const { root, settingsPath, cleanup } = tempAgentDir();
	try {
		writeSettings(settingsPath, { name: "x" });
		const files = readdirSync(root);
		const tmpLeftovers = files.filter((f: string) => f.endsWith(".tmp"));
		assert.equal(tmpLeftovers.length, 0);
	} finally {
		cleanup();
	}
});