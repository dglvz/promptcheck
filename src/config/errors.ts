/** Errores de configuración con ubicación: archivo, línea, columna y campo. */

export type IssuePath = readonly PropertyKey[];

export interface ConfigIssue {
  file: string;
  /** Campo en notación legible: `cases[1].expect[0].type`. Vacío para la raíz. */
  path: string;
  /** 1-indexada. Ausente si no se puede ubicar en el YAML. */
  line?: number;
  /** 1-indexada. */
  column?: number;
  message: string;
}

/** `["cases", 1, "expect", 0]` → `cases[1].expect[0]`. */
export function formatPath(path: IssuePath): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out === "" ? String(key) : `.${String(key)}`;
  }
  return out;
}

/** `evals/x.yaml:12:5  cases[1].id: id repetido` (formato que entienden los editores). */
export function formatIssue(issue: ConfigIssue): string {
  const where =
    issue.line === undefined
      ? issue.file
      : `${issue.file}:${issue.line}${issue.column === undefined ? "" : `:${issue.column}`}`;
  const field = issue.path === "" ? "" : `${issue.path}: `;
  return `${where}  ${field}${issue.message}`;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const n = issues.length;
    super(
      `${n === 1 ? "1 error" : `${n} errores`} de configuración:\n` +
        issues.map((i) => `  ${formatIssue(i)}`).join("\n"),
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}
