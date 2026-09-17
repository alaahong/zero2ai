/**
 * Contracts for the phase improvements: spec sources, the build scaffold, the quality report and
 * the deployment facts. Each of these produces something an operator reads or acts on, so the
 * assertions here are about what those artifacts say — not about internal wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runEsdlcPhase, runScaffoldPreStep } from "../src/esdlc";
import { buildCodeGraph } from "../src/esdlc/code-graph";
import { collectDeployFacts } from "../src/esdlc/deploy-facts";
import { writePhaseConfig } from "../src/esdlc/state";
import { parseCoveragePercent, parseTestCounts, renderQualityArtifact, scoreQuality } from "../src/esdlc/quality";
import { loadSpecSources } from "../src/esdlc/specs";

let projectRoot: string;

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zero2ai-esdlc-improve-"));
});

afterEach(() => {
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

const write = (relative: string, body: string) => {
	const file = path.join(projectRoot, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	return file;
};

describe("spec & skill sources", () => {
	it("loads a project file and a directory of standards, and injects both", async () => {
		write("docs/standards.md", "# API standard\nAll endpoints use /v1.");
		write("skills/api/SKILL.md", "# Skill\nName resources in snake_case.");
		const bundle = await loadSpecSources({
			projectRoot,
			sources: ["docs/standards.md", "skills/api"],
		});
		expect(bundle.skipped).toEqual([]);
		expect(bundle.loaded.map(entry => entry.source)).toEqual(["docs/standards.md", "skills/api"]);
		expect(bundle.loaded[0]!.text).toContain("/v1");
		expect(bundle.loaded[1]!.text).toContain("snake_case");
		expect(bundle.loaded.every(entry => entry.kind === "file")).toBe(true);
	});

	it("reports an unreachable or escaping source instead of failing the phase", async () => {
		write("docs/standards.md", "ok");
		const bundle = await loadSpecSources({
			projectRoot,
			sources: ["../outside.md", "docs/missing.md", "docs/standards.md"],
		});
		expect(bundle.loaded.map(entry => entry.source)).toEqual(["docs/standards.md"]);
		expect(bundle.skipped.map(entry => entry.source)).toEqual(["../outside.md", "docs/missing.md"]);
		expect(bundle.skipped[0]!.reason).toContain("escapes the project");
		expect(bundle.skipped[1]!.reason).toContain("does not exist");
	});

	it("fetches a URL, strips HTML, and refuses an oversized response", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				const url = new URL(request.url);
				if (url.pathname === "/spec") {
					return new Response("<html><body><h1>Rule</h1><p>Keep amounts exact.</p></body></html>", {
						headers: { "content-type": "text/html" },
					});
				}
				return new Response("x".repeat(300 * 1024), { headers: { "content-type": "text/plain" } });
			},
		});
		try {
			const bundle = await loadSpecSources({
				projectRoot,
				sources: [`http://127.0.0.1:${server.port}/spec`, `http://127.0.0.1:${server.port}/huge`],
			});
			expect(bundle.loaded).toHaveLength(1);
			expect(bundle.loaded[0]!.kind).toBe("url");
			// HTML is converted to text rather than injected as tags.
			expect(bundle.loaded[0]!.text).toContain("Keep amounts exact.");
			expect(bundle.loaded[0]!.text).not.toContain("<h1>");
			expect(bundle.skipped[0]!.reason).toContain("larger than");
		} finally {
			server.stop(true);
		}
	});

	it("records what it loaded next to the phase, even when the model then fails", async () => {
		write("docs/standards.md", "Binding rule.");
		fs.mkdirSync(path.join(projectRoot, ".zero2ai", "esdlc", "requirements"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "requirements", "notes.md"), "x".repeat(500));
		const state = await runEsdlcPhase(projectRoot, "analysis", {
			model: "does-not-exist/model",
			specSources: ["docs/standards.md"],
		});
		expect(state.phases.analysis.status).toBe("failed");
		const artifact = path.join(projectRoot, ".zero2ai", "esdlc", "analysis", "specs-loaded.md");
		const text = fs.readFileSync(artifact, "utf-8");
		expect(text).toContain("docs/standards.md");
		expect(text).toContain("Binding rule.");
	});
});

describe("build scaffold", () => {
	it("copies a template without overwriting existing work", async () => {
		write("templates/api/README.md", "# Template readme");
		write("templates/api/src/index.ts", "export const index = 1;");
		write("src/index.ts", "export const existing = true;");
		const result = await runScaffoldPreStep({ cwd: projectRoot, phase: "build", scaffoldTemplate: "templates/api" });
		// The template's src/index.ts is skipped: the repository already has one.
		expect([...result.created].sort()).toEqual(["README.md"]);
		expect(fs.readFileSync(path.join(projectRoot, "README.md"), "utf-8")).toContain("Template readme");
		// The repository's own file wins.
		expect(fs.readFileSync(path.join(projectRoot, "src", "index.ts"), "utf-8")).toContain("existing");
		const record = JSON.parse(
			fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "build", "scaffold.json"), "utf-8"),
		) as { template: string; created: string[] };
		expect(record.template).toBe("templates/api");
		expect(record.created.length).toBeGreaterThan(0);
	});

	it("runs a scaffold command and records its output", async () => {
		write("seed.ts", 'await Bun.write("generated/app.ts", "export const app = 1;\\n");\nconsole.log("seeded");\n');
		write("package.json", JSON.stringify({ name: "fixture", scripts: { seed: "bun run seed.ts" } }, null, 2));
		const result = await runScaffoldPreStep({ cwd: projectRoot, phase: "build", scaffoldCommand: "bun run seed" });
		expect(result.record?.exitCode).toBe(0);
		expect(fs.existsSync(path.join(projectRoot, "generated", "app.ts"))).toBe(true);
		const log = fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "build", "scaffold.log"), "utf-8");
		expect(log).toContain("seeded");
	});

	it("fails loudly when the scaffold command fails", async () => {
		write(
			"package.json",
			JSON.stringify({ name: "fixture", scripts: { boom: 'bun -e "process.exit(3)"' } }, null, 2),
		);
		await expect(
			runScaffoldPreStep({ cwd: projectRoot, phase: "build", scaffoldCommand: "bun run boom" }),
		).rejects.toThrow(/scaffold command failed/);
		expect(fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "build", "scaffold.log"), "utf-8")).toContain(
			"exit code: 3",
		);
	});

	it("does nothing when no scaffold is configured", async () => {
		const result = await runScaffoldPreStep({ cwd: projectRoot, phase: "build" });
		expect(result.record).toBeNull();
		expect(result.notes).toEqual([]);
	});
});

describe("externalized phase configuration", () => {
	it("drives analysis from the workspace config with no flags at all", async () => {
		write("docs/standards.md", "All amounts are integers.");
		fs.mkdirSync(path.join(projectRoot, ".zero2ai", "esdlc", "requirements"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "requirements", "notes.md"), "x".repeat(500));
		await writePhaseConfig(projectRoot, "analysis", { sources: ["docs/standards.md"] });
		const state = await runEsdlcPhase(projectRoot, "analysis", { model: "does-not-exist/model" });
		expect(state.phases.analysis.status).toBe("failed");
		const loaded = fs.readFileSync(
			path.join(projectRoot, ".zero2ai", "esdlc", "analysis", "specs-loaded.md"),
			"utf-8",
		);
		expect(loaded).toContain("docs/standards.md");
		expect(loaded).toContain("All amounts are integers.");
	});

	it("drives the test stage's command and the build stage's scaffold from the config", async () => {
		write("fake-test.ts", 'console.log("7 pass");\nconsole.log("0 fail");\n');
		await writePhaseConfig(projectRoot, "test", { command: "bun run fake-test.ts" });
		await runEsdlcPhase(projectRoot, "test", { model: "does-not-exist/model" });
		const report = JSON.parse(
			fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "test", "quality.json"), "utf-8"),
		) as { signals: Array<{ name: string; command: string; passed?: number }> };
		const test = report.signals.find(signal => signal.name === "test");
		expect(test?.command).toBe("bun run fake-test.ts");
		expect(test?.passed).toBe(7);

		write("templates/api/index.ts", "export const index = 1;");
		await writePhaseConfig(projectRoot, "build", { sources: ["templates/api"] });
		await runEsdlcPhase(projectRoot, "build", { model: "does-not-exist/model" });
		const scaffold = JSON.parse(
			fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "build", "scaffold.json"), "utf-8"),
		) as { template: string; created: string[] };
		expect(scaffold.template).toBe("templates/api");
		expect(scaffold.created).toEqual(["index.ts"]);
	});

	it("takes the requirements material and its attachments from the config", async () => {
		write("meeting.txt", "对账口径需要统一。");
		write("docs/extra.md", "现有系统每 15 分钟批量一次。");
		await writePhaseConfig(projectRoot, "requirements", { sources: ["meeting.txt", "docs/extra.md"] });
		const state = await runEsdlcPhase(projectRoot, "requirements");
		expect(state.phases.requirements.status).toBe("completed");
		// sources[0] is the material (transcribed/read), the rest are attachments.
		const transcript = fs.readFileSync(
			path.join(projectRoot, ".zero2ai", "esdlc", "requirements", "transcript.md"),
			"utf-8",
		);
		expect(transcript).toContain("对账口径需要统一。");
		const attachments = fs.readFileSync(
			path.join(projectRoot, ".zero2ai", "esdlc", "requirements", "attachments.md"),
			"utf-8",
		);
		expect(attachments).toContain("docs/extra.md");
		expect(attachments).toContain("每 15 分钟批量一次");
	});

	it("lets a caller override the stored configuration for one run", async () => {
		await writePhaseConfig(projectRoot, "test", { command: "bun run missing.ts" });
		write("real-test.ts", 'console.log("2 pass");\nconsole.log("0 fail");\n');
		await runEsdlcPhase(projectRoot, "test", { command: "bun run real-test.ts", model: "does-not-exist/model" });
		const report = JSON.parse(
			fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "test", "quality.json"), "utf-8"),
		) as { signals: Array<{ name: string; command: string; passed?: number }> };
		expect(report.signals.find(signal => signal.name === "test")?.passed).toBe(2);
	});
});

describe("live run detail", () => {
	it("streams a command's output into the run log while the phase runs", async () => {
		// A command that prints twice with a pause between: the log must exist before it finishes.
		write(
			"slow.ts",
			[
				'console.log("first line");',
				"await Bun.sleep(1200);",
				'console.log("second line");',
				"await Bun.sleep(1500);",
				'console.log("done");',
				"",
			].join("\n"),
		);
		await writePhaseConfig(projectRoot, "test", { command: "bun run slow.ts" });
		const running = runEsdlcPhase(projectRoot, "test", { model: "does-not-exist/model" });
		// Wait until the phase starts, then read the log *mid-run*.
		let midRun = "";
		for (let attempt = 0; attempt < 120; attempt++) {
			await Bun.sleep(50);
			try {
				midRun = fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "test", "run.log"), "utf-8");
			} catch {
				midRun = "";
			}
			if (midRun.includes("first line")) break;
		}
		expect(midRun).toContain("first line");
		expect(midRun).not.toContain("done");
		await running;
		const finalLog = fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "test", "run.log"), "utf-8");
		expect(finalLog).toContain("second line");
		expect(finalLog).toContain("done");
	});

	it("resets the log per run so an old tail cannot be mistaken for the current one", async () => {
		await writePhaseConfig(projectRoot, "test", { command: "bun run one.ts" });
		write("one.ts", 'console.log("run-one-marker");\n');
		await runEsdlcPhase(projectRoot, "test", { model: "does-not-exist/model" });
		await writePhaseConfig(projectRoot, "test", { command: "bun run two.ts" });
		write("two.ts", 'console.log("run-two-marker");\n');
		await runEsdlcPhase(projectRoot, "test", { model: "does-not-exist/model" });
		const log = fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "test", "run.log"), "utf-8");
		expect(log).toContain("run-two-marker");
		expect(log).not.toContain("run-one-marker");
	});
});

describe("code graph and impact", () => {
	it("follows relative imports and reports who a change reaches", async () => {
		write("src/util.ts", "export const util = 1;\n");
		write("src/service.ts", 'import { util } from "./util";\nexport const service = util + 1;\n');
		write("src/api.ts", 'import { service } from "./service";\nexport const api = service + 1;\n');
		write("src/unrelated.ts", "export const lonely = true;\n");
		write("src/index.ts", 'import { api } from "./api";\nexport const main = api;\n');
		const graph = await buildCodeGraph({ cwd: projectRoot, changedFiles: ["src/util.ts"] });
		expect(graph.changed).toEqual(["src/util.ts"]);
		// util is imported by service (depth 1), which is imported by api (2) and index (3).
		expect(graph.impacted).toMatchObject({ "src/service.ts": 1, "src/api.ts": 2, "src/index.ts": 3 });
		expect(graph.impacted["src/unrelated.ts"]).toBeUndefined();
		// The dependency direction is reported too.
		expect(graph.dependencies).toEqual({});
		const reverse = await buildCodeGraph({ cwd: projectRoot, changedFiles: ["src/index.ts"] });
		expect(reverse.dependencies).toMatchObject({ "src/api.ts": 1, "src/service.ts": 2, "src/util.ts": 3 });
	});

	it("resolves extensionless and index specifiers, and separates external packages", async () => {
		write("lib/dir/index.ts", "export const inside = 1;\n");
		write(
			"lib/consumer.ts",
			'import { inside } from "./dir";\nimport { z } from "zod";\nexport const value = inside;\n',
		);
		const graph = await buildCodeGraph({ cwd: projectRoot, changedFiles: ["lib/dir/index.ts"] });
		expect(graph.impacted).toEqual({ "lib/consumer.ts": 1 });
		expect(graph.external).toContain("zod");
		expect(graph.nodes.find(node => node.path === "lib/dir/index.ts")?.importedBy).toEqual(["lib/consumer.ts"]);
	});

	it("writes the graph and the impact report next to the build", async () => {
		write("src/a.ts", "export const a = 1;\n");
		write("src/b.ts", 'import { a } from "./a";\nexport const b = a;\n');
		write("package.json", JSON.stringify({ name: "fixture", scripts: {} }, null, 2));
		// Build fails at the agent (unknown model) but the graph is derived from the diff before that.
		await runEsdlcPhase(projectRoot, "build", { model: "does-not-exist/model" });
		const graph = JSON.parse(
			fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "build", "code-graph.json"), "utf-8"),
		) as { nodes: unknown[]; impacted: Record<string, number> };
		expect(Array.isArray(graph.nodes)).toBe(true);
		expect(fs.existsSync(path.join(projectRoot, ".zero2ai", "esdlc", "build", "IMPACT.md"))).toBe(true);
	});
});

describe("quality signals", () => {
	it("reads the counts and coverage the test runners actually print", () => {
		expect(parseTestCounts(" 12 pass\n 1 fail\n 2 skip\nRan 15 tests across 3 files.")).toEqual({
			passed: 12,
			failed: 1,
			skipped: 2,
			total: 15,
		});
		expect(parseTestCounts("Tests  8 passed | 2 failed (10)")).toMatchObject({ passed: 8, failed: 2 });
		expect(parseTestCounts("no counts here")).toEqual({});
		expect(parseCoveragePercent("All files |   84.21 |     71.4 |")).toBe(84.21);
		expect(parseCoveragePercent("Lines : 91.5%")).toBe(91.5);
		expect(parseCoveragePercent("no coverage reported")).toBeUndefined();
	});

	it("scores only what it measured, and says which weights it used", () => {
		const partial = scoreQuality([
			{ name: "test", command: "bun test", exitCode: 0, durationMs: 10, passed: 8, failed: 2 },
			{ name: "coverage", command: "(none)", exitCode: null, durationMs: 0, note: "no coverage script" },
		]);
		// tests 0.8 and signals 1.0 over the two present components (0.5 / 0.3 renormalized).
		expect(partial.weights).toEqual({ tests: 0.625, signals: 0.375 });
		expect(partial.score).toBe(88);

		const withCoverage = scoreQuality([
			{ name: "test", command: "bun test", exitCode: 0, durationMs: 10, passed: 10, failed: 0 },
			{ name: "coverage", command: "bun run coverage", exitCode: 0, durationMs: 5, percent: 50 },
		]);
		expect(withCoverage.weights).toEqual({ tests: 0.5, signals: 0.3, coverage: 0.2 });
		expect(withCoverage.score).toBe(90);
	});

	it("writes the score, the weights and the measured signals into the report", () => {
		const text = renderQualityArtifact(
			{
				at: "2026-01-01T00:00:00.000Z",
				score: 73,
				weights: { tests: 0.6, signals: 0.4 },
				signals: [
					{ name: "test", command: "bun test", exitCode: 1, durationMs: 1200, passed: 3, failed: 1 },
					{ name: "lint", command: "(none)", exitCode: null, durationMs: 0, note: "no such script" },
				],
			},
			"raw output here",
		);
		expect(text).toContain("**Score:** 73/100");
		expect(text).toContain("bun test");
		expect(text).toContain("3 passed, 1 failed");
		expect(text).toContain("not measured");
		expect(text).toContain("raw output here");
	});
});

describe("deployment facts", () => {
	it("derives configs, scripts, entrypoints, env vars and ports with their evidence", async () => {
		write("Dockerfile", "FROM oven/bun:1\nEXPOSE 8787\n");
		write(
			"package.json",
			JSON.stringify(
				{
					name: "svc",
					scripts: { build: "bun build ./src/index.ts", start: "bun run src/index.ts" },
					bin: { svc: "src/cli.ts" },
					engines: { bun: ">=1.3" },
				},
				null,
				2,
			),
		);
		write(
			"src/index.ts",
			"const base = process.env.API_BASE_URL;\nBun.serve({ port: 8787, fetch: () => new Response(base) });\n",
		);
		write(".github/workflows/ci.yml", "name: ci\non: push\n");
		const facts = await collectDeployFacts(projectRoot);
		expect(facts.configs.map(config => config.path).sort()).toEqual(
			["Dockerfile", ".github/workflows/ci.yml"].sort(),
		);
		expect(facts.scripts.start).toContain("src/index.ts");
		expect(facts.entrypoints.some(entry => entry.includes("bin.svc"))).toBe(true);
		expect(facts.envVars).toContain("API_BASE_URL");
		expect(facts.ports).toContain("8787");
		expect(facts.evidence).toContain("src/index.ts");
	});

	it("records the facts before the document call, so a failure still leaves evidence", async () => {
		write("Dockerfile", "FROM scratch\n");
		write("package.json", JSON.stringify({ name: "svc", scripts: { start: "bun run index.ts" } }, null, 2));
		const state = await runEsdlcPhase(projectRoot, "deploy", { model: "does-not-exist/model" });
		expect(state.phases.deploy.status).toBe("failed");
		const facts = JSON.parse(
			fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "deploy", "deploy-facts.json"), "utf-8"),
		) as { configs: { path: string }[] };
		expect(facts.configs.map(config => config.path)).toContain("Dockerfile");
		expect(fs.existsSync(path.join(projectRoot, ".zero2ai", "esdlc", "deploy", "DEPLOY-FACTS.md"))).toBe(true);
	});
});
