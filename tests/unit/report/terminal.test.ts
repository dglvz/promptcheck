import { describe, expect, it } from "vitest";
import {
  formatCounts,
  formatInt,
  formatPercent,
  renderTerminalReport,
  trialFailureReason,
} from "../../../src/report/terminal.js";
import type { SuiteResult, TrialResult } from "../../../src/runner/evaluate.js";
import { aggregate } from "../../../src/stats/aggregate.js";

const completion = (latencyMs: number) => ({
  text: "x",
  stopReason: "end_turn",
  model: "m",
  latencyMs,
  usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
});

function t(
  caseId: string,
  model: string,
  trial: number,
  pass: boolean,
  extra: Partial<TrialResult> = {},
): TrialResult {
  return {
    id: `${caseId}/${model}/${trial}`,
    caseId,
    model,
    trial,
    status: "completed",
    completion: completion(500 + trial * 100),
    grades: pass ? [{ pass: true, score: 1, reason: "ok" }] : [],
    pass,
    score: pass ? 1 : 0,
    ...extra,
  };
}

const fail = (reason: string) => ({ grades: [{ pass: false, score: 0, reason }] });

const result = (results: TrialResult[], extra: Partial<SuiteResult> = {}): SuiteResult => ({
  name: "Clasificación de tickets",
  file: "evals/tickets.yaml",
  thresholds: { pass_rate: 0.9, max_regression: 0.05 },
  cacheSystem: false,
  maxTokens: 1024,
  results,
  ...extra,
});

const render = (r: SuiteResult) => renderTerminalReport(r, aggregate(r), { color: false });

describe("formato", () => {
  it.each([
    [1, "100 %"],
    [0.9, "90 %"],
    [2 / 3, "66,7 %"],
    [0, "0 %"],
  ])("porcentaje %f → %s", (rate, text) => {
    expect(formatPercent(rate)).toBe(text);
  });

  it.each([
    [0, "0"],
    [999, "999"],
    [1200, "1.200"],
    [1234567, "1.234.567"],
  ])("entero %i → %s", (n, text) => {
    expect(formatInt(n)).toBe(text);
  });
});

describe("trialFailureReason", () => {
  it.each([
    [
      t("a", "m", 1, false, fail('categoria: esperaba "bug", obtuvo "otro"')),
      'categoria: esperaba "bug", obtuvo "otro"',
    ],
    [
      t("a", "m", 1, false, {
        grades: [
          { pass: false, score: 0, reason: "uno" },
          { pass: true, score: 1, reason: "ok" },
          { pass: false, score: 0, reason: "dos", error: true },
        ],
      }),
      "uno; (no evaluable) dos",
    ],
    [
      t("a", "m", 1, false, {
        status: "error",
        completion: null,
        error: { kind: "overloaded", message: "la API está sobrecargada", fatal: false },
      }),
      "[overloaded] la API está sobrecargada",
    ],
    [
      t("a", "m", 1, false, {
        stopIssue: "la respuesta se cortó por max_tokens",
        ...fail("no es JSON válido"),
      }),
      "la respuesta se cortó por max_tokens; no es JSON válido",
    ],
    [
      t("a", "m", 1, false, { status: "skipped", completion: null }),
      "omitido (la corrida se detuvo)",
    ],
    [t("a", "m", 1, false), "no aprobó"],
  ])("%#", (trial, reason) => {
    expect(trialFailureReason(trial)).toBe(reason);
  });
});

