import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createLocalBashOperations,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	type SessionEntry,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ────────────────────────── blob store ──────────────────────────

interface BlobRef {
	sha256: string;
	size: number;
}

async function ignoreEnoent<T>(promise: Promise<T>, fallback: T): Promise<T> {
	return await promise.catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return fallback;
		throw error;
	});
}

const BLOBS_DIR = join(getAgentDir(), "pi-undo-redo", "blobs");

function blobPath(sha256: string): string {
	return join(BLOBS_DIR, sha256.slice(0, 2), sha256);
}

function hashBuffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

async function saveBlob(buffer: Buffer, precomputedSha256?: string): Promise<BlobRef> {
	const sha256 = precomputedSha256 ?? hashBuffer(buffer);
	const path = blobPath(sha256);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, buffer, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	return { sha256, size: buffer.byteLength };
}

async function loadBlob(ref: BlobRef): Promise<Buffer> {
	return await readFile(blobPath(ref.sha256));
}

async function walkBlobDir(
	directory: string,
): Promise<Array<{ sha256: string; path: string; size: number }>> {
	const entries = await ignoreEnoent(readdir(directory, { withFileTypes: true }), []);
	const results = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return await walkBlobDir(path);
			const info = await stat(path);
			return [{ sha256: entry.name, path, size: info.size }];
		}),
	);
	return results.flat();
}

async function listStoredBlobs(): Promise<Array<{ sha256: string; path: string; size: number }>> {
	return await walkBlobDir(BLOBS_DIR);
}

async function deleteStoredBlob(sha256: string): Promise<void> {
	await unlink(blobPath(sha256));
}

// ────────────────────────── history ──────────────────────────

const STEP_ENTRY_TYPE = "@kmiyh/pi-undo-redo.step";
const ACTION_ENTRY_TYPE = "@kmiyh/pi-undo-redo.action";
const NOTICE_MESSAGE_TYPE = "@kmiyh/pi-undo-redo.notice";

interface StepFileChange {
	path: string;
	before?: BlobRef;
	after?: BlobRef;
}

interface UndoRedoStepEntry {
	version: 1;
	stepId: string;
	createdAt: number;
	files: StepFileChange[];
	toolCount: number;
}

interface UndoRedoActionEntry {
	version: 1;
	actionId: string;
	kind: "undo" | "redo";
	stepId: string;
	createdAt: number;
}

interface DerivedUndoRedoState {
	stepsById: Map<string, UndoRedoStepEntry>;
	applied: string[];
	redo: string[];
	currentTargets: Map<string, BlobRef | undefined>;
}

function sameBlob(left?: BlobRef, right?: BlobRef): boolean {
	if (!left && !right) return true;
	if (!left || !right) return false;
	return left.sha256 === right.sha256;
}

function normalizeStepFiles(files: StepFileChange[]): StepFileChange[] {
	return files.filter((file) => !sameBlob(file.before, file.after));
}

function applyTargetsForStep(
	targets: Map<string, BlobRef | undefined>,
	step: UndoRedoStepEntry,
	side: "before" | "after",
): void {
	for (const file of step.files) {
		targets.set(file.path, side === "before" ? file.before : file.after);
	}
}

function deriveUndoRedoState(entries: SessionEntry[]): DerivedUndoRedoState {
	const stepsById = new Map<string, UndoRedoStepEntry>();
	const applied: string[] = [];
	const redo: string[] = [];
	const currentTargets = new Map<string, BlobRef | undefined>();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;

		if (entry.customType === STEP_ENTRY_TYPE) {
			const step = entry.data as UndoRedoStepEntry | undefined;
			if (!step || !Array.isArray(step.files) || step.files.length === 0) continue;
			stepsById.set(step.stepId, step);
			redo.length = 0;
			applied.push(step.stepId);
			applyTargetsForStep(currentTargets, step, "after");
			continue;
		}

		if (entry.customType !== ACTION_ENTRY_TYPE) continue;

		const action = entry.data as UndoRedoActionEntry | undefined;
		if (!action) continue;

		const step = stepsById.get(action.stepId);
		if (!step) continue;

		if (action.kind === "undo") {
			const lastApplied = applied[applied.length - 1];
			if (lastApplied !== action.stepId) continue;
			applied.pop();
			redo.push(action.stepId);
			applyTargetsForStep(currentTargets, step, "before");
			continue;
		}

		const lastRedo = redo[redo.length - 1];
		if (lastRedo !== action.stepId) continue;
		redo.pop();
		applied.push(action.stepId);
		applyTargetsForStep(currentTargets, step, "after");
	}

	return { stepsById, applied, redo, currentTargets };
}

