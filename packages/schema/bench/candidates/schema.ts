/** Pipeline: `type(def)` compiles lazily; each call returns data or Zero2AiErrors directly. */
import { Zero2AiErrors, type } from "../../src";
import type { Candidate } from "../candidate";
import type { Def } from "../ir";

export const omptypeCandidate: Candidate = {
	name: "schema",
	type(def: Def) {
		// Runtime-generated benchmark definitions cannot preserve the const generic.
		return type(def as never);
	},
	allows(def: Def) {
		const schema = type(def as never);
		return (value: unknown) => schema.allows(value);
	},
	isErrors: result => result instanceof Zero2AiErrors,
	summary: result => (result instanceof Zero2AiErrors ? result.summary : ""),
};
