import { describe, expect, it } from "vitest";
import { getPath, gradeAssertion, parseJsonResponse } from "../../../src/graders/index.js";
import { assertion, out } from "./helpers.js";

const grade = (text: string, a: Record<string, unknown>) => gradeAssertion(out(text), assertion(a));

const TICKET = {
  type: "object",
  required: ["categoria", "prioridad"],
  additionalProperties: false,
  properties: {
    categoria: { enum: ["cuenta", "facturacion", "bug", "otro"] },
    prioridad: { enum: ["alta", "media", "baja"] },
    resumen: { type: "string" },
    etiquetas: { type: "array", items: { type: "string" } },
  },
};

describe("parseJsonResponse", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ["  [1, 2]\n", [1, 2]],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['```\n{"a":1}\n```', { a: 1 }],
    ['Aquí está:\n```json\n{"a": 1}\n```\nListo.', { a: 1 }],
    ["42", 42],
    ['"texto"', "texto"],
  ])("acepta %j", (text, value) => {
    expect(parseJsonResponse(text)).toEqual({ ok: true, value });
  });

  it.each([
    ["", "la respuesta está vacía"],
    ["{a:1}", "JSON"],
    ["```json\n{a:1}\n```", "el bloque de código no es JSON válido"],
    ["Claro, la categoría es cuenta.", "JSON"],
  ])("rechaza %j", (text, error) => {
    const r = parseJsonResponse(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(error);
  });
});

describe("getPath", () => {
  const data = { a: { b: [10, { c: "x" }] }, n: null };
  it.each([
    ["a.b.0", { found: true, value: 10 }],
    ["a.b.1.c", { found: true, value: "x" }],
    ["n", { found: true, value: null }],
    ["a.z", { found: false, at: "a.z" }],
    ["a.b.5", { found: false, at: "a.b.5" }],
    ["a.b.x", { found: false, at: "a.b.x" }],
    ["n.x", { found: false, at: "n.x" }],
    ["a.b.1.c.d", { found: false, at: "a.b.1.c.d" }],
    ["toString", { found: false, at: "toString" }],
  ])("%s", (path, expected) => {
    expect(getPath(data, path)).toEqual(expected);
  });
});

describe("json_valid", () => {
  it.each([
    ['{"ok": true}', true],
    ['```json\n{"ok": true}\n```', true],
    ["ok", false],
  ])("%j → %s", async (text, pass) => {
    const r = await grade(text, { type: "json_valid" });
    expect(r.pass).toBe(pass);
    expect(r.reason).toMatch(pass ? /^es JSON válido$/ : /^no es JSON válido: /);
  });
});

describe("json_schema", () => {
  const a = { type: "json_schema", schema: TICKET };

  it.each([
    ['{"categoria":"cuenta","prioridad":"alta"}', "cumple el esquema"],
    ['```json\n{"categoria":"bug","prioridad":"media","resumen":"x"}\n```', "cumple el esquema"],
  ])("aprueba %j", async (text, reason) => {
    expect(await grade(text, a)).toEqual({ pass: true, score: 1, reason });
  });

  it.each([
    ['{"prioridad":"alta"}', '(raíz): falta el campo "categoria"'],
    [
      '{"categoria":"ventas","prioridad":"alta"}',
      'categoria: debe ser uno de ["cuenta","facturacion","bug","otro"]',
    ],
    ['{"categoria":"bug","prioridad":"alta","extra":1}', 'campo no permitido "extra"'],
    [
      '{"categoria":"bug","prioridad":"alta","etiquetas":["a",2]}',
      "etiquetas.1: debe ser de tipo string",
    ],
    ["no es json", "no es JSON válido"],
  ])("reprueba %j", async (text, reason) => {
    const r = await grade(text, a);
    expect(r.pass).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.reason).toContain(reason);
  });

  it("junta varios errores y resume los que sobran", async () => {
    const r = await grade('{"x":1,"y":2,"z":3,"w":4}', a);
    expect(r.reason).toMatch(/^no cumple el esquema: .+; .+; .+ \(y \d+ más\)$/);
  });

  it.each([
    [{ const: 5 }, "5", true],
    [{ const: 5 }, "6", false],
    [{ type: "array", minItems: 2 }, "[1]", false],
  ])("traduce o conserva otros mensajes de ajv (%j)", async (schema, text, pass) => {
    const r = await grade(text, { type: "json_schema", schema });
    expect(r.pass).toBe(pass);
    if (!pass) expect(r.reason).toMatch(/^no cumple el esquema: \(raíz\): /);
  });

  it("un esquema inválido es un error de evaluación, no un fallo", async () => {
    const r = await grade("{}", { type: "json_schema", schema: { type: "no-existe" } });
    expect(r).toMatchObject({ pass: false, error: true });
    expect(r.reason).toMatch(/^el JSON Schema no es válido: /);
  });
});

describe("json_path_equals", () => {
  const body = '{"categoria":"facturación","items":[{"id":1}],"meta":{"ok":true,"n":null}}';
  it.each([
    [{ path: "categoria", value: "facturación" }, true, 'categoria vale "facturación"'],
    [
      { path: "categoria", value: "cuenta" },
      false,
      'categoria: esperaba "cuenta", obtuvo "facturación"',
    ],
    [{ path: "items.0.id", value: 1 }, true, "items.0.id vale 1"],
    [{ path: "items.0.id", value: "1" }, false, 'items.0.id: esperaba "1", obtuvo 1'],
    [{ path: "items", value: [{ id: 1 }] }, true, 'items vale [{"id":1}]'],
    [{ path: "meta.n", value: null }, true, "meta.n vale null"],
    [{ path: "meta.ok", value: true }, true, "meta.ok vale true"],
    [{ path: "meta.falta", value: 1 }, false, 'meta.falta: no existe (falta "meta.falta")'],
  ])("%j → %s", async (params, pass, reason) => {
    expect(await grade(body, { type: "json_path_equals", ...params })).toEqual({
      pass,
      score: pass ? 1 : 0,
      reason,
    });
  });

  it("reprueba si la respuesta no es JSON", async () => {
    const r = await grade("cuenta", {
      type: "json_path_equals",
      path: "categoria",
      value: "cuenta",
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/^no es JSON válido/);
  });
});