function createTargetsForStep(
	step: UndoRedoStepEntry,
	side: "before" | "after",
): Map<string, BlobRef | undefined> {
	const targets = new Map<string, BlobRef | undefined>();
	applyTargetsForStep(targets, step, side);
	return targets;
}

// ────────────────────────── extension ──────────────────────────

interface RunChange {
	path: string;
	before?: BlobRef;
	after?: BlobRef;
}

interface RunAccumulator {
	changes: Map<string, RunChange>;
	toolCount: number;
}

type ValidationIssue = { path: string; reason: string };

type RestoreBackup = { path: string; content?: Buffer };

type GcState = { lastRunAt?: number };

const STATUS_WIDGET_ID = "@kmiyh/pi-undo-redo/status";
const GC_STATE_FILE = join(getAgentDir(), "pi-undo-redo", "gc-state.json");
const AUTO_GC_MAX_BLOBS = 1_000;
const AUTO_GC_MAX_BYTES = 100 * 1024 * 1024;
const AUTO_GC_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_GC_COOLDOWN_MS = 60 * 60 * 1000;
const bashRenderer = createBashToolDefinition(process.cwd());
const editRenderer = createEditToolDefinition(process.cwd());
const writeRenderer = createWriteToolDefinition(process.cwd());
const localBashOperations = createLocalBashOperations();

