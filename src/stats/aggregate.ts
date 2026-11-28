import type { SuiteResult, TrialResult } from "../runner/evaluate.js";

/**
 * Estadísticas de una corrida (sección 10). Funciones puras.
 *
 * - Tasa del caso = trials aprobados / trials ejecutados (los omitidos por un aborto no cuentan;
 *   un trial con error del proveedor sí cuenta, como no aprobado).
 * - Tasa de la suite (por modelo) = promedio de las tasas de sus casos: cada caso pesa igual,
 *   tenga los trials que tenga.
 * - Caso inestable (flaky): aprueba en unos trials y falla en otros.
 * - Un modelo cumple si su tasa es ≥ `thresholds.pass_rate`; la suite aprueba si cumplen todos.
 */

export interface CaseStats {
  caseId: string;
  model: string;
  executed: number;
  passed: number;
  errors: number;
  rate: number;
  flaky: boolean;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelStats {
  model: string;
  executed: number;
  passed: number;
  errors: number;
  skipped: number;
  /** `null` si no se ejecutó ningún trial (por ejemplo, tras un aborto). */
  passRate: number | null;
  meetsThreshold: boolean;
  flakyCases: string[];
  failingCases: string[];
  latency: { p50: number; p95: number } | null;
  tokens: TokenTotals;
}

export interface SuiteStats {
  models: ModelStats[];
  cases: CaseStats[];
  pass: boolean;
}

/** Percentil por el método del rango más cercano: siempre devuelve un valor observado. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError("percentile de una lista vacía");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
}

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Agrupa conservando el orden de primera aparición (el orden del plan). */
function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function caseStats(caseId: string, model: string, trials: readonly TrialResult[]): CaseStats {
  const executed = trials.filter((t) => t.status !== "skipped");
  const passed = executed.filter((t) => t.pass).length;
  return {
    caseId,
    model,
    executed: executed.length,
    passed,
    errors: executed.filter((t) => t.status === "error").length,
    rate: executed.length === 0 ? 0 : passed / executed.length,
    flaky: passed > 0 && passed < executed.length,
  };
}

export function aggregate(result: SuiteResult): SuiteStats {
  const cases: CaseStats[] = [];
  const models: ModelStats[] = [];

  for (const [model, trials] of groupBy(result.results, (t) => t.model)) {
    const perCase = [...groupBy(trials, (t) => t.caseId)].map(([caseId, ts]) =>
      caseStats(caseId, model, ts),
    );
    cases.push(...perCase);

    const ran = perCase.filter((c) => c.executed > 0);
    const passRate = ran.length === 0 ? null : mean(ran.map((c) => c.rate));
    const completions = trials.flatMap((t) => (t.completion ? [t.completion] : []));
    const latencies = completions.map((c) => c.latencyMs);
    const tokens = completions.reduce<TokenTotals>(
      (acc, c) => ({
        input: acc.input + c.usage.input,
        output: acc.output + c.usage.output,
        cacheRead: acc.cacheRead + c.usage.cacheRead,
        cacheWrite: acc.cacheWrite + c.usage.cacheWrite,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );

    models.push({
      model,
      executed: ran.reduce((s, c) => s + c.executed, 0),
      passed: ran.reduce((s, c) => s + c.passed, 0),
      errors: ran.reduce((s, c) => s + c.errors, 0),
      skipped: trials.filter((t) => t.status === "skipped").length,
      passRate,
      meetsThreshold: passRate !== null && passRate >= result.thresholds.pass_rate,
      flakyCases: perCase.filter((c) => c.flaky).map((c) => c.caseId),
      failingCases: perCase.filter((c) => c.executed > 0 && c.passed === 0).map((c) => c.caseId),
      latency:
        latencies.length === 0
          ? null
          : { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
      tokens,
    });
  }

  return {
    models,
    cases,
    pass:
      result.aborted === undefined && models.length > 0 && models.every((m) => m.meetsThreshold),
  };
}
