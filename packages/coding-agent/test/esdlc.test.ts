/**
 * ESDLC workspace: phase state machine and artifact contracts.
 *
 * The workspace is the deliverable — a failed phase must leave every other
 * phase's artifacts and records untouched, and every phase must state where its
 * output landed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ESDLC_PHASES, readEsdlcState, renderEsdlcStatus, runEsdlcPhase } from "../src/esdlc";
import type { EsdlcPhaseId, EsdlcPhaseRun, EsdlcState } from "../src/esdlc";

let projectRoot: string;

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zero2ai-esdlc-"));
});

afterEach(() => {
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

const artifactPath = (phase: string, name: string) => path.join(projectRoot, ".zero2ai", "esdlc", phase, name);

describe("fresh workspace", () => {
	it("reports every phase as pending and does not create state on read", async () => {
		const state = await readEsdlcState(projectRoot);
		expect(ESDLC_PHASES.every(phase => state.phases[phase].status === "pending")).toBe(true);
		expect(fs.existsSync(path.join(projectRoot, ".zero2ai", "esdlc", "state.json"))).toBe(false);
	});

	it("renders the six-phase flow in the banner", () => {
		const rendered = renderEsdlcStatus({ ...emptyState(), projectRoot });
		expect(rendered).toContain("REQUIREMENTS -> ANALYSIS & DESIGN -> BUILD -> TEST -> DEPLOY -> RELEASE");
	});

	function emptyState(): EsdlcState {
		const phases = {} as Record<EsdlcPhaseId, EsdlcPhaseRun>;
		for (const phase of ESDLC_PHASES) {
			phases[phase] = { status: "pending", startedAt: "", finishedAt: null, summary: null, error: null, artifacts: [] };
		}
		return { version: 1, projectRoot, createdAt: "", updatedAt: "", phases };
	}
});

describe("requirements phase", () => {
	it("captures discussion notes and records the artifact", async () => {
		const state = await runEsdlcPhase(projectRoot, "requirements", { prompt: "Reconciliation scope for Q4" });
		const run = state.phases.requirements;
		expect(run.status).toBe("completed");
		expect(run.artifacts.map(a => a.path)).toEqual([".zero2ai/esdlc/requirements/notes.md"]);
		expect(fs.readFileSync(artifactPath("requirements", "notes.md"), "utf-8")).toContain("Reconciliation scope for Q4");
	});

	it("reads a text transcript handed in with --input", async () => {
		const transcript = path.join(projectRoot, "meeting.vtt");
		fs.writeFileSync(transcript, "00:01 speaker: we need a batch cut-off at 18:00");
		const state = await runEsdlcPhase(projectRoot, "requirements", { input: transcript });
		expect(state.phases.requirements.summary).toContain("transcript.md");
		expect(fs.readFileSync(artifactPath("requirements", "transcript.md"), "utf-8")).toContain("batch cut-off at 18:00");
	});

	it("fails with an actionable message when no material is supplied", async () => {
		const state = await runEsdlcPhase(projectRoot, "requirements");
		const run = state.phases.requirements;
		expect(run.status).toBe("failed");
		expect(run.error).toMatch(/--input/);
		expect(run.finishedAt).not.toBeNull();
	});
});

describe("phase isolation", () => {
	it("keeps completed phases when a later phase fails", async () => {
		await runEsdlcPhase(projectRoot, "requirements", { prompt: "scope" });
		// Deterministic failure: an explicitly requested model that cannot resolve.
		// (Relying on "no model configured" would depend on the host's credentials
		// and on whether a bound provider answers.)
		await runEsdlcPhase(projectRoot, "analysis", { model: "does-not-exist/model" });
		const state = await readEsdlcState(projectRoot);
		expect(state.phases.requirements.status).toBe("completed");
		expect(state.phases.analysis.status).toBe("failed");
		expect(fs.existsSync(artifactPath("requirements", "notes.md"))).toBe(true);
	});

	it("persists the workspace across reads", async () => {
		await runEsdlcPhase(projectRoot, "requirements", { prompt: "scope" });
		const reloaded = await readEsdlcState(projectRoot);
		expect(reloaded.phases.requirements.status).toBe("completed");
		expect(reloaded.phases.release.status).toBe("pending");
	});
});