export default function undoRedoExtension(pi: ExtensionAPI) {
	let currentCwd = process.cwd();
	let currentRun: RunAccumulator | undefined;

	pi.registerMessageRenderer(NOTICE_MESSAGE_TYPE, (message, _options, theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("\n");
		return new Text(theme.fg("muted", `[undo/redo] ${content}`), 0, 0);
	});

	pi.registerTool({
		...bashRenderer,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const definition = createBashToolDefinition(currentCwd, {
				operations: {
					exec: async (command, cwd, options) => {
						const before = currentRun ? await snapshotWorkspace(cwd) : undefined;
						try {
							return await localBashOperations.exec(command, cwd, options);
						} finally {
							if (currentRun && before) {
								const after = await snapshotWorkspace(cwd);
								const changed = await captureSnapshotDiff(currentRun, before, after);
								if (changed > 0) currentRun.toolCount += 1;
							}
						}
					},
				},
			});
			return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...editRenderer,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const definition = createEditToolDefinition(currentCwd, {
				operations: {
					access: async (absolutePath) =>
						await access(absolutePath, constants.R_OK | constants.W_OK),
					readFile: async (absolutePath) => {
						const buffer = await readFile(absolutePath);
						await captureBefore(currentRun, absolutePath, buffer);
						return buffer;
					},
					writeFile: async (absolutePath, content) => {
						await writeFile(absolutePath, content, "utf-8");
						await captureAfter(currentRun, absolutePath, Buffer.from(content, "utf-8"));
						if (currentRun) currentRun.toolCount += 1;
					},
				},
			});
			return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...writeRenderer,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const definition = createWriteToolDefinition(currentCwd, {
				operations: {
					mkdir: async (directory) => {
						await mkdir(directory, { recursive: true });
					},
					writeFile: async (absolutePath, content) => {
						const previous = await readIfExists(absolutePath);
						if (previous) await captureBefore(currentRun, absolutePath, previous);
						await writeFile(absolutePath, content, "utf-8");
						await captureAfter(currentRun, absolutePath, Buffer.from(content, "utf-8"));
						if (currentRun) currentRun.toolCount += 1;
					},
				},
			});
			return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.registerCommand("undo", {
		description: "Revert the last agent file-change step in the current branch",
		handler: async (_args, ctx) => {
			await handleHistoryCommand("undo", ctx);
		},
	});

	pi.registerCommand("redo", {
		description: "Reapply the last undone agent file-change step in the current branch",
		handler: async (_args, ctx) => {
			await handleHistoryCommand("redo", ctx);
		},
	});

	pi.registerShortcut(Key.f8, {
		description: "Show files in the current undo/redo step",
		handler: async (ctx) => {
			await showCurrentStepModal(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		currentRun = undefined;
		await maybeRunAutomaticGc(ctx, "startup");
		await updateStatusWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setWidget(STATUS_WIDGET_ID, undefined, { placement: "aboveEditor" });
			lastStatusCounts = undefined;
		}
	});

	pi.on("agent_start", async () => {
		currentRun = { changes: new Map(), toolCount: 0 };
	});

	pi.on("agent_end", async (_event, ctx) => {
		const didRecordStep = await finalizeCurrentRunIfNeeded();
		if (didRecordStep) await maybeRunAutomaticGc(ctx, "threshold");
		await updateStatusWidget(ctx);
	});

	async function handleHistoryCommand(
		kind: "undo" | "redo",
		ctx: ExtensionCommandContext,
	): Promise<void> {
		await ctx.waitForIdle();
		await finalizeCurrentRunIfNeeded();
		const state = deriveUndoRedoState(ctx.sessionManager.getBranch());
		const stepId = kind === "undo" ? state.applied.at(-1) : state.redo.at(-1);
		if (!stepId) {
			ctx.ui.notify(kind === "undo" ? "Nothing to undo" : "Nothing to redo", "info");
			await updateStatusWidget(ctx);
			return;
		}

		const step = state.stepsById.get(stepId);
		if (!step) {
			ctx.ui.notify(`Could not find ${kind} step ${stepId}`, "error");
			await updateStatusWidget(ctx);
			return;
		}

		const applyTargets = createTargetsForStep(step, kind === "undo" ? "before" : "after");
		const restoreTargets = await mergeMoveCleanupTargets(ctx.cwd, state.currentTargets, applyTargets);

		try {
			await applyTargetsAtomically(restoreTargets);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`${kind} failed: ${message}`, "error");
			await updateStatusWidget(ctx);
			return;
		}

		const action: UndoRedoActionEntry = {
			version: 1,
			actionId: randomUUID(),
			kind,
			stepId: step.stepId,
			createdAt: Date.now(),
		};
		pi.appendEntry<UndoRedoActionEntry>(ACTION_ENTRY_TYPE, action);

		const summary = `${kind === "undo" ? "Reverted" : "Restored"} ${step.files.length} file${step.files.length === 1 ? "" : "s"}.`;
		ctx.ui.notify(summary, "info");
		pi.sendMessage(
			{
				customType: NOTICE_MESSAGE_TYPE,
				content: `User ran /${kind}: ${summary}`,
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
		await updateStatusWidget(ctx);
	}

	async function maybeRunAutomaticGc(
		ctx: ExtensionContext,
		reason: "startup" | "threshold",
	): Promise<void> {
		try {
			const state = await loadGcState();
			const now = Date.now();
			const lastRunAt = state.lastRunAt ?? 0;
			if (now - lastRunAt < AUTO_GC_COOLDOWN_MS) return;
			const stored = await listStoredBlobs();
			if (stored.length === 0) return;
			const totalBytes = stored.reduce((sum, blob) => sum + blob.size, 0);
			const thresholdExceeded = stored.length > AUTO_GC_MAX_BLOBS || totalBytes > AUTO_GC_MAX_BYTES;
			const fallbackDue = reason === "startup" && now - lastRunAt >= AUTO_GC_FALLBACK_MS;
			if (!thresholdExceeded && !fallbackDue) return;
			await runGc(ctx);
		} catch (error) {
			console.error("pi-undo-redo: automatic GC failed", error);
		}
	}

	async function showCurrentStepModal(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		await finalizeCurrentRunIfNeeded();
		const state = deriveUndoRedoState(ctx.sessionManager.getBranch());
		const summary = getCurrentStepSummary(state);
		await ctx.ui.custom<void>(
			(_tui, theme, _keybindings, done) =>
				new StepSummaryModal(theme, ctx.cwd, summary, () => done(undefined)),
			{ overlay: true, overlayOptions: { width: "80%", maxHeight: "85%", anchor: "center" } },
		);
	}

	async function finalizeCurrentRunIfNeeded(): Promise<boolean> {
		if (!currentRun) return false;

		const files = normalizeStepFiles(
			[...currentRun.changes.values()].map((change) => ({
				path: change.path,
				before: change.before,
				after: change.after,
			})),
		);
		const toolCount = currentRun.toolCount;
		currentRun = undefined;

		if (files.length === 0) return false;

		const step: UndoRedoStepEntry = {
			version: 1,
			stepId: randomUUID(),
			createdAt: Date.now(),
			files,
			toolCount,
		};
		pi.appendEntry<UndoRedoStepEntry>(STEP_ENTRY_TYPE, step);
		return true;
	}
}

async function captureBefore(
	run: RunAccumulator | undefined,
	absolutePath: string,
	buffer: Buffer,
): Promise<void> {
	const canonicalPath = await canonicalizePath(absolutePath);
	await captureBeforeForPath(run, canonicalPath, buffer);
}

async function captureBeforeForPath(
	run: RunAccumulator | undefined,
	canonicalPath: string,
	buffer: Buffer,
): Promise<void> {
	if (!run) return;
	const change = getOrCreateRunChange(run, canonicalPath);
	if (change.after && !change.before) return;
	if (!change.before) change.before = await saveBlob(buffer);
}

async function captureAfter(
	run: RunAccumulator | undefined,
	absolutePath: string,
	buffer: Buffer,
): Promise<void> {
	const canonicalPath = await canonicalizePath(absolutePath);
	await captureAfterForPath(run, canonicalPath, buffer);
}

async function captureAfterForPath(
	run: RunAccumulator | undefined,
	canonicalPath: string,
	buffer: Buffer,
): Promise<void> {
	if (!run) return;
	const change = getOrCreateRunChange(run, canonicalPath);
	change.after = await saveBlob(buffer);
}

async function captureRemoval(
	run: RunAccumulator | undefined,
	canonicalPath: string,
): Promise<void> {
	if (!run) return;
	const change = getOrCreateRunChange(run, canonicalPath);
	change.after = undefined;
}

function getOrCreateRunChange(run: RunAccumulator, canonicalPath: string): RunChange {
	let change = run.changes.get(canonicalPath);
	if (!change) {
		change = { path: canonicalPath };
		run.changes.set(canonicalPath, change);
	}
	return change;
}

async function canonicalizePath(absolutePath: string): Promise<string> {
	try {
		return await realpath(absolutePath);
	} catch {
		return resolve(absolutePath);
	}
}

async function readIfExists(path: string): Promise<Buffer | undefined> {
	try {
		return await readFile(path);
	} catch (error) {
		const errno = error as NodeJS.ErrnoException;
		if (errno.code === "ENOENT") return undefined;
		throw error;
	}
}

async function snapshotWorkspace(cwd: string): Promise<Map<string, Buffer>> {
	const snapshot = new Map<string, Buffer>();
	await collectWorkspaceFiles(resolve(cwd), snapshot);
	return snapshot;
}

async function collectWorkspaceFiles(target: string, snapshot: Map<string, Buffer>): Promise<void> {
	const s = await lstat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!s) return;
	if (s.isDirectory()) {
		const entries = await readdir(target, { withFileTypes: true });
		await Promise.all(
			entries.map((entry) => collectWorkspaceFiles(join(target, entry.name), snapshot)),
		);
		return;
	}
	if (!s.isFile()) return;
	snapshot.set(await canonicalizePath(target), await readFile(target));
}

async function captureSnapshotDiff(
	run: RunAccumulator,
	before: Map<string, Buffer>,
	after: Map<string, Buffer>,
): Promise<number> {
	let changed = 0;
	const paths = new Set([...before.keys(), ...after.keys()]);

	for (const path of paths) {
		const previous = before.get(path);
		const next = after.get(path);
		if (previous && next && previous.equals(next)) continue;
		if (previous) await captureBeforeForPath(run, path, previous);
		if (next) await captureAfterForPath(run, path, next);
		else await captureRemoval(run, path);
		changed += 1;
	}

	return changed;
}

async function mergeMoveCleanupTargets(
	cwd: string,
	currentTargets: Map<string, BlobRef | undefined>,
	applyTargets: Map<string, BlobRef | undefined>,
): Promise<Map<string, BlobRef | undefined>> {
	const merged = new Map(applyTargets);
	const cleanupTargets = await findMoveCleanupTargets(cwd, currentTargets, applyTargets);
	for (const path of cleanupTargets) if (!merged.has(path)) merged.set(path, undefined);
	return merged;
}

async function findMoveCleanupTargets(
	cwd: string,
	currentTargets: Map<string, BlobRef | undefined>,
	applyTargets: Map<string, BlobRef | undefined>,
): Promise<Set<string>> {
	const workspace = await snapshotWorkspace(cwd);
	const trackedPaths = new Set([...currentTargets.keys(), ...applyTargets.keys()]);
	const byHash = new Map<string, string[]>();

	for (const [path, buffer] of workspace) {
		if (trackedPaths.has(path)) continue;
		const hash = hashBuffer(buffer);
		const paths = byHash.get(hash);
		if (paths) paths.push(path);
		else byHash.set(hash, [path]);
	}

	const cleanup = new Set<string>();
	for (const path of trackedPaths) {
		if (workspace.has(path)) continue;
		const candidateHashes = new Set<string>();
		const currentBlob = currentTargets.get(path);
		if (currentBlob) candidateHashes.add(currentBlob.sha256);
		const applyBlob = applyTargets.get(path);
		if (applyBlob) candidateHashes.add(applyBlob.sha256);
		for (const hash of candidateHashes) {
			const matches = byHash.get(hash);
			if (matches?.length === 1) cleanup.add(matches[0]!);
		}
	}

	return cleanup;
}

async function applyTargetsAtomically(
	targets: Map<string, BlobRef | undefined>,
): Promise<void> {
	const orderedTargets = [...targets.entries()].sort(([left], [right]) => left.localeCompare(right));
	const backups = new Map<string, RestoreBackup>();
	const appliedPaths: string[] = [];

	try {
		for (const [path, target] of orderedTargets) {
			if (!backups.has(path)) backups.set(path, { path, content: await readIfExists(path) });
			await applyTarget(path, target);
			appliedPaths.push(path);
		}
	} catch (error) {
		const rollbackErrors: string[] = [];
		for (const path of appliedPaths.reverse()) {
			const backup = backups.get(path);
			if (!backup) continue;
			try {
				await restoreBackup(backup);
			} catch (rollbackError) {
				const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
				rollbackErrors.push(`${path}: ${message}`);
			}
		}
		const baseMessage = error instanceof Error ? error.message : String(error);
		if (rollbackErrors.length > 0) {
			throw new Error(`${baseMessage}. Rollback also failed for ${rollbackErrors.join(", ")}.`);
		}
		throw new Error(`${baseMessage}. Applied changes were rolled back.`);
	}
}

async function applyTarget(path: string, target: BlobRef | undefined): Promise<void> {
	await withFileMutationQueue(path, async () => {
		if (!target) {
			await removeIfExists(path);
			return;
		}
		const content = await loadBlob(target);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	});
}

async function restoreBackup(backup: RestoreBackup): Promise<void> {
	await withFileMutationQueue(backup.path, async () => {
		if (!backup.content) {
			await removeIfExists(backup.path);
			return;
		}
		await mkdir(dirname(backup.path), { recursive: true });
		await writeFile(backup.path, backup.content);
	});
}

async function removeIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		const errno = error as NodeJS.ErrnoException;
		if (errno.code !== "ENOENT") throw error;
	}
}

async function runGc(ctx: ExtensionContext): Promise<{ deleted: number; referenced: number }> {
	const referenced = await collectReferencedBlobIds(ctx);
	const stored = await listStoredBlobs();
	let deleted = 0;

	for (const blob of stored) {
		if (referenced.has(blob.sha256)) continue;
		await deleteStoredBlob(blob.sha256).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		deleted += 1;
	}

	await saveGcState({ lastRunAt: Date.now() });
	return { deleted, referenced: stored.length - deleted };
}

async function collectReferencedBlobIds(ctx: ExtensionContext): Promise<Set<string>> {
	const referenced = new Set<string>();
	const scannedPaths = new Set<string>();

	collectBlobIdsFromEntries(ctx.sessionManager.getEntries(), referenced);
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (currentSessionFile) scannedPaths.add(currentSessionFile);

	const sessions = await SessionManager.listAll();
	const uniqueSessions = sessions.filter((session) => {
		if (scannedPaths.has(session.path)) return false;
		scannedPaths.add(session.path);
		return true;
	});
	const perSessionEntries = await Promise.all(
		uniqueSessions.map((session) => {
			try {
				return SessionManager.open(session.path).getEntries();
			} catch {
				return [];
			}
		}),
	);
	for (const entries of perSessionEntries) collectBlobIdsFromEntries(entries, referenced);

	return referenced;
}

function getCurrentStepSummary(state: DerivedUndoRedoState): {
	undo?: UndoRedoStepEntry;
	redo?: UndoRedoStepEntry;
} {
	const undoStepId = state.applied.at(-1);
	const redoStepId = state.redo.at(-1);
	return {
		undo: undoStepId ? state.stepsById.get(undoStepId) : undefined,
		redo: redoStepId ? state.stepsById.get(redoStepId) : undefined,
	};
}

function classifyStepFiles(step: UndoRedoStepEntry): {
	added: string[];
	modified: string[];
	deleted: string[];
} {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const file of step.files) {
		const path = file.path;
		if (!file.before && file.after) {
			added.push(path);
			continue;
		}
		if (file.before && !file.after) {
			deleted.push(path);
			continue;
		}
		modified.push(path);
	}

	return { added, modified, deleted };
}

