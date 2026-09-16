/**
 * ArkType compatibility facade — `@zero2ai/schema/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the schema lazy-JIT runtime: swap `from "arktype"` for
 * `from "@zero2ai/schema/ark"` and nothing else changes. New code should
 * import `@zero2ai/schema` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `Zero2AiError` /
 * `Zero2AiErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { Zero2AiError, Zero2AiErrors } from "./errors";

export * from "./index";

export const ArkError = Zero2AiError;
export type ArkError = Zero2AiError;
export const ArkErrors = Zero2AiErrors;
export type ArkErrors = Zero2AiErrors;
