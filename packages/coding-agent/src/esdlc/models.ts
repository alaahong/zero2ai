/**
 * Bound-model discovery for the ESDLC workspace.
 *
 * Answers "what can this machine already run?" from the same sources every
 * other entry point uses — auth storage (broker / env / `agent.db`), settings,
 * and the model registry — so the web UI never asks for credentials the CLI
 * would not also use.
 */
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
	return { default: resolved, defaultLabel: DEFAULT_LABEL, available };
}
