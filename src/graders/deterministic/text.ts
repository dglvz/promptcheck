import { failed, graphemes, passed, preview } from "../types.js";
import type { Grader } from "../types.js";

/** Calificadores sobre el texto de la respuesta. Funciones puras. */

const asList = (value: string | readonly string[]): readonly string[] =>
  typeof value === "string" ? [value] : value;

const list = (items: readonly string[]): string => items.map((v) => preview(v, 40)).join(", ");

export const equals: Grader<"equals"> = (output, a) => {
  const actual = a.trim ? output.text.trim() : output.text;
  const expected = a.trim ? a.value.trim() : a.value;
  return actual === expected
    ? passed(`es exactamente ${preview(expected)}`)
    : failed(`esperaba ${preview(expected)}, obtuvo ${preview(actual)}`);
};

function findMatches(text: string, values: readonly string[], caseInsensitive: boolean) {
  const haystack = caseInsensitive ? text.toLocaleLowerCase() : text;
  const found: string[] = [];
  const missing: string[] = [];
  for (const v of values) {
    (haystack.includes(caseInsensitive ? v.toLocaleLowerCase() : v) ? found : missing).push(v);
  }
  return { found, missing };
}

export const contains: Grader<"contains"> = (output, a) => {
  const values = asList(a.value);
  const { found, missing } = findMatches(output.text, values, a.case_insensitive);
  const score = found.length / values.length;
  return missing.length === 0
    ? passed(`contiene ${list(values)}`)
    : failed(`no contiene ${list(missing)}`, score);
};

export const notContains: Grader<"not_contains"> = (output, a) => {
  const values = asList(a.value);
  const { found, missing } = findMatches(output.text, values, a.case_insensitive);
  const score = missing.length / values.length;
  return found.length === 0
    ? passed(`no contiene ${list(values)}`)
    : failed(`contiene ${list(found)}, que no debería aparecer`, score);
};

export const regex: Grader<"regex"> = (output, a) => {
  // El esquema ya verificó que la expresión compile.
  const re = new RegExp(a.pattern, a.flags);
  const shown = `/${a.pattern}/${a.flags ?? ""}`;
  return re.test(output.text)
    ? passed(`coincide con ${shown}`)
    : failed(`no coincide con ${shown}; obtuvo ${preview(output.text)}`);
};

/** Cuenta caracteres como los ve una persona, no unidades UTF-16: "ñ" y "👍🏽" valen 1. */
const countChars = (text: string): number => graphemes(text).length;
const countWords = (text: string): number => text.split(/\s+/u).filter(Boolean).length;

export const maxLength: Grader<"max_length"> = (output, a) => {
  // El esquema garantiza exactamente uno de los dos.
  const [limit, actual, unit] =
    a.chars !== undefined
      ? [a.chars, countChars(output.text), "caracteres"]
      : [a.words ?? 0, countWords(output.text), "palabras"];
  return actual <= limit
    ? passed(`${actual} ${unit} (máximo ${limit})`)
    : failed(`${actual} ${unit}, supera el máximo de ${limit}`, limit / actual);
};
