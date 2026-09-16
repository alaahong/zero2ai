/**
 * Store-level credential persistence policy.
 *
 * Proves the guard is wired into the SQLite store: a `broker-only` host gains
 * no new credential rows, while credentials stored earlier keep resolving so a
 * machine stays usable until it is migrated to the broker.
 *
 * Needs the native addon (`bun --cwd=packages/natives run build`), because the
 * store resolves its default path through `@zero2ai/utils`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "../src/auth/sqlite-credential-store";

let tempDir: string;
let previousMode: string | undefined;

beforeEach(() => {
	previousMode = process.env.ZERO2AI_CREDENTIAL_STORE;
	delete process.env.ZERO2AI_CREDENTIAL_STORE;
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero2ai-credential-store-"));
});

afterEach(() => {
	if (previousMode === undefined) delete process.env.ZERO2AI_CREDENTIAL_STORE;
	else process.env.ZERO2AI_CREDENTIAL_STORE = previousMode;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const dbPath = () => path.join(tempDir, "agent.db");

describe("local mode", () => {
	it("round-trips a stored API key", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath());
		store.saveApiKey("openai", "sk-live");
		expect(store.getApiKey("openai")).toBe("sk-live");
		store.close();
	});
});

describe("broker-only mode", () => {
	it("refuses new API keys", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath());
		process.env.ZERO2AI_CREDENTIAL_STORE = "broker-only";
		expect(() => store.saveApiKey("openai", "sk-live")).toThrow(/broker-only/);
		expect(store.getApiKey("openai")).toBeNull();
		store.close();
	});

	it("refuses direct credential upserts", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath());
		process.env.ZERO2AI_CREDENTIAL_STORE = "broker-only";
		expect(() => store.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "sk-x" })).toThrow(
			/broker-only/,
		);
		store.close();
	});

	it("still serves credentials stored before the policy took effect", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath());
		store.saveApiKey("openai", "sk-migrating");
		process.env.ZERO2AI_CREDENTIAL_STORE = "broker-only";
		expect(store.getApiKey("openai")).toBe("sk-migrating");
		store.close();
	});
});