class StepSummaryModal {
	constructor(
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly cwd: string,
		private readonly summary: { undo?: UndoRedoStepEntry; redo?: UndoRedoStepEntry },
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.onClose();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const lines = [this.theme.fg("accent", this.theme.bold("Undo/redo files")), ""];

		if (!this.summary.undo && !this.summary.redo) {
			lines.push(this.theme.fg("dim", "No undo or redo steps are available."));
			lines.push("");
			lines.push(this.theme.fg("dim", "esc close"));
			return renderFramedPanel(this.theme, width, lines);
		}

		const separator = this.theme.fg("accent", " │ ");
		const separatorWidth = visibleWidth(separator);
		const leftWidth = Math.max(10, Math.floor((innerWidth - separatorWidth) / 2));
		const rightWidth = Math.max(10, innerWidth - separatorWidth - leftWidth);
		const leftLines = renderStepColumn(
			this.theme,
			this.cwd,
			"Current undo step",
			this.summary.undo,
			leftWidth,
		);
		const rightLines = renderStepColumn(
			this.theme,
			this.cwd,
			"Current redo step",
			this.summary.redo,
			rightWidth,
		);
		const rowCount = Math.max(leftLines.length, rightLines.length);

		for (let i = 0; i < rowCount; i += 1) {
			const left = padToWidth(leftLines[i] ?? "", leftWidth);
			const right = padToWidth(rightLines[i] ?? "", rightWidth);
			lines.push(`${left}${separator}${right}`);
		}

		lines.push("");
		lines.push(this.theme.fg("dim", "esc close"));
		return renderFramedPanel(this.theme, width, lines);
	}

