/**
 * ESDLC (engineering software development life cycle) workspace model.
 *
 * One workspace per project, persisted under `<project>/.zero2ai/esdlc/`, so a
 * phase run is inspectable (and re-runnable) across sessions. Phases produce
 * artifacts on disk; the state file only records what happened.
 */

/** Phases, in lifecycle order. The order is what the UI renders. */
export const ESDLC_PHASES = ["requirements", "analysis", "build", "test", "deploy", "release"] as const;

export type EsdlcPhaseId = (typeof ESDLC_PHASES)[number];

export type EsdlcPhaseStatus = "pending" | "running" | "completed" | "failed";

/** A file a phase produced, addressed relative to the project root. */
export interface EsdlcArtifact {
	readonly label: string;
	readonly path: string;
}

export interface EsdlcPhaseRun {
	readonly status: EsdlcPhaseStatus;
	readonly startedAt: string;
	readonly finishedAt: string | null;
	/** One-line outcome shown in the UI. */
	readonly summary: string | null;
	/** Failure text when `status === "failed"`. */
	readonly error: string | null;
	readonly artifacts: readonly EsdlcArtifact[];
}

export interface EsdlcState {
	readonly version: 1;
	readonly projectRoot: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly phases: Readonly<Record<EsdlcPhaseId, EsdlcPhaseRun>>;
}

/** Short flow labels — the ids alone lose "& DESIGN", so labels are explicit. */
export const ESDLC_PHASE_LABELS: Readonly<Record<EsdlcPhaseId, string>> = {
	requirements: "REQUIREMENTS",
	analysis: "ANALYSIS & DESIGN",
	build: "BUILD",
	test: "TEST",
	deploy: "DEPLOY",
	release: "RELEASE",
};

export const ESDLC_PHASE_TITLES: Readonly<Record<EsdlcPhaseId, string>> = {
	requirements: "Requirements — capture discussion, transcribe with ASR",
	analysis: "Analysis & Design — BRD / FSD from the requirements",
	build: "Build — prompt-driven implementation with a change preview",
	test: "Test — run the suite and summarise quality",
	deploy: "Deploy — deployment documentation for the build",
	release: "Release — project-level release documentation",
};

export function isEsdlcPhaseId(value: string): value is EsdlcPhaseId {
	return (ESDLC_PHASES as readonly string[]).includes(value);
}

export function emptyPhaseRun(): EsdlcPhaseRun {
	return { status: "pending", startedAt: "", finishedAt: null, summary: null, error: null, artifacts: [] };
}
