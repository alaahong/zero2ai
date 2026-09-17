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
import { currentImpact, renderImpactArtifact } from "./code-graph";
import { collectDeployFacts, renderDeployFactsArtifact, renderDeployFactsForPrompt } from "./deploy-facts";
import { parseCoveragePercent, parseTestCounts, renderQualityArtifact, scoreQuality } from "./quality";
import { loadSpecSources, renderSpecsArtifact, renderSpecsForPrompt } from "./specs";
import { appendQualityHistory, appendRunLog, phaseDir } from "./state";
import type { EsdlcArtifact, EsdlcPhaseId, EsdlcQualityReport, EsdlcQualitySignal, EsdlcScaffoldResult } from "./types";

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
	/** Phase being run; the runner sets it so commands can log against the right workspace phase. */
	readonly phase: EsdlcPhaseId;
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
	/** Documents appended to the requirements material, after the recording/transcript. */
	readonly attachments?: readonly string[];
	/** Spec/skill sources to load for the analysis phases (URL or project-relative path). */
	readonly specSources?: readonly string[];
	/** Build pre-step: command that creates the project skeleton. */
	readonly scaffoldCommand?: string;
	/** Build pre-step: directory copied into the project as the starting skeleton. */
	readonly scaffoldTemplate?: string;
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

async function runCommand(
	cwd: string,
	argv: readonly string[],
	options: {
		readonly signal?: AbortSignal;
		/** Receives output as it arrives, for the live run log and progress lines. */
		readonly onChunk?: (chunk: string) => void;
	} = {},
): Promise<CommandResult> {
	const started = Date.now();
	const child = Bun.spawn([...argv], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		...(options.signal ? { signal: options.signal } : {}),
	});
	let captured = "";
	const pump = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			captured += text;
			options.onChunk?.(text);
		}
	};
	await Promise.all([
		pump(child.stdout as ReadableStream<Uint8Array>),
		pump(child.stderr as ReadableStream<Uint8Array>),
	]);
	const exitCode = await child.exited;
	const trimmed = captured.trim();
	return {
		output:
			trimmed.length > MAX_CAPTURED_OUTPUT_CHARS
				? `${trimmed.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n… (truncated)`
				: trimmed,
		exitCode,
		durationMs: Date.now() - started,
	};
}

/**
 * Run a command for a phase: its output streams into the run log as it arrives and the newest
 * line becomes a progress update, so a long build or test run is watchable while it happens.
 */
async function runPhaseCommand(options: EsdlcRunOptions, argv: readonly string[]): Promise<CommandResult> {
	const label = argv.join(" ");
	options.onProgress?.(`$ ${label}`);
	const stream = createStreamingSink(options);
	const result = await runCommand(options.cwd, argv, {
		...(options.signal ? { signal: options.signal } : {}),
		onChunk: stream.push,
	});
	await stream.flush();
	return result;
}

/**
 * Batch output into the run log and the progress channel: file writes are debounced (~250 ms) and
 * progress lines throttled (~700 ms), so a command that prints per-byte cannot thrash either.
 */
