/**
 * superhive-pi-orchestration — entry point.
 *
 * Gap 2: the gate is no longer "AGENT_KIND === 'project-coordinator'".
 * The extension now loads for any project member and detects role by
 * comparing AGENT_ID against project.coordinatorAgentId.
 *
 * 4-file truth split:
 *   - manage.json holds the `project` block + identity.{name,description}
 *   - settings.json holds the runtime systemPrompt
 *
 * On `session_start`:
 *   1. Read manage.json. If `project` is missing, no-op.
 *   2. Determine role by AGENT_ID === project.coordinatorAgentId.
 *   3. Coordinator: build the CEO prompt from the current config
 *      snapshot (manage + plan file + spawn file + defaults) and
 *      write it to the orch file. Register all 7 tools.
 *   4. Member: append a one-line role fragment to the orch file's
 *      systemPrompt (idempotent — marker-guarded). Register only
 *      read_inbox + post_to_project.
 *
 * Phase J — dynamic system prompt:
 *   After session_start, three file watchers (manage.json, the plan
 *   file, the spawn file) trigger `rebuildSystemPrompt()` on debounced
 *   changes. The rebuild re-reads the full config snapshot, builds
 *   the new prompt, and writes to the orch file (counter bump). The
 *   truth cascade mirrors the new systemPrompt to settings.json.
 *
 *   A `before_agent_start` event handler injects the latest
 *   systemPrompt on every turn — no `/reload` required. The handler
 *   caches the last-read value and only re-reads when the watcher
 *   invalidates the cache.
 *
 * Standalone agents (no project block) exit at step 1 with zero side
 * effects. The orchestrator's tools never reach their model context.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	agentRootFromWorkspace,
	orchestrationExtensionPathFor,
	planExtensionPathFor,
	readOrchestrationExtension,
	readPlanExtension,
	readProjectBlock,
	readSettings,
	settingsJsonPathFor,
	settingsPathFor,
	spawnExtensionPathFor,
	writeOrchestrationExtension,
	writeSettingsJson,
} from "./project.ts";
import {
	buildRolePromptFragment,
	buildSystemPrompt,
	type PlanModeSnapshot,
	type SpawnConfigSnapshot,
	type SystemPromptInputs,
} from "./system-prompt.ts";
import { registerOrchestrationTools } from "./tools.ts";

// Marker in the systemPrompt that records which role's fragment is appended.
// Used to keep the append idempotent across session_starts.
const ROLE_FRAGMENT_MARKER = "\n[superhive:role-fragment:";

// Per-agent file watcher debounce (ms). Matches the truth ext's
// per-file debounce.
const WATCHER_DEBOUNCE_MS = 100;

function readSettingsFromFile(p: string): { systemPrompt?: string } | null {
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as { systemPrompt?: string };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Phase J: dynamic system prompt — config-snapshot assembly
// ---------------------------------------------------------------------------

/**
 * Read the full config snapshot needed to (re)build the system
 * prompt. Pure-FS — no Pi API, no side effects.
 *
 * Pulls from:
 *   - manage.json        — project, identity, permissions, behavior,
 *                          skills, extensions[]
 *   - superhive-pi-plan.json  — planMode block (when present)
 *   - superhive-pi-spawn.json — enabled, allowedTemplates, requireApproval
 *
 * Returns null when there's no project block (caller should skip
 * the rebuild — not a project agent).
 */
