/**
 * `zero2ai esdlc` — engineering lifecycle workspace (status + phase runs).
 */
import { getProjectDir } from "@zero2ai/utils";
import { ESDLC_PHASES, type EsdlcPhaseId, readEsdlcState, renderEsdlcStatus, runEsdlcPhase } from "../esdlc";
import { isEsdlcPhaseId } from "../esdlc/types";

export interface EsdlcCommandArgs {
	readonly action?: string;
	readonly phase?: string;
	readonly input?: string;
	readonly prompt?: string;
	readonly model?: string;
	readonly command?: string;
	readonly json?: boolean;
}

export async function runEsdlcCommand(args: EsdlcCommandArgs): Promise<number> {
	const projectRoot = getProjectDir();
	const action = args.action ?? "status";

	if (action === "status") {
		const state = await readEsdlcState(projectRoot);
		process.stdout.write(args.json ? `${JSON.stringify(state, null, 2)}\n` : `${renderEsdlcStatus(state)}\n`);
		return 0;
	}

	if (action !== "run") {
		process.stderr.write(`unknown action "${action}"; expected one of: status, run\n`);
		return 2;
	}

	const phase = (args.phase ?? "").trim();
	if (!isEsdlcPhaseId(phase)) {
		process.stderr.write(`phase is required and must be one of: ${ESDLC_PHASES.join(", ")}\n`);
		return 2;
	}

	process.stdout.write(`running phase: ${phase}\n`);
	const state = await runEsdlcPhase(projectRoot, phase as EsdlcPhaseId, {
		...(args.input ? { input: args.input } : {}),
		...(args.prompt ? { prompt: args.prompt } : {}),
		...(args.model ? { model: args.model } : {}),
		...(args.command ? { command: args.command } : {}),
		onProgress: message => process.stdout.write(`  - ${message}\n`),
	});
	const run = state.phases[phase as EsdlcPhaseId];
	process.stdout.write(`\nphase ${phase}: ${run.status}\n`);
	if (run.summary) process.stdout.write(`  ${run.summary}\n`);
	if (run.error) process.stderr.write(`  ${run.error}\n`);
	for (const artifact of run.artifacts) process.stdout.write(`  artifact: ${artifact.path}\n`);
	return run.status === "completed" ? 0 : 1;
}
