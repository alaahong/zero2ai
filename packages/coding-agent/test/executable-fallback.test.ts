import * as path from "node:path";
import * as utils from "@zero2ai/utils";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveCliEntryCmd, resolveExecutablePath, resolveWorkerSpawnCmd } from "../src/subprocess/worker-client";

describe("executable fallback on unlinked binary", () => {
	const originalExecPathDesc = Object.getOwnPropertyDescriptor(process, "execPath");
	const originalArgv0Desc = Object.getOwnPropertyDescriptor(process, "argv0");

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalExecPathDesc) {
			Object.defineProperty(process, "execPath", originalExecPathDesc);
		}
		if (originalArgv0Desc) {
			Object.defineProperty(process, "argv0", originalArgv0Desc);
		}
	});

	function setProcessProp(prop: "execPath" | "argv0", value: string): void {
		Object.defineProperty(process, prop, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	it("launches the healthy compiled binary without invoking fallback lookups", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);
		const whichSpy = vi.spyOn(utils, "$which");

		expect(resolveCliEntryCmd()).toEqual([process.execPath]);
		expect(resolveWorkerSpawnCmd("__zero2ai_worker_test")).toEqual({
			cmd: [process.execPath, "__zero2ai_worker_test"],
		});
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("prefers original absolute launcher path over generic PATH match when executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/zero2ai/18.1.8/bin/zero2ai";
		const originalLauncher = "/opt/homebrew/bin/zero2ai";
		const otherOmpInPath = "/usr/local/bin/zero2ai";

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "zero2ai") return otherOmpInPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === originalLauncher || p === otherOmpInPath;
		});

		expect(resolveCliEntryCmd()).toEqual([originalLauncher]);
		expect(resolveWorkerSpawnCmd("__zero2ai_worker_test")).toEqual({
			cmd: [originalLauncher, "__zero2ai_worker_test"],
		});
	});

	it("falls back to PATH when original absolute launcher exists but is not executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/zero2ai/18.1.8/bin/zero2ai";
		const originalLauncher = "/opt/homebrew/bin/zero2ai";
		const otherOmpInPath = "/usr/local/bin/zero2ai";

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "zero2ai") return otherOmpInPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			// Launcher is not executable (e.g. root-owned, mode 0644, or directory)
			return p === otherOmpInPath;
		});

		expect(resolveCliEntryCmd()).toEqual([otherOmpInPath]);
		expect(resolveWorkerSpawnCmd("__zero2ai_worker_test")).toEqual({
			cmd: [otherOmpInPath, "__zero2ai_worker_test"],
		});
	});

	it("does not resolve relative argv0 against the working tree", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/zero2ai/18.1.8/bin/zero2ai";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "./zero2ai");

		const cwdRogueBinary = path.resolve("./zero2ai");
		vi.spyOn(utils, "$which").mockReturnValue(null);
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === cwdRogueBinary;
		});

		// Relative argv0 must never resolve against cwd; falls back to missingPath gracefully
		expect(resolveExecutablePath()).toBe(missingPath);
	});

	it("does not treat Windows drive-relative paths (e.g. C:zero2ai) as bare commands", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "C:\\Tools\\zero2ai.exe";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "C:zero2ai");

		let whichCalledWith: string | undefined;
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			whichCalledWith = cmd;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		resolveExecutablePath();

		// Should not pass "C:zero2ai" to which as a bare name; only "zero2ai" generic fallback is queried
		expect(whichCalledWith).toBe("zero2ai");
	});

	it("falls back to $which('zero2ai') when original execPath was unlinked and argv0 has no path", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/zero2ai/18.1.8/bin/zero2ai";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "zero2ai");

		const mockUpgradedPath = "/opt/homebrew/bin/zero2ai";
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "zero2ai") return mockUpgradedPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === mockUpgradedPath;
		});

		expect(resolveCliEntryCmd()).toEqual([mockUpgradedPath]);
		expect(resolveWorkerSpawnCmd("__zero2ai_worker_test")).toEqual({
			cmd: [mockUpgradedPath, "__zero2ai_worker_test"],
		});
	});

	it("falls back to process.argv0 when $which('zero2ai') is unavailable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/custom/install/bin/zero2ai";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "my-zero2ai");

		const mockCustomPath = "/usr/local/bin/my-zero2ai";
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "my-zero2ai") return mockCustomPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === mockCustomPath;
		});

		expect(resolveExecutablePath()).toBe(mockCustomPath);
	});

	it("does not perform fallback lookup when isCompiledBinary is false", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(false);
		const missingPath = "/opt/homebrew/Cellar/zero2ai/18.1.8/bin/zero2ai";
		setProcessProp("execPath", missingPath);

		const whichSpy = vi.spyOn(utils, "$which");
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		const resolved = resolveExecutablePath();
		expect(whichSpy).not.toHaveBeenCalled();
		expect(resolved).toBe(missingPath);
	});

	it("returns original execPath gracefully if no fallback candidate exists", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/nonexistent/zero2ai";
		setProcessProp("execPath", missingPath);
		vi.spyOn(utils, "$which").mockReturnValue(null);
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		expect(resolveExecutablePath()).toBe(missingPath);
	});
});
