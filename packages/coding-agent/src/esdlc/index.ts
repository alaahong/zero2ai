/**
 * ESDLC workspace: phase orchestration, status rendering and the banner shared
 * by the CLI and the interactive screen.
 */
import {
	ESDLC_PHASES,
	ESDLC_PHASE_LABELS,
	ESDLC_PHASE_TITLES,
	type EsdlcPhaseId,
	type EsdlcPhaseRun,
	type EsdlcState,
} from "./types";
import { readEsdlcState, recordPhaseRun } from "./state";
import * as phases from "./phases";
import type { EsdlcPhaseOutcome, EsdlcRunOptions } from "./phases";

export type { EsdlcRunOptions, EsdlcPhaseOutcome };
export { ESDLC_PHASES, ESDLC_PHASE_LABELS, ESDLC_PHASE_TITLES, readEsdlcState };
export type { EsdlcPhaseId, EsdlcPhaseRun, EsdlcState };

const RUNNERS: Readonly<Record<EsdlcPhaseId, (options: EsdlcRunOptions) => Promise<EsdlcPhaseOutcome>>> = {
	requirements: phases.runRequirementsPhase,
	analysis: phases.runAnalysisPhase,
	build: phases.runBuildPhase,
	test: phases.runTestPhase,
	deploy: phases.runDeployPhase,
	release: phases.runReleasePhase,
};

/**
 * Run one phase, persisting the running → completed|failed transition.
 *
 * A failed phase records its error and leaves other phases untouched, so a
 * workspace is never destroyed by a bad run.
 */
export async function runEsdlcPhase(
	projectRoot: string,
	phase: EsdlcPhaseId,
	options: Omit<EsdlcRunOptions, "cwd"> = {},
): Promise<EsdlcState> {
	const startedAt = new Date().toISOString();
	const running: EsdlcPhaseRun = { status: "running", startedAt, finishedAt: null, summary: null, error: null, artifacts: [] };
	await recordPhaseRun(projectRoot, phase, running);
	try {
		const outcome = await RUNNERS[phase]({ ...options, cwd: projectRoot });
		return await recordPhaseRun(projectRoot, phase, {
			status: "completed",
			startedAt,
			finishedAt: new Date().toISOString(),
			summary: outcome.summary,
			error: null,
			artifacts: outcome.artifacts,
		});
	} catch (error) {
		return await recordPhaseRun(projectRoot, phase, {
			...running,
			status: "failed",
			finishedAt: new Date().toISOString(),
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

const BANNER_LINES: readonly string[] = [
	" _____ _____ ____   ___  ____      _    ___ ",
	"|__  /| ____|  _ \\ / _ \\|___ \\    / \\  |_ _|",
	"  / / |  _| | |_) | | | | __) |  / _ \\  | | ",
	" / /_ | |___|  _ <| |_| |/ __/  / ___ \\ | | ",
	"/____||_____|_| \\_\\\\___/|_____| /_/   \\_\\___|",
];

const FLOW = ESDLC_PHASES.map(phase => ESDLC_PHASE_LABELS[phase]).join(" -> ");

/** Banner art only (no flow line): callers decide how to present the flow. */
export function renderEsdlcBannerArt(): readonly string[] {
	return [...BANNER_LINES];
}

/** Banner as individual lines: the TUI renders one array element per row. */
export function renderEsdlcBannerLines(): readonly string[] {
	return [...BANNER_LINES, `  ${FLOW}`, ""];
}

export function renderEsdlcBanner(): string {
	return `${BANNER_LINES.join("\n")}\n  ${FLOW}\n`;
}

const STATUS_MARK: Readonly<Record<EsdlcPhaseRun["status"], string>> = {
	pending: ".",
	running: "~",
	completed: "+",
	failed: "x",
};

/** Plain-text status table; the interactive screen re-uses it verbatim. */
export function renderEsdlcStatus(state: EsdlcState): string {
	const lines: string[] = [renderEsdlcBanner(), `project: ${state.projectRoot}`, ""];
	for (const [index, phase] of ESDLC_PHASES.entries()) {
		const run = state.phases[phase];
		lines.push(`${STATUS_MARK[run.status]} ${index + 1}. ${phase.padEnd(13)} ${ESDLC_PHASE_TITLES[phase]}`);
		if (run.summary) lines.push(`      |_ ${run.summary}`);
		if (run.error) lines.push(`      |_ ${run.error.split("\n")[0]}`);
		for (const artifact of run.artifacts) lines.push(`      |_ ${artifact.path}`);
	}
	lines.push("", 'run a phase:  zero2ai esdlc run <phase> [--input <file>] [--prompt "<text>"] [--model <id>]');
	return lines.join("\n");
}
