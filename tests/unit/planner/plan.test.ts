import { describe, expect, it } from "vitest";
import { Suite } from "../../../src/config/schema.js";
import type { SuiteInput } from "../../../src/config/schema.js";
import { PlanError, planSuite, trialId } from "../../../src/planner/plan.js";

const suite = (overrides: Partial<SuiteInput> = {}) =>
  Suite.parse({
    name: "Plan",
    models: [{ id: "claude-opus-5-5", effort: "low" }, "claude-haiku-5-5"],
    defaults: { trials: 2, max_tokens: 300, cache_system: true },
    prompt: { system: "Idioma: {{idioma}}", user: "Traduce: {{texto}}" },
    cases: [
      { id: "hola", vars: { texto: "hola", idioma: "inglés" }, expect: [{ type: "json_valid" }] },
      { id: "chau", vars: { texto: "chau", idioma: "francés" }, expect: [{ type: "json_valid" }] },
    ],
    ...overrides,
  });

describe("planSuite", () => {
  it("expande caso × modelo × repetición en orden estable", () => {
    expect(planSuite(suite()).map((t) => t.id)).toEqual([
      "hola/claude-opus-5-5/1",
      "hola/claude-opus-5-5/2",
      "hola/claude-haiku-5-5/1",
      "hola/claude-haiku-5-5/2",
      "chau/claude-opus-5-5/1",
      "chau/claude-opus-5-5/2",
      "chau/claude-haiku-5-5/1",
      "chau/claude-haiku-5-5/2",
    ]);
  });

  it("arma la petición con variables interpoladas y la configuración de la suite", () => {
    const [first, , haiku] = planSuite(suite());
    expect(first?.request).toEqual({
      model: "claude-opus-5-5",
      system: "Idioma: inglés",
      user: "Traduce: hola",
      maxTokens: 300,
      cacheSystem: true,
      effort: "low",
    });
    expect(haiku?.request).not.toHaveProperty("effort");
    expect(first).toMatchObject({ caseId: "hola", trial: 1, model: { id: "claude-opus-5-5" } });
    expect(first?.assertions).toEqual([{ type: "json_valid", weight: 1 }]);
  });

  it("omite system si la suite no lo define", () => {
    const s = suite({
      prompt: { user: "Traduce: {{texto}}" },
      cases: [{ id: "x", vars: { texto: "a" }, expect: [{ type: "json_valid" }] }],
    });
    expect(planSuite(s)[0]?.request).not.toHaveProperty("system");
  });

  it("filtra por modelo y por caso", () => {
    const plan = planSuite(suite(), { models: ["claude-haiku-5-5"], cases: ["chau"] });
    expect(plan.map((t) => t.id)).toEqual(["chau/claude-haiku-5-5/1", "chau/claude-haiku-5-5/2"]);
  });

  it("permite cambiar el número de trials", () => {
    expect(planSuite(suite(), { trials: 1 })).toHaveLength(4);
    expect(planSuite(suite(), { trials: 3 })).toHaveLength(12);
  });

  it.each([0, -1, 1.5, Number.NaN])("rechaza trials = %s", (trials) => {
    expect(() => planSuite(suite(), { trials })).toThrow(PlanError);
  });

  it("falla con los ids disponibles si un filtro no existe", () => {
    expect(() => planSuite(suite(), { models: ["claude-opus"] })).toThrow(
      "modelo desconocido: claude-opus. Disponibles: claude-opus-5-5, claude-haiku-5-5",
    );
    expect(() => planSuite(suite(), { cases: ["a", "b"] })).toThrow(
      "caso desconocidos: a, b. Disponibles: hola, chau",
    );
  });

  it("los ids son estables entre llamadas", () => {
    expect(planSuite(suite()).map((t) => t.id)).toEqual(planSuite(suite()).map((t) => t.id));
    expect(trialId("c", "m", 3)).toBe("c/m/3");
  });
});
