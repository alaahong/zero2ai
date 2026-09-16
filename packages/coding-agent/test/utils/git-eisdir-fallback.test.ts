import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@zero2ai/natives/vcs";
import { removeWithRetries } from "@zero2ai/utils";
import { $ } from "bun";

describe("git reference directory fallback", () => {
	let repoDir: string;
	let commitSha: string;

	beforeAll(async () => {
		repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "zero2ai-ref-fallback-"));
		const initResult = await $`git init --initial-branch=main`.cwd(repoDir).quiet();
		if (initResult.exitCode !== 0) throw new Error("git init failed");
		await $`git config user.name "Test User"`.cwd(repoDir).quiet();
		await $`git config user.email "test@example.com"`.cwd(repoDir).quiet();
		await fs.writeFile(path.join(repoDir, "file.txt"), "hello world");
		await $`git add file.txt`.cwd(repoDir).quiet();
		await $`git commit -m "initial commit"`.cwd(repoDir).quiet();

		commitSha = (await $`git rev-parse HEAD`.cwd(repoDir).quiet().text()).trim();

		// We will simulate a situation where:
		// There is a branch called "zero2ai-flash" which is packed (in packed-refs).
		// But there is also a subdirectory created inside refs/heads under the same name:
		// refs/heads/zero2ai-flash/... because a branch called "zero2ai-flash/something" exists as a loose ref.
		// Thus:
		// 1. refs/heads/zero2ai-flash is a directory on disk.
		// 2. packed-refs contains: <commitSha> refs/heads/zero2ai-flash
		// In this case, trying to read refs/heads/zero2ai-flash as a file throws EISDIR.
		// We want to verify that we gracefully handle this and fallback to resolving from packed-refs.

		// Let's pack the current main branch as refs/heads/zero2ai-flash so we have it in packed-refs
		await $`git update-ref refs/heads/zero2ai-flash ${commitSha}`.cwd(repoDir).quiet();
		// Also point HEAD to refs/heads/zero2ai-flash so we exercise HEAD -> ref -> readRef / readRefSync
		await fs.writeFile(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/zero2ai-flash\n");
		await $`git pack-refs --all`.cwd(repoDir).quiet();
		// Check that packed-refs exists
		const packedRefs = await fs.readFile(path.join(repoDir, ".git", "packed-refs"), "utf8");
		expect(packedRefs).toContain("refs/heads/zero2ai-flash");

		// Delete the loose ref file for refs/heads/zero2ai-flash if git pack-refs didn't already delete it (it usually does).
		await removeWithRetries(path.join(repoDir, ".git", "refs", "heads", "zero2ai-flash"));

		// Now, create refs/heads/zero2ai-flash as a directory to simulate another branch like "zero2ai-flash/feature" existing.
		// We can just create the directory and a file inside it, or just the directory.
		await fs.mkdir(path.join(repoDir, ".git", "refs", "heads", "zero2ai-flash"), { recursive: true });
		await fs.writeFile(path.join(repoDir, ".git", "refs", "heads", "zero2ai-flash", "feature"), commitSha);
	});

	afterAll(async () => {
		await removeWithRetries(repoDir).catch(() => {});
	});

	test("resolves branch that has directory conflict via resolveSync on head", () => {
		const headStateSync = vcs.requireGit(repoDir).headSync();
		expect(headStateSync).not.toBeNull();
		if (!headStateSync) return;
		expect(headStateSync.commit).toBe(commitSha);
	});

	test("resolves branch that has directory conflict via resolve on ref", async () => {
		const repository = vcs.git(repoDir);
		expect(repository).not.toBeNull();
		if (!repository) return;
		const resolved = await repository.resolveRef("refs/heads/zero2ai-flash");
		expect(resolved).toBe(commitSha);
	});
});
