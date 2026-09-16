/**
 * Credential persistence policy (`ZERO2AI_CREDENTIAL_STORE`).
 *
 * Contract: only explicitly recognized spellings disable local persistence;
 * anything else — including typos — keeps the store usable, because silently
 * refusing to save credentials would lock users out of the product.
 *
 * The store-level integration (that a blocked write never reaches SQLite) lives
 * in `credential-store-persistence.test.ts`, which needs the native addon.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	assertCredentialPersistenceAllowed,
	credentialStoreMode,
} from "../src/auth/credential-persistence";

let previousMode: string | undefined;

beforeEach(() => {
	previousMode = process.env.ZERO2AI_CREDENTIAL_STORE;
	delete process.env.ZERO2AI_CREDENTIAL_STORE;
});

afterEach(() => {
	if (previousMode === undefined) delete process.env.ZERO2AI_CREDENTIAL_STORE;
	else process.env.ZERO2AI_CREDENTIAL_STORE = previousMode;
});

describe("credentialStoreMode", () => {
	it("defaults to local when unset", () => {
		expect(credentialStoreMode()).toBe("local");
	});

	it("treats the documented spellings as broker-only", () => {
		for (const value of ["broker-only", "BROKER-ONLY", " broker ", "none", "off"]) {
			process.env.ZERO2AI_CREDENTIAL_STORE = value;
			expect(credentialStoreMode()).toBe("broker-only");
		}
	});

	it("keeps local mode for unrecognized values so a typo cannot lock users out", () => {
		process.env.ZERO2AI_CREDENTIAL_STORE = "brokeronly";
		expect(credentialStoreMode()).toBe("local");
	});
});

describe("assertCredentialPersistenceAllowed", () => {
	it("allows writes in local mode", () => {
		expect(() => assertCredentialPersistenceAllowed("openai")).not.toThrow();
	});

	it("rejects writes in broker-only mode with the remediation path", () => {
		process.env.ZERO2AI_CREDENTIAL_STORE = "broker-only";
		expect(() => assertCredentialPersistenceAllowed("openai")).toThrow(/broker-only/);
		expect(() => assertCredentialPersistenceAllowed("openai")).toThrow(/ZERO2AI_AUTH_BROKER_URL/);
		expect(() => assertCredentialPersistenceAllowed("openai")).toThrow(/openai/);
	});
});
