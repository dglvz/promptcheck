import { describe, expect, it } from "vitest";
import { Suite } from "../../../src/config/schema.js";
import type { SuiteInput } from "../../../src/config/schema.js";
import { FakeProvider, failure, refusal } from "../../../src/providers/fake.js";
import { describeStop, evaluateSuite, stopAfterFatal } from "../../../src/runner/evaluate.js";

const suite = (overrides: Partial<SuiteInput> = {}) =>
  Suite.parse({
    name: "Juez",
    models: ["claude-haiku-5-5"],
    defaults: { trials: 2 },
    judge: { model: "claude-opus-5-5", effort: "low" },
    prompt: { system: "Resume en una frase.", user: "Texto: {{texto}}" },
    cases: [
      {
        id: "a",
        vars: { texto: "uno" },
        expect: [
          { type: "contains", value: "uno" },
          { type: "llm_judge", rubric: "Es breve." },
        ],
      },
      { id: "b", vars: { texto: "dos" }, expect: [{ type: "llm_judge", rubric: "Menciona dos." }] },
    ],
    ...overrides,
  });

const verdict = (score: number) => JSON.stringify({ reasoning: "r", score, pass: score >= 0.7 });

describe("evaluateSuite con juez LLM", () => {
  it("califica con el juez de la suite usando su propio proveedor", async () => {
    const model = new FakeProvider().when({}, (req) => `Resumen: ${req.user}`);
    const judge = new FakeProvider()
      .when({ system: "Menciona dos." }, verdict(0.2))
      .when({}, verdict(0.9));

    const result = await evaluateSuite(suite(), "s.yaml", {
      provider: model,
      judgeProvider: judge,
    });

    expect(model.calls).toHaveLength(4);
    expect(judge.calls).toHaveLength(4);
    expect(result.results.map((r) => [r.id, r.pass])).toEqual([
      ["a/claude-haiku-5-5/1", true],
      ["a/claude-haiku-5-5/2", true],
      ["b/claude-haiku-5-5/1", false],
      ["b/claude-haiku-5-5/2", false],
    ]);
    // El juez recibe el system y la entrada del prompt evaluado.
    expect(judge.calls[0]?.system).toContain("Resume en una frase.");
    expect(judge.calls[0]?.user).toContain("Texto: uno");
    expect(judge.calls[0]).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
  });

  it("sin judgeProvider, el juez usa el mismo proveedor", async () => {
    const shared = new FakeProvider()
      .when({ model: "claude-opus-5-5" }, verdict(1))
      .when({}, "uno dos");
    const result = await evaluateSuite(suite(), "s.yaml", { provider: shared });
    expect(result.results.every((r) => r.pass)).toBe(true);
    expect(shared.calls).toHaveLength(8);
  });

  it("las llamadas al juez respetan la concurrencia", async () => {
    const model = new FakeProvider({ default: "uno dos" });
    const judge = new FakeProvider({ default: verdict(1), delayMs: 10 });
    await evaluateSuite(suite({ defaults: { trials: 5 } }), "s.yaml", {
      provider: model,
      judgeProvider: judge,
      concurrency: 2,
    });
    expect(judge.calls).toHaveLength(10); // 2 casos × 5 trials, un llm_judge cada uno;
    expect(judge.maxInFlight).toBe(2);
  });

  it("sin sección judge, llm_judge queda como error de evaluación", async () => {
    const s = suite();
    const { judge: _omit, ...noJudge } = s;
    const result = await evaluateSuite(noJudge, "s.yaml", {
      provider: new FakeProvider({ default: "uno" }),
    });
    expect(result.results[0]?.grades[1]).toMatchObject({ error: true });
    expect(result.results[0]?.pass).toBe(false);
  });

  it("un rechazo del modelo evaluado no aprueba aunque el juez apruebe", async () => {
    const model = new FakeProvider().when({}, refusal("cyber", "uno"));
    const judge = new FakeProvider({ default: verdict(1) });
    const result = await evaluateSuite(suite({ defaults: { trials: 1 } }), "s.yaml", {
      provider: model,
      judgeProvider: judge,
    });
    expect(result.results[0]).toMatchObject({
      pass: false,
      stopIssue: "el modelo rechazó la petición (cyber)",
    });
  });
});

