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
import {
	ESDLC_PHASES,
	esdlcMessages,
	readEsdlcState,
	renderEsdlcStatus,
	resolveEsdlcLocale,
	runEsdlcPhase,
} from "../src/esdlc";
import type { EsdlcMessageKey, EsdlcPhaseId, EsdlcPhaseRun, EsdlcQuestion, EsdlcState } from "../src/esdlc";
import { appendPhaseEvent, readProjectTree, writeCallTranscript, writeWorkspaceLocale } from "../src/esdlc/state";
import type { EsdlcTreeNode } from "../src/esdlc/state";

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
			phases[phase] = {
				status: "pending",
				startedAt: "",
				finishedAt: null,
				summary: null,
				error: null,
				artifacts: [],
				question: null,
			};
		}
		return {
			version: 1,
			projectRoot,
			createdAt: "",
			updatedAt: "",
			phases,
			notes: "",
			locale: "",
			specSources: [],
			scaffoldCommand: "",
			scaffoldTemplate: "",
		};
	}
});

describe("requirements phase", () => {
	it("captures discussion notes and records the artifact", async () => {
		const state = await runEsdlcPhase(projectRoot, "requirements", { prompt: "Reconciliation scope for Q4" });
		const run = state.phases.requirements;
		expect(run.status).toBe("completed");
		expect(run.artifacts.map(a => a.path)).toEqual([".zero2ai/esdlc/requirements/notes.md"]);
		expect(fs.readFileSync(artifactPath("requirements", "notes.md"), "utf-8")).toContain(
			"Reconciliation scope for Q4",
		);
	});

	it("reads a text transcript handed in with --input", async () => {
		const transcript = path.join(projectRoot, "meeting.vtt");
		fs.writeFileSync(transcript, "00:01 speaker: we need a batch cut-off at 18:00");
		const state = await runEsdlcPhase(projectRoot, "requirements", { input: transcript });
		expect(state.phases.requirements.summary).toContain("transcript.md");
		expect(fs.readFileSync(artifactPath("requirements", "transcript.md"), "utf-8")).toContain(
			"batch cut-off at 18:00",
		);
	});

	it("fails with an actionable message when no material is supplied", async () => {
		const state = await runEsdlcPhase(projectRoot, "requirements");
		const run = state.phases.requirements;
		expect(run.status).toBe("failed");
		expect(run.error).toMatch(/--input/);
		expect(run.finishedAt).not.toBeNull();
	});
});

describe("call transcripts", () => {
	it("writes the prompt, the reasoning and the output as separate files the UI can open", async () => {
		const paths = await writeCallTranscript(projectRoot, "analysis", "brd", {
			systemPrompt: "SYSTEM RULES",
			userPrompt: "USER MATERIAL",
			thinking: "REASONING TRACE",
			text: "BRD BODY",
		});
		expect(paths.promptPath).toBe(".zero2ai/esdlc/analysis/calls/01-brd.prompt.md");
		expect(await Bun.file(path.join(projectRoot, paths.promptPath)).text()).toContain("USER MATERIAL");
		expect(paths.thinkingPath).toBe(".zero2ai/esdlc/analysis/calls/01-brd.thinking.md");
		expect(await Bun.file(path.join(projectRoot, paths.thinkingPath!)).text()).toContain("REASONING TRACE");
		expect(await Bun.file(path.join(projectRoot, paths.responsePath)).text()).toContain("BRD BODY");
	});

	it("omits the reasoning file when the model returned none", async () => {
		const paths = await writeCallTranscript(projectRoot, "analysis", "fsd", {
			systemPrompt: "s",
			userPrompt: "u",
			text: "t",
		});
		expect(paths.thinkingPath).toBeUndefined();
	});

	it("numbers later calls so a rerun cannot overwrite the earlier trail", async () => {
		await appendPhaseEvent(projectRoot, {
			at: new Date().toISOString(),
			phase: "analysis",
			kind: "brd",
			model: "provider/model",
			promptChars: 1,
			responseChars: 1,
			durationMs: 1,
		});
		const paths = await writeCallTranscript(projectRoot, "analysis", "brd", {
			systemPrompt: "s",
			userPrompt: "u",
			text: "t",
		});
		expect(paths.promptPath).toBe(".zero2ai/esdlc/analysis/calls/02-brd.prompt.md");
	});

	it("records the failure instead of an empty output file", async () => {
		const paths = await writeCallTranscript(projectRoot, "analysis", "brd", {
			systemPrompt: "s",
			userPrompt: "u",
			text: "",
			error: "model call failed: 401 unauthorized",
		});
		expect(await Bun.file(path.join(projectRoot, paths.responsePath)).text()).toContain("401 unauthorized");
	});
});

describe("project tree", () => {
	it("flags workspace artifacts, marks build-changed files and hides machine dirs", async () => {
		fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "src", "app.ts"), "export const app = 1;\n");
		fs.mkdirSync(path.join(projectRoot, "node_modules", "left-pad"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
		await runEsdlcPhase(projectRoot, "requirements", { prompt: "scope" });
		fs.mkdirSync(path.join(projectRoot, ".zero2ai", "esdlc", "build"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "build", "changed-files.txt"), "src/app.ts\n");

		const root = await readProjectTree(projectRoot);
		const app = findNode(root, "src/app.ts");
		expect(app?.changed).toBe(true);
		expect(app?.artifact).toBe(false);
		expect(app?.bytes).toBeGreaterThan(0);
		expect(findNode(root, "src")?.directory).toBe(true);
		expect(findNode(root, ".zero2ai/esdlc/requirements/notes.md")?.artifact).toBe(true);
		expect(findNode(root, "node_modules")).toBeNull();
	});
});

