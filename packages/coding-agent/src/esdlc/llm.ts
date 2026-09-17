/**
 * One-shot model access for ESDLC document phases.
 *
 * Deliberately thin: model resolution reuses the same registry/role chain as
 * other one-shot generators, so `--model`, provider credentials and the usage
 * policy stay consistent with the rest of the CLI.
 */
import { type AssistantMessage, completeSimple } from "@zero2ai/ai";
import { type ResolvedCommitModel, resolvePrimaryModel } from "../commit/model-selection";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";

export interface EsdlcCompletion {
	readonly text: string;
	readonly model: string;
}

/** What one model call cost, for the UI's execution trail. */
export interface EsdlcCallSummary {
	readonly model: string;
	readonly promptChars: number;
	readonly responseChars: number;
	readonly durationMs: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly stopReason?: string;
	readonly error?: string;
	/** The material the call ran on and produced, so the trail can show the real work. */
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly text: string;
	/** Native reasoning, when the provider returns it. */
	readonly thinking?: string;
}

export interface EsdlcCompletionOptions {
	readonly cwd: string;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly model?: string;
	readonly maxTokens?: number;
	readonly signal?: AbortSignal;
	/** Invoked once per call, success or failure, with timing, usage and content. */
	readonly onCall?: (summary: EsdlcCallSummary) => void | Promise<void>;
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
		// The role chain ("commit → smol → any") can come up empty on hosts whose
		// bound providers are not role-mapped (a single gateway, a local runtime).
		// Any provider the host can actually reach beats refusing to work.
		// An explicitly requested model must fail loudly when it cannot resolve —
		// silently running a different one would misreport what produced a document.
		const fallback = options.model ? undefined : registry.getAvailable()[0];
		if (!fallback) {
			throw new Error(
				`ESDLC needs a language model for this phase, but none is usable: ${(error as Error).message}\n` +
					`Configure a provider (see \`zero2ai models\`), or pass --model <provider/model>.`,
			);
		}
		target = { model: fallback, apiKey: registry.resolver(fallback) };
	}
	const startedAt = Date.now();
	const promptChars = options.systemPrompt.length + options.userPrompt.length;
	let message: AssistantMessage;
	try {
		message = await completeSimple(
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
	} catch (error) {
		await options.onCall?.({
			model: `${target.model.provider}/${target.model.id}`,
			promptChars,
			responseChars: 0,
			durationMs: Date.now() - startedAt,
			error: (error as Error).message,
			systemPrompt: options.systemPrompt,
			userPrompt: options.userPrompt,
			text: "",
		});
		throw error;
	}
	const text = message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
	const thinking = message.content
		.filter(block => block.type === "thinking")
		.map(block => block.thinking)
		.join("\n\n")
		.trim();
	await options.onCall?.({
		...(thinking ? { thinking } : {}),
		systemPrompt: options.systemPrompt,
		userPrompt: options.userPrompt,
		text,
		model: `${target.model.provider}/${target.model.id}`,
		promptChars,
		responseChars: text.length,
		durationMs: Date.now() - startedAt,
		...(message.usage ? { inputTokens: message.usage.input, outputTokens: message.usage.output } : {}),
		stopReason: message.stopReason,
	});
	if (message.stopReason === "error") {
		throw new Error(`model call failed: ${message.errorMessage ?? "provider error"}`);
	}
	if (!text) throw new Error("model returned an empty response");
	return { text, model: `${target.model.provider}/${target.model.id}` };
}
