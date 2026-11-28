import { describe, expect, it } from "vitest";
import { gradeAssertion } from "../../../src/graders/index.js";
import { assertion, out } from "./helpers.js";

const grade = (text: string, a: Record<string, unknown>) => gradeAssertion(out(text), assertion(a));

describe("equals", () => {
  it.each([
    ["cuenta", { value: "cuenta" }, true, 'es exactamente "cuenta"'],
    ["  cuenta\n", { value: "cuenta" }, true, 'es exactamente "cuenta"'],
    [
      "  cuenta\n",
      { value: "cuenta", trim: false },
      false,
      'esperaba "cuenta", obtuvo "  cuenta\\n"',
    ],
    ["Cuenta", { value: "cuenta" }, false, 'esperaba "cuenta", obtuvo "Cuenta"'],
    ["facturación", { value: "cuenta" }, false, 'esperaba "cuenta", obtuvo "facturación"'],
  ])("%j con %j → %s", async (text, params, pass, reason) => {
    expect(await grade(text, { type: "equals", ...params })).toEqual({
      pass,
      score: pass ? 1 : 0,
      reason,
    });
  });

  it("recorta respuestas largas en la razón", async () => {
    const r = await grade("x".repeat(200), { type: "equals", value: "y" });
    expect(r.reason).toBe(`esperaba "y", obtuvo "${"x".repeat(60)}…"`);
  });
});

describe("contains", () => {
  it.each([
    ["El escáner falla", { value: "escáner" }, true, 1, 'contiene "escáner"'],
    ["El ESCÁNER falla", { value: "escáner" }, false, 0, 'no contiene "escáner"'],
    [
      "El ESCÁNER falla",
      { value: "escáner", case_insensitive: true },
      true,
      1,
      'contiene "escáner"',
    ],
    ["alta prioridad, bug", { value: ["alta", "bug"] }, true, 1, 'contiene "alta", "bug"'],
    ["alta prioridad", { value: ["alta", "bug", "app"] }, false, 1 / 3, 'no contiene "bug", "app"'],
  ])("%j con %j → %s", async (text, params, pass, score, reason) => {
    expect(await grade(text, { type: "contains", ...params })).toEqual({ pass, score, reason });
  });
});

describe("not_contains", () => {
  it.each([
    ["Todo bien", { value: "error" }, true, 1, 'no contiene "error"'],
    ["Hubo un Error", { value: "error" }, true, 1, 'no contiene "error"'],
    [
      "Hubo un Error",
      { value: "error", case_insensitive: true },
      false,
      0,
      'contiene "error", que no debería aparecer',
    ],
    [
      "Lo siento, no puedo",
      { value: ["lo siento", "no puedo", "disculpa"], case_insensitive: true },
      false,
      1 / 3,
      'contiene "lo siento", "no puedo", que no debería aparecer',
    ],
  ])("%j con %j → %s", async (text, params, pass, score, reason) => {
    expect(await grade(text, { type: "not_contains", ...params })).toEqual({ pass, score, reason });
  });
});

describe("regex", () => {
  it.each([
    ["Pedido #12345", { pattern: "#\\d{5}" }, true, "coincide con /#\\d{5}/"],
    [
      "PRIORIDAD: ALTA",
      { pattern: "prioridad: (alta|media)", flags: "i" },
      true,
      "coincide con /prioridad: (alta|media)/i",
    ],
    ["sin número", { pattern: "^\\d+$" }, false, 'no coincide con /^\\d+$/; obtuvo "sin número"'],
    ["línea 1\nOK", { pattern: "^OK$", flags: "m" }, true, "coincide con /^OK$/m"],
  ])("%j con %j → %s", async (text, params, pass, reason) => {
    expect(await grade(text, { type: "regex", ...params })).toEqual({
      pass,
      score: pass ? 1 : 0,
      reason,
    });
  });

  it("la bandera g no deja estado entre trials", async () => {
    const a = { type: "regex", pattern: "a", flags: "g" };
    expect((await grade("a", a)).pass).toBe(true);
    expect((await grade("a", a)).pass).toBe(true);
  });
});

describe("max_length", () => {
  it.each([
    ["hola", { chars: 4 }, true, 1, "4 caracteres (máximo 4)"],
    ["hola!", { chars: 4 }, false, 4 / 5, "5 caracteres, supera el máximo de 4"],
    ["ñandú👍🏽", { chars: 6 }, true, 1, "6 caracteres (máximo 6)"],
    ["uno dos  tres\ncuatro", { words: 4 }, true, 1, "4 palabras (máximo 4)"],
    ["uno dos tres cuatro", { words: 2 }, false, 0.5, "4 palabras, supera el máximo de 2"],
    ["   ", { words: 1 }, true, 1, "0 palabras (máximo 1)"],
  ])("%j con %j → %s", async (text, params, pass, score, reason) => {
    expect(await grade(text, { type: "max_length", ...params })).toEqual({ pass, score, reason });
  });
});
