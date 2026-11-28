import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import type { CliDeps } from "../../src/cli/program.js";
import { FakeProvider, failure, refusal } from "../../src/providers/fake.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** CLI con salida capturada y un FakeProvider; nunca toca la red. */
function cli(fake: FakeProvider) {
  const out: string[] = [];
  const err: string[] = [];
  let providerCreated = false;
  const deps: CliDeps = {
    createProvider: () => {
      providerCreated = true;
      return fake;
    },
    cwd: FIXTURES,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    color: false,
  };
  return {
    run: (...args: string[]) => runCli(args, deps),
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    providerCreated: () => providerCreated,
  };
}

const echo = () => new FakeProvider().when({}, (req) => `Hola ${req.user.split(" ").at(-1) ?? ""}`);

describe("promptcheck run", () => {
  it("corre todas las suites de una carpeta (recursiva, sin ocultas) y sale con 0", async () => {
    const c = cli(echo());
    expect(await c.run("run", "cli/ok")).toBe(0);
    expect(c.stdout()).toContain("Saludo");
    expect(c.stdout()).toContain("Despedida");
    expect(c.stdout()).not.toContain("carpeta oculta");
    expect(c.stdout()).toContain("2/2 suites aprobadas.");
    expect(c.stderr()).toBe("");
  });

  it("sale con 1 si una suite queda bajo el umbral", async () => {
    const fake = new FakeProvider({ default: "Hola Ana" }).when(
      { user: "Luis" },
      "Hola Ana",
      "Hola Luis",
    );
    const c = cli(fake);
    expect(await c.run("run", "cli/ok/saludo.yaml")).toBe(1);
    expect(c.stdout()).toContain("✘ luis · claude-haiku-5-5 (1/2 aprobados) inestable");
    expect(c.stdout()).toContain('trial 1: no contiene "Luis"');
    expect(c.stdout()).toContain("✘ Suite no aprobada: bajo el umbral en claude-haiku-5-5");
  });

  it("un rechazo hace fallar el trial aunque sus aserciones pasen", async () => {
    const fake = new FakeProvider().when({}, refusal("cyber", "Hola Ana Hola Luis"));
    const c = cli(fake);
    expect(await c.run("run", "cli/ok/saludo.yaml", "--trials", "1")).toBe(1);
    expect(c.stdout()).toContain("el modelo rechazó la petición (cyber)");
  });

  it("sale con 2 ante una suite inválida, sin crear el proveedor", async () => {
    const c = cli(echo());
    expect(await c.run("run", "cli/bad")).toBe(2);
    expect(c.stderr()).toMatch(/1 error de configuración:/);
    expect(c.stderr()).toMatch(
      /mala\.yaml:8:15 {2}cases\[0\]\.expect\[0\]\.type: tipo de aserción desconocido/,
    );
    expect(c.providerCreated()).toBe(false);
  });

  it("no corre nada si alguna de las suites es inválida", async () => {
    const fake = echo();
    const c = cli(fake);
    expect(await c.run("run", "cli/ok", "cli/bad")).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [["run", "no-existe"], "no existe la ruta: no-existe"],
    [["run", "cli/ok", "--model", "claude-opus"], "modelo desconocido: claude-opus"],
    [["run", "cli/ok/saludo.yaml", "--case", "pepe"], "caso desconocido: pepe"],
    [["run", "--trials", "0"], "--trials debe ser un entero mayor que 0"],
    [["run", "--concurrency", "x"], "--concurrency debe ser un entero mayor que 0"],
    [["run", "--opcion-inexistente"], "unknown option"],
  ])("sale con 2: %j", async (args, message) => {
    const c = cli(echo());
    expect(await c.run(...args)).toBe(2);
    expect(c.stderr()).toContain(message);
  });

  it("sale con 4 ante un error fatal del proveedor y no corre las suites restantes", async () => {
    const fake = new FakeProvider().when(
      {},
      failure("authentication", "credenciales inválidas", 401),
    );
    const c = cli(fake);
    expect(await c.run("run", "cli/ok")).toBe(4);
    expect(c.stdout()).toContain("✘ Corrida detenida: [authentication] credenciales inválidas");
    expect(c.stderr()).toContain("No se corrieron 1 suite(s) restante(s).");
  });

  it("sale con 4 si el modelo del juez no existe", async () => {
    const fake = new FakeProvider()
      .when({ model: "claude-opus-typo" }, failure("not_found", "modelo no encontrado", 404))
      .when({}, "Hola Ana");
    const c = cli(fake);
    expect(await c.run("run", "cli/judge")).toBe(4);
    expect(c.stdout()).toContain(
      "✘ Corrida detenida: [not_found] juez (claude-opus-typo): modelo no encontrado",
    );
  });

  it("aplica --model, --case, --trials y --concurrency", async () => {
    const fake = echo();
    const c = cli(fake);
    const code = await c.run(
      "run",
      "cli/ok/saludo.yaml",
      "--model",
      "claude-haiku-5-5",
      "--case",
      "ana,luis",
      "--trials",
      "3",
      "--concurrency",
      "1",
    );
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(6);
    expect(fake.maxInFlight).toBe(1);
  });

  it("--help y --version salen con 0", async () => {
    const c = cli(echo());
    expect(await c.run("--version")).toBe(0);
    expect(await c.run("run", "--help")).toBe(0);
    expect(c.stdout()).toContain("Usage: promptcheck run");
  });
});