describe("renderTerminalReport", () => {
  it("suite aprobada", () => {
    expect(render(result([t("a", "claude-opus-5-5", 1, true), t("b", "claude-opus-5-5", 2, true)])))
      .toMatchInlineSnapshot(`
        "Clasificación de tickets  evals/tickets.yaml
        ┌─────────────────┬────────────┬────────┬────────────┬─────────┬──────────────────┬───────────────────┬──────────────────┐
        │ Modelo          │ Aprobación │ Trials │ Inestables │ Errores │ Tokens (ent/sal) │ Caché (lect/escr) │ Latencia p50/p95 │
        ├─────────────────┼────────────┼────────┼────────────┼─────────┼──────────────────┼───────────────────┼──────────────────┤
        │ claude-opus-5-5 │ 100 % ✔    │ 2/2    │ 0          │ 0       │ 2.400 / 600      │ —                 │ 600 / 700 ms     │
        └─────────────────┴────────────┴────────┴────────────┴─────────┴──────────────────┴───────────────────┴──────────────────┘
        Umbral de aprobación: 90 %

        ✔ Suite aprobada"
      `);
  });

  it("suite con un caso inestable, un caso roto y un error", () => {
    const r = result([
      t("correo-reset", "claude-opus-5-5", 1, true),
      t("correo-reset", "claude-opus-5-5", 2, true),
      t("correo-reset", "claude-haiku-5-5", 1, true),
      t(
        "correo-reset",
        "claude-haiku-5-5",
        2,
        false,
        fail('categoria: esperaba "cuenta", obtuvo "facturacion"'),
      ),
      t("app-se-cierra", "claude-opus-5-5", 1, true),
      t("app-se-cierra", "claude-opus-5-5", 2, true),
      t("app-se-cierra", "claude-haiku-5-5", 1, false, fail("no es JSON válido: Unexpected token")),
      t("app-se-cierra", "claude-haiku-5-5", 2, false, {
        status: "error",
        completion: null,
        error: { kind: "overloaded", message: "la API está sobrecargada", fatal: false },
      }),
    ]);
    expect(render(r)).toMatchInlineSnapshot(`
      "Clasificación de tickets  evals/tickets.yaml
      ┌──────────────────┬────────────┬────────┬────────────┬─────────┬──────────────────┬───────────────────┬──────────────────┐
      │ Modelo           │ Aprobación │ Trials │ Inestables │ Errores │ Tokens (ent/sal) │ Caché (lect/escr) │ Latencia p50/p95 │
      ├──────────────────┼────────────┼────────┼────────────┼─────────┼──────────────────┼───────────────────┼──────────────────┤
      │ claude-opus-5-5  │ 100 % ✔    │ 4/4    │ 0          │ 0       │ 4.800 / 1.200    │ —                 │ 600 / 700 ms     │
      ├──────────────────┼────────────┼────────┼────────────┼─────────┼──────────────────┼───────────────────┼──────────────────┤
      │ claude-haiku-5-5 │ 25 % ✘     │ 1/4    │ 1          │ 1       │ 3.600 / 900      │ —                 │ 600 / 700 ms     │
      └──────────────────┴────────────┴────────┴────────────┴─────────┴──────────────────┴───────────────────┴──────────────────┘
      Umbral de aprobación: 90 %
      ⚠ claude-haiku-5-5: 1 error(es) del proveedor (overloaded)

      Casos con fallos:
        ✘ correo-reset · claude-haiku-5-5 (1/2 aprobados) inestable
            trial 2: categoria: esperaba "cuenta", obtuvo "facturacion"
        ✘ app-se-cierra · claude-haiku-5-5 (0/2 aprobados)
            trial 1: no es JSON válido: Unexpected token
            trial 2: [overloaded] la API está sobrecargada

      ✘ Suite no aprobada: bajo el umbral en claude-haiku-5-5"
    `);
  });

  it("resume los trials que no entran", () => {
    const trials = [1, 2, 3, 4, 5].map((n) => t("a", "m", n, false, fail(`fallo ${n}`)));
    const out = render(result(trials));
    expect(out).toContain("trial 3: fallo 3");
    expect(out).not.toContain("trial 4: fallo 4");
    expect(out).toContain("… y 2 trial(s) más");
  });

  it("corrida detenida por un error fatal", () => {
    const r = result(
      [
        t("a", "m", 1, false, {
          status: "error",
          completion: null,
          error: { kind: "authentication", message: "credenciales inválidas", fatal: true },
        }),
        t("a", "m", 2, false, { status: "skipped", completion: null }),
        t("a", "m", 3, false, { status: "skipped", completion: null }),
      ],
      { aborted: { kind: "authentication", message: "credenciales inválidas", fatal: true } },
    );
    const out = render(r);
    expect(out).toContain("✘ Corrida detenida: [authentication] credenciales inválidas");
    expect(out).toContain("2 trial(s) no se ejecutaron.");
    expect(out).not.toContain("omitido");
  });

  it("con color agrega códigos ANSI; sin color, no", () => {
    const r = result([t("a", "m", 1, true)]);
    const ESC = "\u001b[";
    expect(renderTerminalReport(r, aggregate(r), { color: true })).toContain(ESC);
    expect(render(r)).not.toContain(ESC);
  });
});