function createStreamingSink(options: EsdlcRunOptions): { push: (chunk: string) => void; flush: () => Promise<void> } {
	const pending: string[] = [];
	let lastProgressAt = 0;
	let progressTimer: ReturnType<typeof setTimeout> | null = null;
	let writeTimer: ReturnType<typeof setTimeout> | null = null;

	const flushLog = async (): Promise<void> => {
		if (!pending.length || !options.phase) return;
		const text = pending.join("");
		pending.length = 0;
		await appendRunLog(options.cwd, options.phase, text);
	};
	const scheduleLog = (): void => {
		if (writeTimer) return;
		writeTimer = setTimeout(() => {
			writeTimer = null;
			void flushLog();
		}, 250);
	};
	const emitProgress = (): void => {
		const now = Date.now();
		if (now - lastProgressAt < 700) {
			if (progressTimer) return;
			progressTimer = setTimeout(() => {
				progressTimer = null;
				emitProgress();
			}, 700);
			return;
		}
		lastProgressAt = now;
		const line = pending
			.join("")
			.split("\n")
			.map(entry => entry.trim())
			.filter(Boolean)
			.pop();
		if (line) options.onProgress?.(line.length > 140 ? `${line.slice(0, 140)}…` : line);
	};

	return {
		push: chunk => {
			pending.push(chunk);
			scheduleLog();
			emitProgress();
		},
		flush: async () => {
			if (writeTimer) {
				clearTimeout(writeTimer);
				writeTimer = null;
			}
			if (progressTimer) {
				clearTimeout(progressTimer);
				progressTimer = null;
			}
			await flushLog();
		},
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
	const stagePrompt = options.prompt?.trim();
	const extra = [
		notes ? `工作区补充说明（来自使用者，视为需求约束）：\n${notes}` : "",
		stagePrompt ? `本阶段附加指令（来自工作区配置）：\n${stagePrompt}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	const userPrompt = extra ? `${request.userPrompt}\n\n---\n${extra}` : request.userPrompt;
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
	// Configured material is a path *inside the project*, so it resolves against the project
	// root — not the process working directory, which is unrelated when `--dir` is used.
	const rawInput = options.input?.trim();
	const input = rawInput ? (path.isAbsolute(rawInput) ? rawInput : path.resolve(options.cwd, rawInput)) : undefined;
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
	// Attached documents are part of the material, not a separate phase: they are what the
	// requirements phase was told to consider, and they are recorded as such.
	const attachments = options.attachments ?? [];
	if (attachments.length) {
		const bundle = await loadSpecSources({ projectRoot: options.cwd, sources: attachments });
		artifacts.push(await writeArtifact(options.cwd, "requirements", "attachments.md", renderSpecsArtifact(bundle)));
		options.onProgress?.(
			`attachments: ${bundle.loaded.length} loaded${bundle.skipped.length ? `, ${bundle.skipped.length} skipped` : ""}`,
		);
	}
	return { summary: `captured ${artifacts.map(a => a.label).join(" + ")}`, artifacts };
}

/** 2) Analysis & design — BRD and FSD from the captured requirements. */
export async function runAnalysisPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	let material = await readArtifacts(options.cwd, "requirements", ARTIFACT_INPUTS);
	if (!material)
		throw new Error("no requirements captured yet: run `zero2ai esdlc run requirements --input <file>` first");
	const artifacts: EsdlcArtifact[] = [];
	// Spec/skill sources: the operator's own standards ground the documents. Loaded first and
	// persisted as an artifact, so the run is auditable even if the model call then fails.
	const specs = await loadSpecSources({
		projectRoot: options.cwd,
		sources: options.specSources ?? [],
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (specs.loaded.length || specs.skipped.length) {
		artifacts.push(await writeArtifact(options.cwd, "analysis", "specs-loaded.md", renderSpecsArtifact(specs)));
		options.onProgress?.(
			`specs: ${specs.loaded.length} loaded${specs.skipped.length ? `, ${specs.skipped.length} skipped` : ""}`,
		);
	}
	const specsSection = renderSpecsForPrompt(specs);
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
	const specArgs = {
		requirements: material,
		specs: specsSection || "(no spec sources configured — state assumptions explicitly)",
	};
	const brd = await callModel(options, "brd", {
		systemPrompt: systemAnalyst,
		userPrompt: prompt.render(brdUser, specArgs),
	});
	const brdArtifact = await writeArtifact(options.cwd, "analysis", "BRD.md", brd.text);
	const fsd = await callModel(options, "fsd", {
		systemPrompt: systemAnalyst,
		userPrompt: prompt.render(fsdUser, { ...specArgs, brd: brd.text }),
	});
	const fsdArtifact = await writeArtifact(options.cwd, "analysis", "FSD.md", fsd.text);
	artifacts.push(brdArtifact, fsdArtifact);
	const specNote = specs.loaded.length ? `, ${specs.loaded.length} spec source(s)` : "";
	return { summary: `BRD + FSD generated with ${brd.model}${specNote}`, artifacts };
}

/** Copy a template directory into the project, skipping the workspace and any VCS metadata. */
async function copyScaffoldTemplate(cwd: string, template: string): Promise<string[]> {
	const source = path.resolve(cwd, template);
	const stat = await fs.stat(source).catch(() => null);
	if (!stat?.isDirectory()) throw new Error(`scaffold template is not a directory: ${template}`);
	const created: string[] = [];
	const walk = async (dir: string, relative: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === ".zero2ai" || entry.name === "node_modules") continue;
			const from = path.join(dir, entry.name);
			const to = path.join(cwd, relative, entry.name);
			const display = path.join(relative, entry.name).replaceAll("\\", "/");
			if (entry.isDirectory()) {
				await fs.mkdir(to, { recursive: true });
				await walk(from, path.join(relative, entry.name));
				continue;
			}
			// Never overwrite work already in the repository: a scaffold seeds, it does not clobber.
			if (await Bun.file(to).exists()) continue;
			await fs.mkdir(path.dirname(to), { recursive: true });
			await Bun.write(to, Bun.file(from));
			created.push(display);
		}
	};
	await walk(source, "");
	return created;
}

/**
 * The scaffold pre-step: seed a skeleton before the agent writes code.
 *
 * Separated (and exported) because it is the one part of `build` that is verifiable without a
 * model: it either created files and said so, or it failed loudly with a log to read.
 */
export async function runScaffoldPreStep(options: EsdlcRunOptions): Promise<{
	readonly notes: string[];
	readonly created: string[];
	readonly record: EsdlcScaffoldResult | null;
}> {
	const template = options.scaffoldTemplate?.trim() ?? "";
	const command = options.scaffoldCommand?.trim() ?? "";
	const notes: string[] = [];
	const created: string[] = [];
	let exitCode: number | null = null;
	let durationMs = 0;

	if (template) {
		const startedAt = Date.now();
		created.push(...(await copyScaffoldTemplate(options.cwd, template)));
		durationMs += Date.now() - startedAt;
		notes.push(`template ${template} seeded ${created.length} file(s)`);
		await writeArtifact(
			options.cwd,
			"build",
			"scaffold-files.txt",
			created.length ? created.join("\n") : "(template contributed no new files)",
		);
	}
	if (command) {
		options.onProgress?.(`scaffold: ${command}`);
		const argv = command.split(/\s+/).filter(Boolean);
		const run = await runPhaseCommand(options, argv);
		exitCode = run.exitCode;
		durationMs += run.durationMs;
		notes.push(`command \`${command}\` exited ${run.exitCode} in ${run.durationMs} ms`);
		await writeArtifact(
			options.cwd,
			"build",
			"scaffold.log",
			`# Scaffold\n\ncommand: ${command}\nexit code: ${run.exitCode}\nduration: ${run.durationMs} ms\n\n${run.output || "(no output)"}`,
		);
		if (run.exitCode !== 0) {
			throw new Error(`scaffold command failed (exit ${run.exitCode}); see .zero2ai/esdlc/build/scaffold.log`);
		}
	}
	if (!notes.length) return { notes, created, record: null };
	const record: EsdlcScaffoldResult = { command, template, exitCode, durationMs, created };
	await writeArtifact(options.cwd, "build", "scaffold.json", `${JSON.stringify(record, null, 2)}\n`);
	return { notes, created, record };
}

