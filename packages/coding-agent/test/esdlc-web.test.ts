/**
 * ESDLC web workspace: HTTP contract.
 *
 * The server is a local tool, so the contract that matters is: it answers on
 * loopback, it refuses cross-origin-ish callers and path escapes, and a phase
 * triggered over HTTP lands in the same workspace the CLI uses.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { startEsdlcWeb, type EsdlcWebHandle } from "../src/esdlc/web";
import { esdlcMessages, readEsdlcState } from "../src/esdlc";

let projectRoot: string;
let server: EsdlcWebHandle;

beforeEach(async () => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zero2ai-esdlc-web-"));
	server = startEsdlcWeb({ projectRoot, port: 0 });
});

afterEach(() => {
	server.stop();
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

const api = (pathname: string) => `${server.url}${pathname}`;

/** Poll the workspace until a phase reaches a terminal state. */
async function waitForPhase(phase: string, status: string, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = (await (await fetch(api("/api/state"))).json()) as {
			phases: Record<string, { status: string; summary: string | null; error: string | null }>;
		};
		if (state.phases[phase]?.status === status) return state.phases[phase];
		await Bun.sleep(50);
	}
	throw new Error(`phase ${phase} never reached ${status}`);
}

describe("page", () => {
	it("renders the lifecycle flow and the banner", async () => {
		const response = await fetch(api("/"));
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("REQUIREMENTS  →  ANALYSIS & DESIGN  →  BUILD  →  TEST  →  DEPLOY  →  RELEASE");
		expect(html).toContain("ZERO2AI · ESDLC");
	});
});

describe("state API", () => {
	it("reports every phase with its workspace root", async () => {
		const payload = (await (await fetch(api("/api/state"))).json()) as {
			projectRoot: string;
			phases: Record<string, { status: string }>;
		};
		expect(payload.projectRoot).toBe(path.resolve(projectRoot));
		expect(Object.keys(payload.phases).sort()).toEqual([
			"analysis",
			"build",
			"deploy",
			"release",
			"requirements",
			"test",
		]);
	});
});

describe("run API", () => {
	it("runs a phase and persists it into the workspace", async () => {
		const response = await fetch(api("/api/run"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ phase: "requirements", prompt: "reconciliation scope" }),
		});
		expect(response.status).toBe(200);
		await waitForPhase("requirements", "completed");
		const onDisk = await readEsdlcState(projectRoot);
		expect(onDisk.phases.requirements.status).toBe("completed");
		expect(onDisk.phases.requirements.artifacts[0]?.path).toBe(".zero2ai/esdlc/requirements/notes.md");
	});

	it("rejects an unknown phase", async () => {
		const response = await fetch(api("/api/run"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ phase: "deploy-everything" }),
		});
		expect(response.status).toBe(400);
	});
});

describe("artifact API", () => {
	it("returns the content of a workspace artifact", async () => {
		await fetch(api("/api/run"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ phase: "requirements", prompt: "cut-off at 18:00" }),
		});
		await waitForPhase("requirements", "completed");
		const response = await fetch(
			api("/api/artifact?path=" + encodeURIComponent(".zero2ai/esdlc/requirements/notes.md")),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("cut-off at 18:00");
	});

	it("refuses paths that leave the project directory", async () => {
		for (const escapeAttempt of ["../secret.txt", "../../etc/passwd", "/etc/passwd", ".."]) {
			const response = await fetch(api("/api/artifact?path=" + encodeURIComponent(escapeAttempt)));
			expect(response.status).toBe(403);
		}
	});

	it("normalises a traversal that stays inside the project", async () => {
		// The boundary is the project directory, not the workspace: the tree spans the project
		// (an artifact-only tree would hide the code a build wrote).
		fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "src", "app.ts"), "export const app = 1;\n");
		const response = await fetch(api("/api/artifact?path=" + encodeURIComponent(".zero2ai/esdlc/../../src/app.ts")));
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("export const app");
	});
});

describe("bound models API", () => {
	it("reports the default chain and every model with usable credentials", async () => {
		const response = await fetch(api("/api/models"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			default: { label: string } | null;
			defaultLabel: string;
			available: { label: string; provider: string; id: string }[];
		};
		expect(typeof payload.defaultLabel).toBe("string");
		const scoped = payload as unknown as {
			configRoot: string;
			legacyRoot: { dirName: string; hasConfig: boolean } | null;
		};
		expect(typeof scoped.configRoot).toBe("string");
		expect(scoped.configRoot.length).toBeGreaterThan(0);
		if (scoped.legacyRoot) expect(typeof scoped.legacyRoot.dirName).toBe("string");
		expect(Array.isArray(payload.available)).toBe(true);
		// Every listed model must be addressable as provider/id, which is what the
		// picker sends back as `model`.
		for (const model of payload.available) expect(model.label).toBe(`${model.provider}/${model.id}`);
		// The implicit default must be something this host can actually run.
		if (payload.default) expect(payload.available.map(m => m.label)).toContain(payload.default.label);
	});

	it("threads an explicit model choice into the phase run", async () => {
		const response = await fetch(api("/api/run"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ phase: "deploy", model: "does-not-exist/model" }),
		});
		expect(response.status).toBe(200);
		const run = await waitForPhase("deploy", "failed");
		expect(run.error).toMatch(/model/i);
	});
});