	invalidate(): void {}
}

function renderStepColumn(
	theme: ExtensionContext["ui"]["theme"],
	cwd: string,
	title: string,
	step: UndoRedoStepEntry | undefined,
	width: number,
): string[] {
	const lines: string[] = [theme.fg("muted", theme.bold(title))];
	if (!step) {
		lines.push(theme.fg("dim", "No files available."));
		return lines;
	}
	const changes = classifyStepFiles(step);
	const total = step.files.length;
	lines.push(theme.fg("dim", `${total} file${total === 1 ? "" : "s"}`));
	lines.push("");
	appendSectionLines(lines, theme, "Added", changes.added, cwd, width);
	appendSectionLines(lines, theme, "Modified", changes.modified, cwd, width);
	appendSectionLines(lines, theme, "Deleted", changes.deleted, cwd, width);
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function appendSectionLines(
	lines: string[],
	theme: ExtensionContext["ui"]["theme"],
	title: string,
	paths: string[],
	cwd: string,
	width: number,
): void {
	if (paths.length === 0) return;
	lines.push(theme.fg("muted", title));
	for (const path of paths) {
		lines.push(truncateToWidth(`• ${displayPath(path, cwd)}`, width, theme.fg("dim", "...")));
	}
	lines.push("");
}

function padToWidth(text: string, width: number): string {
	return truncateToWidth(text, width, "", true);
}

function createFrameLine(
	theme: ExtensionContext["ui"]["theme"],
	line: string,
	innerWidth: number,
): string {
	const pad = Math.max(0, innerWidth - visibleWidth(line));
	return `${theme.fg("accent", "│ ")}${line}${" ".repeat(pad)}${theme.fg("accent", " │")}`;
}

function renderFramedPanel(
	theme: ExtensionContext["ui"]["theme"],
	width: number,
	lines: string[],
): string[] {
	const innerWidth = Math.max(20, width - 4);
	const ellipsis = theme.fg("dim", "...");
	const top = theme.fg("accent", `┌${"─".repeat(innerWidth + 2)}┐`);
	const bottom = theme.fg("accent", `└${"─".repeat(innerWidth + 2)}┘`);
	return [
		top,
		...lines.map((line) => createFrameLine(theme, truncateToWidth(line, innerWidth, ellipsis), innerWidth)),
		bottom,
	];
}

async function loadGcState(): Promise<GcState> {
	const raw = await readFile(GC_STATE_FILE, "utf-8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as GcState;
		return typeof parsed.lastRunAt === "number" ? { lastRunAt: parsed.lastRunAt } : {};
	} catch {
		return {};
	}
}

async function saveGcState(state: GcState): Promise<void> {
	await mkdir(dirname(GC_STATE_FILE), { recursive: true });
	await writeFile(GC_STATE_FILE, JSON.stringify(state), "utf-8");
}

function collectBlobIdsFromEntries(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
	referenced: Set<string>,
): void {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STEP_ENTRY_TYPE) continue;
		const step = entry.data as UndoRedoStepEntry | undefined;
		if (!step?.files) continue;
		for (const file of step.files) {
			if (file.before) referenced.add(file.before.sha256);
			if (file.after) referenced.add(file.after.sha256);
		}
	}
}

