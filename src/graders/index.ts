import type { Assertion } from "../config/schema.js";
import type { CompletionResult } from "../providers/provider.js";
import { jsonPathEquals, jsonSchema, jsonValid } from "./deterministic/json.js";
import { costBelow, latencyBelow } from "./deterministic/metrics.js";
import { contains, equals, maxLength, notContains, regex } from "./deterministic/text.js";
import { gradeError } from "./types.js";
import type { GradeContext, GradeResult } from "./types.js";

export * from "./types.js";
export { parseJsonResponse, getPath } from "./json.js";
export { describeSchemaError } from "./deterministic/json.js";

/** Evalúa una aserción. Nunca lanza: un fallo inesperado del calificador es un error de evaluación. */
export async function gradeAssertion(
  output: CompletionResult,
  assertion: Assertion,
  ctx: GradeContext = {},
): Promise<GradeResult> {
  try {
    switch (assertion.type) {
      case "equals":
        return await equals(output, assertion, ctx);
      case "contains":
        return await contains(output, assertion, ctx);
      case "not_contains":
        return await notContains(output, assertion, ctx);
      case "regex":
        return await regex(output, assertion, ctx);
      case "max_length":
        return await maxLength(output, assertion, ctx);
      case "json_valid":
        return await jsonValid(output, assertion, ctx);
      case "json_schema":
        return await jsonSchema(output, assertion, ctx);
      case "json_path_equals":
        return await jsonPathEquals(output, assertion, ctx);
      case "latency_below":
        return await latencyBelow(output, assertion, ctx);
      case "cost_below":
        return await costBelow(output, assertion, ctx);
      case "llm_judge":
        // Llega con el issue 11 (juez con salida estructurada).
        return gradeError("el calificador llm_judge todavía no está implementado");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return gradeError(`falló el calificador ${assertion.type}: ${message}`);
  }
}

export interface TrialGrade {
  grades: GradeResult[];
  /** El trial aprueba si todas sus aserciones aprueban (sección 6). */
  pass: boolean;
  /** Promedio de los puntajes ponderado por `weight`; no decide la aprobación. */
  score: number;
}

export async function gradeTrial(
  output: CompletionResult,
  assertions: readonly Assertion[],
  ctx: GradeContext = {},
): Promise<TrialGrade> {
  const grades = await Promise.all(assertions.map((a) => gradeAssertion(output, a, ctx)));
  const totalWeight = assertions.reduce((sum, a) => sum + a.weight, 0);
  const weighted = grades.reduce((sum, g, i) => sum + g.score * (assertions[i]?.weight ?? 0), 0);
  return {
    grades,
    pass: grades.every((g) => g.pass),
    score: totalWeight === 0 ? 0 : weighted / totalWeight,
  };
}
