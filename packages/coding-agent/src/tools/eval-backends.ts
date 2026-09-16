import { $flag } from "@zero2ai/utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/** Read per-backend allowance from settings (py/js default on). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
	};
}

/**
 * Materialize the active eval backend allowance: ZERO2AI_PY / ZERO2AI_JS
 * env flags override the per-key settings; otherwise settings win (py/js default on).
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const settings = readEvalBackendsAllowance(session);
	return {
		python: $flag("ZERO2AI_PY", settings.python),
		js: $flag("ZERO2AI_JS", settings.js),
	};
}