describe("describeStop", () => {
  const base = {
    text: "",
    model: "m",
    latencyMs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  it.each([
    ["end_turn", undefined],
    ["stop_sequence", undefined],
    ["max_tokens", "la respuesta se cortó por max_tokens"],
    ["pause_turn", "la respuesta terminó por pause_turn"],
  ])("%s → %s", (stopReason, expected) => {
    expect(describeStop({ ...base, stopReason })).toBe(expected);
  });

  it("rechazo sin categoría", () => {
    expect(describeStop({ ...base, stopReason: "refusal" })).toBe(
      "el modelo rechazó la petición (sin categoría)",
    );
  });
});

describe("evaluateSuite: caché del juez", () => {
  it("el primer trial de cada caso se califica solo, para que el resto lea la caché del juez", async () => {
    const model = new FakeProvider({ default: "uno dos" });
    const judge = new FakeProvider({ default: verdict(1), delayMs: 10 });
    const result = await evaluateSuite(suite({ defaults: { trials: 3 } }), "s.yaml", {
      provider: model,
      judgeProvider: judge,
      concurrency: 4,
    });
    const reads = (caseId: string) =>
      result.results
        .filter((r) => r.caseId === caseId)
        .map((r) =>
          (r.grades.find((g) => g.judge)?.judge?.usage.cacheRead ?? 0) > 0 ? "read" : "write",
        );
    expect(reads("a")).toEqual(["write", "read", "read"]);
    expect(reads("b")).toEqual(["write", "read", "read"]);
  });

  it("informa si la suite pidió caché del system", async () => {
    const r = await evaluateSuite(
      suite({ defaults: { trials: 1, cache_system: true } }),
      "s.yaml",
      {
        provider: new FakeProvider({ default: verdict(1) }),
      },
    );
    expect(r.cacheSystem).toBe(true);
  });
});

describe("errores fatales del juez", () => {
  it("abortan la corrida (código 4) y no repiten la llamada que no puede funcionar", async () => {
    const model = new FakeProvider({ default: "uno dos" });
    const judge = new FakeProvider().when({}, failure("not_found", "modelo no encontrado", 404));
    const result = await evaluateSuite(suite({ defaults: { trials: 3 } }), "s.yaml", {
      provider: model,
      judgeProvider: judge,
      concurrency: 1,
    });
    expect(result.aborted).toEqual({
      kind: "not_found",
      message: "juez (claude-opus-5-5): modelo no encontrado",
      fatal: true,
      status: 404,
    });
    expect(judge.calls).toHaveLength(1);
    expect(result.results[0]?.grades[1]).toMatchObject({
      error: true,
      judgeError: { kind: "not_found", fatal: true },
    });
  });

  it("un error no fatal del juez no aborta", async () => {
    const judge = new FakeProvider().when({}, failure("overloaded"));
    const result = await evaluateSuite(suite({ defaults: { trials: 2 } }), "s.yaml", {
      provider: new FakeProvider({ default: "uno dos" }),
      judgeProvider: judge,
    });
    expect(result.aborted).toBeUndefined();
    expect(judge.calls).toHaveLength(4);
  });

  it("stopAfterFatal deja pasar los errores no fatales y frena tras el primero fatal", async () => {
    const inner = new FakeProvider().when({}, failure("rate_limit"), failure("permission"), "ok");
    const guarded = stopAfterFatal(inner);
    const req = { model: "m", user: "u", maxTokens: 1 };
    await expect(guarded.complete(req)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(guarded.fatal()).toBeUndefined();
    await expect(guarded.complete(req)).rejects.toMatchObject({ kind: "permission" });
    await expect(guarded.complete(req)).rejects.toMatchObject({ kind: "permission" });
    expect(inner.calls).toHaveLength(2);
    expect(guarded.fatal()).toMatchObject({ kind: "permission", fatal: true });
    expect(guarded.name).toBe("fake");
  });
});