let lastStatusCounts: { undo: number; redo: number } | undefined;

async function updateStatusWidget(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const state = deriveUndoRedoState(ctx.sessionManager.getBranch());
	const counts = { undo: state.applied.length, redo: state.redo.length };
	if (
		lastStatusCounts &&
		lastStatusCounts.undo === counts.undo &&
		lastStatusCounts.redo === counts.redo
	) {
		return;
	}
	lastStatusCounts = counts;
	const lines = buildStatusLines(state);
	ctx.ui.setWidget(
		STATUS_WIDGET_ID,
		(_tui, theme) => new Text(lines.map((line) => theme.fg("dim", line)).join("\n"), 0, 0),
		{ placement: "aboveEditor" },
	);
}

function buildStatusLines(state: DerivedUndoRedoState): string[] {
	const undoCount = state.applied.length;
	const redoCount = state.redo.length;
	const undoLabel = `undo ${undoCount} step${undoCount === 1 ? "" : "s"} available`;
	const redoLabel = `redo ${redoCount} step${redoCount === 1 ? "" : "s"} available`;
	return [`${undoLabel} · ${redoLabel} · f8 undo/redo files`];
}

async function validateTargets(targets: Map<string, BlobRef | undefined>): Promise<ValidationIssue[]> {
	const results = await Promise.all(
		[...targets].map(async ([path, expected]): Promise<ValidationIssue | undefined> => {
			const current = await readIfExists(path);
			if (!expected && !current) return undefined;
			if (!expected && current) return { path, reason: "file exists but should be absent" };
			if (expected && !current) return { path, reason: "file is missing" };
			if (expected && current) {
				if (current.byteLength !== expected.size || hashBuffer(current) !== expected.sha256) {
					return { path, reason: "file contents differ from the expected branch state" };
				}
			}
			return undefined;
		}),
	);
	return results.filter((r): r is ValidationIssue => r !== undefined);
}

