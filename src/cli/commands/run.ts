import { relative } from "node:path";
import { ConfigError, formatIssue } from "../../config/errors.js";
import { loadSuite } from "../../config/load.js";
import type { Suite } from "../../config/schema.js";
import { PlanError, planSuite } from "../../planner/plan.js";
import type { PlanOptions } from "../../planner/plan.js";
import type { Provider } from "../../providers/provider.js";
import { renderTerminalReport } from "../../report/terminal.js";
import { evaluateSuite } from "../../runner/evaluate.js";
import { aggregate } from "../../stats/aggregate.js";
import { EXIT } from "../exit-codes.js";
import type { ExitCode } from "../exit-codes.js";
import { UsageError, findSuiteFiles } from "../files.js";

export interface RunFlags {
  model?: string[];
  case?: string[];
  trials?: number;
  concurrency?: number;
}

export interface RunDeps {
  /** Se crea recién cuando todas las suites son válidas, para no exigir credenciales antes. */
  createProvider: () => Provider;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  /** Progreso en vivo (por ejemplo, una línea que se reescribe en una TTY). */
  progress?: (done: number, total: number) => void;
}

interface LoadedSuite {
  file: string;
  display: string;
  suite: Suite;
}

/** Carga y valida todas las suites antes de gastar un solo token. */
async function loadAll(
  paths: readonly string[],
  plan: PlanOptions,
  deps: RunDeps,
): Promise<LoadedSuite[] | ExitCode> {
  let files: string[];
  try {
    files = await findSuiteFiles(paths, deps.cwd);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`Error: ${err.message}`);
      return EXIT.CONFIG;
    }
    throw err;
  }

  const loaded: LoadedSuite[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const display = relative(deps.cwd, file) || file;
    try {
      const suite = await loadSuite(file);
      planSuite(suite, plan); // valida filtros y trials sin ejecutar nada
      loaded.push({ file, display, suite });
    } catch (err) {
      if (err instanceof ConfigError) {
        problems.push(...err.issues.map((i) => formatIssue({ ...i, file: display })));
      } else if (err instanceof PlanError) {
        problems.push(`${display}  ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  if (problems.length > 0) {
    const n = problems.length;
    deps.stderr(`${n === 1 ? "1 error" : `${n} errores`} de configuración:`);
    for (const p of problems) deps.stderr(`  ${p}`);
    return EXIT.CONFIG;
  }
  return loaded;
}

export async function runCommand(
  paths: readonly string[],
  flags: RunFlags,
  deps: RunDeps,
): Promise<ExitCode> {
  const plan: PlanOptions = {
    ...(flags.model === undefined ? {} : { models: flags.model }),
    ...(flags.case === undefined ? {} : { cases: flags.case }),
    ...(flags.trials === undefined ? {} : { trials: flags.trials }),
  };

  const loaded = await loadAll(paths, plan, deps);
  if (typeof loaded === "number") return loaded;

  const provider = deps.createProvider();
  let passedSuites = 0;
  for (const [i, { file, display, suite }] of loaded.entries()) {
    if (i > 0) deps.stdout("");
    const result = await evaluateSuite(suite, file, {
      provider,
      plan,
      ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
      ...(deps.progress === undefined ? {} : { onTrialDone: deps.progress }),
    });
    const stats = aggregate(result);
    deps.stdout(renderTerminalReport({ ...result, file: display }, stats, { color: deps.color }));

    if (result.aborted) {
      const left = loaded.length - i - 1;
      if (left > 0) deps.stderr(`No se corrieron ${left} suite(s) restante(s).`);
      return EXIT.API;
    }
    if (stats.pass) passedSuites++;
  }

  if (loaded.length > 1) deps.stdout(`\n${passedSuites}/${loaded.length} suites aprobadas.`);
  return passedSuites === loaded.length ? EXIT.OK : EXIT.FAILED;
}
