/**
 * Specification & skill sources for the analysis phases.
 *
 * An operator points the workspace at the standards that govern their documents — a company
 * spec page, an internal template repository, or a skill directory checked into the project —
 * and the analysis prompts are generated against them instead of the model's imagination.
 *
 * Two rules shape this module:
 *   - Provenance is part of the output. Every document records where it came from, how big it
 *     was and whether it was truncated, because a BRD that cites a spec must cite a real one.
 *   - Bounded by construction: each source has a fetch/read timeout and a byte cap, the total
 *     injected into a prompt is capped, and local paths cannot escape the project.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@zero2ai/utils";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_SOURCE_BYTES = 256 * 1024;
/** Total characters folded into one prompt; the rest is reported as truncated, never dropped silently. */
const MAX_TOTAL_CHARS = 40_000;
const MAX_SOURCES = 20;

export interface EsdlcLoadedSource {
	readonly source: string;
	readonly kind: "url" | "file";
	readonly bytes: number;
	readonly chars: number;
	readonly truncated: boolean;
	readonly text: string;
}

export interface EsdlcSkippedSource {
	readonly source: string;
	readonly reason: string;
}

export interface EsdlcSpecBundle {
	readonly loaded: readonly EsdlcLoadedSource[];
	readonly skipped: readonly EsdlcSkippedSource[];
}

function isHttpUrl(source: string): boolean {
	return /^https?:\/\//i.test(source);
}

/** HTML fetched from an internal wiki is still spec text; strip tags rather than injecting noise. */
function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Local sources resolve inside the project: a spec path must not become a file-read primitive. */
function resolveLocal(projectRoot: string, source: string): string {
	const root = path.resolve(projectRoot);
	const resolved = path.resolve(root, source);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw new Error(`spec source escapes the project directory: ${source}`);
	}
	return resolved;
}

/**
 * Load every configured source.
 *
 * A source that fails is reported as skipped with its reason instead of failing the phase: one
 * unreachable wiki page must not block a document that other sources can still ground.
 */
export async function loadSpecSources(input: {
	readonly projectRoot: string;
	readonly sources: readonly string[];
	readonly signal?: AbortSignal;
}): Promise<EsdlcSpecBundle> {
	const loaded: EsdlcLoadedSource[] = [];
	const skipped: EsdlcSkippedSource[] = [];
	let budget = MAX_TOTAL_CHARS;

	for (const raw of input.sources.slice(0, MAX_SOURCES)) {
		const source = raw.trim();
		if (!source) continue;
		if (budget <= 0) {
			skipped.push({ source, reason: "prompt budget exhausted by earlier sources" });
			continue;
		}
		try {
			const entry = isHttpUrl(source)
				? await loadUrl(source, input.signal)
				: await loadFile(input.projectRoot, source);
			const room = Math.max(0, budget);
			const truncated = entry.text.length > room;
			const text = truncated ? entry.text.slice(0, room) : entry.text;
			budget -= text.length;
			loaded.push({ ...entry, text, truncated, chars: text.length });
		} catch (error) {
			skipped.push({ source, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { loaded, skipped };
}

async function loadUrl(source: string, signal?: AbortSignal): Promise<Omit<EsdlcLoadedSource, "truncated">> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(source, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	const contentType = response.headers.get("content-type") ?? "";
	const raw = await response.text();
	if (raw.length > MAX_SOURCE_BYTES) throw new Error(`source larger than ${MAX_SOURCE_BYTES} bytes`);
	const text = /html/i.test(contentType) ? htmlToText(raw) : raw.trim();
	if (!text) throw new Error("source returned no text");
	return { source, kind: "url", bytes: Buffer.byteLength(raw, "utf8"), chars: text.length, text };
}

async function loadFile(projectRoot: string, source: string): Promise<Omit<EsdlcLoadedSource, "truncated">> {
	const resolved = resolveLocal(projectRoot, source);
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(resolved);
	} catch (error) {
		if (isEnoent(error)) throw new Error("path does not exist");
		throw error;
	}
	// A directory is a useful thing to point at (a skill folder): read its text files, in order.
	if (stat.isDirectory()) {
		const names = (await fs.readdir(resolved)).filter(name => /\.(md|markdown|txt|json|ya?ml)$/i.test(name)).sort();
		if (!names.length) throw new Error("directory holds no readable text files");
		const parts: string[] = [];
		for (const name of names.slice(0, 40)) {
			const file = Bun.file(path.join(resolved, name));
			parts.push(`### ${name}\n\n${(await file.text()).trim()}`);
		}
		const text = parts.join("\n\n");
		return { source, kind: "file", bytes: Buffer.byteLength(text, "utf8"), chars: text.length, text };
	}
	if (stat.size > MAX_SOURCE_BYTES) throw new Error(`source larger than ${MAX_SOURCE_BYTES} bytes`);
	const text = (await Bun.file(resolved).text()).trim();
	if (!text) throw new Error("source is empty");
	return { source, kind: "file", bytes: stat.size, chars: text.length, text };
}

/** Render the bundle for a prompt: provenance first, then the text. */
export function renderSpecsForPrompt(bundle: EsdlcSpecBundle): string {
	if (!bundle.loaded.length) return "";
	const parts = bundle.loaded.map(
		entry =>
			`### ${entry.source} (${entry.kind}, ${entry.bytes} bytes${entry.truncated ? ", truncated" : ""})\n\n${entry.text}`,
	);
	if (bundle.skipped.length) {
		parts.push(`### Not loaded\n\n${bundle.skipped.map(entry => `- ${entry.source}: ${entry.reason}`).join("\n")}`);
	}
	return parts.join("\n\n---\n\n");
}

/** The audit record written next to the phase, so a reader can check what grounded the document. */
export function renderSpecsArtifact(bundle: EsdlcSpecBundle): string {
	const lines = ["# Specs & skill sources", ""];
	if (!bundle.loaded.length && !bundle.skipped.length) {
		lines.push("_No spec sources configured._", "", "Set them in the workspace (analysis tab) or pass `--spec`.");
	}
	for (const entry of bundle.loaded) {
		lines.push(
			`- **${entry.source}** — ${entry.kind}, ${entry.bytes} bytes, ${entry.chars} chars used${entry.truncated ? " (truncated)" : ""}`,
		);
	}
	for (const entry of bundle.skipped) {
		lines.push(`- ~~${entry.source}~~ — skipped: ${entry.reason}`);
	}
	if (bundle.loaded.length) {
		lines.push("", "## Content", "");
		for (const entry of bundle.loaded) {
			lines.push(`### ${entry.source}`, "", entry.text, "");
		}
	}
	return lines.join("\n");
}