export function assembleSystemPromptInputs(
	managePath: string,
	agentRoot: string,
): SystemPromptInputs | null {
	const manage = readSettings(managePath);
	const project = manage?.project;
	if (!project || !project.localPath || !project.coordinatorAgentId) {
		return null;
	}

	// Permissions — default to all-true when missing (matches truth's
	// default).
	const permissions = manage?.permissions ?? {
		filesystem: true,
		terminal: true,
		network: true,
	};

	const behavior = manage?.behavior ?? {};
	const skills = Array.isArray(manage?.skills) ? (manage!.skills as string[]) : [];
	const extensions = Array.isArray(manage?.extensions) ? manage!.extensions as string[] : [];

	const extHas = (name: string): boolean =>
		extensions.some((e) => typeof e === "string" && (e === name || e === `./extensions/${name}`));

	const planFile = readPlanExtension(planExtensionPathFor(agentRoot));
	const spawnFile = readSpawnExtensionSafe(spawnExtensionPathFor(agentRoot));

	const planMode: PlanModeSnapshot | null = planFile?.planMode
		? {
				defaultMode: planFile.planMode.defaultMode,
				thinkingLevel: planFile.planMode.thinkingLevel,
				defaultPlanTools: planFile.planMode.defaultPlanTools,
			}
		: null;

	const spawnConfig: SpawnConfigSnapshot | null = spawnFile
		? {
				allowedTemplates: spawnFile.allowedTemplates ?? null,
				requireApproval: spawnFile.requireApproval === true,
			}
		: null;

	return {
		project,
		agent: {
			name: manage?.identity?.name,
			role: manage?.identity?.role,
			description: manage?.identity?.description,
		},
		identity: {},
		permissions,
		behavior: {
			autoCompaction: behavior.autoCompaction,
			autoRetry: behavior.autoRetry,
		},
		skills,
		activeExtensions: {
			truth: true, // always present for a Pi agent
			telemetry: true, // always present for a project agent
			context: extHas("superhive-pi-context"),
			orchestration: true, // this ext IS the orchestrator
			plan: extHas("superhive-pi-plan") && planFile !== null,
			spawn: extHas("superhive-pi-spawn") && spawnFile?.enabled === true,
		},
		planMode,
		spawnConfig,
	};
}

/**
 * Local read of the spawn ext's per-agent file. We use a loose
 * read here (rather than truth's readSpawnExtension) because the
 * spawn ext is in a different module and we don't want to
 * cross-import. The shape is small and well-defined by
 * superhive-pi-truth/settings-schema.ts.
 */
interface SpawnFileLoose {
	enabled?: boolean;
	allowedTemplates?: string[] | null;
	requireApproval?: boolean;
}

function readSpawnExtensionSafe(path: string): SpawnFileLoose | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as SpawnFileLoose;
	} catch {
		return null;
	}
}

/**
 * Rebuild the system prompt from the current config snapshot and
 * write it to the orch file. Counter bumps via writeOrchestrationExtension.
 * No-op for non-project agents.
 *
 * Returns the new systemPrompt string, or null if the agent has no
 * project block.
 */
export function rebuildSystemPrompt(agentRoot: string): string | null {
	const inputs = assembleSystemPromptInputs(settingsPathFor(agentRoot), agentRoot);
	if (!inputs) return null;
	return writeSystemPromptFromInputs(inputs, agentRoot);
}

/**
 * Build the system prompt from inputs and write to the orch file.
 * The `roleFragmentAppended` field is set to `"coordinator"` (or
 * `"member"` in the member path) — no category marker.
 *
 * Idempotent: when the rebuilt prompt + marker are byte-equivalent
 * to what's already on disk, the write is skipped (no counter
 * bump). Matches the truth cascade's deep-equal check so the
 * file's `managedBy` counter doesn't churn on every rebuild.
 */
function writeSystemPromptFromInputs(inputs: SystemPromptInputs, agentRoot: string, roleMarker: string = "coordinator"): string {
	const prompt = buildSystemPrompt(inputs);
	const orchPath = orchestrationExtensionPathFor(agentRoot);
	const current = readOrchestrationExtension(orchPath) ?? {};

	// Idempotency check: skip the write when the rebuilt content
	// matches the on-disk orch file. This avoids counter churn on
	// no-op rebuilds (e.g. the orchestrator polls for changes
	// every 500ms; without this check, every session_start would
	// bump the counter on every poll).
	if (current.systemPrompt === prompt && current.roleFragmentAppended === roleMarker) {
		return prompt;
	}

	writeOrchestrationExtension(orchPath, { ...current, systemPrompt: prompt, roleFragmentAppended: roleMarker });

	// Backward-compat: also seed settings.json's systemPrompt from
	// the orch write when settings.json has none yet (one-time
	// migration path). The cascade keeps it in sync after.
	const settingsJsonPath = settingsJsonPathFor(agentRoot);
	const settingsJson = readSettingsFromFile(settingsJsonPath);
	if (settingsJson && !settingsJson.systemPrompt) {
		writeSettingsJson(settingsJsonPath, { ...settingsJson, systemPrompt: prompt });
	}

	return prompt;
}

