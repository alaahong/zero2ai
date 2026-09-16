import { describe, expect, it } from "bun:test";
import { rewriteGitWorktreeAdd } from "@zero2ai/coding-agent/tools/bash-worktree-rewrite";

const ZERO2AI = ["bun", "/opt/zero2ai cli.ts"] as const;

describe("rewriteGitWorktreeAdd", () => {
	it("routes supported branch creation through zero2ai with an option terminator", () => {
		expect(rewriteGitWorktreeAdd("git worktree add -b feat ../wt origin/main", ZERO2AI)).toBe(
			"bun '/opt/zero2ai cli.ts' worktree add -b feat -- ../wt origin/main",
		);
	});

	it("preserves surrounding shell structure while rewriting a -C segment", () => {
		expect(rewriteGitWorktreeAdd("cd x && git -C repo worktree add ../wt && ls", ZERO2AI)).toBe(
			"cd x && bun '/opt/zero2ai cli.ts' worktree add -C repo -- ../wt && ls",
		);
	});

	it("leaves unsupported or unsafe commands unchanged", () => {
		const commands = [
			"git worktree add --lock ../wt",
			'git worktree add "$HOME/wt"',
			"FOO=1 git worktree add ../wt",
			"git worktree list",
			"printf x | git worktree add ../wt",
			"git worktree add ../wt | cat",
		];
		for (const command of commands) expect(rewriteGitWorktreeAdd(command, ZERO2AI)).toBe(command);
	});

	it("quotes rewritten argv containing spaces", () => {
		expect(rewriteGitWorktreeAdd("git worktree add 'path with spaces'", ZERO2AI)).toBe(
			"bun '/opt/zero2ai cli.ts' worktree add -- 'path with spaces'",
		);
	});
});
