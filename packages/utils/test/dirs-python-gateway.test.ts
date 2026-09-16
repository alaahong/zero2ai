import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigDirName, getPythonGatewayDir, setAgentDir } from "@zero2ai/utils/dirs";
import { Snowflake } from "@zero2ai/utils/snowflake";

describe("python gateway directory", () => {
	let tempRoot = "";
	let originalAgentDir = "";
	let originalConfigDir: string | undefined;
	let originalXdgStateHome: string | undefined;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalConfigDir = process.env.ZERO2AI_CONFIG_DIR;
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		tempRoot = path.join(os.tmpdir(), "zero2ai-utils-python-gateway", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		if (originalConfigDir === undefined) {
			delete process.env.ZERO2AI_CONFIG_DIR;
		} else {
			process.env.ZERO2AI_CONFIG_DIR = originalConfigDir;
		}
		if (originalXdgStateHome === undefined) {
			delete process.env.XDG_STATE_HOME;
		} else {
			process.env.XDG_STATE_HOME = originalXdgStateHome;
		}
		setAgentDir(originalAgentDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("uses XDG state for the default agent profile", async () => {
		if (process.platform === "win32") return;

		process.env.ZERO2AI_CONFIG_DIR = `.zero2ai-test-${Snowflake.next()}`;
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "zero2ai"), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "agent");
		setAgentDir(defaultAgentDir);

		expect(getPythonGatewayDir()).toBe(path.join(process.env.XDG_STATE_HOME, "zero2ai", "python-gateway"));
	});

	it("keeps custom agent profiles isolated from XDG shared state", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "zero2ai"), { recursive: true });
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getPythonGatewayDir()).toBe(path.join(customAgentDir, "python-gateway"));
	});
});
