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
import { readEsdlcState } from "../src/esdlc";

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
		const payload = (await response.json()) as { state: { status: string; artifacts: { path: string }[] } };
		expect(payload.state.status).toBe("completed");
		expect(payload.state.artifacts[0]?.path).toBe(".zero2ai/esdlc/requirements/notes.md");
		const onDisk = await readEsdlcState(projectRoot);
		expect(onDisk.phases.requirements.status).toBe("completed");
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
		const response = await fetch(api("/api/artifact?path=" + encodeURIComponent(".zero2ai/esdlc/requirements/notes.md")));
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("cut-off at 18:00");
	});

	it("refuses paths outside the workspace", async () => {
		for (const escapeAttempt of ["../secret.txt", ".zero2ai/esdlc/../../package.json", "/etc/passwd"]) {
			const response = await fetch(api("/api/artifact?path=" + encodeURIComponent(escapeAttempt)));
			expect(response.status).toBe(403);
		}
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
		const payload = (await response.json()) as { state: { status: string; error: string | null } };
		expect(payload.state.status).toBe("failed");
		expect(payload.state.error).toMatch(/model/i);
	});
});

describe("rebinding guard", () => {
	it("refuses a request whose Host is not loopback", async () => {
		const response = await fetch(api("/api/state"), { headers: { host: "attacker.example" } });
		expect(response.status).toBe(403);
	});
});
