/**
 * ESDLC phase implementations.
 *
 * Every phase is a plain function: it reads what earlier phases produced, does
 * one job, writes artifacts under `.zero2ai/esdlc/<phase>/`, and returns a
 * one-line summary. Failures throw — the runner records them as `failed` and
 * never touches the artifacts of other phases.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@zero2ai/natives/vcs";
import { asRecord, isEnoent, prompt } from "@zero2ai/utils";
import { type EsdlcCallSummary, generateText } from "./llm";
import { transcribeRecording } from "./audio";
import { phaseDir } from "./state";
import type { EsdlcArtifact, EsdlcPhaseId } from "./types";

import systemAnalyst from "./prompts/system-analyst.md" with { type: "text" };
import systemEngineer from "./prompts/system-engineer.md" with { type: "text" };
import brdUser from "./prompts/brd.user.md" with { type: "text" };
import fsdUser from "./prompts/fsd.user.md" with { type: "text" };
import testUser from "./prompts/test.user.md" with { type: "text" };
import deployUser from "./prompts/deploy.user.md" with { type: "text" };
import releaseUser from "./prompts/release.user.md" with { type: "text" };

const MAX_CAPTURED_OUTPUT_CHARS = 40_000;
const ARTIFACT_INPUTS = ["transcript.md", "notes.md"] as const;

/** What one phase hands the runner after a model call: metrics plus the content itself. */
export type EsdlcPhaseEvent = EsdlcCallSummary & { readonly kind: string };

/** Below this many characters the requirements material cannot support a BRD. */
const CLARIFICATION_THRESHOLD_CHARS = 400;

export interface EsdlcRunOptions {
	readonly cwd: string;
	/** Recording or transcript handed to the requirements phase. */
	readonly input?: string;
	/** Free-form instruction (requirements notes, build instruction). */
	readonly prompt?: string;
	readonly model?: string;
	/** Test phase: command override. */
	readonly command?: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (message: string) => void;
	/** Workspace 补充说明, injected into every model prompt. */
	readonly notes?: string;
	/** Ask the human a question and wait for the answer. */
	readonly requestInput?: (question: string) => Promise<string>;
	/** Execution trail: one record per model call, awaited so transcripts land in order. */
	readonly onEvent?: (record: EsdlcPhaseEvent) => void | Promise<void>;
}

export interface EsdlcPhaseOutcome {
	readonly summary: string;
	readonly artifacts: readonly EsdlcArtifact[];
}

async function writeArtifact(
	projectRoot: string,
	phase: EsdlcPhaseId,
	name: string,
	body: string,
): Promise<EsdlcArtifact> {
	const dir = phaseDir(projectRoot, phase);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, name), body.endsWith("\n") ? body : `${body}\n`);
	return { label: name, path: path.relative(projectRoot, path.join(dir, name)).replaceAll("\\", "/") };
}

async function readArtifacts(projectRoot: string, phase: EsdlcPhaseId, names: readonly string[]): Promise<string> {
	const dir = phaseDir(projectRoot, phase);
	const parts: string[] = [];
	for (const name of names) {
		try {
			const text = await Bun.file(path.join(dir, name)).text();
			if (text.trim()) parts.push(text.trim());
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return parts.join("\n\n");
}

interface CommandResult {
	readonly output: string;
	readonly exitCode: number;
	readonly durationMs: number;
}

async function runCommand(cwd: string, argv: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
	const started = Date.now();
	const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe", ...(signal ? { signal } : {}) });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout as ReadableStream).text(),
		new Response(child.stderr as ReadableStream).text(),
		child.exited,
	]);
	const combined = [stdout, stderr]
		.filter(part => part.trim())
		.join("\n")
		.trim();
	return {
		output:
			combined.length > MAX_CAPTURED_OUTPUT_CHARS
				? `${combined.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n… (truncated)`
				: combined,
		exitCode,
		durationMs: Date.now() - started,
	};
}

/** Worktree diff against HEAD, or an empty string outside a repository. */
async function worktreeDiff(cwd: string): Promise<{ patch: string; files: readonly string[] }> {
	try {
		const repo = vcs.repo(cwd);
		if (!repo) return { patch: "", files: [] };
		const [patch, files] = await Promise.all([repo.diffText({ base: "HEAD" }), repo.changedFiles({ base: "HEAD" })]);
		return { patch, files };
	} catch {
		return { patch: "", files: [] };
	}
}

