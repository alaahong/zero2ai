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
import { ESDLC_PHASES, type EsdlcPhaseId, type EsdlcPhaseRun, type EsdlcState, emptyPhaseRun } from "./types";

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

function emptyState(projectRoot: string, now: string): EsdlcState {
	const phases = Object.fromEntries(ESDLC_PHASES.map(phase => [phase, emptyPhaseRun()])) as Record<
		EsdlcPhaseId,
		EsdlcPhaseRun
	>;
	return { version: 1, projectRoot, createdAt: now, updatedAt: now, phases };
}

/** Read the workspace, or an empty one when the project has never been run. */
export async function readEsdlcState(projectRoot: string): Promise<EsdlcState> {
	try {
		const parsed = (await Bun.file(statePath(projectRoot)).json()) as EsdlcState;
		// Defensive: a state file written by an older/newer shape must not crash the UI.
		const phases = { ...emptyState(projectRoot, parsed.createdAt ?? new Date().toISOString()).phases };
		for (const phase of ESDLC_PHASES) phases[phase] = parsed.phases?.[phase] ?? emptyPhaseRun();
		return { ...parsed, projectRoot, phases };
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return emptyState(projectRoot, new Date().toISOString());
	}
}

export async function writeEsdlcState(state: EsdlcState): Promise<void> {
	const file = statePath(state.projectRoot);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${JSON.stringify(state, null, 2)}\n`);
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
