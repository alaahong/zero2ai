/**
 * ESDLC workspace persistence.
 *
 * Layout (all under the project, so a workspace travels with the repository):
 *   <project>/.zero2ai/esdlc/state.json      run history, one entry per phase
 *   <project>/.zero2ai/esdlc/<phase>/…       artifacts written by that phase
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@zero2ai/utils";
import {
	ESDLC_PHASES,
	type EsdlcCallRecord,
	type EsdlcPhaseId,
	type EsdlcPhaseRun,
	type EsdlcState,
	emptyPhaseRun,
} from "./types";

export const ESDLC_DIR_NAME = path.join(".zero2ai", "esdlc");

export function esdlcDir(projectRoot: string): string {
	return path.join(projectRoot, ESDLC_DIR_NAME);
}

export function phaseDir(projectRoot: string, phase: EsdlcPhaseId): string {
	return path.join(esdlcDir(projectRoot), phase);
}

function statePath(projectRoot: string): string {
	return path.join(esdlcDir(projectRoot), "state.json");
}

function eventsPath(projectRoot: string, phase: EsdlcPhaseId): string {
	return path.join(phaseDir(projectRoot, phase), "events.jsonl");
}

function emptyState(projectRoot: string, now: string): EsdlcState {
	const phases = Object.fromEntries(ESDLC_PHASES.map(phase => [phase, emptyPhaseRun()])) as Record<
		EsdlcPhaseId,
		EsdlcPhaseRun
	>;
	return { version: 1, projectRoot, createdAt: now, updatedAt: now, phases, notes: "", locale: "" };
}

/** Read the workspace, or an empty one when the project has never been run. */
export async function readEsdlcState(projectRoot: string): Promise<EsdlcState> {
	try {
		const parsed = (await Bun.file(statePath(projectRoot)).json()) as EsdlcState;
		// Defensive: a state file written by an older/newer shape must not crash the UI.
		const phases = { ...emptyState(projectRoot, parsed.createdAt ?? new Date().toISOString()).phases };
		for (const phase of ESDLC_PHASES) {
			phases[phase] = { ...emptyPhaseRun(), ...parsed.phases?.[phase] };
		}
		return {
			...parsed,
			projectRoot,
			phases,
			notes: typeof parsed.notes === "string" ? parsed.notes : "",
			locale: typeof parsed.locale === "string" ? parsed.locale : "",
		};
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return emptyState(projectRoot, new Date().toISOString());
	}
}

export async function writeEsdlcState(state: EsdlcState): Promise<void> {
	const file = statePath(state.projectRoot);
	await fs.mkdir(path.dirname(file), { recursive: true });
	// `projectRoot` is derived from where this file lives, so writing it would only record the
	// operator's machine layout in a file that gets committed. Readers restore it on load.
	await Bun.write(file, `${JSON.stringify({ ...state, projectRoot: "" }, null, 2)}\n`);
}

/** Record a phase transition, preserving everything the other phases recorded. */
export async function recordPhaseRun(
	projectRoot: string,
	phase: EsdlcPhaseId,
	run: EsdlcPhaseRun,
): Promise<EsdlcState> {
	const state = await readEsdlcState(projectRoot);
	const next: EsdlcState = {
		...state,
		updatedAt: new Date().toISOString(),
		phases: { ...state.phases, [phase]: run },
	};
	await writeEsdlcState(next);
	return next;
}

/** Workspace-level 补充说明, injected into every model prompt. */
export async function writeWorkspaceNotes(projectRoot: string, notes: string): Promise<EsdlcState> {
	return await updateWorkspace(projectRoot, { notes });
}

/** Persist the interface language chosen in the workspace. */
export async function writeWorkspaceLocale(projectRoot: string, locale: string): Promise<EsdlcState> {
	return await updateWorkspace(projectRoot, { locale });
}

/** Apply a workspace-level setting and persist it. */
async function updateWorkspace(projectRoot: string, patch: { notes?: string; locale?: string }): Promise<EsdlcState> {
	const state = await readEsdlcState(projectRoot);
	const next: EsdlcState = { ...state, ...patch, updatedAt: new Date().toISOString() };
	await writeEsdlcState(next);
	return next;
}

export async function appendPhaseEvent(projectRoot: string, record: EsdlcCallRecord): Promise<void> {
	const file = eventsPath(projectRoot, record.phase);
	await fs.mkdir(path.dirname(file), { recursive: true });
	try {
		const existing = await Bun.file(file).text();
		await Bun.write(file, `${existing}${JSON.stringify(record)}\n`);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		await Bun.write(file, `${JSON.stringify(record)}\n`);
	}
}

