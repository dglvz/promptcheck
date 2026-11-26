/**
 * Interpolación de `{{variables}}` en los prompts. Funciones puras, sin dependencias.
 *
 * Sintaxis: `{{nombre}}` o `{{ nombre }}`, donde el nombre usa letras, números y `_`.
 * No hay escapes ni expresiones: lo que no coincide con el patrón se deja tal cual.
 */

export type VarValue = string | number | boolean;
export type Vars = Readonly<Record<string, VarValue>>;

const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Nombres de variables usados en la plantilla, sin repetir y en orden de aparición. */
export function findVariables(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(VARIABLE), (m) => m[1] ?? ""))];
}

/** Variables de la plantilla que no están en `vars`. */
export function missingVariables(template: string, vars: Vars): string[] {
  return findVariables(template).filter((name) => !Object.hasOwn(vars, name));
}

export class MissingVariableError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`faltan variables: ${missing.map((v) => `{{${v}}}`).join(", ")}`);
    this.name = "MissingVariableError";
  }
}

/** Reemplaza cada `{{var}}` por su valor. Lanza `MissingVariableError` si falta alguna. */
export function interpolate(template: string, vars: Vars): string {
  const missing = missingVariables(template, vars);
  if (missing.length > 0) throw new MissingVariableError(missing);
  return template.replace(VARIABLE, (_match, name: string) => String(vars[name]));
}
