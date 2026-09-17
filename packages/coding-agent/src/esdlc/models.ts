/**
 * Bound-model discovery for the ESDLC workspace.
 *
 * Answers "what can this machine already run?" from the same sources every
 * other entry point uses — auth storage (broker / env / `agent.db`), settings,
 * and the model registry — so the web UI never asks for credentials the CLI
 * would not also use.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { getAgentDbPath, getConfigDirName } from "@zero2ai/utils";
import { resolvePrimaryModel } from "../commit/model-selection";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";

export interface BoundModelSummary {
	readonly id: string;
	readonly provider: string;
	readonly label: string;
}

export interface BoundModels {
	/** Model the phase runner would pick when no explicit choice is made. */
	readonly default: BoundModelSummary | null;
	/** Human-readable description of the default chain. */
	readonly defaultLabel: string;
	/** Every model whose provider has usable credentials on this host. */
	readonly available: readonly BoundModelSummary[];
	/** Config root the credentials were read from (e.g. `.zero2ai`). */
	readonly configRoot: string;
	/**
	 * Pre-rename root when this host still has one. Credentials bound there are
	 * invisible to the current root, which is the usual reason a custom provider
	 * "disappears" after the rename — surface it instead of leaving users guessing.
	 */
	readonly legacyRoot: { readonly dirName: string; readonly hasConfig: boolean } | null;
}

const LEGACY_CONFIG_DIR_NAME = ".omp";

/** Rows in a root's credential store; 0 when the file or table is missing. */
function countCredentials(dbPath: string): number {
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db.query("SELECT COUNT(*) AS n FROM auth_credentials").get() as { n: number } | null;
			return row?.n ?? 0;
		} finally {
			db.close();
		}
	} catch {
		return 0;
	}
}

/**
 * Report the pre-rename root only when it plausibly explains a missing provider:
 * the active root has no credentials at all while the legacy one has some.
 * After a migration both roots hold credentials and the notice stays silent.
 */
function detectLegacyRoot(activeDirName: string): BoundModels["legacyRoot"] {
	if (activeDirName === LEGACY_CONFIG_DIR_NAME) return null;
	try {
		const legacyAgentDir = path.join(os.homedir(), LEGACY_CONFIG_DIR_NAME, "agent");
		if (!fs.existsSync(legacyAgentDir)) return null;
		if (countCredentials(getAgentDbPath()) > 0) return null;
		if (countCredentials(path.join(legacyAgentDir, "agent.db")) === 0) return null;
		return { dirName: LEGACY_CONFIG_DIR_NAME, hasConfig: fs.existsSync(path.join(legacyAgentDir, "config.yml")) };
	} catch {
		return null;
	}
}

const DEFAULT_LABEL = "默认（commit → smol → 任一已绑定）";

function summarize(model: { id: string; provider: string }): BoundModelSummary {
	return { id: model.id, provider: model.provider, label: `${model.provider}/${model.id}` };
}

/** List the models this host can already run, plus the implicit default. */
export async function listBoundModels(cwd: string): Promise<BoundModels> {
	const authStorage = await discoverAuthStorage();
	const settings = await Settings.init({ cwd });
	const registry = new ModelRegistry(authStorage);
	const available = registry.getAvailable().map(summarize).sort((a, b) => a.label.localeCompare(b.label));
	let resolved: BoundModelSummary | null = null;
	try {
		resolved = summarize((await resolvePrimaryModel(undefined, settings, registry)).model);
	} catch {
		// Mirror `generateText`: when the role chain has no candidate, the first
		// bound model is what a run would actually use.
		const fallback = registry.getAvailable()[0];
		resolved = fallback ? summarize(fallback) : null;
	}
	const configRoot = getConfigDirName();
	return {
		default: resolved,
		defaultLabel: DEFAULT_LABEL,
		available,
		configRoot,
		legacyRoot: detectLegacyRoot(configRoot),
	};
}