function _formatValidationIssues(kind: "undo" | "redo", issues: ValidationIssue[], cwd: string): string {
	const heading = kind === "undo"
		? "Cannot undo because the workspace does not match the current branch state."
		: "Cannot redo because the workspace does not match the current branch state.";
	const details = issues
		.slice(0, 5)
		.map((issue) => `• ${displayPath(issue.path, cwd)} — ${issue.reason}`)
		.join("\n");
	const suffix = issues.length > 5 ? `\n…and ${issues.length - 5} more.` : "";
	return `${heading}\n${details}${suffix}`;
}

// NOTE: handleSyncCommand + maybeOfferBranchSync exist in the original but were
// never wired up. Kept here (unused) to preserve original code; validateTargets
// is their only consumer. Delete in a follow-up if undesired.
async function _handleSyncCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	finalizeCurrentRunIfNeeded: () => Promise<boolean>,
): Promise<void> {
	await ctx.waitForIdle();
	await finalizeCurrentRunIfNeeded();
	const state = deriveUndoRedoState(ctx.sessionManager.getBranch());
	const issues = await validateTargets(state.currentTargets);
	if (issues.length === 0) {
		ctx.ui.notify("Workspace is already aligned with the current branch.", "info");
		return;
	}
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			"Sync workspace to branch?",
			`This will rewrite ${state.currentTargets.size} tracked file${state.currentTargets.size === 1 ? "" : "s"} to match the current branch state.`,
		);
		if (!ok) return;
	}
	const restoreTargets = await mergeMoveCleanupTargets(ctx.cwd, state.currentTargets, state.currentTargets);
	try {
		await applyTargetsAtomically(restoreTargets);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`undo-sync failed: ${message}`, "error");
		return;
	}
	const summary = `Synchronized ${state.currentTargets.size} tracked file${state.currentTargets.size === 1 ? "" : "s"} to the current branch.`;
	ctx.ui.notify(summary, "info");
	pi.sendMessage(
		{ customType: NOTICE_MESSAGE_TYPE, content: `User ran /undo-sync: ${summary}`, display: true },
		{ deliverAs: "nextTurn" },
	);
}