describe("caché y juez en el reporte", () => {
  const withCache = (cacheRead: number, cacheWrite: number) =>
    t("a", "claude-haiku-5-5", 1, true, {
      completion: { ...completion(500), usage: { input: 100, output: 50, cacheRead, cacheWrite } },
    });

  it("muestra lecturas y escrituras de caché, o — si no hubo", () => {
    expect(render(result([withCache(1200, 300)]))).toContain("1.200 / 300");
    expect(render(result([withCache(0, 0)]))).toMatch(/│ — +│ 500 \/ 500 ms/);
  });

  it("avisa cuando cache_system no tuvo efecto", () => {
    const out = render({ ...result([withCache(0, 0)]), cacheSystem: true });
    expect(out).toContain(
      "⚠ cache_system está activo pero no se cacheó nada en claude-haiku-5-5: el system prompt probablemente es más corto que el mínimo cacheable del modelo (512 tokens en los modelos 5.5).",
    );
    expect(render({ ...result([withCache(600, 0)]), cacheSystem: true })).not.toContain("⚠");
  });

  it("resume el consumo del juez y avisa si su prefijo no se cacheó", () => {
    const judged = (cacheRead: number) =>
      t("a", "m", 1, true, {
        grades: [
          {
            pass: true,
            score: 1,
            reason: "juez",
            judge: {
              model: "claude-opus-5-5",
              latencyMs: 1,
              usage: { input: 1000, output: 80, cacheRead, cacheWrite: 0 },
            },
          },
        ],
      });
    expect(render(result([judged(700)]))).toContain(
      "Juez (claude-opus-5-5): 1 evaluación(es) · tokens 1.000 / 80 · caché 700 / 0",
    );
    expect(render(result([judged(0)]))).toContain("⚠ El prefijo del juez no se cacheó");
  });
});

describe("rechazos, cortes y errores en el reporte", () => {
  const stopped = (trial: number, stopReason: string, refusalCategory?: string) =>
    t("a", "claude-haiku-5-5", trial, false, {
      completion: {
        ...completion(500),
        stopReason,
        ...(refusalCategory === undefined ? {} : { refusalCategory }),
      },
    });

  it("resume por modelo y sugiere subir max_tokens", () => {
    const out = render(
      result([
        stopped(1, "refusal", "cyber"),
        stopped(2, "refusal", "cyber"),
        stopped(3, "max_tokens"),
        t("a", "claude-haiku-5-5", 4, false, {
          status: "error",
          completion: null,
          error: { kind: "rate_limit", message: "x", fatal: false },
        }),
      ]),
    );
    expect(out).toContain("⚠ claude-haiku-5-5: 2 rechazo(s) del modelo (cyber ×2)");
    expect(out).toContain(
      "⚠ claude-haiku-5-5: 1 respuesta(s) cortada(s) por max_tokens; prueba a subir defaults.max_tokens (ahora 1.024)",
    );
    expect(out).toContain("⚠ claude-haiku-5-5: 1 error(es) del proveedor (rate_limit)");
  });

  it.each([
    [{}, ""],
    [{ cyber: 1 }, "cyber"],
    [{ cyber: 2, bio: 1 }, "cyber ×2, bio"],
  ])("formatCounts(%j) = %j", (counts, text) => {
    expect(formatCounts(counts)).toBe(text);
  });
});