/** 3) Build — optional scaffold, then the agent, then the change record. */
export async function runBuildPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const design = await readArtifacts(options.cwd, "analysis", ["FSD.md", "BRD.md"]);
	const scaffold = await runScaffoldPreStep(options);
	const { notes: scaffoldNotes, created } = scaffold;
	const scaffoldSection = scaffoldNotes.length
		? `\n\nThe project skeleton was prepared before you started: ${scaffoldNotes.join("; ")}.${
				created.length ? ` New files:\n${created.slice(0, 40).join("\n")}` : ""
			}\nContinue from this skeleton instead of replacing it.`
		: "";
	const instruction =
		(options.prompt?.trim() ||
			(design
				? "Implement the functional specification in this repository. Work in small, verifiable steps and run the project's checks."
				: "Implement the requested change in this repository, then run the project's checks.")) + scaffoldSection;
	const entry = Bun.main;
	const argv = [process.execPath, entry, "-p", instruction];
	// Honour the caller's model choice (web picker / --model) for the agent run too.
	if (options.model) argv.push("--model", options.model);
	const run = await runPhaseCommand(options, argv);
	const artifacts = [
		await writeArtifact(options.cwd, "build", "agent-output.md", `# Build run\n\n${run.output || "(no output)"}`),
	];
	const { patch, files } = await worktreeDiff(options.cwd);
	if (files.length > 0)
		artifacts.push(await writeArtifact(options.cwd, "build", "changed-files.txt", files.join("\n")));
	if (patch.trim()) artifacts.push(await writeArtifact(options.cwd, "build", "changes.patch", patch));
	// What the change touches: the import graph answers the reviewer's "what else breaks?".
	options.onProgress?.("analysing impact …");
	const graph = await currentImpact(options.cwd, files);
	artifacts.push(
		await writeArtifact(options.cwd, "build", "code-graph.json", `${JSON.stringify(graph, null, 2)}\n`),
		await writeArtifact(options.cwd, "build", "IMPACT.md", renderImpactArtifact(graph)),
	);
	const impactCount = Object.keys(graph.impacted).length;
	await writeArtifact(
		options.cwd,
		"build",
		"BUILD-NOTES.md",
		`# Build notes\n\n- instruction: ${instruction}\n- exit code: ${run.exitCode}\n- duration: ${run.durationMs} ms\n` +
			`- changed files: ${files.length}\n\n> The authoritative change record is the repository's own version control; ` +
			`the patch above is a working-tree snapshot taken by this phase.`,
	);
	if (run.exitCode !== 0) throw new Error(`build run failed (exit ${run.exitCode}); see ${artifacts[0]!.path}`);
	const scaffoldFiles = scaffoldNotes.length
		? [
				{ label: "scaffold.json", file: "scaffold.json" },
				...(created.length ? [{ label: "scaffold-files.txt", file: "scaffold-files.txt" }] : []),
				...(scaffold.record?.command ? [{ label: "scaffold.log", file: "scaffold.log" }] : []),
			].map(entry => ({
				label: entry.label,
				path: path
					.relative(options.cwd, path.join(phaseDir(options.cwd, "build"), entry.file))
					.replaceAll("\\", "/"),
			}))
		: [];
	return {
		summary:
			`exit 0, ${files.length} file(s) changed, ${impactCount} file(s) impacted` +
			(scaffoldNotes.length ? " (scaffolded first)" : ""),
		artifacts: [
			...artifacts,
			...scaffoldFiles,
			{
				label: "BUILD-NOTES.md",
				path: path
					.relative(options.cwd, path.join(phaseDir(options.cwd, "build"), "BUILD-NOTES.md"))
					.replaceAll("\\", "/"),
			},
		],
	};
}

