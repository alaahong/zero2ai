/**
 * Cross-root sync for model configuration (`zero2ai sync`).
 *
 * The engine is plan/apply: {@link planRootSync} reads both roots and decides
 * what would change without writing anything, {@link applySyncPlan} performs the
 * pending writes. `--dry-run` is then just "plan and print", and every decision
 * is testable against temp directories.
 *
 * Three groups, in the order an operator reads them:
 *   - `models`      the source root's `models.yml` (custom providers, patch, discovery)
 *   - `settings`    model settings in the source root's `config.yml`
 *   - `credentials` active rows of the source root's `agent.db`
 *
 * Nothing is destructive by default: an existing file or an explicitly set
 * scalar is reported and left alone unless `force` is set; maps (`modelRoles`,
 * `modelTags`) merge entry by entry and the target wins a conflict. Credential
 * rows are written only after the CLI confirmed them — see `cli/sync-cli.ts`.
 */
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { YAML } from "bun";
import {
	AUTHENTICATED_SENTINEL,
	type AuthCredential,
	type AuthCredentialRow,
	readAuthCredentialRows,
	SqliteAuthCredentialStore,
} from "@zero2ai/ai";
import { credentialStoreMode } from "@zero2ai/ai/auth/credential-persistence";
import { getBaseConfigRoot, getConfigDirName } from "@zero2ai/utils";
import { getEnumValues, type ModelTagsSettings, type SettingValue } from "./settings-schema";
import type { Settings } from "./settings";

export const SYNC_GROUPS = ["models", "settings", "credentials"] as const;
export type SyncGroupId = (typeof SYNC_GROUPS)[number];

/** Model settings carried across roots; report order. */
export const SYNCED_SETTING_KEYS = [
	"modelRoles",
	"modelTags",
	"modelProviderOrder",
	"cycleOrder",
	"defaultThinkingLevel",
] as const;
export type SyncedSettingKey = (typeof SYNCED_SETTING_KEYS)[number];

/** Keys whose value is a map: entries merge, and the target wins a conflict. */
const MERGED_SETTING_KEYS: Readonly<Record<string, true>> = { modelRoles: true, modelTags: true };

/** Canonical model-config file name; `<root>/models.yaml` is read only when this is absent. */
const MODELS_FILE_NAME = "models.yml";
const MODELS_FALLBACK_NAME = "models.yaml";
const CREDENTIAL_DB_NAME = "agent.db";

/** `--from` names for the roots this tool ships with. */
const NAMED_SOURCES: Readonly<Record<string, string>> = { omp: ".omp", "oh-my-pi": ".omp", pi: ".pi" };

export interface SyncSource {
	/** What the operator typed, for reporting. */
	readonly label: string;
	readonly agentDir: string;
}

export type SyncAction = "create" | "update" | "same" | "skip";

/** One decision, as reported. `pending` marks the ones a non-dry run applies. */
export interface SyncNote {
	readonly group: SyncGroupId;
	readonly name: string;
	readonly action: SyncAction;
	readonly detail: string;
	readonly pending: boolean;
}

/** A write the plan decided on. Only {@link applySyncPlan} interprets these. */
export type SyncWrite =
	| { readonly group: "models"; readonly name: string; readonly path: string; readonly content: string }
	| { readonly group: "settings"; readonly key: SyncedSettingKey; readonly value: unknown }
	| { readonly group: "credentials"; readonly provider: string; readonly credential: AuthCredential };

export interface SyncPlan {
	readonly source: SyncSource;
	readonly targetAgentDir: string;
	readonly targetDbPath: string;
	readonly groups: readonly SyncGroupId[];
	readonly force: boolean;
	readonly notes: readonly SyncNote[];
	readonly writes: readonly SyncWrite[];
}

export interface SyncPlanOptions {
	readonly source: SyncSource;
	readonly targetAgentDir: string;
	readonly targetDbPath: string;
	/** Live settings of the target root: the source of truth for what it already sets. */
	readonly settings: Settings;
	readonly groups: readonly SyncGroupId[];
	readonly force: boolean;
}

