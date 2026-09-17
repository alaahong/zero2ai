/**
 * CLI answer-channel contracts.
 *
 * The reported bug was a question that "flashed by": the analysis stage asks for missing context,
 * but the CLI only offered an answer channel when it detected an interactive terminal, so every
 * other invocation skipped the question silently and generated documents full of guesses.
 *
 * These tests drive the real CLI (spawned, not called in-process) because the defect lived in the
 * argument plumbing — a unit test of the phase would have passed while the flag did nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let projectRoot: string;

const CLI = path.resolve(import.meta.dir, "..", "src", "cli.ts");

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zero2ai-esdlc-cli-"));
	fs.writeFileSync(path.join(projectRoot, "note.txt"), "需要对账\n");
});

afterEach(() => {
	// Windows can still hold a handle for a moment after the child exits.
	try {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

/** Run the CLI with no terminal attached: stdin is a closed pipe, exactly what CI sees. */
async function runCli(args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = Bun.spawn(["bun", CLI, ...args], {
		cwd: projectRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout as ReadableStream).text(),
		new Response(child.stderr as ReadableStream).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

// The model is deliberately unresolvable: the phase answers the question *before* it calls a
// model, so the clarification artifact proves the answer path without spending a generation.
const UNUSABLE_MODEL = "does-not-exist/model";

describe("esdlc CLI answer channel", () => {
	it("uses --clarify to answer the analysis question without a terminal", async () => {
		expect(
			(await runCli(["esdlc", "run", "requirements", "--dir", projectRoot, "--input", "note.txt"])).exitCode,
		).toBe(0);
		const run = await runCli([
			"esdlc",
			"run",
			"analysis",
			"--dir",
			projectRoot,
			"--model",
			UNUSABLE_MODEL,
			"--clarify",
			"范围：仅对私业务；规则：18:00 截止",
		]);
		// The run fails on the model, but the answer was recorded before that call.
		expect(run.exitCode).toBe(1);
		const clarifications = fs.readFileSync(
			path.join(projectRoot, ".zero2ai", "esdlc", "analysis", "clarifications.md"),
			"utf-8",
		);
		expect(clarifications).toContain("仅对私业务");
	}, 60_000);

	it("says the question was skipped instead of skipping it silently", async () => {
		await runCli(["esdlc", "run", "requirements", "--dir", projectRoot, "--input", "note.txt"]);
		const run = await runCli(["esdlc", "run", "analysis", "--dir", projectRoot, "--model", UNUSABLE_MODEL]);
		// The operator is told what was skipped and how to supply it…
		expect(run.stderr).toContain("需求材料较少");
		expect(run.stderr).toContain("--clarify");
		// …and the same hint is in the run log, so the workspace shows it too.
		const log = fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "analysis", "run.log"), "utf-8");
		expect(log).toContain("--clarify");
		// Nothing was invented on the operator's behalf.
		expect(fs.existsSync(path.join(projectRoot, ".zero2ai", "esdlc", "analysis", "clarifications.md"))).toBe(false);
	}, 60_000);

	it("keeps the question out of the way when the material is already substantial", async () => {
		fs.writeFileSync(path.join(projectRoot, "long.txt"), "对账范围与规则说明。".repeat(60));
		await runCli(["esdlc", "run", "requirements", "--dir", projectRoot, "--input", "long.txt"]);
		const run = await runCli(["esdlc", "run", "analysis", "--dir", projectRoot, "--model", UNUSABLE_MODEL]);
		expect(run.stderr).not.toContain("--clarify");
	}, 60_000);
});
