import { failed, gradeError, passed } from "../types.js";
import type { Grader } from "../types.js";

/** Calificadores sobre métricas del trial (latencia y costo). Funciones puras. */

export const latencyBelow: Grader<"latency_below"> = (output, a) =>
  output.latencyMs < a.ms
    ? passed(`tardó ${output.latencyMs} ms (límite ${a.ms} ms)`)
    : failed(`tardó ${output.latencyMs} ms, no menos de ${a.ms} ms`);

const usd = (n: number): string => `US$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;

export const costBelow: Grader<"cost_below"> = (_output, a, ctx) => {
  // Sin precio conocido no se puede afirmar nada: es un error de evaluación, no un aprobado.
  if (ctx.costUsd === undefined) {
    return gradeError("costo desconocido: el modelo no tiene precio registrado");
  }
  return ctx.costUsd < a.usd
    ? passed(`costó ${usd(ctx.costUsd)} (límite ${usd(a.usd)})`)
    : failed(`costó ${usd(ctx.costUsd)}, no menos de ${usd(a.usd)}`);
};
