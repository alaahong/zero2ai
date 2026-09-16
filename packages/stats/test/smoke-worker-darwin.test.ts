import { afterEach, describe, expect, it, vi } from "bun:test";
import { smokeTestSyncWorker } from "@zero2ai/stats/aggregator";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@zero2ai-stats-smoke-darwin-");

afterEach(() => {
	vi.restoreAllMocks();
});

describe("smokeTestSyncWorker", () => {
	it("skips the worker spawn on darwin so zero2ai --smoke-test stays off the macOS abort surface", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			throw new Error("worker should not be created on darwin");
		});

		await expect(smokeTestSyncWorker()).resolves.toBeUndefined();
		expect(workerSpy).not.toHaveBeenCalled();
	});
});
