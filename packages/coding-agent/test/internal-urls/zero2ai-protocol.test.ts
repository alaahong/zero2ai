import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@zero2ai/coding-agent/internal-urls";

describe("Zero2AiProtocolHandler", () => {
	it("treats zero2ai://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("zero2ai://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("zero2ai://tools/read.md");
		const prefixed = await router.resolve("zero2ai://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
