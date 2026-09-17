/**
 * Cross-root model-config sync (`zero2ai sync`) contracts.
 *
 * Every case here is about what an operator ends up with on disk after the
 * command: the model file they now have, the role bindings they can still rely
 * on, and the credentials that did or did not move between stores. The
 * non-destructive rules (skip unless `force`, target wins a role conflict) are
 * the ones worth locking down — a silent overwrite would be unrecoverable.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore, readAuthCredentialRows } from "@zero2ai/ai";
import { Effort } from "@zero2ai/catalog/effort";
import { Settings } from "@zero2ai/coding-agent/config/settings";
import {
	applySyncPlan,
	planRootSync,
	resolveSyncSource,
	type SyncPlan,
	type SyncSource,
} from "@zero2ai/coding-agent/config/root-sync";
import { TempDir } from "@zero2ai/utils";

let temp: TempDir;
let sourceRoot: string;
let sourceDir: string;
let targetDir: string;

beforeEach(() => {
	// TempDir retries on the Windows EBUSY that a just-closed SQLite handle leaves behind.
	temp = TempDir.createSync("@zero2ai-root-sync-");
	sourceRoot = temp.join("source");
	sourceDir = temp.join("source", "agent");
	targetDir = temp.join("target");
	fs.mkdirSync(sourceDir, { recursive: true });
	fs.mkdirSync(targetDir, { recursive: true });
});

afterEach(async () => {
	await temp.remove();
});

function source(): SyncSource {
	return { label: "test", agentDir: sourceDir };
}

async function plan(settings: Settings, force = false): Promise<SyncPlan> {
	return planRootSync({
		source: source(),
		targetAgentDir: targetDir,
		targetDbPath: path.join(targetDir, "agent.db"),
		settings,
		groups: ["models", "settings", "credentials"],
		force,
	});
}

/** Seed a credential store at `dbPath` with one api key for `provider`. */
async function seedCredential(dbPath: string, provider: string, key: string): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	try {
		store.upsertAuthCredentialForProvider(provider, { type: "api_key", key });
	} finally {
		store.close();
	}
}

describe("models.yml", () => {
	it("copies the source file when the target has none", async () => {
		fs.writeFileSync(path.join(sourceDir, "models.yml"), "providers:\n  corp:\n    baseUrl: https://corp/v1\n");
		const settings = Settings.isolated();
		const planned = await plan(settings);
		expect(planned.notes.find(note => note.group === "models")?.action).toBe("create");

		await applySyncPlan(planned, settings);
		expect(await Bun.file(path.join(targetDir, "models.yml")).text()).toContain("baseUrl: https://corp/v1");
	});

	it("leaves a diverged target alone until forced, then keeps a backup", async () => {
		fs.writeFileSync(path.join(sourceDir, "models.yml"), "providers:\n  corp:\n    baseUrl: https://source/v1\n");
		fs.writeFileSync(path.join(targetDir, "models.yml"), "providers:\n  corp:\n    baseUrl: https://local/v1\n");
		const settings = Settings.isolated();

		const unforced = await plan(settings);
		expect(unforced.notes.find(note => note.group === "models")?.action).toBe("skip");
		expect(unforced.writes.some(write => write.group === "models")).toBe(false);
		expect(await Bun.file(path.join(targetDir, "models.yml")).text()).toContain("https://local/v1");

		const forced = await plan(settings, true);
		const result = await applySyncPlan(forced, settings);
		expect(await Bun.file(path.join(targetDir, "models.yml")).text()).toContain("https://source/v1");
		const backups = fs.readdirSync(targetDir).filter(name => name.startsWith("models.yml.pre-sync-"));
		expect(backups).toHaveLength(1);
		expect(await Bun.file(path.join(targetDir, backups[0] ?? "")).text()).toContain("https://local/v1");
		expect(result.applied.some(note => note.group === "models")).toBe(true);
	});

	it("reports a source without model configuration instead of writing nothing", async () => {
		await expect(plan(Settings.isolated())).rejects.toThrow(/No model configuration/);
	});
});

describe("model settings", () => {
	it("adds the source's roles and keeps the target's own binding", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "config.yml"),
			"modelRoles:\n  default: source/source-model\n  smol: source/smol-model\ndefaultThinkingLevel: low\n",
		);
		const settings = Settings.isolated();
		settings.set("modelRoles", { default: "local/local-model" });

		const planned = await plan(settings);
		const roles = planned.notes.find(note => note.name === "modelRoles");
		expect(roles?.action).toBe("update");
		expect(roles?.detail).toContain("smol");
		expect(planned.notes.find(note => note.name === "defaultThinkingLevel")?.action).toBe("create");

		await applySyncPlan(planned, settings);
		expect(settings.get("modelRoles")).toEqual({ default: "local/local-model", smol: "source/smol-model" });
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
	});

	it("skips a scalar the target already sets unless forced", async () => {
		fs.writeFileSync(path.join(sourceDir, "config.yml"), "defaultThinkingLevel: low\n");
		const settings = Settings.isolated();
		settings.set("defaultThinkingLevel", Effort.High);

		const unforced = await plan(settings);
		expect(unforced.notes.find(note => note.name === "defaultThinkingLevel")?.action).toBe("skip");
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.High);

		await applySyncPlan(await plan(settings, true), settings);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
	});
});

describe("credentials", () => {
	it("copies missing rows, keeps existing ones, and snapshots the store first", async () => {
		await seedCredential(path.join(sourceDir, "agent.db"), "anthropic", "sk-source");
		const targetDb = path.join(targetDir, "agent.db");
		await seedCredential(targetDb, "openai", "sk-existing");
		const settings = Settings.isolated();

		const planned = await plan(settings);
		const created = planned.notes.filter(note => note.group === "credentials" && note.action === "create");
		expect(created).toHaveLength(1);
		expect(created[0]?.name).toContain("anthropic");

		const result = await applySyncPlan(planned, settings);
		const backupPath = result.backupPath;
		expect(backupPath).not.toBeNull();
		expect(backupPath !== null && fs.existsSync(backupPath)).toBe(true);
		expect(
			readAuthCredentialRows(targetDb)
				.map(row => row.provider)
				.sort(),
		).toEqual(["anthropic", "openai"]);

		// Re-running is a no-op: same-provider rows are matched by identity.
		const again = await plan(settings);
		expect(again.writes.some(write => write.group === "credentials")).toBe(false);
		expect(again.notes.find(note => note.group === "credentials" && note.action === "same")?.detail).toContain(
			"already present",
		);
	});
});

describe("resolveSyncSource", () => {
	it("accepts a known name, a config root, and an agent dir", async () => {
		expect((await resolveSyncSource("omp")).agentDir).toBe(path.join(os.homedir(), ".omp", "agent"));

		fs.writeFileSync(path.join(sourceDir, "agent.db"), "");
		expect((await resolveSyncSource(sourceDir)).agentDir).toBe(sourceDir);
		expect((await resolveSyncSource(sourceRoot)).agentDir).toBe(sourceDir);
	});
});
