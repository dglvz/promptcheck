import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { getPath, parseJsonResponse, showJson } from "../json.js";
import { failed, gradeError, passed } from "../types.js";
import type { Grader } from "../types.js";

/** Calificadores sobre respuestas JSON. Funciones puras (salvo la caché de esquemas compilados). */

export const jsonValid: Grader<"json_valid"> = (output) => {
  const parsed = parseJsonResponse(output.text);
  return parsed.ok ? passed("es JSON válido") : failed(`no es JSON válido: ${parsed.error}`);
};

// Un solo Ajv para todo el proceso; los esquemas compilados se reutilizan entre trials.
const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<object, ValidateFunction | Error>();

function compile(schema: Record<string, unknown>): ValidateFunction | Error {
  let entry = compiled.get(schema);
  if (entry === undefined) {
    try {
      entry = ajv.compile(schema);
    } catch (err) {
      entry = err instanceof Error ? err : new Error(String(err));
    }
    compiled.set(schema, entry);
  }
  return entry;
}

/** Traduce los errores más comunes de ajv; el resto conserva el mensaje original. */
export function describeSchemaError(e: ErrorObject): string {
  const where = e.instancePath === "" ? "(raíz)" : e.instancePath.slice(1).replaceAll("/", ".");
  const params = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required":
      return `${where}: falta el campo "${String(params.missingProperty)}"`;
    case "type":
      return `${where}: debe ser de tipo ${String(params.type)}`;
    case "enum":
      return `${where}: debe ser uno de ${showJson(params.allowedValues)}`;
    case "const":
      return `${where}: debe ser ${showJson(params.allowedValue)}`;
    case "additionalProperties":
      return `${where}: campo no permitido "${String(params.additionalProperty)}"`;
    default:
      return `${where}: ${e.message ?? e.keyword}`;
  }
}

const MAX_ERRORS_SHOWN = 3;

export const jsonSchema: Grader<"json_schema"> = (output, a) => {
  const validate = compile(a.schema);
  if (validate instanceof Error)
    return gradeError(`el JSON Schema no es válido: ${validate.message}`);

  const parsed = parseJsonResponse(output.text);
  if (!parsed.ok) return failed(`no es JSON válido: ${parsed.error}`);

  if (validate(parsed.value)) return passed("cumple el esquema");
  const errors = validate.errors ?? [];
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).map(describeSchemaError);
  const more =
    errors.length > MAX_ERRORS_SHOWN ? ` (y ${errors.length - MAX_ERRORS_SHOWN} más)` : "";
  return failed(`no cumple el esquema: ${shown.join("; ")}${more}`);
};

export const jsonPathEquals: Grader<"json_path_equals"> = (output, a) => {
  const parsed = parseJsonResponse(output.text);
  if (!parsed.ok) return failed(`no es JSON válido: ${parsed.error}`);

  const lookup = getPath(parsed.value, a.path);
  if (!lookup.found) return failed(`${a.path}: no existe (falta "${lookup.at}")`);
  return isDeepStrictEqual(lookup.value, a.value)
    ? passed(`${a.path} vale ${showJson(a.value)}`)
    : failed(`${a.path}: esperaba ${showJson(a.value)}, obtuvo ${showJson(lookup.value)}`);
};