/** Depth-first lookup by project-relative path. */
function findNode(node: EsdlcTreeNode, target: string): EsdlcTreeNode | null {
	for (const child of node.children ?? []) {
		if (child.path === target) return child;
		const hit = findNode(child, target);
		if (hit) return hit;
	}
	return null;
}

describe("interface language", () => {
	it("keeps both catalogs complete and parametrically in sync", () => {
		const en = esdlcMessages("en");
		const zh = esdlcMessages("zh");
		expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
		const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort();
		for (const key of Object.keys(en) as EsdlcMessageKey[]) {
			expect(en[key].trim().length).toBeGreaterThan(0);
			expect(zh[key].trim().length).toBeGreaterThan(0);
			// A locale that drops or renames a placeholder renders "{count}" to the operator.
			expect(placeholders(zh[key])).toEqual(placeholders(en[key]));
		}
	});

	it("resolves the language with an explicit flag winning over the workspace and the environment", () => {
		const env = { LANG: "en_US.UTF-8" };
		expect(resolveEsdlcLocale({ explicit: "zh", stored: "en", env })).toBe("zh");
		expect(resolveEsdlcLocale({ stored: "zh", env })).toBe("zh");
		expect(resolveEsdlcLocale({ env: { LANG: "zh_CN.UTF-8" } })).toBe("zh");
		expect(resolveEsdlcLocale({ env: { ZERO2AI_LANG: "zh-Hans" } })).toBe("zh");
		// Nothing recognized anywhere: the default, never a crash.
		expect(resolveEsdlcLocale({ explicit: "klingon", stored: "??", env: { LANG: "C" } })).toBe("en");
		expect(resolveEsdlcLocale({})).toBe("en");
	});

	it("renders the status in the requested language and follows the stored choice", async () => {
		await writeWorkspaceLocale(projectRoot, "zh");
		const state = await readEsdlcState(projectRoot);
		expect(state.locale).toBe("zh");
		const zh = renderEsdlcStatus(state, "zh");
		expect(zh).toContain("项目目录");
		expect(zh).toContain("需求 — 采集讨论，可用 ASR 转写");
		// No explicit locale: the workspace's stored choice wins.
		expect(renderEsdlcStatus(state)).toContain("项目目录");
		const en = renderEsdlcStatus(state, "en");
		expect(en).toContain("Requirements — capture discussion, transcribe with ASR");
		expect(en).not.toContain("项目目录");
	});
});

describe("workspace state hygiene", () => {
	it("never writes the host path into the state file, but still reports it at runtime", async () => {
		await runEsdlcPhase(projectRoot, "requirements", { prompt: "scope" });
		const onDisk = (await Bun.file(path.join(projectRoot, ".zero2ai", "esdlc", "state.json")).json()) as {
			projectRoot: string;
		};
		// The file is committed; an absolute host path would publish the operator's machine layout.
		expect(onDisk.projectRoot).toBe("");
		expect(JSON.stringify(onDisk)).not.toContain(projectRoot);
		// Readers derive it from where the file lives, so the runtime view keeps the real root.
		expect((await readEsdlcState(projectRoot)).projectRoot).toBe(projectRoot);
	});
});

describe("human-in-the-loop transport", () => {
	it("parks on the question it persists and resumes once the transport answers", async () => {
		await runEsdlcPhase(projectRoot, "requirements", { prompt: "对账" });
		// Held in an object: the assignments happen inside the transport callback, which
		// definite-assignment analysis cannot see.
		const seen: { asked?: EsdlcQuestion; persisted?: EsdlcPhaseRun } = {};
		const run = runEsdlcPhase(projectRoot, "analysis", {
			// Deterministic end: the model never resolves, so the phase fails right after the answer.
			model: "does-not-exist/model",
			requestInput: async question => {
				seen.asked = question;
				// The workspace must already show the question when the transport is asked —
				// asserting the record here avoids racing a transient status.
				seen.persisted = (await readEsdlcState(projectRoot)).phases.analysis;
				return "补充：仅对私业务，金额两位小数";
			},
		});
		const state = await run;
		expect(seen.persisted?.status).toBe("awaiting-input");
		// The id the page echoes back to /api/answer is the one persisted in the workspace.
		expect(seen.persisted?.question).toEqual(seen.asked);
		expect(seen.asked?.text).toContain("需求材料较少");
		expect(state.phases.analysis.status).toBe("failed");
		expect(state.phases.analysis.question).toBeNull();
	});

	it("does not park when no transport is supplied", async () => {
		await runEsdlcPhase(projectRoot, "requirements", { prompt: "对账" });
		const settled = await Promise.race([
			runEsdlcPhase(projectRoot, "analysis", { model: "does-not-exist/model" }).then(state => state.phases.analysis),
			Bun.sleep(20_000).then(() => "parked" as const),
		]);
		if (settled === "parked") throw new Error("a phase with no transport must not park on a question");
		expect(settled.status).toBe("failed");
		expect(await readEsdlcState(projectRoot).then(state => state.phases.analysis.question)).toBeNull();
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
