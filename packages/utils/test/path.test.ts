import { describe, expect, it } from "bun:test";
import { isFullyQualifiedPath, stripWindowsExtendedLengthPathPrefix, windowsPathToWslMount } from "../src/path";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("removes drive and UNC extended-length prefixes on Windows", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\Shi Xin\\zero2ai.exe", "win32")).toBe(
			"C:\\Users\\Shi Xin\\zero2ai.exe",
		);
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\zero2ai.exe", "win32")).toBe(
			"\\\\server\\share\\zero2ai.exe",
		);
	});

	it("leaves non-Windows paths unchanged", () => {
		const path = "\\\\?\\C:\\Users\\Shi Xin\\zero2ai.exe";
		expect(stripWindowsExtendedLengthPathPrefix(path, "linux")).toBe(path);
	});
});

describe("windowsPathToWslMount", () => {
	it("clamps parent traversal at the Windows drive root", () => {
		expect(windowsPathToWslMount("C:\\..\\Windows\\x")).toBe("/mnt/c/Windows/x");
	});

	it("rejects paths without an absolute Windows drive", () => {
		expect(windowsPathToWslMount("/home/me/file.txt")).toBeUndefined();
	});
});

describe("isFullyQualifiedPath", () => {
	it("identifies fully qualified Windows paths across platforms", () => {
		expect(isFullyQualifiedPath("C:\\zero2ai\\bin\\zero2ai.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("c:/zero2ai/bin/zero2ai.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("\\\\server\\share\\zero2ai.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("//server/share/zero2ai.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("C:zero2ai", "win32")).toBe(false);
		expect(isFullyQualifiedPath(".\\zero2ai", "win32")).toBe(false);
		expect(isFullyQualifiedPath("\\bin\\zero2ai", "win32")).toBe(false);
		expect(isFullyQualifiedPath("/bin/zero2ai", "win32")).toBe(false);
		expect(isFullyQualifiedPath("//", "win32")).toBe(false);
		expect(isFullyQualifiedPath("\\\\", "win32")).toBe(false);
	});

	it("identifies absolute POSIX paths", () => {
		expect(isFullyQualifiedPath("/usr/local/bin/zero2ai", "darwin")).toBe(true);
		expect(isFullyQualifiedPath("/usr/local/bin/zero2ai", "linux")).toBe(true);
		expect(isFullyQualifiedPath("./zero2ai", "darwin")).toBe(false);
		expect(isFullyQualifiedPath("zero2ai", "linux")).toBe(false);
	});
});