export interface SyncApplyResult {
	readonly applied: readonly SyncNote[];
	/** Snapshot written before the first credential row was touched, if any. */
	readonly backupPath: string | null;
}

/** Resolve `--from` to an agent root: a known name, a config root, or an agent dir. */
export async function resolveSyncSource(from: string | undefined): Promise<SyncSource> {
	const requested = from?.trim() || "omp";
	if (requested === getConfigDirName() || requested === "zero2ai") {
		// The base root, so a named profile can pull from the unprefixed one.
		return { label: `${requested} (${getConfigDirName()})`, agentDir: path.join(getBaseConfigRoot(), "agent") };
	}
	const homeRelative = NAMED_SOURCES[requested];
	if (homeRelative) {
		return { label: `${requested} (~/${homeRelative})`, agentDir: path.join(os.homedir(), homeRelative, "agent") };
	}
	const resolved = path.resolve(requested);
	// Accept either the agent dir itself or the config root that holds it.
	if (await hasAnyRootFile(resolved)) return { label: requested, agentDir: resolved };
	const nested = path.join(resolved, "agent");
	if (await hasAnyRootFile(nested)) return { label: requested, agentDir: nested };
	return { label: requested, agentDir: resolved };
}

/** Whether a directory looks like an agent root: any of the files this command reads. */
async function hasAnyRootFile(dir: string): Promise<boolean> {
	for (const name of [MODELS_FILE_NAME, MODELS_FALLBACK_NAME, CREDENTIAL_DB_NAME, "config.yml", "config.yaml"]) {
		if (await Bun.file(path.join(dir, name)).exists()) return true;
	}
	return false;
}

