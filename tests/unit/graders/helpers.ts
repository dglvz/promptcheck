import { Assertion } from "../../../src/config/schema.js";
import type { CompletionResult } from "../../../src/providers/provider.js";

/** Respuesta mínima para calificar. */
export const out = (text: string, overrides: Partial<CompletionResult> = {}): CompletionResult => ({
  text,
  stopReason: "end_turn",
  model: "claude-haiku-5-5",
  latencyMs: 100,
  usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  ...overrides,
});

/** Aserción validada por el esquema real, con sus valores por defecto aplicados. */
export const assertion = (input: Record<string, unknown>) => Assertion.parse(input);
