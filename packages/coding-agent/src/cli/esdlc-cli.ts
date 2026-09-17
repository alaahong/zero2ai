/**
 * `zero2ai esdlc` — engineering lifecycle workspace (status + phase runs).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, readLines } from "@zero2ai/utils";
import {
	ESDLC_PHASES,
	type EsdlcLocale,
	resolveEsdlcLocale,
	tEsdlc,
	type EsdlcPhaseId,
	type EsdlcQuestion,
	readEsdlcState,
	renderEsdlcStatus,
	runEsdlcPhase,
} from "../esdlc";
import { isEsdlcPhaseId } from "../esdlc/types";
import { currentImpact, renderImpactArtifact } from "../esdlc/code-graph";
import { phaseDir } from "../esdlc/state";
import { openEsdlcScreen } from "../esdlc/screen";
import { DEFAULT_ESDLC_WEB_PORT, startEsdlcWeb } from "../esdlc/web";

export interface EsdlcCommandArgs {
	readonly action?: string;
	readonly phase?: string;
	readonly input?: string;
	readonly prompt?: string;
	readonly model?: string;
	readonly command?: string;
	readonly json?: boolean;
	readonly web?: boolean;
	readonly port?: number;
	/** Project directory; defaults to the current working directory. */
	readonly dir?: string;
	/** Interface language override (`zh` | `en`). */
	readonly lang?: string;
	/** Spec/skill sources for the analysis phases (URL or project-relative path). */
	readonly spec?: readonly string[];
	/** Build pre-step command that creates the project skeleton. */
	readonly scaffold?: string;
	/** Build pre-step template directory copied into the project. */
	readonly template?: string;
}

/**
 * Ask the operator on an interactive terminal.
 *
 * Non-TTY callers pass no transport at all, which makes the phase proceed instead of parking
 * on a prompt no one can answer.
 */
async function askOnTty(question: EsdlcQuestion, locale: EsdlcLocale): Promise<string> {
	process.stdout.write(`\n${tEsdlc(locale, "cli.askHuman")}：${question.text}\n> `);
	for await (const line of readLines(Bun.stdin.stream())) {
		return new TextDecoder().decode(line).trim();
	}
	return "";
}

export async function runEsdlcCommand(args: EsdlcCommandArgs): Promise<number> {
	// Any directory works: the workspace belongs to the project, not the cwd.
	const projectRoot = args.dir ? path.resolve(args.dir) : getProjectDir();
	const action = args.action ?? "status";
	// Language: explicit flag → workspace choice → environment.
	const locale = resolveEsdlcLocale({
		explicit: args.lang,
		stored: (await readEsdlcState(projectRoot)).locale,
		env: Bun.env,
	});

	if (action === "status") {
		const state = await readEsdlcState(projectRoot);
		if (args.json) {
			process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
			return 0;
		}
		// Browser workspace: the primary interactive surface for people who
		// prefer a web page over a terminal screen.
		if (args.web) {
			const server = startEsdlcWeb({ projectRoot, port: args.port ?? DEFAULT_ESDLC_WEB_PORT });
			process.stdout.write(
				`ESDLC workspace: ${server.url}\nproject: ${projectRoot}\n(loopback only — Ctrl+C to stop)\n`,
			);
			const { promise, resolve } = Promise.withResolvers<number>();
			const shutdown = (): void => {
				server.stop();
				resolve(0);
			};
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
			return await promise;
		}
		// Interactive terminal: the screen is the primary surface; pipes and CI
		// keep the static rendering so `esdlc` stays scriptable.
		if (process.stdout.isTTY) {
			return await openEsdlcScreen({
				projectRoot,
				locale,
				...(args.input ? { input: args.input } : {}),
				...(args.prompt ? { prompt: args.prompt } : {}),
				...(args.model ? { model: args.model } : {}),
				...(args.command ? { command: args.command } : {}),
			}).done;
		}
		process.stdout.write(`${renderEsdlcStatus(state, locale)}\n`);
		return 0;
	}

	if (action === "graph") {
		const graph = await currentImpact(projectRoot);
		const changedLabel = `${graph.changed.length} changed`;
		const impacted = Object.entries(graph.impacted);
		process.stdout.write(
			`${changedLabel}, ${impacted.length} impacted, ${graph.filesScanned} source file(s) scanned\n`,
		);
		for (const file of graph.changed) process.stdout.write(`  ~ ${file}\n`);
		for (const [file, depth] of impacted.slice(0, 40)) process.stdout.write(`  ← ${file} (depth ${depth})\n`);
		for (const [file, depth] of Object.entries(graph.dependencies).slice(0, 20)) {
			process.stdout.write(`  → ${file} (depth ${depth})\n`);
		}
		const dir = phaseDir(projectRoot, "build");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "code-graph.json"), `${JSON.stringify(graph, null, 2)}\n`);
		await Bun.write(path.join(dir, "IMPACT.md"), `${renderImpactArtifact(graph)}\n`);
		process.stdout.write(`  written: .zero2ai/esdlc/build/code-graph.json, IMPACT.md\n`);
		return 0;
	}

	if (action !== "run") {
		process.stderr.write(`${tEsdlc(locale, "cli.unknownAction", { action })}\n`);
		return 2;
	}

	const phase = (args.phase ?? "").trim();
	if (!isEsdlcPhaseId(phase)) {
		process.stderr.write(`${tEsdlc(locale, "cli.phaseRequired", { phases: ESDLC_PHASES.join(", ") })}\n`);
		return 2;
	}

	process.stdout.write(`${tEsdlc(locale, "cli.runningPhase", { phase })}\n`);
	const state = await runEsdlcPhase(projectRoot, phase as EsdlcPhaseId, {
		// Human-in-the-loop needs a human: only an interactive terminal can answer.
		...(process.stdin.isTTY === true
			? { requestInput: (question: EsdlcQuestion) => askOnTty(question, locale) }
			: {}),
		...(args.input ? { input: args.input } : {}),
		...(args.prompt ? { prompt: args.prompt } : {}),
		...(args.model ? { model: args.model } : {}),
		...(args.command ? { command: args.command } : {}),
		...(args.spec?.length ? { specSources: args.spec } : {}),
		...(args.scaffold ? { scaffoldCommand: args.scaffold } : {}),
		...(args.template ? { scaffoldTemplate: args.template } : {}),
		onProgress: message => process.stdout.write(`  - ${message}\n`),
	});
	const run = state.phases[phase as EsdlcPhaseId];
	process.stdout.write(`\n${tEsdlc(locale, "cli.phaseResult", { phase, status: run.status })}\n`);
	if (run.summary) process.stdout.write(`  ${run.summary}\n`);
	if (run.error) process.stderr.write(`  ${run.error}\n`);
	for (const artifact of run.artifacts)
		process.stdout.write(`  ${tEsdlc(locale, "cli.artifact")}: ${artifact.path}\n`);
	return run.status === "completed" ? 0 : 1;
}
