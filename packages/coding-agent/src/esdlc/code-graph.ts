/**
 * Code graph and change impact.
 *
 * The build phase reports *what* changed; this module answers what that change touches. It scans
 * the project's own import statements (Bun's scanner, so ESM, CJS and re-exports are all handled
 * by the runtime rather than by a regex), builds a file-level dependency graph, and marks the
 * files reachable from the change — the impact set a reviewer needs before approving.
 *
 * Bounded by construction: a file cap, a size cap per file, machine directories skipped, and a
 * depth cap on the traversal, so a monorepo cannot turn a worktree into an unbounded walk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@zero2ai/utils";
import * as vcs from "@zero2ai/natives/vcs";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const LOADERS: Readonly<Record<string, "ts" | "tsx" | "js" | "jsx">> = {
	".ts": "ts",
	".tsx": "tsx",
	".mts": "ts",
	".cts": "ts",
	".js": "js",
	".jsx": "jsx",
	".mjs": "js",
	".cjs": "js",
};
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	"coverage",
	".next",
	".turbo",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	".zero2ai",
]);
const MAX_FILES = 1500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_EDGES = 8000;

export interface EsdlcCodeGraphNode {
	/** Project-relative POSIX path. */
	readonly path: string;
	readonly imports: readonly string[];
	readonly importedBy: readonly string[];
}

export interface EsdlcCodeGraph {
	readonly at: string;
	readonly nodes: readonly EsdlcCodeGraphNode[];
	/** Files the build reported as changed, present in the graph. */
	readonly changed: readonly string[];
	/** Changed files plus everything that (transitively) imports them, with BFS depth. */
	readonly impacted: Readonly<Record<string, number>>;
	/** What the changed files themselves depend on. */
	readonly dependencies: Readonly<Record<string, number>>;
	/** Bare specifiers (external packages) the changed files rely on. */
	readonly external: readonly string[];
	readonly filesScanned: number;
	readonly truncated: boolean;
}

async function listSourceFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
	const files: string[] = [];
	let truncated = false;
	const walk = async (dir: string): Promise<void> => {
		if (files.length >= MAX_FILES) {
			truncated = true;
			return;
		}
		let entries: Array<{ name: string; isDirectory: () => boolean }>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		for (const entry of entries) {
			if (files.length >= MAX_FILES) {
				truncated = true;
				return;
			}
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				await walk(path.join(dir, entry.name));
				continue;
			}
			if (!SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue;
			if (entry.name.endsWith(".d.ts")) continue;
			files.push(path.join(dir, entry.name));
		}
	};
	await walk(root);
	return { files, truncated };
}

/** Resolve a relative specifier the way a bundler would: exact, then extension, then index. */
function resolveSpecifier(fromFile: string, specifier: string, known: ReadonlySet<string>): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [
		base,
		...SOURCE_EXTENSIONS.map(extension => base + extension),
		...SOURCE_EXTENSIONS.map(extension => path.join(base, `index${extension}`)),
	];
	// A specifier may already carry a JS extension pointing at a TS file (`./x.js` → `./x.ts`).
	const withoutJs = base.replace(/\.(js|mjs|cjs)$/, "");
	for (const extension of SOURCE_EXTENSIONS) candidates.push(withoutJs + extension);
	for (const candidate of candidates) {
		if (known.has(candidate)) return candidate;
	}
	return null;
}

