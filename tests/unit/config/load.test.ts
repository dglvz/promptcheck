import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, formatIssue } from "../../../src/config/errors.js";
import type { ConfigIssue } from "../../../src/config/errors.js";
import { loadSuite, parseSuite, resolveFileRef } from "../../../src/config/load.js";
import type { FileReader } from "../../../src/config/load.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/suites/", import.meta.url));
const SUITE = resolve("/proyecto/evals/suite.yaml");

/** Lector en memoria: las llaves son rutas relativas a la carpeta de la suite. */
function memoryReader(files: Record<string, string>): FileReader {
  const byPath = new Map(
    Object.entries(files).map(([p, c]) => [resolve("/proyecto/evals", p), c] as const),
  );
  return {
    readFile: (path) => {
      const content = byPath.get(resolve(path));
      if (content === undefined) {
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      }
      return Promise.resolve(content);
    },
  };
}

async function issuesOf(yaml: string, files: Record<string, string> = {}): Promise<ConfigIssue[]> {
  try {
    await parseSuite(yaml, SUITE, memoryReader(files));
  } catch (err) {
    if (err instanceof ConfigError) return [...err.issues];
    throw err;
  }
  throw new Error("se esperaba un ConfigError");
}

const VALID = `name: Prueba
models: [claude-haiku-5-5]
prompt:
  user: "Hola {{nombre}}"
cases:
  - id: uno
    vars: { nombre: Ana }
    expect:
      - type: contains
        value: Ana
`;

describe("loadSuite con archivos reales", () => {
  it("carga el fixture de tickets y resuelve file://", async () => {
    const suite = await loadSuite(resolve(FIXTURES, "tickets/suite.yaml"));
    expect(suite.name).toBe("Clasificación de tickets de soporte");
    expect(suite.models).toEqual([
      { id: "claude-opus-5-5", effort: "medium" },
      { id: "claude-haiku-5-5" },
    ]);
    expect(suite.prompt.system).toContain("Eres un clasificador de tickets");
    expect(suite.prompt.user).toBe("Ticket del cliente:\n{{texto}}");
    expect(suite.defaults).toEqual({ max_tokens: 1024, trials: 3, cache_system: true });
    const schema = suite.cases[0]?.expect[0];
    expect(schema?.type).toBe("json_schema");
    if (schema?.type === "json_schema") {
      expect(schema.schema).toMatchObject({ required: ["categoria", "prioridad", "resumen"] });
    }
  });

  it("reporta un archivo de suite inexistente", async () => {
    const missing = resolve(FIXTURES, "no-existe.yaml");
    await expect(loadSuite(missing)).rejects.toThrow(
      /no se pudo leer la suite: el archivo no existe/,
    );
  });
});

