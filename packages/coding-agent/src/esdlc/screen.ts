/**
 * Interactive ESDLC workspace screen.
 *
 * Keyboard-driven equivalent of the `esdlc` subcommand: the six lifecycle
 * phases with their live status, one highlighted row, and the artifacts of the
 * selected phase. Triggering a phase runs the same engine the CLI uses, so the
 * screen is a view over `<project>/.zero2ai/esdlc/`, never a second code path.
 */
import { ProcessTerminal, TUI, type Component } from "@zero2ai/tui";
import {
	ESDLC_PHASES,
	ESDLC_PHASE_TITLES,
	readEsdlcState,
	renderEsdlcBannerLines,
	runEsdlcPhase,
} from "./index";
import type { EsdlcPhaseId, EsdlcState } from "./types";

const PROGRESS_HISTORY = 6;
const UP = "\u001b[A";
const DOWN = "\u001b[B";

export interface EsdlcScreenOptions {
	readonly projectRoot: string;
	readonly input?: string;
	readonly prompt?: string;
	readonly model?: string;
	readonly command?: string;
}

export interface EsdlcScreenHandle {
	/** Resolves with the number of failed phases (0 = everything green). */
	readonly done: Promise<number>;
}

class EsdlcScreen implements Component {
	#state: EsdlcState;
	#selected = 0;
	#running: EsdlcPhaseId | null = null;
	#progress: string[] = [];
	#notice: string | null = null;
	#typing: { phase: EsdlcPhaseId; buffer: string } | null = null;
	readonly #options: EsdlcScreenOptions;
	readonly #refresh: () => void;
	readonly #finish: (failed: number) => void;

	constructor(options: EsdlcScreenOptions, state: EsdlcState, refresh: () => void, finish: (failed: number) => void) {
		this.#options = options;
		this.#state = state;
		this.#refresh = refresh;
		this.#finish = finish;
	}

	render(width: number): readonly string[] {
		const lines: string[] = [...renderEsdlcBannerLines(), `project: ${this.#options.projectRoot}`, ""];
		ESDLC_PHASES.forEach((phase, index) => {
			const run = this.#state.phases[phase];
			const cursor = index === this.#selected ? ">" : " ";
			const mark = run.status === "completed" ? "+" : run.status === "failed" ? "x" : run.status === "running" ? "~" : ".";
			lines.push(`${cursor} ${mark} ${index + 1}. ${phase.padEnd(13)} ${ESDLC_PHASE_TITLES[phase]}`.slice(0, width));
			if (run.summary) lines.push(`        ${run.summary}`.slice(0, width));
			if (run.error) lines.push(`        ! ${run.error.split("\n")[0]}`.slice(0, width));
			if (index === this.#selected) {
				for (const artifact of run.artifacts) lines.push(`        ${artifact.path}`.slice(0, width));
			}
		});
		lines.push("");
		if (this.#typing) {
			lines.push(`  notes for ${this.#typing.phase}: ${this.#typing.buffer}_`.slice(0, width));
			lines.push("  Enter to run · Esc to cancel");
		} else if (this.#running) {
			lines.push(`  running ${this.#running} …`);
			for (const entry of this.#progress.slice(-PROGRESS_HISTORY)) lines.push(`    - ${entry}`.slice(0, width));
		} else {
			lines.push(`  ${this.#notice ?? "up/down select · Enter run · r refresh · q quit"}`.slice(0, width));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (this.#typing) {
			this.#handleTyping(data);
			return;
		}
		if (this.#running) return;
		if (data === "q" || data === "\u0003" || data === "\u001b") {
			this.#finish(this.#failedCount());
			return;
		}
		if (data === UP || data === "k") {
			this.#selected = (this.#selected + ESDLC_PHASES.length - 1) % ESDLC_PHASES.length;
		} else if (data === DOWN || data === "j") {
			this.#selected = (this.#selected + 1) % ESDLC_PHASES.length;
		} else if (data === "\r" || data === "\n") {
			const phase = ESDLC_PHASES[this.#selected]!;
			// The requirements phase is the only one whose input a human types here.
			if (phase === "requirements" && !this.#options.prompt && !this.#options.input) {
				this.#typing = { phase, buffer: "" };
			} else {
				void this.#run(phase);
			}
		} else if (data === "r") {
			void this.#reload();
			return;
		}
		this.#refresh();
	}

	#handleTyping(data: string): void {
		const typing = this.#typing;
		if (!typing) return;
		if (data === "\u001b" || data === "\u0003") {
			this.#typing = null;
		} else if (data === "\r" || data === "\n") {
			this.#typing = null;
			void this.#run(typing.phase, typing.buffer);
			return;
		} else if (data === "\u007f") {
			typing.buffer = typing.buffer.slice(0, -1);
		} else if (data >= " " && !data.startsWith("\u001b")) {
			typing.buffer += data;
		}
		this.#refresh();
	}

	async #run(phase: EsdlcPhaseId, prompt?: string): Promise<void> {
		this.#running = phase;
		this.#progress = [];
		this.#notice = null;
		this.#refresh();
		this.#state = await runEsdlcPhase(this.#options.projectRoot, phase, {
			...(this.#options.input ? { input: this.#options.input } : {}),
			...(prompt ?? this.#options.prompt ? { prompt: prompt ?? this.#options.prompt } : {}),
			...(this.#options.model ? { model: this.#options.model } : {}),
			...(this.#options.command ? { command: this.#options.command } : {}),
			onProgress: message => {
				this.#progress.push(message);
				this.#refresh();
			},
		});
		const run = this.#state.phases[phase];
		this.#running = null;
		this.#notice = `${phase}: ${run.status}`;
		this.#refresh();
	}

	async #reload(): Promise<void> {
		this.#state = await readEsdlcState(this.#options.projectRoot);
		this.#refresh();
	}

	#failedCount(): number {
		return ESDLC_PHASES.filter(phase => this.#state.phases[phase].status === "failed").length;
	}
}

/** Mount the workspace screen. Resolves when the user quits. */
export function openEsdlcScreen(options: EsdlcScreenOptions): EsdlcScreenHandle {
	const { promise, resolve } = Promise.withResolvers<number>();
	const ui = new TUI(new ProcessTerminal());
	let settled = false;
	const finish = (failed: number): void => {
		if (settled) return;
		settled = true;
		ui.stop();
		resolve(failed);
	};
	void readEsdlcState(options.projectRoot).then(initial => {
		const screen = new EsdlcScreen(options, initial, () => ui.requestRender(), finish);
		ui.addChild(screen);
		ui.setFocus(screen);
		ui.start();
	});
	return { done: promise };
}