async function collectRepoFacts(cwd: string): Promise<string> {
	const parts: string[] = [];
	const packageJson = Bun.file(path.join(cwd, "package.json"));
	if (await packageJson.exists()) {
		const parsed = asRecord(await packageJson.json()) ?? {};
		parts.push(
			`package.json: name=${String(parsed.name ?? "?")} version=${String(parsed.version ?? "?")}\n` +
				`scripts: ${Object.keys(asRecord(parsed.scripts) ?? {}).join(", ") || "(none)"}\n` +
				`bin: ${Object.keys(asRecord(parsed.bin) ?? {}).join(", ") || "(none)"}\n` +
				`engines: ${JSON.stringify(parsed.engines ?? {})}`,
		);
	}
	for (const candidate of ["Dockerfile", "docker-compose.yml", "compose.yml", "Cargo.toml"]) {
		const file = Bun.file(path.join(cwd, candidate));
		if (await file.exists()) parts.push(`${candidate}: present (${Math.round(file.size / 1024)} KiB)`);
	}
	for (const dir of ["infra", ".github/workflows", "deploy", "k8s"]) {
		try {
			const entries = await fs.readdir(path.join(cwd, dir));
			parts.push(`${dir}/: ${entries.slice(0, 20).join(", ")}`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return parts.join("\n\n") || "(no repository facts found)";
}

/**
 * Every document phase goes through here: the workspace notes are appended to
 * the prompt (they are operator context, not part of the source material) and
 * each call is recorded for the execution trail.
 */
async function callModel(
	options: EsdlcRunOptions,
	kind: string,
	request: { systemPrompt: string; userPrompt: string; maxTokens?: number },
): Promise<{ text: string; model: string }> {
	const notes = options.notes?.trim();
	const userPrompt = notes
		? `${request.userPrompt}\n\n---\n工作区补充说明（来自使用者，视为需求约束）：\n${notes}`
		: request.userPrompt;
	const result = await generateText({
		cwd: options.cwd,
		systemPrompt: request.systemPrompt,
		userPrompt,
		...(options.model ? { model: options.model } : {}),
		...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		onCall: async summary => {
			await options.onEvent?.({ kind, ...summary });
		},
	});
	return result;
}

/** 1) Requirements — capture a discussion and turn it into text. */
export async function runRequirementsPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const input = options.input?.trim();
	const notes = options.prompt?.trim();
	if (!input && !notes) {
		throw new Error(
			'requirements needs material: pass --input <recording|transcript> or --prompt "<discussion notes>"',
		);
	}
	const artifacts: EsdlcArtifact[] = [];
	if (input) {
		const { text, source } = await transcribeRecording(input, {
			...(options.signal ? { signal: options.signal } : {}),
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
		});
		if (!text) throw new Error(`no text extracted from ${source}`);
		artifacts.push(
			await writeArtifact(
				options.cwd,
				"requirements",
				"transcript.md",
				`# Requirements input — ${source}\n\n${text}`,
			),
		);
	}
	if (notes) {
		artifacts.push(await writeArtifact(options.cwd, "requirements", "notes.md", `# Requirements notes\n\n${notes}`));
	}
	return { summary: `captured ${artifacts.map(a => a.label).join(" + ")}`, artifacts };
}

/** 2) Analysis & design — BRD and FSD from the captured requirements. */
export async function runAnalysisPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	let material = await readArtifacts(options.cwd, "requirements", ARTIFACT_INPUTS);
	if (!material)
		throw new Error("no requirements captured yet: run `zero2ai esdlc run requirements --input <file>` first");
	const artifacts: EsdlcArtifact[] = [];
	// Human-in-the-loop: a one-line requirement cannot support a BRD, so ask for
	// the missing context instead of letting the model invent it.
	if (options.requestInput && material.length < CLARIFICATION_THRESHOLD_CHARS) {
		const answer = await options.requestInput(
			"需求材料较少，生成的 BRD/FSD 会有较多假设。请补充：业务目标、范围边界、干系人角色、关键规则或约束（可直接留空继续）。",
		);
		if (answer.trim()) {
			material = `${material}\n\n## 人工补充说明\n${answer.trim()}`;
			artifacts.push(
				await writeArtifact(options.cwd, "analysis", "clarifications.md", `# 人工补充说明\n\n${answer.trim()}`),
			);
		}
	}
	const brd = await callModel(options, "brd", {
		systemPrompt: systemAnalyst,
		userPrompt: prompt.render(brdUser, { requirements: material }),
	});
	const brdArtifact = await writeArtifact(options.cwd, "analysis", "BRD.md", brd.text);
	const fsd = await callModel(options, "fsd", {
		systemPrompt: systemAnalyst,
		userPrompt: prompt.render(fsdUser, { requirements: material, brd: brd.text }),
	});
	const fsdArtifact = await writeArtifact(options.cwd, "analysis", "FSD.md", fsd.text);
	artifacts.push(brdArtifact, fsdArtifact);
	return { summary: `BRD + FSD generated with ${brd.model}`, artifacts };
}

/** 3) Build — drive the agent on the design and capture what changed. */
export async function runBuildPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const design = await readArtifacts(options.cwd, "analysis", ["FSD.md", "BRD.md"]);
	const instruction =
		options.prompt?.trim() ||
		(design
			? "Implement the functional specification in this repository. Work in small, verifiable steps and run the project's checks."
			: "Implement the requested change in this repository, then run the project's checks.");
	const entry = Bun.main;
	const argv = [process.execPath, entry, "-p", instruction];
	// Honour the caller's model choice (web picker / --model) for the agent run too.
	if (options.model) argv.push("--model", options.model);
	const run = await runCommand(options.cwd, argv, options.signal);
	const artifacts = [
		await writeArtifact(options.cwd, "build", "agent-output.md", `# Build run\n\n${run.output || "(no output)"}`),
	];
	const { patch, files } = await worktreeDiff(options.cwd);
	if (files.length > 0)
		artifacts.push(await writeArtifact(options.cwd, "build", "changed-files.txt", files.join("\n")));
	if (patch.trim()) artifacts.push(await writeArtifact(options.cwd, "build", "changes.patch", patch));
	await writeArtifact(
		options.cwd,
		"build",
		"BUILD-NOTES.md",
		`# Build notes\n\n- instruction: ${instruction}\n- exit code: ${run.exitCode}\n- duration: ${run.durationMs} ms\n` +
			`- changed files: ${files.length}\n\n> The authoritative change record is the repository's own version control; ` +
			`the patch above is a working-tree snapshot taken by this phase.`,
	);
	if (run.exitCode !== 0) throw new Error(`build run failed (exit ${run.exitCode}); see ${artifacts[0]!.path}`);
	return {
		summary: `exit 0, ${files.length} file(s) changed`,
		artifacts: [
			...artifacts,
			{
				label: "BUILD-NOTES.md",
				path: path
					.relative(options.cwd, path.join(phaseDir(options.cwd, "build"), "BUILD-NOTES.md"))
					.replaceAll("\\", "/"),
			},
		],
	};
}