export async function planRootSync(options: SyncPlanOptions): Promise<SyncPlan> {
	if (!(await hasAnyRootFile(options.source.agentDir))) {
		throw new Error(
			`No model configuration at ${options.source.agentDir} (looked for ${MODELS_FILE_NAME}, ${CREDENTIAL_DB_NAME}, config.yml).`,
		);
	}
	const notes: SyncNote[] = [];
	const writes: SyncWrite[] = [];
	if (options.groups.includes("models")) await planModels(options, notes, writes);
	if (options.groups.includes("settings")) await planSettings(options, notes, writes);
	if (options.groups.includes("credentials")) planCredentials(options, notes, writes);
	return {
		source: options.source,
		targetAgentDir: options.targetAgentDir,
		targetDbPath: options.targetDbPath,
		groups: options.groups,
		force: options.force,
		notes,
		writes,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// models
// ─────────────────────────────────────────────────────────────────────────────

async function planModels(options: SyncPlanOptions, notes: SyncNote[], writes: SyncWrite[]): Promise<void> {
	let sourcePath: string | undefined;
	for (const name of [MODELS_FILE_NAME, MODELS_FALLBACK_NAME]) {
		const candidate = path.join(options.source.agentDir, name);
		if (await Bun.file(candidate).exists()) {
			sourcePath = candidate;
			break;
		}
	}
	if (!sourcePath) {
		notes.push({
			group: "models",
			name: MODELS_FILE_NAME,
			action: "skip",
			detail: `${options.source.label} has no ${MODELS_FILE_NAME}`,
			pending: false,
		});
		return;
	}
	const content = await Bun.file(sourcePath).text();
	const targetPath = path.join(options.targetAgentDir, MODELS_FILE_NAME);
	const target = Bun.file(targetPath);
	if (!(await target.exists())) {
		if (await Bun.file(path.join(options.targetAgentDir, MODELS_FALLBACK_NAME)).exists()) {
			notes.push({
				group: "models",
				name: MODELS_FILE_NAME,
				action: options.force ? "create" : "skip",
				detail: options.force
					? `from ${path.basename(sourcePath)}; takes precedence over the existing ${MODELS_FALLBACK_NAME}`
					: `target root reads ${MODELS_FALLBACK_NAME}; --force writes ${MODELS_FILE_NAME}, which takes precedence`,
				pending: options.force,
			});
			if (options.force) writes.push({ group: "models", name: MODELS_FILE_NAME, path: targetPath, content });
			return;
		}
		notes.push({
			group: "models",
			name: MODELS_FILE_NAME,
			action: "create",
			detail: `from ${path.basename(sourcePath)}`,
			pending: true,
		});
		writes.push({ group: "models", name: MODELS_FILE_NAME, path: targetPath, content });
		return;
	}
	if ((await target.text()) === content) {
		notes.push({
			group: "models",
			name: MODELS_FILE_NAME,
			action: "same",
			detail: "identical to the source",
			pending: false,
		});
		return;
	}
	if (!options.force) {
		notes.push({
			group: "models",
			name: MODELS_FILE_NAME,
			action: "skip",
			detail: "differs from the source; --force overwrites it (after a backup)",
			pending: false,
		});
		return;
	}
	notes.push({
		group: "models",
		name: MODELS_FILE_NAME,
		action: "update",
		detail: "overwritten from the source (previous file backed up)",
		pending: true,
	});
	writes.push({ group: "models", name: MODELS_FILE_NAME, path: targetPath, content });
}

// ─────────────────────────────────────────────────────────────────────────────
// settings
// ─────────────────────────────────────────────────────────────────────────────

async function planSettings(options: SyncPlanOptions, notes: SyncNote[], writes: SyncWrite[]): Promise<void> {
	let sourcePath: string | undefined;
	for (const name of ["config.yml", "config.yaml"]) {
		const candidate = path.join(options.source.agentDir, name);
		if (await Bun.file(candidate).exists()) {
			sourcePath = candidate;
			break;
		}
	}
	if (!sourcePath) {
		notes.push({
			group: "settings",
			name: SYNCED_SETTING_KEYS.join(", "),
			action: "skip",
			detail: `${options.source.label} has no config.yml`,
			pending: false,
		});
		return;
	}
	let raw: unknown;
	try {
		raw = YAML.parse(await Bun.file(sourcePath).text());
	} catch (error) {
		notes.push({
			group: "settings",
			name: sourcePath,
			action: "skip",
			detail: `config.yml does not parse: ${error instanceof Error ? error.message : String(error)}`,
			pending: false,
		});
		return;
	}
	if (!isPlainObject(raw)) {
		notes.push({
			group: "settings",
			name: sourcePath,
			action: "skip",
			detail: "config.yml is not a mapping",
			pending: false,
		});
		return;
	}
	const targetGlobal = options.settings.getGlobalSettings();
	for (const key of SYNCED_SETTING_KEYS) {
		const sourceValue = readRawSetting(raw, key);
		if (sourceValue === undefined) continue;
		if (!settingValueFits(key, sourceValue)) {
			notes.push({
				group: "settings",
				name: key,
				action: "skip",
				detail: "source value does not match this setting's schema",
				pending: false,
			});
			continue;
		}
		const targetValue = readRawSetting(targetGlobal, key);
		if (targetValue === undefined) {
			notes.push({
				group: "settings",
				name: key,
				action: "create",
				detail: describeSettingValue(sourceValue),
				pending: true,
			});
			writes.push({ group: "settings", key, value: sourceValue });
			continue;
		}
		if (MERGED_SETTING_KEYS[key] === true) {
			const { merged, added } = mergeRecords(targetValue, sourceValue);
			if (added.length === 0) {
				notes.push({
					group: "settings",
					name: key,
					action: "same",
					detail: "every source entry is already set",
					pending: false,
				});
				continue;
			}
			notes.push({
				group: "settings",
				name: key,
				action: "update",
				detail: `adds ${added.join(", ")}`,
				pending: true,
			});
			writes.push({ group: "settings", key, value: merged });
			continue;
		}
		if (canonicalJson(targetValue) === canonicalJson(sourceValue)) {
			notes.push({ group: "settings", name: key, action: "same", detail: "already identical", pending: false });
			continue;
		}
		if (!options.force) {
			notes.push({
				group: "settings",
				name: key,
				action: "skip",
				detail: `target sets ${describeSettingValue(targetValue)}; --force replaces it`,
				pending: false,
			});
			continue;
		}
		notes.push({
			group: "settings",
			name: key,
			action: "update",
			detail: describeSettingValue(sourceValue),
			pending: true,
		});
		writes.push({ group: "settings", key, value: sourceValue });
	}
}

/** Read a setting from a raw config layer, accepting nested and flat dotted keys. */
function readRawSetting(raw: unknown, key: SyncedSettingKey): unknown {
	let current = raw;
	for (const segment of key.split(".")) {
		if (!isPlainObject(current)) return isPlainObject(raw) ? raw[key] : undefined;
		current = current[segment];
	}
	return current;
}

function settingValueFits(key: SyncedSettingKey, value: unknown): boolean {
	switch (key) {
		case "modelRoles":
			return isStringRecord(value);
		case "modelTags":
			return isModelTagsSettings(value);
		case "modelProviderOrder":
		case "cycleOrder":
			return isStringArray(value);
		case "defaultThinkingLevel":
			return isThinkingLevel(value);
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isPlainObject(value) && Object.values(value).every(entry => typeof entry === "string");
}

function isModelTagsSettings(value: unknown): value is ModelTagsSettings {
	return (
		isPlainObject(value) &&
		Object.values(value).every(entry => isPlainObject(entry) && typeof entry.name === "string")
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function isThinkingLevel(value: unknown): value is SettingValue<"defaultThinkingLevel"> {
	const allowed = getEnumValues("defaultThinkingLevel");
	return typeof value === "string" && allowed !== undefined && allowed.includes(value);
}

/** Merge source entries into the target map; the target wins a conflict. */
function mergeRecords(target: unknown, source: unknown): { merged: Record<string, unknown>; added: string[] } {
	const merged: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
	const added: string[] = [];
	if (isPlainObject(source)) {
		for (const [name, value] of Object.entries(source)) {
			if (merged[name] !== undefined) continue;
			merged[name] = value;
			added.push(name);
		}
	}
	return { merged, added };
}

function describeSettingValue(value: unknown): string {
	if (Array.isArray(value)) return `${value.length} entr${value.length === 1 ? "y" : "ies"}`;
	if (typeof value === "string") return value;
	if (isPlainObject(value)) return `${Object.keys(value).length} key(s)`;
	return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// credentials
// ─────────────────────────────────────────────────────────────────────────────

function planCredentials(options: SyncPlanOptions, notes: SyncNote[], writes: SyncWrite[]): void {
	if (credentialStoreMode() !== "local") {
		notes.push({
			group: "credentials",
			name: CREDENTIAL_DB_NAME,
			action: "skip",
			detail: "this host is configured broker-only (ZERO2AI_CREDENTIAL_STORE); no local credential writes",
			pending: false,
		});
		return;
	}
	const sourceRows = readAuthCredentialRows(path.join(options.source.agentDir, CREDENTIAL_DB_NAME));
	if (sourceRows.length === 0) {
		notes.push({
			group: "credentials",
			name: CREDENTIAL_DB_NAME,
			action: "skip",
			detail: `no credentials in ${options.source.label}`,
			pending: false,
		});
		return;
	}
	const present = new Set(readAuthCredentialRows(options.targetDbPath).map(credentialRowKey));
	let already = 0;
	let sentinels = 0;
	for (const row of sourceRows) {
		if (row.credential.type === "api_key" && row.credential.key === AUTHENTICATED_SENTINEL) {
			sentinels += 1;
			continue;
		}
		const key = credentialRowKey(row);
		if (present.has(key)) {
			already += 1;
			continue;
		}
		present.add(key);
		notes.push({
			group: "credentials",
			name: `${row.provider} (${credentialLabel(row)})`,
			action: "create",
			detail: "copied into the local store",
			pending: true,
		});
		writes.push({ group: "credentials", provider: row.provider, credential: row.credential });
	}
	if (already > 0) {
		notes.push({
			group: "credentials",
			name: CREDENTIAL_DB_NAME,
			action: "same",
			detail: `${already} credential(s) already present`,
			pending: false,
		});
	}
	if (sentinels > 0) {
		notes.push({
			group: "credentials",
			name: CREDENTIAL_DB_NAME,
			action: "skip",
			detail: `${sentinels} placeholder ${AUTHENTICATED_SENTINEL} entry skipped — authenticated out of band`,
			pending: false,
		});
	}
}

/** Store-row identity: provider + stored OAuth identity, else the credential's own content. */
function credentialRowKey(row: AuthCredentialRow): string {
	return `${row.provider}\u0000${row.identityKey ?? canonicalJson(row.credential)}`;
}

function credentialLabel(row: AuthCredentialRow): string {
	if (row.credential.type === "api_key") return "api key";
	const who = row.credential.email ?? row.credential.accountId ?? row.credential.orgName ?? row.credential.orgId;
	return who ? `oauth ${who}` : "oauth";
}

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perform the plan's writes. Files and settings land first; the credential store
 * is snapshotted once, before the first row it touches.
 */
export async function applySyncPlan(
	plan: SyncPlan,
	settings: Settings,
	now: Date = new Date(),
): Promise<SyncApplyResult> {
	const stamp = syncStamp(now);
	for (const write of plan.writes) {
		switch (write.group) {
			case "models": {
				const previous = Bun.file(write.path);
				if (await previous.exists()) await Bun.write(`${write.path}.pre-sync-${stamp}.bak`, previous);
				await Bun.write(write.path, write.content);
				break;
			}
			case "settings":
				// Narrowing guards, not casts: a hand-built plan still cannot write a
				// shape the schema would reject.
				switch (write.key) {
					case "modelRoles":
						if (isStringRecord(write.value)) settings.set("modelRoles", write.value);
						break;
					case "modelTags":
						if (isModelTagsSettings(write.value)) settings.set("modelTags", write.value);
						break;
					case "modelProviderOrder":
						if (isStringArray(write.value)) settings.set("modelProviderOrder", write.value);
						break;
					case "cycleOrder":
						if (isStringArray(write.value)) settings.set("cycleOrder", write.value);
						break;
					case "defaultThinkingLevel":
						if (isThinkingLevel(write.value)) settings.set("defaultThinkingLevel", write.value);
						break;
				}
				break;
			case "credentials":
				break; // Batched below, so one snapshot covers the whole group.
		}
	}
	if (plan.writes.some(write => write.group === "settings")) await settings.flush();

	const credentialWrites = plan.writes.filter(write => write.group === "credentials");
	let backupPath: string | null = null;
	if (credentialWrites.length > 0) {
		backupPath = await backupCredentialStore(plan.targetDbPath, stamp);
		const store = await SqliteAuthCredentialStore.open(plan.targetDbPath);
		try {
			for (const write of credentialWrites) store.upsertAuthCredentialForProvider(write.provider, write.credential);
		} finally {
			store.close();
		}
	}
	return { applied: plan.notes.filter(note => note.pending), backupPath };
}

/**
 * Snapshot the target credential store. `VACUUM INTO` rather than a byte copy:
 * the store runs in WAL mode, where copying the file alone can capture a torn
 * state.
 */
async function backupCredentialStore(dbPath: string, stamp: string): Promise<string | null> {
	if (!(await Bun.file(dbPath).exists())) return null;
	const backupPath = `${dbPath}.pre-sync-${stamp}.bak`;
	const db = new Database(dbPath, { readonly: true });
	try {
		db.run("VACUUM INTO ?", [backupPath]);
	} finally {
		db.close();
	}
	return backupPath;
}

/** Local-time `YYYYMMDD-HHmmss`, matching the pre-migration backup naming. */
export function syncStamp(now: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, so two config layers compare structurally. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (!isPlainObject(value)) return JSON.stringify(value) ?? "null";
	const entries = Object.keys(value)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
	return `{${entries.join(",")}}`;
}