describe("parseSuite", () => {
  it("acepta una suite válida", async () => {
    const suite = await parseSuite(VALID, SUITE, memoryReader({}));
    expect(suite.cases[0]?.vars).toEqual({ nombre: "Ana" });
  });

  it("ubica un tipo de aserción desconocido en su línea", async () => {
    const yaml = VALID.replace("type: contains", "type: contiene");
    const [issue] = await issuesOf(yaml);
    expect(issue).toMatchObject({
      file: SUITE,
      path: "cases[0].expect[0].type",
      line: 9,
      column: 15,
    });
    expect(issue?.message).toMatch(/^tipo de aserción desconocido/);
  });

  it("apunta a la llave desconocida, no al objeto", async () => {
    const yaml = VALID.replace("    expect:", "    expcet: []\n    expect:");
    const issues = await issuesOf(yaml);
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: "cases[0].expcet",
        line: 8,
        column: 5,
        message: 'llave desconocida "expcet"',
      }),
    );
  });

  it("ubica un campo requerido faltante en su objeto padre", async () => {
    const yaml = VALID.replace("        value: Ana\n", "");
    const [issue] = await issuesOf(yaml);
    expect(issue).toMatchObject({
      path: "cases[0].expect[0].value",
      line: 9,
      message: "campo requerido",
    });
  });

  it("reporta todos los errores de una vez", async () => {
    const yaml = `name: ""
models: []
prompt: { user: x }
cases: []
`;
    const issues = await issuesOf(yaml);
    expect(issues.map((i) => i.path)).toEqual(["name", "models", "cases"]);
    expect(issues.map((i) => i.line)).toEqual([1, 2, 4]);
  });

  it("detecta variables del prompt que el caso no define", async () => {
    const yaml = VALID.replace("vars: { nombre: Ana }", "vars: { otro: 1 }");
    const [issue] = await issuesOf(yaml);
    expect(issue).toMatchObject({ path: "cases[0].vars", line: 7 });
    expect(issue?.message).toBe('el prompt usa {{nombre}} pero el caso "uno" no la define en vars');
  });

  it("también revisa las variables del system prompt leído desde archivo", async () => {
    const yaml = VALID.replace("prompt:", "prompt:\n  system: file://sys.md");
    const [issue] = await issuesOf(yaml, { "sys.md": "Tono: {{tono}}" });
    expect(issue?.message).toContain("{{tono}}");
  });

  it("reporta YAML mal formado con su línea", async () => {
    const [issue] = await issuesOf("name: x\nmodels: [a\n");
    expect(issue?.message).toMatch(/^YAML inválido:/);
    expect(issue?.line).toBeGreaterThanOrEqual(2);
  });

  it("rechaza llaves duplicadas", async () => {
    const [issue] = await issuesOf(`name: a\nname: b\n${VALID.split("\n").slice(1).join("\n")}`);
    expect(issue?.message).toMatch(/^YAML inválido:/);
    expect(issue?.line).toBe(2);
  });

  it("rechaza un documento que no es un objeto", async () => {
    const [issue] = await issuesOf("- solo\n- una lista\n");
    expect(issue?.message).toBe("la suite debe ser un objeto YAML (llave: valor)");
  });

  it("reporta un file:// inexistente en el campo que lo usa", async () => {
    const yaml = VALID.replace("prompt:", "prompt:\n  system: file://prompts/falta.md");
    const [issue] = await issuesOf(yaml);
    expect(issue).toMatchObject({ path: "prompt.system", line: 4, column: 11 });
    expect(issue?.message).toBe("no se pudo leer file://prompts/falta.md: el archivo no existe");
  });

  it("lee el esquema JSON desde file:// y reporta JSON inválido", async () => {
    const yaml = VALID.replace(
      "      - type: contains\n        value: Ana",
      "      - type: json_schema\n        schema: file://s.json",
    );
    await expect(
      parseSuite(yaml, SUITE, memoryReader({ "s.json": '{"type":"object"}' })),
    ).resolves.toBeDefined();

    const [issue] = await issuesOf(yaml, { "s.json": "{ no es json" });
    expect(issue?.path).toBe("cases[0].expect[0].schema");
    expect(issue?.message).toMatch(/^file:\/\/s\.json no es JSON válido/);
  });

  it("no resuelve file:// en campos que no lo aceptan", async () => {
    const yaml = VALID.replace("value: Ana", "value: file://x.txt").replace(
      "Hola {{nombre}}",
      "Hola",
    );
    const suite = await parseSuite(yaml, SUITE, memoryReader({}));
    expect(suite.cases[0]?.expect[0]).toMatchObject({ value: "file://x.txt" });
  });
});

describe("resolveFileRef", () => {
  it("resuelve rutas relativas a la carpeta de la suite", () => {
    expect(resolveFileRef("file://prompts/a.md", resolve("/s"))).toBe(resolve("/s/prompts/a.md"));
  });

  it("acepta rutas absolutas", () => {
    const abs = resolve("/otra/a.md");
    expect(resolveFileRef(`file://${abs}`, resolve("/s"))).toBe(abs);
  });
});

describe("formatIssue", () => {
  it.each([
    [
      { file: "s.yaml", path: "cases[0].id", line: 3, column: 7, message: "m" },
      "s.yaml:3:7  cases[0].id: m",
    ],
    [{ file: "s.yaml", path: "", line: 3, message: "m" }, "s.yaml:3  m"],
    [{ file: "s.yaml", path: "name", message: "m" }, "s.yaml  name: m"],
  ])("%j", (issue, expected) => {
    expect(formatIssue(issue)).toBe(expected);
  });

  it("ConfigError resume la cantidad de errores", () => {
    const one = new ConfigError([{ file: "a", path: "", message: "x" }]);
    const two = new ConfigError([
      { file: "a", path: "", message: "x" },
      { file: "a", path: "", message: "y" },
    ]);
    expect(one.message).toMatch(/^1 error de configuración:/);
    expect(two.message).toMatch(/^2 errores de configuración:/);
  });
});
