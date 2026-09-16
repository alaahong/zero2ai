import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@zero2ai/schema";
import type * as TypeBox from "@zero2ai/schema/typebox";
import * as zod from "@zero2ai/schema/zod";
import * as piCodingAgent from "@zero2ai/coding-agent";
import { GreenCommand } from "@zero2ai/coding-agent/extensibility/custom-commands/bundled/ci-green";
import type { CustomCommandAPI } from "@zero2ai/coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@zero2ai/coding-agent/extensibility/hooks/types";
import type { VcsGitRepo } from "@zero2ai/natives";
import * as vcs from "@zero2ai/natives/vcs";

afterEach(() => {
	vi.restoreAllMocks();
});

function createApi(): CustomCommandAPI {
	return {
		cwd: "/tmp/test",
		exec: async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		}),
		typebox: {} as unknown as typeof TypeBox,
		arktype: Object.assign(Function.prototype.bind.call(type, undefined) as typeof type, type, { type }),
		zod,
		pi: piCodingAgent,
	};
}

describe("GreenCommand", () => {
	it("includes tag instructions when HEAD has a tag", async () => {
		vi.spyOn(vcs, "requireGit").mockReturnValue({
			tagsAt: async () => ["v0.1.0-alpha2"],
		} as unknown as VcsGitRepo);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).toContain("v0.1.0-alpha2");
		expect(result).not.toContain("timeouts due to the harnesses");
	});

	it("omits tag instructions when HEAD is not tagged", async () => {
		vi.spyOn(vcs, "requireGit").mockReturnValue({
			tagsAt: async () => [],
		} as unknown as VcsGitRepo);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).not.toContain("v0.1.0-alpha2");
	});
});