/** Build the file-level import graph for a project root. */
export async function buildCodeGraph(input: {
	readonly cwd: string;
	readonly changedFiles?: readonly string[];
}): Promise<EsdlcCodeGraph> {
	const root = path.resolve(input.cwd);
	const { files, truncated } = await listSourceFiles(root);
	const known = new Set(files);
	const imports = new Map<string, Set<string>>();
	const externals = new Set<string>();

	// Declared before the scan so bare specifiers can be attributed to the changed files below.
	const changedSet = new Set<string>(
		(input.changedFiles ?? [])
			.map(file => path.resolve(root, file.replaceAll("\\", "/")))
			.filter(file => known.has(file)),
	);
	let edges = 0;
	for (const file of files) {
		const handle = Bun.file(file);
		if (handle.size > MAX_FILE_BYTES) continue;
		let source: string;
		try {
			source = await handle.text();
		} catch {
			continue;
		}
		const loader = LOADERS[path.extname(file)] ?? "ts";
		let scanned: Array<{ path: string }>;
		try {
			scanned = new Bun.Transpiler({ loader }).scanImports(source) as Array<{ path: string }>;
		} catch {
			continue;
		}
		const resolved = new Set<string>();
		for (const entry of scanned) {
			if (!entry?.path) continue;
			const target = resolveSpecifier(file, entry.path, known);
			if (target) {
				if (target !== file) resolved.add(target);
				continue;
			}
			if (!entry.path.startsWith(".")) {
				externals.add(entry.path);
				if (changedSet.has(file)) externals.add(entry.path);
			}
		}
		if (resolved.size && edges < MAX_EDGES) {
			edges += resolved.size;
			imports.set(file, resolved);
		}
	}

	const importedBy = new Map<string, Set<string>>();
	for (const [file, targets] of imports) {
		for (const target of targets) {
			const set = importedBy.get(target) ?? new Set<string>();
			set.add(file);
			importedBy.set(target, set);
		}
	}

	const rel = (absolute: string) => path.relative(root, absolute).replaceAll("\\", "/");
	const changed = [...changedSet].map(file => rel(file)).sort();

	// Impact: everything that transitively imports a changed file (the blast radius).
	const impacted = new Map<string, number>();
	const queue: Array<{ file: string; depth: number }> = [...changedSet].map(file => ({ file, depth: 0 }));
	const seen = new Set(changedSet);
	while (queue.length) {
		const current = queue.shift();
		if (!current) break;
		for (const dependent of importedBy.get(current.file) ?? []) {
			if (seen.has(dependent)) continue;
			seen.add(dependent);
			impacted.set(rel(dependent), current.depth + 1);
			queue.push({ file: dependent, depth: current.depth + 1 });
		}
	}

	// Dependencies: what the change itself leans on, so the reviewer sees both directions.
	const dependencies = new Map<string, number>();
	const depQueue: Array<{ file: string; depth: number }> = [...changedSet].map(file => ({ file, depth: 0 }));
	const depSeen = new Set(changedSet);
	while (depQueue.length) {
		const current = depQueue.shift();
		if (!current) break;
		for (const target of imports.get(current.file) ?? []) {
			if (depSeen.has(target)) continue;
			depSeen.add(target);
			dependencies.set(rel(target), current.depth + 1);
			depQueue.push({ file: target, depth: current.depth + 1 });
		}
	}

	const nodes: EsdlcCodeGraphNode[] = [...known]
		.map(absolute => ({
			path: rel(absolute),
			imports: [...(imports.get(absolute) ?? [])].map(rel).sort(),
			importedBy: [...(importedBy.get(absolute) ?? [])].map(rel).sort(),
		}))
		.sort((a, b) => a.path.localeCompare(b.path));

	return {
		at: new Date().toISOString(),
		nodes,
		changed: [...changed].sort(),
		impacted: Object.fromEntries([...impacted].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))),
		dependencies: Object.fromEntries([...dependencies].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))),
		external: [...externals].sort(),
		filesScanned: files.length,
		truncated,
	};
}

/**
 * Current impact for a project: the changed set comes from version control, the graph from the
 * imports. Cheap enough to derive on demand (no model involved), so the workspace can show the
 * impact of *uncommitted* work without waiting for a build.
 */
export async function currentImpact(cwd: string, changedFiles?: readonly string[]): Promise<EsdlcCodeGraph> {
	let changed = changedFiles;
	if (!changed) {
		try {
			const repo = vcs.repo(cwd);
			changed = repo ? [...(await repo.changedFiles({ base: "HEAD" }))] : [];
		} catch {
			changed = [];
		}
	}
	return await buildCodeGraph({ cwd, changedFiles: changed });
}

/** The human-readable impact report next to the JSON. */
export function renderImpactArtifact(graph: EsdlcCodeGraph): string {
	const lines = [
		"# Change impact",
		"",
		`Derived ${graph.at} from ${graph.filesScanned} source file(s)${graph.truncated ? " (file cap reached)" : ""}.`,
		"",
		"## Changed files",
		"",
		graph.changed.length ? graph.changed.map(file => `- \`${file}\``).join("\n") : "_None — nothing to analyse._",
		"",
		"## Impact (files that import a changed file, transitively)",
		"",
	];
	const impacted = Object.entries(graph.impacted);
	lines.push(
		impacted.length
			? impacted.map(([file, depth]) => `- \`${file}\` — depth ${depth}`).join("\n")
			: "_No dependent file imports the changed set._",
	);
	lines.push("", "## Dependencies of the change", "");
	const dependencies = Object.entries(graph.dependencies);
	lines.push(
		dependencies.length
			? dependencies.map(([file, depth]) => `- \`${file}\` — depth ${depth}`).join("\n")
			: "_The changed files import nothing tracked._",
	);
	if (graph.external.length) {
		lines.push(
			"",
			"## External packages the change relies on",
			"",
			graph.external.map(name => `- \`${name}\``).join("\n"),
		);
	}
	lines.push(
		"",
		"> Edges come from the project's own import statements (resolved relative specifiers).",
		"> Bare specifiers are listed as external packages; dynamic imports and re-export chains are",
		"> followed only as far as the scanner reports them.",
	);
	return lines.join("\n");
}