async function _maybeOfferBranchSync(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	finalizeCurrentRunIfNeeded: () => Promise<boolean>,
): Promise<void> {
	await finalizeCurrentRunIfNeeded();
	const state = deriveUndoRedoState(ctx.sessionManager.getBranch());
	const issues = await validateTargets(state.currentTargets);
	if (issues.length === 0) return;
	if (!ctx.hasUI || state.currentTargets.size === 0) {
		ctx.ui.notify("Undo/redo history switched to the current branch. Workspace was not auto-synced.", "info");
		return;
	}
	const ok = await ctx.ui.confirm(
		"Sync workspace to this branch?",
		`The current branch tracks ${state.currentTargets.size} file${state.currentTargets.size === 1 ? "" : "s"}, and ${issues.length} tracked file${issues.length === 1 ? " is" : "s are"} out of sync. Sync tracked files now?`,
	);
	if (!ok) {
		ctx.ui.notify("Switched branch without syncing tracked workspace files.", "info");
		return;
	}
	const restoreTargets = await mergeMoveCleanupTargets(ctx.cwd, state.currentTargets, state.currentTargets);
	try {
		await applyTargetsAtomically(restoreTargets);
		const summary = `Synchronized ${state.currentTargets.size} tracked file${state.currentTargets.size === 1 ? "" : "s"} after switching branches.`;
		ctx.ui.notify(summary, "info");
		pi.sendMessage(
			{ customType: NOTICE_MESSAGE_TYPE, content: `Automatic branch sync applied: ${summary}`, display: true },
			{ deliverAs: "nextTurn" },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Branch sync failed: ${message}`, "error");
	}
}

function displayPath(path: string, cwd: string): string {
	const relativePath = relative(cwd, path);
	if (!relativePath || relativePath.startsWith("..")) return path;
	return relativePath;
}
