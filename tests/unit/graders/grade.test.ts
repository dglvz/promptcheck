import { describe, expect, it } from "vitest";
import { gradeAssertion, gradeTrial } from "../../../src/graders/index.js";
import { assertion, out } from "./helpers.js";

describe("latency_below", () => {
  it.each([
    [999, 1000, true, "tardó 999 ms (límite 1000 ms)"],
    [1000, 1000, false, "tardó 1000 ms, no menos de 1000 ms"],
    [2500, 1000, false, "tardó 2500 ms, no menos de 1000 ms"],
  ])("%i ms con límite %i → %s", async (latencyMs, ms, pass, reason) => {
    const r = await gradeAssertion(
      out("x", { latencyMs }),
      assertion({ type: "latency_below", ms }),
    );
    expect(r).toEqual({ pass, score: pass ? 1 : 0, reason });
  });
});

describe("cost_below", () => {
  const a = assertion({ type: "cost_below", usd: 0.01 });

  it.each([
    [0.0012, true, "costó US$0.0012 (límite US$0.01)"],
    [0.01, false, "costó US$0.01, no menos de US$0.01"],
    [0.25, false, "costó US$0.25, no menos de US$0.01"],
    [0, true, "costó US$0 (límite US$0.01)"],
  ])("costo %f → %s", async (costUsd, pass, reason) => {
    expect(await gradeAssertion(out("x"), a, { costUsd })).toEqual({
      pass,
      score: pass ? 1 : 0,
      reason,
    });
  });

  it("con costo desconocido es un error de evaluación, nunca un aprobado", async () => {
    expect(await gradeAssertion(out("x"), a, {})).toEqual({
      pass: false,
      score: 0,
      reason: "costo desconocido: el modelo no tiene precio registrado",
      error: true,
    });
  });
});

describe("llm_judge (pendiente)", () => {
  it("se reporta como error de evaluación hasta que exista el juez", async () => {
    const r = await gradeAssertion(out("x"), assertion({ type: "llm_judge", rubric: "r" }));
    expect(r).toMatchObject({ pass: false, error: true });
  });
});

describe("gradeTrial", () => {
  const text = '{"categoria":"cuenta","prioridad":"alta"}';

  it("aprueba solo si todas las aserciones aprueban", async () => {
    const all = await gradeTrial(out(text), [
      assertion({ type: "json_valid" }),
      assertion({ type: "json_path_equals", path: "categoria", value: "cuenta" }),
    ]);
    expect(all).toMatchObject({ pass: true, score: 1 });
    expect(all.grades).toHaveLength(2);

    const one = await gradeTrial(out(text), [
      assertion({ type: "json_valid" }),
      assertion({ type: "json_path_equals", path: "categoria", value: "bug" }),
    ]);
    expect(one.pass).toBe(false);
    expect(one.grades.map((g) => g.pass)).toEqual([true, false]);
  });

  it("pondera el puntaje con weight, sin afectar la aprobación", async () => {
    const r = await gradeTrial(out(text), [
      assertion({ type: "json_valid", weight: 3 }),
      assertion({ type: "contains", value: ["cuenta", "bug"] }), // puntaje 0.5
    ]);
    expect(r.pass).toBe(false);
    expect(r.score).toBeCloseTo((3 * 1 + 1 * 0.5) / 4);
  });

  it("un error de evaluación hace que el trial no apruebe", async () => {
    const r = await gradeTrial(out(text), [
      assertion({ type: "json_valid" }),
      assertion({ type: "cost_below", usd: 1 }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.grades[1]?.error).toBe(true);
  });

  it("sin aserciones el puntaje es 0 y aprueba trivialmente", async () => {
    expect(await gradeTrial(out(text), [])).toEqual({ grades: [], pass: true, score: 0 });
  });
});
