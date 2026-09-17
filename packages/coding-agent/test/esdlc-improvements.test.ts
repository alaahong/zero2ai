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
import { collectDeployFacts } from "../src/esdlc/deploy-facts";
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
		const result = await runScaffoldPreStep({
			cwd: projectRoot,
			scaffoldTemplate: "templates/api",
		});
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
		const result = await runScaffoldPreStep({ cwd: projectRoot, scaffoldCommand: "bun run seed" });
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
		await expect(runScaffoldPreStep({ cwd: projectRoot, scaffoldCommand: "bun run boom" })).rejects.toThrow(
			/scaffold command failed/,
		);
		expect(fs.readFileSync(path.join(projectRoot, ".zero2ai", "esdlc", "build", "scaffold.log"), "utf-8")).toContain(
			"exit code: 3",
		);
	});

	it("does nothing when no scaffold is configured", async () => {
		const result = await runScaffoldPreStep({ cwd: projectRoot });
		expect(result.record).toBeNull();
		expect(result.notes).toEqual([]);
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
