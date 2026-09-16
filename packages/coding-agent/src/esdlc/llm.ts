/**
 * One-shot model access for ESDLC document phases.
 *
 * Deliberately thin: model resolution reuses the same registry/role chain as
 * other one-shot generators, so `--model`, provider credentials and the usage
 * policy stay consistent with the rest of the CLI.
 */
import { completeSimple } from "@zero2ai/ai";
import { type ResolvedCommitModel, resolvePrimaryModel } from "../commit/model-selection";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";

export interface EsdlcCompletion {
	readonly text: string;
	readonly model: string;
}

export interface EsdlcCompletionOptions {
	readonly cwd: string;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly model?: string;
	readonly maxTokens?: number;
	readonly signal?: AbortSignal;
}

/** Generate one document body. Throws with an actionable message when no model is usable. */
export async function generateText(options: EsdlcCompletionOptions): Promise<EsdlcCompletion> {
	const authStorage = await discoverAuthStorage();
	const settings = await Settings.init({ cwd: options.cwd });
	const registry = new ModelRegistry(authStorage);
	let target: ResolvedCommitModel;
	try {
		target = await resolvePrimaryModel(options.model, settings, registry);
	} catch (error) {
		throw new Error(
			`ESDLC needs a language model for this phase, but none is usable: ${(error as Error).message}\n` +
				`Configure a provider (see \`zero2ai models\`), or pass --model <provider/model>.`,
		);
	}
	const message = await completeSimple(
		target.model,
		{
			systemPrompt: options.systemPrompt.trim() ? [options.systemPrompt] : undefined,
			messages: [{ role: "user", content: options.userPrompt, timestamp: Date.now() }],
		},
		{
			apiKey: target.apiKey,
			maxTokens: options.maxTokens ?? 8192,
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
	if (message.stopReason === "error") {
		throw new Error(`model call failed: ${message.errorMessage ?? "provider error"}`);
	}
	const text = message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("model returned an empty response");
	return { text, model: `${target.model.provider}/${target.model.id}` };
}