/** One model call's transcripts, so the execution trail shows the actual work. */
export async function writeCallTranscript(
	projectRoot: string,
	phase: EsdlcPhaseId,
	kind: string,
	call: {
		readonly systemPrompt: string;
		readonly userPrompt: string;
		readonly text: string;
		readonly thinking?: string;
		readonly error?: string;
	},
): Promise<{ promptPath: string; thinkingPath?: string; responsePath: string }> {
	const dir = path.join(phaseDir(projectRoot, phase), "calls");
	await fs.mkdir(dir, { recursive: true });
	const seq = String((await readPhaseEvents(projectRoot, phase)).length + 1).padStart(2, "0");
	const stem = `${seq}-${kind.replace(/[^\w.-]+/g, "-")}`;
	const write = async (name: string, body: string) => {
		const file = path.join(dir, name);
		await Bun.write(file, body.endsWith("\n") ? body : `${body}\n`);
		return path.relative(projectRoot, file).replaceAll("\\", "/");
	};
	const promptPath = await write(
		`${stem}.prompt.md`,
		`# 提示词 · ${kind}\n\n## system\n\n${call.systemPrompt.trim() || "(none)"}\n\n## user\n\n${call.userPrompt}`,
	);
	const responsePath = await write(
		`${stem}.response.md`,
		call.error ? `# 调用失败 · ${kind}\n\n${call.error}` : `# 输出 · ${kind}\n\n${call.text}`,
	);
	const thinkingPath = call.thinking
		? await write(`${stem}.thinking.md`, `# 思考过程 · ${kind}\n\n${call.thinking}`)
		: undefined;
	return { promptPath, responsePath, ...(thinkingPath ? { thinkingPath } : {}) };
}

export async function readPhaseEvents(projectRoot: string, phase: EsdlcPhaseId): Promise<EsdlcCallRecord[]> {
	try {
		const text = await Bun.file(eventsPath(projectRoot, phase)).text();
		return text
			.split("\n")
			.filter(Boolean)
			.flatMap(line => {
				try {
					return [JSON.parse(line) as EsdlcCallRecord];
				} catch {
					return [];
				}
			});
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return [];
	}
}

/** A project entry in the workspace file tree. */
export interface EsdlcTreeNode {
	readonly name: string;
	/** Project-relative POSIX path. */
	readonly path: string;
	readonly directory: boolean;
	readonly bytes?: number;
	/** Written by an ESDLC phase (inside the workspace directory). */
	readonly artifact: boolean;
	/** Reported as changed by the latest build phase. */
	readonly changed: boolean;
	/** A directory listing that hit the entry cap; the UI says so rather than lying by omission. */
	readonly truncated?: boolean;
	readonly children?: readonly EsdlcTreeNode[];
}

/** Directories whose contents are machine-managed: walking them buries the review surface. */
const TREE_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"out",
	"build",
	"target",
	"vendor",
	"coverage",
	".next",
	".turbo",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
]);

/** Guard rails: a monorepo must not turn one page load into an unbounded walk. */
const TREE_MAX_DEPTH = 8;
const TREE_MAX_ENTRIES_PER_DIR = 300;

/**
 * The project as a nested file tree, with ESDLC artifacts and the build phase's changed files
 * flagged — the artifact tree alone would hide the code a build actually wrote.
 */
export async function readProjectTree(projectRoot: string): Promise<EsdlcTreeNode> {
	const workspace = path.relative(projectRoot, esdlcDir(projectRoot)).replaceAll("\\", "/");
	const changed = new Set(await readChangedFiles(projectRoot));
	const isArtifact = (rel: string) => rel === workspace || rel.startsWith(`${workspace}/`);

	async function walk(dir: string, rel: string, depth: number): Promise<EsdlcTreeNode[]> {
		let entries: Array<{ name: string; isDirectory: () => boolean }>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		const visible = entries
			.filter(entry => !(entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)))
			.filter(entry => entry.name !== ".DS_Store")
			.sort((a, b) =>
				a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
			);
		const nodes: EsdlcTreeNode[] = [];
		for (const entry of visible.slice(0, TREE_MAX_ENTRIES_PER_DIR)) {
			const full = path.join(dir, entry.name);
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				const children = depth >= TREE_MAX_DEPTH ? [] : await walk(full, childRel, depth + 1);
				nodes.push({
					name: entry.name,
					path: childRel,
					directory: true,
					artifact: isArtifact(childRel),
					changed: changed.has(childRel),
					children,
				});
				continue;
			}
			let bytes: number | undefined;
			try {
				bytes = (await fs.stat(full)).size;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			nodes.push({
				name: entry.name,
				path: childRel,
				directory: false,
				artifact: isArtifact(childRel),
				changed: changed.has(childRel),
				...(bytes === undefined ? {} : { bytes }),
			});
		}
		if (visible.length > TREE_MAX_ENTRIES_PER_DIR) {
			nodes.push({
				name: `… ${visible.length - TREE_MAX_ENTRIES_PER_DIR} more`,
				path: rel,
				directory: false,
				artifact: false,
				changed: false,
				truncated: true,
			});
		}
		return nodes;
	}

	return {
		name: path.basename(projectRoot) || projectRoot,
		path: "",
		directory: true,
		artifact: false,
		changed: false,
		children: await walk(projectRoot, "", 0),
	};
}

/** Files the latest build phase reported as changed; empty outside a build. */
export async function readChangedFiles(projectRoot: string): Promise<string[]> {
	try {
		const text = await Bun.file(path.join(phaseDir(projectRoot, "build"), "changed-files.txt")).text();
		return text
			.split("\n")
			.map(line => line.trim().replaceAll("\\", "/"))
			.filter(Boolean);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}
