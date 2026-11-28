/**
 * Utilidades JSON compartidas por json_valid, json_schema y json_path_equals.
 * Funciones puras.
 */

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

const FENCE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```/i;

/**
 * Interpreta la respuesta como JSON. Tolera que venga dentro de un bloque ```json … ```,
 * algo que los modelos hacen a menudo aunque se les pida JSON puro.
 */
export function parseJsonResponse(text: string): JsonParse {
  const trimmed = text.trim();
  const attempt = (source: string): JsonParse => {
    try {
      return { ok: true, value: JSON.parse(source) as unknown };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const direct = attempt(trimmed);
  if (direct.ok) return direct;
  const fenced = FENCE.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    const inner = attempt(fenced[1].trim());
    if (inner.ok) return inner;
    return { ok: false, error: `el bloque de código no es JSON válido: ${inner.error}` };
  }
  return trimmed === "" ? { ok: false, error: "la respuesta está vacía" } : direct;
}

export type PathLookup = { found: true; value: unknown } | { found: false; at: string };

/** Sigue una ruta con puntos (`a.b.0`) dentro de un valor JSON. */
export function getPath(value: unknown, path: string): PathLookup {
  let current = value;
  const walked: string[] = [];
  for (const segment of path.split(".")) {
    walked.push(segment);
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : Number.NaN;
      if (!(index < current.length)) return { found: false, at: walked.join(".") };
      current = current[index];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false, at: walked.join(".") };
    }
  }
  return { found: true, value: current };
}

/** JSON compacto y recortado para mostrar en razones. */
export function showJson(value: unknown, max = 60): string {
  // JSON.stringify devuelve undefined para undefined o funciones, aunque su tipo diga string.
  const text = (JSON.stringify(value) as string | undefined) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
