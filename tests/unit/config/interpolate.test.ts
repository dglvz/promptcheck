import { describe, expect, it } from "vitest";
import {
  MissingVariableError,
  findVariables,
  interpolate,
  missingVariables,
} from "../../../src/config/interpolate.js";

describe("findVariables", () => {
  it.each([
    ["sin variables", []],
    ["{{a}}", ["a"]],
    ["{{ a }} y {{b_2}}", ["a", "b_2"]],
    ["{{a}} {{a}} {{ a }}", ["a"]],
    ["{{1a}} {{a-b}} {a} {{}}", []],
  ])("%j → %j", (template, expected) => {
    expect(findVariables(template)).toEqual(expected);
  });
});

describe("interpolate", () => {
  it("reemplaza variables de texto, número y booleano", () => {
    expect(interpolate("{{t}} / {{ n }} / {{b}}", { t: "hola", n: 3, b: false })).toBe(
      "hola / 3 / false",
    );
  });

  it("no reinterpreta valores que contienen llaves", () => {
    expect(interpolate("{{a}}", { a: "{{b}}", b: "x" })).toBe("{{b}}");
  });

  it("deja intacto el texto que no es una variable", () => {
    expect(interpolate('JSON: {"k": 1}', {})).toBe('JSON: {"k": 1}');
  });

  it("lanza MissingVariableError con las variables que faltan", () => {
    expect(() => interpolate("{{a}} {{b}} {{c}}", { b: 1 })).toThrow(MissingVariableError);
    try {
      interpolate("{{a}} {{b}} {{c}}", { b: 1 });
    } catch (err) {
      expect((err as MissingVariableError).missing).toEqual(["a", "c"]);
      expect((err as Error).message).toBe("faltan variables: {{a}}, {{c}}");
    }
  });

  it("no confunde propiedades heredadas con variables definidas", () => {
    expect(missingVariables("{{toString}}", {})).toEqual(["toString"]);
  });
});
