import { describe, expect, it } from "vitest";
import { Assertion, Suite, modelLabel, spanishErrors } from "../../../src/config/schema.js";

const minimal = {
  name: "Mínima",
  models: ["claude-haiku-5-5"],
  prompt: { user: "Hola" },
  cases: [{ id: "uno", expect: [{ type: "contains", value: "hola" }] }],
};

const parse = (data: unknown) => Suite.safeParse(data, { error: spanishErrors });
const messages = (data: unknown): string[] => {
  const r = parse(data);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("Suite", () => {
  it("aplica valores por defecto y normaliza los modelos", () => {
    const r = parse(minimal);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.models).toEqual([{ id: "claude-haiku-5-5" }]);
    expect(r.data.defaults).toEqual({ max_tokens: 1024, trials: 1, cache_system: false });
    expect(r.data.thresholds).toEqual({ pass_rate: 1, max_regression: 0.05 });
    expect(r.data.cases[0]?.vars).toEqual({});
    expect(r.data.cases[0]?.expect[0]).toEqual({
      type: "contains",
      value: "hola",
      case_insensitive: false,
      weight: 1,
    });
  });

  it.each([
    ["sin modelos", { ...minimal, models: [] }, "models: indica al menos un modelo"],
    ["sin casos", { ...minimal, cases: [] }, "cases: la suite necesita al menos un caso"],
    ["sin prompt", { ...minimal, prompt: undefined }, "prompt: campo requerido"],
    ["nombre vacío", { ...minimal, name: "  " }, "name: no puede estar vacío"],
    ["llave desconocida", { ...minimal, expcet: [] }, ': Llave desconocida: "expcet"'],
    ["esfuerzo inválido", { ...minimal, models: [{ id: "m", effort: "turbo" }] }, "models.0"],
    [
      "id de caso inválido",
      { ...minimal, cases: [{ id: "con espacios", expect: [{ type: "json_valid" }] }] },
      "cases.0.id: usa solo letras",
    ],
    [
      "id de caso repetido",
      { ...minimal, cases: [minimal.cases[0], minimal.cases[0]] },
      'cases.1.id: id repetido: "uno" ya se usa en cases[0]',
    ],
    [
      "modelo repetido",
      { ...minimal, models: ["a", { id: "a" }] },
      'models.1: modelo repetido: "a"',
    ],
    [
      "modelo repetido con el mismo effort",
      { ...minimal, models: [{ id: "a", effort: "low" }, "a", { id: "a", effort: "low" }] },
      'models.2: modelo repetido: "a@low"',
    ],
    [
      "llm_judge sin juez",
      { ...minimal, cases: [{ id: "x", expect: [{ type: "llm_judge", rubric: "r" }] }] },
      "cases.0.expect.0: las aserciones `llm_judge` requieren una sección `judge`",
    ],
    [
      "pass_rate fuera de rango",
      { ...minimal, thresholds: { pass_rate: 1.5 } },
      "thresholds.pass_rate",
    ],
    ["trials no entero", { ...minimal, defaults: { trials: 1.5 } }, "defaults.trials"],
  ])("rechaza: %s", (_name, data, expected) => {
    const found = messages(data);
    expect(
      found.some((m) => m.includes(expected)),
      found.join("\n"),
    ).toBe(true);
  });

  it("acepta el mismo modelo con distintos esfuerzos", () => {
    const models = ["a", { id: "a", effort: "low" }, { id: "a", effort: "high" }];
    expect(messages({ ...minimal, models })).toEqual([]);
  });

  it.each([
    [{ id: "claude-haiku-5-5" }, "claude-haiku-5-5"],
    [{ id: "claude-haiku-5-5", effort: "low" as const }, "claude-haiku-5-5@low"],
  ])("modelLabel(%j) = %s", (model, label) => {
    expect(modelLabel(model)).toBe(label);
  });

  it("acepta un juez y fallbacks", () => {
    const r = parse({
      ...minimal,
      judge: { model: "claude-opus-5-5", effort: "low" },
      fallbacks: "default",
      cases: [{ id: "x", expect: [{ type: "llm_judge", rubric: "r" }] }],
    });
    expect(r.success).toBe(true);
  });
});

describe("Assertion", () => {
  const ok = (a: unknown) => Assertion.safeParse(a, { error: spanishErrors }).success;
  const err = (a: unknown) => {
    const r = Assertion.safeParse(a, { error: spanishErrors });
    return r.success ? "" : r.error.issues.map((i) => i.message).join(" | ");
  };

  it.each([
    { type: "equals", value: "x" },
    { type: "contains", value: ["a", "b"], case_insensitive: true },
    { type: "not_contains", value: "x" },
    { type: "regex", pattern: "^\\d+$", flags: "i" },
    { type: "max_length", chars: 100 },
    { type: "max_length", words: 20 },
    { type: "json_valid" },
    { type: "json_schema", schema: { type: "object" } },
    { type: "json_path_equals", path: "a.b.0", value: null },
    { type: "json_path_equals", path: "items", value: [1, 2] },
    { type: "latency_below", ms: 2000 },
    { type: "cost_below", usd: 0.01 },
    { type: "llm_judge", rubric: "Es amable", threshold: 0.8, weight: 2 },
  ])("acepta $type", (a) => {
    expect(ok(a), err(a)).toBe(true);
  });

  it.each([
    [{ type: "nope" }, "tipo de aserción desconocido; los válidos son: equals, contains"],
    ["equals", "cada aserción debe ser un objeto con `type`"],
    [{ type: "equals" }, "campo requerido"],
    [{ type: "regex", pattern: "(" }, "la expresión regular no es válida"],
    [{ type: "regex", pattern: "a", flags: "x" }, "solo se permiten las banderas"],
    [{ type: "max_length" }, "indica exactamente uno de `chars` o `words`"],
    [{ type: "max_length", chars: 1, words: 1 }, "indica exactamente uno de `chars` o `words`"],
    [{ type: "json_path_equals", path: "a..b", value: 1 }, "usa puntos para separar"],
    [{ type: "json_path_equals", path: "a" }, "campo requerido"],
    [{ type: "json_schema", schema: "schema.json" }, "ruta con prefijo, por ejemplo `file://"],
    [{ type: "contains", value: [] }, ""],
    [{ type: "latency_below", ms: -1 }, ""],
    [{ type: "llm_judge", rubric: "r", threshold: 2 }, ""],
    [{ type: "equals", value: "x", weight: 0 }, ""],
    [{ type: "equals", value: "x", extra: 1 }, "Llave desconocida"],
  ])("rechaza %j", (a, expected) => {
    expect(ok(a)).toBe(false);
    expect(err(a)).toContain(expected);
  });
});
