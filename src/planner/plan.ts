import { modelLabel } from "../config/schema.js";
import type { Assertion, ModelConfig, Suite } from "../config/schema.js";
import { interpolate } from "../config/interpolate.js";
import type { CompletionRequest } from "../providers/provider.js";

/**
 * Expande una suite en la lista de trials a ejecutar: caso × modelo × repetición (sección 5).
 * Función pura: no toca red ni disco.
 */

export interface Trial {
  /** Estable entre corridas: `caso/modelo/n`. Sirve para la caché, el baseline y Batches. */
  id: string;
  caseId: string;
  model: ModelConfig;
  /** `id` o `id@effort` (ver `modelLabel`): identifica al modelo en el id y en el reporte. */
  modelLabel: string;
  /** Número de repetición, empezando en 1. */
  trial: number;
  /** Petición lista para el proveedor, con las variables ya interpoladas. */
  request: CompletionRequest;
  assertions: readonly Assertion[];
}

export interface PlanOptions {
  /** Solo estos modelos: por id (todas sus variantes de effort) o por etiqueta `id@effort`. */
  models?: readonly string[];
  /** Solo estos casos (por id). */
  cases?: readonly string[];
  /** Reemplaza `defaults.trials` de la suite. */
  trials?: number;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export const trialId = (caseId: string, modelId: string, trial: number): string =>
  `${caseId}/${modelId}/${trial}`;

/**
 * Filtra por nombre y falla si algún filtro no coincide con nada (un typo no debe correr 0
 * trials). Cada elemento puede responder a varios nombres (un modelo, a su id y a su etiqueta).
 */
function pick<T>(
  items: readonly T[],
  namesOf: (t: T) => readonly string[],
  wanted: readonly string[] | undefined,
  what: string,
): T[] {
  if (wanted === undefined) return [...items];
  const available = [...new Set(items.flatMap(namesOf))];
  const unknown = wanted.filter((id) => !available.includes(id));
  if (unknown.length > 0) {
    throw new PlanError(
      `${what} desconocido${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. ` +
        `Disponibles: ${available.join(", ")}`,
    );
  }
  return items.filter((t) => namesOf(t).some((n) => wanted.includes(n)));
}

export function planSuite(suite: Suite, options: PlanOptions = {}): Trial[] {
  const trials = options.trials ?? suite.defaults.trials;
  if (!Number.isInteger(trials) || trials < 1) {
    throw new PlanError(
      `el número de trials debe ser un entero mayor que 0 (se recibió ${trials})`,
    );
  }
  const models = pick(suite.models, (m) => [m.id, modelLabel(m)], options.models, "modelo");
  const cases = pick(suite.cases, (c) => [c.id], options.cases, "caso");

  const plan: Trial[] = [];
  for (const c of cases) {
    // El cargador ya verificó que cada variable exista; interpolate igual falla si no.
    const user = interpolate(suite.prompt.user, c.vars);
    const system =
      suite.prompt.system === undefined ? undefined : interpolate(suite.prompt.system, c.vars);
    for (const model of models) {
      const label = modelLabel(model);
      for (let n = 1; n <= trials; n++) {
        const request: CompletionRequest = {
          model: model.id,
          user,
          maxTokens: suite.defaults.max_tokens,
          cacheSystem: suite.defaults.cache_system,
          ...(system === undefined ? {} : { system }),
          ...(model.effort === undefined ? {} : { effort: model.effort }),
        };
        plan.push({
          id: trialId(c.id, label, n),
          caseId: c.id,
          model,
          modelLabel: label,
          trial: n,
          request,
          assertions: c.expect,
        });
      }
    }
  }
  return plan;
}