/** 4) Test — measure quality, chart it, and summarise it. */
export async function runTestPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const testCommand = options.command?.trim() || (await detectTestCommand(options.cwd));
	const signals: EsdlcQualitySignal[] = [];
	const outputs: string[] = [];

	const runSignal = async (
		name: string,
		command: string,
	): Promise<{ exitCode: number; output: string; durationMs: number }> => {
		const argv = command.split(/\s+/).filter(Boolean);
		options.onProgress?.(`quality: ${name} (${command})`);
		const run = await runPhaseCommand(options, argv);
		outputs.push(`$ ${command}\n${run.output || "(no output)"}`);
		return { exitCode: run.exitCode, output: run.output, durationMs: run.durationMs };
	};

	const tests = await runSignal("test", testCommand);
	const counts = parseTestCounts(tests.output);
	signals.push({
		name: "test",
		command: testCommand,
		exitCode: tests.exitCode,
		durationMs: tests.durationMs,
		...counts,
	});

	// Coverage: only when the project's own test command already reports it, or when a dedicated
	// script exists. The phase never invents a toolchain the repository does not configure.
	const scripts = await readPackageScripts(options.cwd);
	const coverageScript = Object.keys(scripts).find(name => /^coverage$|^test:cov/i.test(name));
	const coveragePercent = parseCoveragePercent(tests.output);
	if (coveragePercent !== undefined) {
		signals.push({
			name: "coverage",
			command: testCommand,
			exitCode: tests.exitCode,
			durationMs: tests.durationMs,
			percent: coveragePercent,
			note: "read from the test command's own output",
		});
	} else if (coverageScript) {
		const coverage = await runSignal("coverage", `bun run ${coverageScript}`);
		signals.push({
			name: "coverage",
			command: `bun run ${coverageScript}`,
			exitCode: coverage.exitCode,
			durationMs: coverage.durationMs,
			...(parseCoveragePercent(coverage.output) !== undefined
				? { percent: parseCoveragePercent(coverage.output) as number }
				: { note: "no percentage found in the reporter output" }),
		});
	} else {
		signals.push({
			name: "coverage",
			command: "(none)",
			exitCode: null,
			durationMs: 0,
			note: "no coverage script in the project",
		});
	}

	// Static checks: run exactly the scripts this project defines, never a toolchain we picked.
	for (const [signal, pattern] of [
		["typecheck", /^(typecheck|check:types|check:ts|type-check)$/i],
		["lint", /^(lint|check:lint|eslint)$/i],
	] as const) {
		const script = Object.keys(scripts).find(name => pattern.test(name));
		if (!script) {
			signals.push({
				name: signal,
				command: "(none)",
				exitCode: null,
				durationMs: 0,
				note: "no such script in the project",
			});
			continue;
		}
		const result = await runSignal(signal, `bun run ${script}`);
		signals.push({
			name: signal,
			command: `bun run ${script}`,
			exitCode: result.exitCode,
			durationMs: result.durationMs,
		});
	}

	const { score, weights } = scoreQuality(signals);
	const report: EsdlcQualityReport = { at: new Date().toISOString(), score, weights, signals };
	const raw = outputs.join("\n\n") || "(no output)";
	const qualityArtifact = await writeArtifact(options.cwd, "test", "QUALITY.md", renderQualityArtifact(report, raw));
	const jsonArtifact = await writeArtifact(
		options.cwd,
		"test",
		"quality.json",
		`${JSON.stringify(report, null, 2)}\n`,
	);
	await appendQualityHistory(options.cwd, report);

	let summary =
		`**Score ${score}/100** — ${signals
			.filter(signal => signal.exitCode !== null)
			.map(signal => `${signal.name} ${signal.exitCode === 0 ? "ok" : `exit ${signal.exitCode}`}`)
			.join(", ")}` + `\n\n> Automated narrative summary unavailable:\n> {{error}}`;
	try {
		const analysis = await callModel(options, "test-summary", {
			systemPrompt: systemEngineer,
			userPrompt: prompt.render(testUser, {
				command: testCommand,
				exitCode: String(tests.exitCode),
				durationMs: String(tests.durationMs),
				output: `${JSON.stringify(report, null, 2)}\n\n${raw}`,
			}),
		});
		summary = analysis.text;
	} catch (error) {
		summary = summary.replace("{{error}}", (error as Error).message);
	}
	const reportArtifact = await writeArtifact(
		options.cwd,
		"test",
		"report.md",
		`# Test report\n\n${summary}\n\n## Quality signals\n\n${JSON.stringify(report, null, 2)}\n\n## Raw output\n\n\`\`\`\n${raw}\n\`\`\`\n`,
	);
	const passed = signals.find(signal => signal.name === "test")?.passed;
	return {
		summary: `score ${score}/100${passed !== undefined ? `, ${passed} test(s) passed` : ""}`,
		artifacts: [reportArtifact, qualityArtifact, jsonArtifact],
	};
}

