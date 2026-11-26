import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LineCounter, isMap, isNode, isPair, isScalar, parseDocument } from "yaml";
import type { Document } from "yaml";
import { ConfigError, formatPath } from "./errors.js";
import type { ConfigIssue, IssuePath } from "./errors.js";
import { missingVariables } from "./interpolate.js";
import { Suite, spanishErrors } from "./schema.js";

/** Acceso a disco inyectable, para probar el cargador sin archivos reales. */
export interface FileReader {
  readFile(path: string): Promise<string>;
}

export const nodeFileReader: FileReader = {
  readFile: (path) => readFile(path, "utf8"),
};

const FILE_PREFIX = "file://";

/** Ubica un campo del YAML y devuelve su línea y columna (1-indexadas). */
class Locator {
  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter,
  ) {}

  /**
   * Si el campo no existe (por ejemplo, falta un campo requerido), devuelve la posición
   * del ancestro más cercano. Con `key`, apunta a esa llave dentro del objeto.
   */
  locate(path: IssuePath, key?: string): { line: number; column: number } | undefined {
    for (let depth = path.length; depth >= 0; depth--) {
      const sub = path.slice(0, depth);
      const node: unknown = sub.length === 0 ? this.doc.contents : this.doc.getIn(sub, true);
      if (!isNode(node)) continue;

      let offset = node.range?.[0];
      if (key !== undefined && depth === path.length && isMap(node)) {
        const pair = node.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === key);
        if (pair && isScalar(pair.key)) offset = pair.key.range?.[0] ?? offset;
      }
      if (offset === undefined) continue;
      const { line, col } = this.lines.linePos(offset);
      return { line, column: col };
    }
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isFileRef = (v: unknown): v is string => typeof v === "string" && v.startsWith(FILE_PREFIX);

interface FileRef {
  path: IssuePath;
  ref: string;
  kind: "text" | "json";
  set: (value: unknown) => void;
}

/** Campos que aceptan `file://`: `prompt.system`, `prompt.user` y `schema` de `json_schema`. */
function collectFileRefs(data: Record<string, unknown>): FileRef[] {
  const refs: FileRef[] = [];
  const prompt = data.prompt;
  if (isRecord(prompt)) {
    for (const field of ["system", "user"] as const) {
      const value = prompt[field];
      if (isFileRef(value)) {
        refs.push({
          path: ["prompt", field],
          ref: value,
          kind: "text",
          set: (v) => (prompt[field] = v),
        });
      }
    }
  }
  const cases = data.cases;
  if (Array.isArray(cases)) {
    cases.forEach((c: unknown, i) => {
      if (!isRecord(c) || !Array.isArray(c.expect)) return;
      c.expect.forEach((a: unknown, j) => {
        if (isRecord(a) && a.type === "json_schema" && isFileRef(a.schema)) {
          refs.push({
            path: ["cases", i, "expect", j, "schema"],
            ref: a.schema,
            kind: "json",
            set: (v) => (a.schema = v),
          });
        }
      });
    });
  }
  return refs;
}

/** `file://prompts/x.md` relativo a la carpeta de la suite; también acepta `file:///abs`. */
export function resolveFileRef(ref: string, suiteDir: string): string {
  if (ref.startsWith("file:///")) return fileURLToPath(ref);
  const rel = ref.slice(FILE_PREFIX.length);
  return isAbsolute(rel) ? rel : resolve(suiteDir, rel);
}

const errorMessage = (err: unknown): string => {
  if (isRecord(err) && err.code === "ENOENT") return "el archivo no existe";
  return err instanceof Error ? err.message : String(err);
};

/**
 * Lee, resuelve y valida una suite. Lanza `ConfigError` con todos los problemas encontrados
 * (no solo el primero), cada uno con archivo, línea, columna y campo.
 */
export async function loadSuite(file: string, reader: FileReader = nodeFileReader): Promise<Suite> {
  let source: string;
  try {
    source = await reader.readFile(file);
  } catch (err) {
    throw new ConfigError([
      { file, path: "", message: `no se pudo leer la suite: ${errorMessage(err)}` },
    ]);
  }
  return parseSuite(source, file, reader);
}

/** Como `loadSuite`, pero a partir del texto ya leído. `file` se usa para ubicar y resolver rutas. */
export async function parseSuite(
  source: string,
  file: string,
  reader: FileReader = nodeFileReader,
): Promise<Suite> {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });

  if (doc.errors.length > 0) {
    throw new ConfigError(
      doc.errors.map((e) => {
        const { line, col } = lines.linePos(e.pos[0]);
        return {
          file,
          path: "",
          line,
          column: col,
          message: `YAML inválido: ${e.message.split("\n")[0] ?? e.message}`,
        };
      }),
    );
  }

  const locator = new Locator(doc, lines);
  /** Con `key`, el problema es esa llave dentro del objeto en `path` (p. ej. una llave desconocida). */
  const issueAt = (path: IssuePath, message: string, key?: string): ConfigIssue => ({
    file,
    path: formatPath(key === undefined ? path : [...path, key]),
    ...locator.locate(path, key),
    message,
  });

  const data: unknown = doc.toJS();
  if (!isRecord(data)) {
    throw new ConfigError([issueAt([], "la suite debe ser un objeto YAML (llave: valor)")]);
  }

  // 1. Resolver file:// antes de validar, para que zod vea el contenido real.
  const issues: ConfigIssue[] = [];
  const suiteDir = dirname(resolve(file));
  for (const ref of collectFileRefs(data)) {
    const target = resolveFileRef(ref.ref, suiteDir);
    let text: string;
    try {
      text = await reader.readFile(target);
    } catch (err) {
      issues.push(issueAt(ref.path, `no se pudo leer ${ref.ref}: ${errorMessage(err)}`));
      continue;
    }
    if (ref.kind === "text") {
      ref.set(text);
      continue;
    }
    try {
      ref.set(JSON.parse(text) as unknown);
    } catch (err) {
      issues.push(issueAt(ref.path, `${ref.ref} no es JSON válido: ${errorMessage(err)}`));
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);

  // 2. Validar estructura.
  const parsed = Suite.safeParse(data, { error: spanishErrors });
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.flatMap((iss) =>
        iss.code === "unrecognized_keys"
          ? iss.keys.map((key) => issueAt(iss.path, `llave desconocida "${key}"`, key))
          : [issueAt(iss.path, iss.message)],
      ),
    );
  }
  const suite = parsed.data;

  // 3. Cada {{var}} del prompt tiene que existir en los vars de cada caso.
  const template = `${suite.prompt.system ?? ""}\n${suite.prompt.user}`;
  suite.cases.forEach((c, i) => {
    const missing = missingVariables(template, c.vars);
    if (missing.length === 0) return;
    const list = missing.map((v) => `{{${v}}}`).join(", ");
    issues.push(
      issueAt(
        ["cases", i, "vars"],
        `el prompt usa ${list} pero el caso "${c.id}" no ${missing.length === 1 ? "la define" : "las define"} en vars`,
      ),
    );
  });
  if (issues.length > 0) throw new ConfigError(issues);

  return suite;
}
