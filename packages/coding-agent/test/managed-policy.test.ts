/**
 * Managed (administrator) approval policy.
 *
 * Contract under test: restrictions declared by the operator survive every
 * user-facing way of loosening approval — `--yolo`, per-tool `allow`, and
 * project config — while an absent policy file changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetManagedPolicyCacheForTests, getManagedPolicy, managedExtensionPaths } from "../src/config/managed-policy";
import { resolveApproval } from "../src/tools/approval";

const BASH = { name: "bash", approval: "exec" } as const;
const READ_TOOL = { name: "read", approval: "read" } as const;

let tempDir: string | undefined;
let previousPolicyEnv: string | undefined;

function tempDirRoot(): string {
	if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero2ai-managed-policy-"));
	return tempDir;
}

function writePolicy(contents: string): void {
	const root = tempDirRoot();
	const file = path.join(root, "managed-policy.json");
	fs.writeFileSync(file, contents);
	process.env.ZERO2AI_MANAGED_POLICY = file;
	__resetManagedPolicyCacheForTests();
}

beforeEach(() => {
	previousPolicyEnv = process.env.ZERO2AI_MANAGED_POLICY;
	delete process.env.ZERO2AI_MANAGED_POLICY;
	__resetManagedPolicyCacheForTests();
});

afterEach(() => {
	if (previousPolicyEnv === undefined) delete process.env.ZERO2AI_MANAGED_POLICY;
	else process.env.ZERO2AI_MANAGED_POLICY = previousPolicyEnv;
	__resetManagedPolicyCacheForTests();
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("absent managed policy", () => {
	it("leaves yolo auto-approval untouched", () => {
		expect(getManagedPolicy()).toBeUndefined();
		expect(resolveApproval(BASH, {}, "yolo", {}).policy).toBe("allow");
	});

	it("leaves user policy untouched", () => {
		expect(resolveApproval(BASH, {}, "always-ask", { bash: "allow" }).policy).toBe("allow");
	});
});

describe("managed tool directives", () => {
	it("deny survives --yolo", () => {
		writePolicy(JSON.stringify({ approval: { bash: "deny" } }));
		const resolved = resolveApproval(BASH, {}, "yolo", {});
		expect(resolved.policy).toBe("deny");
		expect(resolved.source).toBe("managed");
	});

	it("prompt survives --yolo and a user allow", () => {
		writePolicy(JSON.stringify({ approval: { bash: "prompt" } }));
		const resolved = resolveApproval(BASH, {}, "yolo", { bash: "allow" });
		expect(resolved.policy).toBe("prompt");
		expect(resolved.source).toBe("managed");
	});

	it("wildcard applies to tools without a specific entry", () => {
		writePolicy(JSON.stringify({ approval: { "*": "prompt" } }));
		expect(resolveApproval(READ_TOOL, {}, "yolo", {}).policy).toBe("prompt");
	});

	it("a user deny is still reported as the user's own decision", () => {
		writePolicy(JSON.stringify({ approval: { bash: "prompt" } }));
		expect(resolveApproval(BASH, {}, "yolo", { bash: "deny" }).source).toBe("user");
	});

	it("allow grants nothing on its own", () => {
		writePolicy(JSON.stringify({ approval: { bash: "allow" } }));
		expect(resolveApproval(BASH, {}, "always-ask", {}).policy).toBe("prompt");
	});
});

describe("managed approval mode ceiling", () => {
	it("always-ask prevents yolo from auto-approving exec tools", () => {
		writePolicy(JSON.stringify({ approvalMode: "always-ask" }));
		const resolved = resolveApproval(BASH, {}, "yolo", {});
		expect(resolved.policy).toBe("prompt");
	});

	it("always-ask still auto-approves read-only tools", () => {
		writePolicy(JSON.stringify({ approvalMode: "always-ask" }));
		expect(resolveApproval(READ_TOOL, {}, "yolo", {}).policy).toBe("allow");
	});

	it("a looser managed mode does not tighten the session", () => {
		writePolicy(JSON.stringify({ approvalMode: "yolo" }));
		expect(resolveApproval(BASH, {}, "yolo", {}).policy).toBe("allow");
	});
});

describe("managed extensions", () => {
	it("exposes absolute extension paths from the policy file", () => {
		const policyExtension = path.join(tempDirRoot(), "policy-hook.ts");
		writePolicy(JSON.stringify({ extensions: [policyExtension] }));
		expect(managedExtensionPaths()).toEqual([policyExtension]);
	});

	it("is empty when no policy file is configured", () => {
		expect(managedExtensionPaths()).toEqual([]);
	});

	it("rejects relative paths — a cwd-dependent audit hook must fail loudly", () => {
		writePolicy(JSON.stringify({ extensions: ["policy-hook.ts"] }));
		expect(() => getManagedPolicy()).toThrow(/absolute extension paths/);
	});

	it("rejects a non-array extensions field", () => {
		writePolicy(JSON.stringify({ extensions: "policy-hook.ts" }));
		expect(() => getManagedPolicy()).toThrow(/non-array/);
	});
});

describe("malformed policy", () => {
	it("throws for an explicitly configured file that is not valid JSON", () => {
		writePolicy("{ not json");
		expect(() => getManagedPolicy()).toThrow(/not valid JSON/);
	});

	it("throws for an unknown approval mode", () => {
		writePolicy(JSON.stringify({ approvalMode: "anything-goes" }));
		expect(() => getManagedPolicy()).toThrow(/unknown approvalMode/);
	});
});
