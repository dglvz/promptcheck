import { Command, CommanderError, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { AnthropicProvider } from "../providers/anthropic.js";
import { VERSION } from "../version.js";
import { runCommand } from "./commands/run.js";
import type { RunDeps, RunFlags } from "./commands/run.js";
import { EXIT } from "./exit-codes.js";

/** Dependencias de la CLI; en las pruebas se reemplazan (proveedor falso, salida capturada). */
export type CliDeps = RunDeps;

export function defaultDeps(): CliDeps {
  const progress = process.stderr.isTTY
    ? (done: number, total: number) => {
        process.stderr.write(`\r  ${done}/${total} trials`);
        if (done === total) process.stderr.write("\r\x1b[K");
      }
    : undefined;
  return {
    createProvider: () => new AnthropicProvider(),
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    color: pc.isColorSupported,
    ...(progress === undefined ? {} : { progress }),
  };
}

const positiveInt = (name: string) => (value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(`${name} debe ser un entero mayor que 0`);
  }
  return n;
};

/** Acepta `--model a --model b` y `--model a,b`. */
const collect = (value: string, previous: string[] | undefined): string[] => [
  ...(previous ?? []),
  ...value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
];

interface RunOptions extends RunFlags {
  color: boolean;
}

/** Construye el programa. `setExit` recibe el código de salida de cada comando. */
export function createProgram(
  deps: CliDeps = defaultDeps(),
  setExit: (code: number) => void = () => undefined,
): Command {
  const program = new Command()
    .name("promptcheck")
    .description("Evalúa prompts de Claude como si fueran pruebas unitarias.")
    .version(VERSION, "-v, --version", "muestra la versión")
    .helpOption("-h, --help", "muestra la ayuda")
    .helpCommand("help [comando]", "muestra la ayuda de un comando")
    .configureOutput({
      writeOut: (s) => {
        deps.stdout(s.replace(/\n$/, ""));
      },
      writeErr: (s) => {
        deps.stderr(s.replace(/\n$/, ""));
      },
    })
    .exitOverride();

  program
    .command("run")
    .description("corre las suites (archivos o carpetas; por defecto, evals/)")
    .argument("[rutas...]", "archivos .yaml o carpetas con suites", ["evals"])
    .option("-m, --model <ids>", "solo estos modelos (repetible o separados por comas)", collect)
    .option("-c, --case <ids>", "solo estos casos (repetible o separados por comas)", collect)
    .option("-t, --trials <n>", "repeticiones por caso y modelo", positiveInt("--trials"))
    .option(
      "--concurrency <n>",
      "llamadas simultáneas (por defecto 4)",
      positiveInt("--concurrency"),
    )
    .option("--no-color", "salida sin colores")
    .action(async (paths: string[], opts: RunOptions) => {
      const { color, ...flags } = opts;
      setExit(await runCommand(paths, flags, { ...deps, color: deps.color && color }));
    });

  return program;
}

/** Ejecuta la CLI y devuelve el código de salida (sin llamar a process.exit). */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps = defaultDeps(),
): Promise<number> {
  let code: number = EXIT.OK;
  const program = createProgram(deps, (c) => (code = c));
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help y --version terminan con código 0; un flag o argumento inválido, con 2.
      return err.exitCode === 0 ? EXIT.OK : EXIT.CONFIG;
    }
    throw err;
  }
  return code;
}
