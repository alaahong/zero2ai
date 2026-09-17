/**
 * `sdlc` / `sdlc-web` shortcuts.
 *
 * Two contracts matter to an operator, and both are the kind that breaks
 * silently: an unregistered shortcut is rewritten to `launch` and forwarded to
 * the model as a prompt (the #1496 leak class), and `sdlc-web` must open the
 * browser workspace without `--web`. The second is asserted against the real
 * CLI — spawning it and fetching the URL it prints — because that is the only
 * place the "browser by default" decision is observable.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { commands, isSubcommand, resolveCliArgv } from "@zero2ai/coding-agent/cli-commands";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
/** Cold `bun src/cli.ts` bootstrap plus a served page; well under this on any host. */
const SPAWN_TIMEOUT_MS = 60_000;

type Cli = Subprocess<"ignore", "pipe", "pipe">;

let projectRoot: string | undefined;
let proc: Cli | undefined;

afterEach(async () => {
	proc?.kill();
	await proc?.exited.catch(() => undefined);
	proc = undefined;
	if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
	projectRoot = undefined;
});

function tempProject(): string {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zero2ai-sdlc-shortcut-"));
	return projectRoot;
}

function spawnCli(argv: string[]): Cli {
	proc = Bun.spawn([process.execPath, cliEntry, ...argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return proc;
}

/**
 * Read stdout until `pattern` matches, then return the capture. Awaiting the
 * stream (not a timer) is what makes this both fast and race-free; a stream
 * that closes first fails with everything the command said.
 */
async function readUntilMatch(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of stream) {
		text += decoder.decode(chunk, { stream: true });
		const match = pattern.exec(text);
		if (match?.[1]) return match[1];
	}
	throw new Error(`never saw ${pattern} in: ${JSON.stringify(text)}`);
}

describe("sdlc shortcuts", () => {
	it("registers both shortcuts so their argv never reaches the model", () => {
		expect(isSubcommand("sdlc")).toBe(true);
		expect(isSubcommand("sdlc-web")).toBe(true);
		expect(resolveCliArgv(["sdlc"])).toEqual({ argv: ["sdlc"] });
		expect(resolveCliArgv(["sdlc-web", "--dir", "."])).toEqual({ argv: ["sdlc-web", "--dir", "."] });
	});

	it("routes `sdlc` to the esdlc workspace command", () => {
		expect(commands.find(entry => entry.aliases?.includes("sdlc"))?.name).toBe("esdlc");
		expect(commands.some(entry => entry.name === "sdlc-web")).toBe(true);
	});

	it(
		"runs the workspace status for `sdlc`",
		async () => {
			const dir = tempProject();
			const cli = spawnCli(["sdlc", "--dir", dir, "--json"]);
			const [exitCode, stdout] = await Promise.all([cli.exited, new Response(cli.stdout).text()]);
			expect(exitCode).toBe(0);
			const state = JSON.parse(stdout) as { projectRoot: string; phases: Record<string, { status: string }> };
			expect(state.projectRoot).toBe(path.resolve(dir));
			expect(Object.keys(state.phases)).toEqual(["requirements", "analysis", "build", "test", "deploy", "release"]);
		},
		SPAWN_TIMEOUT_MS,
	);

	it(
		"opens the browser workspace for `sdlc-web` without `--web`",
		async () => {
			const dir = tempProject();
			const cli = spawnCli(["sdlc-web", "--dir", dir, "--port", "0"]);
			const url = await readUntilMatch(cli.stdout as ReadableStream<Uint8Array>, /ESDLC workspace: (http:\/\/\S+)/);
			const response = await fetch(url);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("ZERO2AI · ESDLC");
		},
		SPAWN_TIMEOUT_MS,
	);
});
