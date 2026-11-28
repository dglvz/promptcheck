import { describe, expect, it } from "vitest";
import type { SuiteResult, TrialResult } from "../../../src/runner/evaluate.js";
import { aggregate, percentile } from "../../../src/stats/aggregate.js";

let seq = 0;
/** Trial completado (o con el estado indicado) con latencia y tokens fijos. */
export function trial(
  caseId: string,
  model: string,
  pass: boolean,
  overrides: Partial<TrialResult> = {},
): TrialResult {
  seq++;
  return {
    id: `${caseId}/${model}/${seq}`,
    caseId,
    model,
    trial: seq,
    status: "completed",
    completion: {
      text: "x",
      stopReason: "end_turn",
      model,
      latencyMs: 100 * seq,
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
    },
    grades: [],
    pass,
    score: pass ? 1 : 0,
    ...overrides,
  };
}

const suite = (results: TrialResult[], pass_rate = 0.9, aborted?: SuiteResult["aborted"]) =>
  ({
    name: "S",
    file: "s.yaml",
    thresholds: { pass_rate, max_regression: 0.05 },
    results,
    ...(aborted ? { aborted } : {}),
  }) satisfies SuiteResult;

describe("percentile", () => {
  it.each([
    [[5], 50, 5],
    [[5], 95, 5],
    [[1, 2, 3, 4], 50, 2],
    [[4, 1, 3, 2], 95, 4],
    [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50, 50],
    [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95, 100],
    [[1, 2, 3], 0, 1],
  ])("%j p%i = %i", (values, p, expected) => {
    expect(percentile(values, p)).toBe(expected);
  });

  it("rechaza una lista vacía", () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
  });
});

describe("aggregate", () => {
  it("la tasa de la suite es el promedio de las tasas de los casos (cada caso pesa igual)", () => {
    const stats = aggregate(
      suite([
        // caso a: 1/1; caso b: 1/3 → (1 + 1/3) / 2 = 2/3 (no 2/4)
        trial("a", "m", true),
        trial("b", "m", true),
        trial("b", "m", false),
        trial("b", "m", false),
      ]),
    );
    expect(stats.models[0]?.passRate).toBeCloseTo(2 / 3);
    expect(stats.models[0]).toMatchObject({ executed: 4, passed: 2, meetsThreshold: false });
    expect(stats.pass).toBe(false);
  });

  it("separa por modelo y conserva el orden del plan", () => {
    const stats = aggregate(
      suite([trial("a", "opus", true), trial("a", "haiku", false), trial("b", "opus", true)]),
    );
    expect(stats.models.map((m) => [m.model, m.passRate])).toEqual([
      ["opus", 1],
      ["haiku", 0],
    ]);
    expect(stats.cases.map((c) => `${c.caseId}/${c.model}`)).toEqual([
      "a/opus",
      "b/opus",
      "a/haiku",
    ]);
  });

  it("marca casos inestables y casos que fallan siempre", () => {
    const stats = aggregate(
      suite([
        trial("estable", "m", true),
        trial("estable", "m", true),
        trial("flaky", "m", true),
        trial("flaky", "m", false),
        trial("roto", "m", false),
        trial("roto", "m", false),
      ]),
    );
    expect(stats.models[0]?.flakyCases).toEqual(["flaky"]);
    expect(stats.models[0]?.failingCases).toEqual(["roto"]);
    expect(stats.cases.find((c) => c.caseId === "flaky")).toMatchObject({
      executed: 2,
      passed: 1,
      rate: 0.5,
      flaky: true,
    });
  });

  it("los errores cuentan como no aprobados; los omitidos no cuentan", () => {
    const stats = aggregate(
      suite([
        trial("a", "m", true),
        trial("a", "m", false, {
          status: "error",
          completion: null,
          error: { kind: "rate_limit", message: "x", fatal: false },
        }),
        trial("a", "m", false, { status: "skipped", completion: null }),
      ]),
    );
    expect(stats.models[0]).toMatchObject({
      executed: 2,
      passed: 1,
      errors: 1,
      skipped: 1,
      passRate: 0.5,
    });
  });

  it("suma tokens y calcula latencias solo de los trials completados", () => {
    seq = 0;
    const stats = aggregate(
      suite([
        trial("a", "m", true), // 100 ms
        trial("b", "m", true), // 200 ms
        trial("c", "m", false, { status: "error", completion: null }),
      ]),
    );
    expect(stats.models[0]?.tokens).toEqual({ input: 20, output: 10, cacheRead: 4, cacheWrite: 2 });
    expect(stats.models[0]?.latency).toEqual({ p50: 100, p95: 200 });
  });

  it("aprueba si todos los modelos llegan al umbral", () => {
    const results = [trial("a", "opus", true), trial("a", "haiku", true)];
    expect(aggregate(suite(results, 1)).pass).toBe(true);
    expect(aggregate(suite([...results, trial("b", "haiku", false)], 0.9)).pass).toBe(false);
    expect(aggregate(suite([...results, trial("b", "haiku", false)], 0.5)).pass).toBe(true);
  });

  it("una corrida abortada nunca aprueba", () => {
    const aborted = { kind: "authentication" as const, message: "x", fatal: true };
    expect(aggregate(suite([trial("a", "m", true)], 0.5, aborted)).pass).toBe(false);
  });

  it("un modelo sin trials ejecutados no tiene tasa ni latencia", () => {
    const stats = aggregate(
      suite([trial("a", "m", false, { status: "skipped", completion: null })]),
    );
    expect(stats.models[0]).toMatchObject({ passRate: null, latency: null, meetsThreshold: false });
  });

  it("una suite sin resultados no aprueba", () => {
    expect(aggregate(suite([])).pass).toBe(false);
  });
});