/** The project's own scripts, so a phase only runs checks the repository defines. */
async function readPackageScripts(cwd: string): Promise<Record<string, string>> {
	try {
		const parsed = asRecord(await Bun.file(path.join(cwd, "package.json")).json());
		const scripts = asRecord(parsed?.scripts) ?? {};
		return Object.fromEntries(
			Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch (error) {
		if (isEnoent(error)) return {};
		throw error;
	}
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

/** 5) Deploy — a document built from facts the repository actually carries. */
export async function runDeployPhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const facts = await collectDeployFacts(options.cwd);
	const factsArtifact = await writeArtifact(
		options.cwd,
		"deploy",
		"deploy-facts.json",
		`${JSON.stringify(facts, null, 2)}\n`,
	);
	const evidenceArtifact = await writeArtifact(
		options.cwd,
		"deploy",
		"DEPLOY-FACTS.md",
		renderDeployFactsArtifact(facts),
	);
	const { text, model } = await callModel(options, "deploy-doc", {
		systemPrompt: systemEngineer,
		userPrompt: prompt.render(deployUser, { facts: renderDeployFactsForPrompt(facts) }),
	});
	const artifact = await writeArtifact(options.cwd, "deploy", "DEPLOY.md", text);
	return {
		summary:
			`deployment document generated with ${model} — ${facts.configs.length} config(s), ` +
			`${facts.envVars.length} env var(s) cited`,
		artifacts: [artifact, evidenceArtifact, factsArtifact],
	};
}

/** 6) Release — project-level release documentation. */
export async function runReleasePhase(options: EsdlcRunOptions): Promise<EsdlcPhaseOutcome> {
	const facts = renderDeployFactsForPrompt(await collectDeployFacts(options.cwd));
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