describe("project tree API", () => {
	it("nests the project, flags ESDLC artifacts and marks the build's changed files", async () => {
		fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "src", "app.ts"), "export const app = 1;\n");
		fs.mkdirSync(path.join(projectRoot, "node_modules", "left-pad"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
		await fetch(api("/api/run"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ phase: "requirements", prompt: "scope" }),
		});
		await waitForPhase("requirements", "completed");
		// The build phase reports its changed files; the tree surfaces them.
		const buildDir = path.join(projectRoot, ".zero2ai", "esdlc", "build");
		fs.mkdirSync(buildDir, { recursive: true });
		fs.writeFileSync(path.join(buildDir, "changed-files.txt"), "src/app.ts\n");

		const root = (await (await fetch(api("/api/tree"))).json()) as ProjectNode;
		const app = find(root, "src/app.ts");
		expect(app?.changed).toBe(true);
		expect(app?.artifact).toBe(false);
		expect(app?.bytes).toBeGreaterThan(0);
		const artifact = find(root, ".zero2ai/esdlc/requirements/notes.md");
		expect(artifact?.artifact).toBe(true);
		expect(find(root, "node_modules")).toBeNull();
	});

	it("serves a project file the tree shows, not just workspace artifacts", async () => {
		fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "src", "app.ts"), "export const app = 1;\n");
		const response = await fetch(api("/api/artifact?path=" + encodeURIComponent("src/app.ts")));
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("export const app");
	});
});

interface ProjectNode {
	name: string;
	path: string;
	directory: boolean;
	artifact: boolean;
	changed: boolean;
	bytes?: number;
	children?: ProjectNode[];
}

/** Depth-first lookup by project-relative path. */
function find(node: ProjectNode, target: string): ProjectNode | null {
	for (const child of node.children ?? []) {
		if (child.path === target) return child;
		const hit = find(child, target);
		if (hit) return hit;
	}
	return null;
}

describe("workspace notes API", () => {
	it("persists 补充说明 and returns it with the state", async () => {
		const saved = await fetch(api("/api/notes"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ notes: "所有金额字段保留两位小数" }),
		});
		expect(saved.status).toBe(200);
		const state = (await (await fetch(api("/api/state"))).json()) as { notes: string };
		expect(state.notes).toBe("所有金额字段保留两位小数");
	});

	it("rejects a non-string notes payload", async () => {
		const response = await fetch(api("/api/notes"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ notes: 42 }),
		});
		expect(response.status).toBe(400);
	});
});

describe("human-in-the-loop API", () => {
	it("rejects an answer for a question that is not pending", async () => {
		const response = await fetch(api("/api/answer"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ questionId: "not-pending", text: "x" }),
		});
		expect(response.status).toBe(404);
	});

	it("requires a questionId", async () => {
		const response = await fetch(api("/api/answer"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "x" }),
		});
		expect(response.status).toBe(400);
	});
});

describe("detached runs", () => {
	it("acknowledges immediately and reports progress through the state", async () => {
		const response = await fetch(api("/api/run"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ phase: "requirements", prompt: "async scope" }),
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as { started: boolean }).started).toBe(true);
		const run = await waitForPhase("requirements", "completed");
		expect(run.summary).toContain("notes.md");
	});
});

describe("malformed requests", () => {
	it("answers 400 instead of crashing on an unparseable body", async () => {
		for (const pathname of ["/api/run", "/api/notes", "/api/answer"]) {
			const response = await fetch(api(pathname), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{ this is not json",
			});
			expect(response.status).toBe(400);
		}
	});

	it("rejects a non-object body", async () => {
		const response = await fetch(api("/api/run"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '"just a string"',
		});
		expect(response.status).toBe(400);
	});
});

describe("page script", () => {
	it("parses, so a syntax error cannot ship a blank workspace", async () => {
		const html = await (await fetch(server.url)).text();
		const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
		expect(script.length).toBeGreaterThan(1000);
		// Compilation is the contract: the page runs this exact text in the browser.
		expect(() => new Function(script)).not.toThrow();
		expect(script).not.toContain("$" + "{");
	});
});