/** 4) Test — run the suite and summarise quality. */
export async function runTestPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const command = options.command?.trim() || (await detectTestCommand(options.cwd));
	const argv = command.split(/\s+/).filter(Boolean);
	const run = await runCommand(options.cwd, argv, options.signal);
	let summary =
		`**Verdict:** ${run.exitCode === 0 ? "the configured suite passed" : "the configured suite failed"} ` +
		`(exit ${run.exitCode}, ${run.durationMs} ms)\n\n> Automated narrative summary unavailable:\n> {{error}}`;
	try {
		const analysis = await callModel(options, "test-summary", {
			systemPrompt: systemEngineer,
			userPrompt: prompt.render(testUser, {
				command,
				exitCode: String(run.exitCode),
				durationMs: String(run.durationMs),
				output: run.output || "(no output)",
			}),
		});
		summary = analysis.text;
	} catch (error) {
		summary = summary.replace("{{error}}", (error as Error).message);
	}
	const artifact = await writeArtifact(
		options.cwd,
		"test",
		"report.md",
		`# Test report\n\n${summary}\n\n## Raw output\n\n\`\`\`\n${run.output || "(no output)"}\n\`\`\`\n`,
	);
	return { summary: `exit ${run.exitCode} in ${run.durationMs} ms`, artifacts: [artifact] };
}

async function detectTestCommand(cwd: string): Promise<string> {
	try {
		const parsed = asRecord(await Bun.file(path.join(cwd, "package.json")).json());
		const scripts = asRecord(parsed?.scripts);
		if (scripts?.test) return "bun run test";
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return "bun test";
}

/** 5) Deploy — deployment documentation from repository facts. */
export async function runDeployPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const facts = await collectRepoFacts(options.cwd);
	const { text, model } = await callModel(options, "deploy-doc", {
		systemPrompt: systemEngineer,
		userPrompt: prompt.render(deployUser, { facts }),
	});
	const artifact = await writeArtifact(options.cwd, "deploy", "DEPLOY.md", text);
	return { summary: `deployment document generated with ${model}`, artifacts: [artifact] };
}

/** 6) Release — project-level release documentation. */
export async function runReleasePhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const facts = await collectRepoFacts(options.cwd);
	const { patch, files } = await worktreeDiff(options.cwd);
	const history = [
		files.length ? `Uncommitted changes (${files.length}):\n${files.join("\n")}` : "No uncommitted changes.",
		`Working-tree diff stat: ${patch ? `${patch.split("\n").length} lines` : "(empty)"}`,
	].join("\n\n");
	const { text, model } = await callModel(options, "release-notes", {
		systemPrompt: systemEngineer,
		userPrompt: prompt.render(releaseUser, { facts, history }),
	});
	const artifact = await writeArtifact(options.cwd, "release", "RELEASE-NOTES.md", text);
	return { summary: `release notes generated with ${model}`, artifacts: [artifact] };
}
