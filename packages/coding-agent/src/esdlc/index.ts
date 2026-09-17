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
	type EsdlcQuestion,
	type EsdlcState,
} from "./types";
import { appendPhaseEvent, readEsdlcState, recordPhaseRun, writeCallTranscript } from "./state";
import * as phases from "./phases";
import type { EsdlcPhaseOutcome, EsdlcRunOptions } from "./phases";
import {
	ESDLC_LOCALES,
	type EsdlcLocale,
	esdlcCatalogs,
	esdlcMessages,
	isEsdlcLocale,
	resolveEsdlcLocale,
	tEsdlc,
} from "./i18n";

export type { EsdlcRunOptions, EsdlcPhaseOutcome };

/**
 * Options accepted by {@link runEsdlcPhase}: the phase options minus the ones the runner
 * owns, plus an optional transport for answering a phase's question.
 */
export type EsdlcPhaseRequest = Omit<EsdlcRunOptions, "cwd" | "notes" | "requestInput" | "onEvent"> & {
	readonly requestInput?: (question: EsdlcQuestion) => Promise<string>;
};
export { ESDLC_PHASES, ESDLC_PHASE_LABELS, ESDLC_PHASE_TITLES, readEsdlcState };
export { ESDLC_LOCALES, esdlcCatalogs, esdlcMessages, isEsdlcLocale, resolveEsdlcLocale, tEsdlc };
export type { EsdlcLocale, EsdlcMessageKey } from "./i18n";
export type { EsdlcPhaseId, EsdlcPhaseRun, EsdlcQuestion, EsdlcState };

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
	options: EsdlcPhaseRequest = {},
): Promise<EsdlcState> {
	const startedAt = new Date().toISOString();
	const running: EsdlcPhaseRun = {
		status: "running",
		startedAt,
		finishedAt: null,
		summary: null,
		error: null,
		artifacts: [],
		question: null,
	};
	await recordPhaseRun(projectRoot, phase, running);
	const state = await readEsdlcState(projectRoot);
	const { requestInput, ...phaseOptions } = options;
	try {
		const outcome = await RUNNERS[phase]({
			...phaseOptions,
			cwd: projectRoot,
			notes: state.notes,
			// The runner owns the persisted question; the caller owns the transport (web page or
			// interactive terminal). Without a transport there is no human to wait for, so the
			// phase proceeds rather than parking forever on a question nobody can answer.
			...(requestInput
				? {
						requestInput: async (text: string) => {
							const question: EsdlcQuestion = {
								id: crypto.randomUUID(),
								text,
								askedAt: new Date().toISOString(),
							};
							await recordPhaseRun(projectRoot, phase, { ...running, status: "awaiting-input", question });
							const answer = await requestInput(question);
							await recordPhaseRun(projectRoot, phase, { ...running, question: null });
							return answer;
						},
					}
				: {}),
			onEvent: async ({ kind, systemPrompt, userPrompt, text, thinking, ...metrics }) => {
				// Persist the material and the answer as transcripts next to the phase, then record
				// their paths: the trail shows what the model actually read and reasoned, not a tally.
				const transcripts = await writeCallTranscript(projectRoot, phase, kind, {
					systemPrompt,
					userPrompt,
					text,
					...(thinking ? { thinking } : {}),
					...(metrics.error ? { error: metrics.error } : {}),
				});
				await appendPhaseEvent(projectRoot, {
					at: new Date().toISOString(),
					phase,
					kind,
					...metrics,
					...transcripts,
					...(thinking ? { thinkingChars: thinking.length } : {}),
				});
			},
		});
		return await recordPhaseRun(projectRoot, phase, {
			status: "completed",
			startedAt,
			finishedAt: new Date().toISOString(),
			summary: outcome.summary,
			error: null,
			artifacts: outcome.artifacts,
			question: null,
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
	"awaiting-input": "?",
	completed: "+",
	failed: "x",
};

/** Plain-text status table; the interactive screen re-uses it verbatim. */
export function renderEsdlcStatus(state: EsdlcState, locale?: EsdlcLocale): string {
	const lang = locale ?? resolveEsdlcLocale({ stored: state.locale, env: Bun.env });
	const messages = esdlcMessages(lang);
	const lines: string[] = [renderEsdlcBanner(), `${tEsdlc(lang, "cli.project")}: ${state.projectRoot}`, ""];
	for (const [index, phase] of ESDLC_PHASES.entries()) {
		const run = state.phases[phase];
		lines.push(`${STATUS_MARK[run.status]} ${index + 1}. ${phase.padEnd(13)} ${messages[`phase.${phase}.title`]}`);
		if (run.summary) lines.push(`      |_ ${run.summary}`);
		if (run.error) lines.push(`      |_ ${run.error.split("\n")[0]}`);
		for (const artifact of run.artifacts) lines.push(`      |_ ${artifact.path}`);
	}
	lines.push("", `  ${tEsdlc(lang, "cli.hint")}`);
	return lines.join("\n");
}