describe("file editing API", () => {
	it("writes an edit and serves it back through the artifact endpoint", async () => {
		fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "docs", "BRD.md"), "# 旧标题\n");
		const written = await fetch(api("/api/file"), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "docs/BRD.md", text: "# 新标题\n\n补充段落\n" }),
		});
		expect(written.status).toBe(200);
		expect(((await written.json()) as { bytes: number }).bytes).toBe(26);
		expect(fs.readFileSync(path.join(projectRoot, "docs", "BRD.md"), "utf-8")).toContain("新标题");
		const served = await fetch(api("/api/artifact?path=" + encodeURIComponent("docs/BRD.md")));
		expect(await served.text()).toContain("补充段落");
		const root = (await (await fetch(api("/api/tree"))).json()) as ProjectNode;
		expect(find(root, "docs/BRD.md")?.bytes).toBe(26);
	});

	it("creates a file that did not exist yet", async () => {
		const response = await fetch(api("/api/file"), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "notes/new.txt", text: "hello" }),
		});
		expect(response.status).toBe(200);
		expect(fs.readFileSync(path.join(projectRoot, "notes", "new.txt"), "utf-8")).toBe("hello");
	});

	it("refuses writes outside the project or into .git", async () => {
		for (const target of ["../outside.md", "/tmp/outside.md", ".git/config"]) {
			const response = await fetch(api("/api/file"), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: target, text: "x" }),
			});
			expect(response.status).toBe(403);
		}
		expect(fs.existsSync(path.join(projectRoot, ".git", "config"))).toBe(false);
	});

	it("refuses a binary target, an oversized payload and a non-string body", async () => {
		fs.writeFileSync(path.join(projectRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a]));
		const cases: Array<[string, string | number, number]> = [
			["logo.png", "not an image", 400],
			["big.txt", "x".repeat(1024 * 1024 + 1), 413],
			["typed.txt", 42, 400],
		];
		for (const [target, text, status] of cases) {
			const response = await fetch(api("/api/file"), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: target, text }),
			});
			expect(response.status).toBe(status);
		}
		expect(fs.readFileSync(path.join(projectRoot, "logo.png")).subarray(0, 2)).toEqual(Buffer.from([0x89, 0x50]));
	});
});

describe("markdown rendering", () => {
	it("renders structure, escapes markup and drops unsafe links", async () => {
		const html = await (await fetch(server.url)).text();
		const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
		const source = script.slice(script.indexOf("function escapeHtml"), script.indexOf("function renderTree()"));
		const render = new Function("" + source + "; return renderMarkdown;")() as (text: string) => string;
		const out = render(
			[
				"# 标题 **粗体**",
				"",
				"- 一",
				"  - 二",
				"",
				"| 列 | 值 |",
				"| --- | --- |",
				"| a | 1 |",
				"",
				"> 引用",
				"",
				"```ts",
				"const x = 1 < 2;",
				"```",
				"",
				"[坏](javascript:alert(1)) <img src=x onerror=alert(1)>",
			].join("\n"),
		);
		expect(out).toContain("<h1>标题 <strong>粗体</strong></h1>");
		expect(out).toContain("<table class=md-table>");
		expect(out).toContain("<blockquote><p>引用</p></blockquote>");
		expect(out).toContain("<pre class=md-code><code>const x = 1 &lt; 2;</code></pre>");
		// Model output is untrusted: raw markup is text and unsafe URLs are neutralised.
		expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(out).not.toContain("javascript:");
	});
});

describe("language API", () => {
	it("persists the chosen language and reports it with the state", async () => {
		const saved = await fetch(api("/api/locale"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ locale: "en" }),
		});
		expect(saved.status).toBe(200);
		const state = (await (await fetch(api("/api/state"))).json()) as { locale: string };
		expect(state.locale).toBe("en");
		// The choice survives a reload of the workspace file, not just the response.
		expect((await readEsdlcState(projectRoot)).locale).toBe("en");
	});

	it("rejects an unknown language", async () => {
		const response = await fetch(api("/api/locale"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ locale: "fr" }),
		});
		expect(response.status).toBe(400);
	});

	it("ships every catalog to the page so switching needs no reload", async () => {
		const html = await (await fetch(server.url)).text();
		const injected = /const CATALOGS = (\{[\s\S]*?\});\n/.exec(html)?.[1] ?? "";
		const catalogs = JSON.parse(injected) as Record<string, Record<string, string>>;
		for (const locale of ["zh", "en"]) {
			expect(Object.keys(catalogs[locale] ?? {}).length).toBeGreaterThan(50);
			for (const [key, value] of Object.entries(esdlcMessages(locale as "zh" | "en"))) {
				expect(catalogs[locale]?.[key]).toBe(value);
			}
		}
	});
});

describe("rebinding guard", () => {
	it("refuses a request whose Host is not loopback", async () => {
		const response = await fetch(api("/api/state"), { headers: { host: "attacker.example" } });
		expect(response.status).toBe(403);
	});
});