// ---------------------------------------------------------------------------
// File watchers — invalidate the cache + trigger a rebuild
// ---------------------------------------------------------------------------

interface OrchestratorState {
	agentRoot: string;
	managePath: string;
	planPath: string;
	spawnPath: string;
	orchPath: string;
	/**
	 * Cached value of the last-read systemPrompt. The
	 * before_agent_start handler returns this on every turn —
	 * cached because the rebuild + write only fires on actual
	 * changes (the watchers), and the read is otherwise a no-op
	 * on every turn.
	 */
	cachedPrompt: string | null;
	/**
	 * Set to true by any watcher when the source files have
	 * changed since the last cache fill. Cleared by the next
	 * successful read.
	 */
	cacheDirty: boolean;
	// File watcher disposers (so session_shutdown can stop them).
	disposers: Array<() => void>;
}

function startWatchers(
	state: OrchestratorState,
	invalidate: () => void,
	rebuild: () => void,
): void {
	const tryRead = (path: string): string => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	};
	// Simple poll-based watcher (avoids the FSWatcher chokepoints
	// the truth ext hits). Polls every WATCHER_DEBOUNCE_MS * 5;
	// coalesces rapid edits via the debounce. Same effective
	// behavior as the truth ext's createWatcher (which itself
	// uses fs.watch + a debounce timer).
	let lastManage = tryRead(state.managePath);
	let lastPlan = tryRead(state.planPath);
	let lastSpawn = tryRead(state.spawnPath);
	let pendingRebuild: NodeJS.Timeout | null = null;

	const scheduleRebuild = (): void => {
		if (pendingRebuild) clearTimeout(pendingRebuild);
		pendingRebuild = setTimeout(() => {
			pendingRebuild = null;
			try {
				rebuild();
			} catch (err) {
				process.stderr.write(`[orch] rebuild failed: ${(err as Error).message}\n`);
			}
		}, WATCHER_DEBOUNCE_MS);
	};

	const tick = (): void => {
		const curManage = tryRead(state.managePath);
		const curPlan = tryRead(state.planPath);
		const curSpawn = tryRead(state.spawnPath);
		if (curManage !== lastManage) {
			lastManage = curManage;
			invalidate();
			scheduleRebuild();
		}
		if (curPlan !== lastPlan) {
			lastPlan = curPlan;
			invalidate();
			scheduleRebuild();
		}
		if (curSpawn !== lastSpawn) {
			lastSpawn = curSpawn;
			invalidate();
			scheduleRebuild();
		}
	};

	const interval = setInterval(tick, WATCHER_DEBOUNCE_MS * 5);
	// unref() so the interval doesn't keep the Node event loop alive.
	// Without this, every session_start would leave a dangling
	// timer and smoke / test runs would never exit. The Pi runtime
	// is a long-lived process that doesn't rely on this interval
	// for shutdown; process exit / session_shutdown tears it down
	// via state.disposers.
	interval.unref();
	state.disposers.push(() => {
		clearInterval(interval);
		if (pendingRebuild) clearTimeout(pendingRebuild);
	});
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function superhivePiOrchestration(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const workspace = ctx.cwd;
		if (!workspace) {
			// No cwd — cannot derive agent root. Skip silently.
			return;
		}

		const agentRoot = agentRootFromWorkspace(workspace);
		const managePath = settingsPathFor(agentRoot);
		const orchPath = orchestrationExtensionPathFor(agentRoot);
		const settingsJsonPath = settingsJsonPathFor(agentRoot);

		const project = readProjectBlock(managePath);
		if (!project || !project.localPath || !project.coordinatorAgentId) {
			// Not a project member (no project block, or missing
			// coordinatorAgentId from an older settings file).
			return;
		}

		const selfAgentId = process.env.AGENT_ID;
		if (!selfAgentId) {
			// The main process should always inject AGENT_ID; if
			// it's missing, this is a config bug. Skip without
			// side effects.
			return;
		}

		const isCoordinator = project.coordinatorAgentId === selfAgentId;
		const role = isCoordinator ? "coordinator" : "member";

		if (isCoordinator) {
			// Build the CEO prompt from the full config snapshot
			// and write to the orch file. The new path replaces
			// the old inline build. Member path keeps the simpler
			// one-line role-fragment append.
			const prompt = writeSystemPromptFromInputs(
				assembleSystemPromptInputs(managePath, agentRoot)!,
				agentRoot,
			);

			// Backward-compat: same one-time settings.json seed as
			// before. The cascade keeps it in sync after.
			const settingsJson = readSettingsFromFile(settingsJsonPath);
			if (settingsJson && !settingsJson.systemPrompt) {
				writeSettingsJson(settingsJsonPath, { ...settingsJson, systemPrompt: prompt });
			}

			// Wire the dynamic-prompt state. The cache is filled
			// synchronously so the first before_agent_start read
			// is a cache hit.
			const state: OrchestratorState = {
				agentRoot,
				managePath,
				planPath: planExtensionPathFor(agentRoot),
				spawnPath: spawnExtensionPathFor(agentRoot),
				orchPath,
				cachedPrompt: prompt,
				cacheDirty: false,
				disposers: [],
			};
			startWatchers(
				state,
				() => {
					state.cacheDirty = true;
				},
				() => {
					const next = rebuildSystemPrompt(agentRoot);
					if (next !== null) {
						state.cachedPrompt = next;
						state.cacheDirty = false;
					}
				},
			);

			// Live-inject the latest prompt on every turn. Returns
			// the cached value when unchanged; re-reads on cache
			// invalidation (which only happens after a watcher
			// tick, so we don't re-read the orch file on every
			// turn when nothing has changed).
			pi.on("before_agent_start", (event) => {
				if (state.cacheDirty) {
					const fresh = readOrchestrationExtension(state.orchPath);
					if (fresh?.systemPrompt) {
						state.cachedPrompt = fresh.systemPrompt;
						state.cacheDirty = false;
					}
				}
				const fresh = state.cachedPrompt;
				if (fresh && fresh !== event.systemPrompt) {
					return { systemPrompt: fresh };
				}
				return undefined;
			});

			// Tear down on shutdown. Pi's API doesn't expose a
			// session_shutdown for this ext today, so we register
			// on process exit to stop the pollers.
			//
			// We bump the max listeners count for this specific
			// process because the orchestrator can be registered
			// many times in test runs (each session_start adds one
			// 'exit' listener). In production the orchestrator is
			// registered once per Pi process, so this never
			// approaches the default cap.
			const teardown = (): void => {
				for (const d of state.disposers) d();
				state.disposers = [];
			};
			if (process.listenerCount("exit") > process.getMaxListeners() - 5) {
				process.setMaxListeners(process.listenerCount("exit") + 10);
			}
			process.once("exit", teardown);
		} else {
			// Member: append a one-line role fragment to the orch
			// file's systemPrompt (idempotent). Cascade mirrors out
			// to settings.json.
			const current = readOrchestrationExtension(orchPath) ?? {};
			const existing = current.systemPrompt ?? "";
			const marker = `${ROLE_FRAGMENT_MARKER}${role}]`;
			if (!existing.includes(marker)) {
				const fragment = buildRolePromptFragment(role);
				const next = existing
					? `${existing}\n\n${fragment}${marker}`
					: `${fragment}${marker}`;
				writeOrchestrationExtension(orchPath, {
					...current,
					systemPrompt: next,
					roleFragmentAppended: role,
				});
			}
		}

		registerOrchestrationTools(pi, { role, settingsPath: managePath, project });
	});
}
