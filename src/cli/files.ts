import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

/** Busca archivos de suite (.yaml / .yml) en las rutas dadas. */

const SUITE_EXTENSIONS = new Set([".yaml", ".yml"]);

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Carpetas que nunca contienen suites: ocultas (.baseline, .promptcheck…) y dependencias. */
const isIgnoredDir = (segment: string): boolean =>
  segment.startsWith(".") || segment === "node_modules";

async function suitesInDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && SUITE_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map((e) => join(e.parentPath, e.name))
    .filter((file) => !relative(dir, file).split(sep).slice(0, -1).some(isIgnoredDir));
}

/**
 * Devuelve las rutas absolutas de las suites, ordenadas y sin repetir. Un archivo se acepta
 * con cualquier extensión (lo pidió explícitamente); una carpeta se recorre recursivamente.
 */
export async function findSuiteFiles(paths: readonly string[], cwd: string): Promise<string[]> {
  const found = new Set<string>();
  for (const p of paths) {
    const abs = resolve(cwd, p);
    let info;
    try {
      info = await stat(abs);
    } catch {
      throw new UsageError(`no existe la ruta: ${p}`);
    }
    if (info.isDirectory()) {
      const files = await suitesInDir(abs);
      if (files.length === 0) throw new UsageError(`no hay suites (.yaml/.yml) en ${p}`);
      for (const f of files) found.add(f);
    } else {
      found.add(abs);
    }
  }
  return [...found].sort();
}
