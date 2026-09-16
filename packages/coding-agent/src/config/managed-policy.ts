/**
 * Managed (administrator) approval policy.
 *
 * This layer sits *above* user settings and runtime flags: the values here are
 * what an operator guarantees, so `--yolo`, project config, ACP client
 * permission gates, or subagent defaults cannot lift them. Only restrictive
 * directives take effect — `deny`, `prompt`, and a stricter `approvalMode`;
 * `allow` is accepted for readability but grants nothing.
 *
 * Resolution order (first hit wins):
 *   1. `ZERO2AI_MANAGED_POLICY` — explicit file path. Missing, unreadable, or
 *      malformed is a hard error: a silently ignored policy file is worse than
 *      a visible failure.
 *   2. `<dir>/managed-policy.json`, where `<dir>` is
 *      `ZERO2AI_MANAGED_POLICY_DIR`, else `%ProgramData%\zero2ai` (Windows) or
 *      `/etc/zero2ai` (POSIX). Absence is normal; a malformed file throws.
 *
 * File shape (JSON, deliberately — this layer must not depend on the YAML
 * settings pipeline it constrains):
 *
 *   {
 *     "approvalMode": "always-ask",
 *     "approval": { "*": "prompt", "bash": "prompt", "eval": "deny" }
 *   }
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type ManagedPolicyValue = "allow" | "deny" | "prompt";
export type ManagedApprovalMode = "always-ask" | "write" | "yolo";

export interface ManagedPolicy {
	readonly approvalMode?: ManagedApprovalMode;
	readonly approval: Readonly<Record<string, ManagedPolicyValue>>;
	/**
	 * Extension modules that are always loaded, on absolute paths. User controls
	 * (`--no-extensions`, `disabledExtensions`) cannot remove them, which keeps
	 * the operator's audit/redaction hooks in place on every session.
	 */
	readonly extensions: readonly string[];
	/** Path the policy was loaded from; surfaced in prompts and diagnostics. */
	readonly sourcePath: string;
}

const MANAGED_POLICY_FILE = "managed-policy.json";
const POLICY_VALUES: Readonly<Record<string, true>> = { allow: true, deny: true, prompt: true };
const MODE_VALUES: Readonly<Record<string, true>> = { "always-ask": true, write: true, yolo: true };

function managedPolicyDir(): string {
	const configured = process.env.ZERO2AI_MANAGED_POLICY_DIR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return path.join(process.env.ProgramData?.trim() || "C:\\ProgramData", "zero2ai");
	return "/etc/zero2ai";
}

/** Candidate policy files in resolution order; the first exists-and-parses wins. */
function candidatePolicyPaths(): Array<{ path: string; required: boolean }> {
	const explicit = process.env.ZERO2AI_MANAGED_POLICY?.trim();
	if (explicit) return [{ path: explicit, required: true }];
	return [{ path: path.join(managedPolicyDir(), MANAGED_POLICY_FILE), required: false }];
}

function parsePolicy(text: string, sourcePath: string): ManagedPolicy {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`managed policy ${sourcePath} is not valid JSON: ${(error as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`managed policy ${sourcePath} must be a JSON object`);
	}
	const record = raw as { approvalMode?: unknown; approval?: unknown; extensions?: unknown };
	const approvalMode =
		typeof record.approvalMode === "string" && MODE_VALUES[record.approvalMode] === true
			? (record.approvalMode as ManagedApprovalMode)
			: undefined;
	if (record.approvalMode !== undefined && approvalMode === undefined) {
		throw new Error(`managed policy ${sourcePath} has an unknown approvalMode: ${String(record.approvalMode)}`);
	}
	const approval: Record<string, ManagedPolicyValue> = {};
	if (record.approval !== undefined) {
		if (typeof record.approval !== "object" || record.approval === null || Array.isArray(record.approval)) {
			throw new Error(`managed policy ${sourcePath} has a non-object "approval" map`);
		}
		for (const [tool, value] of Object.entries(record.approval as Record<string, unknown>)) {
			if (typeof value !== "string" || POLICY_VALUES[value] !== true) {
				throw new Error(`managed policy ${sourcePath} has an invalid policy for "${tool}": ${String(value)}`);
			}
			approval[tool] = value as ManagedPolicyValue;
		}
	}
	const extensions: string[] = [];
	if (record.extensions !== undefined) {
		if (!Array.isArray(record.extensions)) {
			throw new Error(`managed policy ${sourcePath} has a non-array "extensions" list`);
		}
		for (const entry of record.extensions) {
			// Absolute paths only: a relative entry would resolve differently per
			// session cwd, and a silently missing audit hook is worse than a crash.
			if (typeof entry !== "string" || !path.isAbsolute(entry)) {
				throw new Error(`managed policy ${sourcePath} requires absolute extension paths, got: ${String(entry)}`);
			}
			extensions.push(entry);
		}
	}
	return { approvalMode, approval, extensions, sourcePath };
}

let cached: ManagedPolicy | null | undefined;

/**
 * Load the managed policy once per process. Synchronous by necessity:
 * {@link resolveApproval} runs on the tool-call hot path and is not async.
 */
export function getManagedPolicy(): ManagedPolicy | undefined {
	if (cached !== undefined) return cached ?? undefined;
	for (const candidate of candidatePolicyPaths()) {
		let text: string;
		try {
			text = fs.readFileSync(candidate.path, "utf-8");
		} catch (error) {
			if (candidate.required) {
				throw new Error(`managed policy ${candidate.path} could not be read: ${(error as Error).message}`);
			}
			continue;
		}
		cached = parsePolicy(text, candidate.path);
		return cached;
	}
	cached = null;
	return undefined;
}

/** Restricted approval directive for a tool, if the operator declared one. */
export function lookupManagedApproval(
	policy: ManagedPolicy | undefined,
	...keys: Array<string | undefined>
): ManagedPolicyValue | undefined {
	if (!policy) return undefined;
	for (const key of keys) {
		if (!key) continue;
		const value = policy.approval[key];
		if (value === "deny" || value === "prompt") return value;
	}
	const wildcard = policy.approval["*"];
	return wildcard === "deny" || wildcard === "prompt" ? wildcard : undefined;
}

/** Absolute extension paths the operator requires on every session. */
export function managedExtensionPaths(): readonly string[] {
	return getManagedPolicy()?.extensions ?? [];
}

/** Test-only: drop the cached policy so a rewritten file is re-read. */
export function __resetManagedPolicyCacheForTests(): void {
	cached = undefined;
}
