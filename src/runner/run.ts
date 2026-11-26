import pLimit from "p-limit";
import type { Trial } from "../planner/plan.js";
import { ProviderError } from "../providers/provider.js";
import type { CompletionResult, Provider, ProviderErrorKind } from "../providers/provider.js";

/**
 * Ejecuta los trials contra un proveedor con concurrencia limitada (sección 5).
 *
 * - Respeta `concurrency` (por defecto 4) para no chocar con los rate limits.
 * - Devuelve un resultado por trial, en el mismo orden del plan, sin importar en qué orden
 *   terminen.
 * - Un error no fatal (rate limit, sobrecarga, 5xx…) queda registrado en su trial y la corrida
 *   sigue. Un error fatal (credenciales, petición inválida, facturación…) deja de lanzar trials
 *   nuevos: los que ya estaban en curso terminan y el resto se marca como omitido.
 *
 * La caché de respuestas y el tope de gasto (`--max-cost`) se agregan aquí en v0.2.
 */

export const DEFAULT_CONCURRENCY = 4;

/** Error serializable (va a los reportes JSON tal cual). */
export interface TrialError {
  kind: ProviderErrorKind;
  message: string;
  fatal: boolean;
  status?: number;
}

export type TrialOutcome =
  | { status: "completed"; completion: CompletionResult }
  | { status: "error"; error: TrialError }
  | { status: "skipped" };

export type TrialRun = TrialOutcome & { trial: Trial };

export interface RunOptions {
  provider: Provider;
  concurrency?: number;
  /** Se llama al terminar cada trial (completado o con error), en orden de llegada. */
  onTrialDone?: (run: TrialRun, done: number, total: number) => void;
}

export interface RunResult {
  runs: TrialRun[];
  /** Presente si la corrida se cortó por un error fatal. */
  aborted?: TrialError;
}

export function toTrialError(err: unknown): TrialError {
  if (err instanceof ProviderError) {
    return {
      kind: err.kind,
      message: err.message,
      fatal: err.fatal,
      ...(err.status === undefined ? {} : { status: err.status }),
    };
  }
  // Un fallo que no viene del proveedor es un bug de promptcheck o de la prueba:
  // se registra en el trial sin cortar la corrida, con el mensaje original.
  return {
    kind: "unknown",
    message: err instanceof Error ? err.message : String(err),
    fatal: false,
  };
}

export async function runTrials(trials: readonly Trial[], options: RunOptions): Promise<RunResult> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency debe ser un entero mayor que 0 (se recibió ${concurrency})`);
  }

  const limit = pLimit(concurrency);
  let aborted: TrialError | undefined;
  let done = 0;

  const runs = await Promise.all(
    trials.map((trial) =>
      limit(async (): Promise<TrialRun> => {
        if (aborted !== undefined) return { trial, status: "skipped" };

        let run: TrialRun;
        try {
          const completion = await options.provider.complete(trial.request);
          run = { trial, status: "completed", completion };
        } catch (err) {
          const error = toTrialError(err);
          if (error.fatal) aborted ??= error;
          run = { trial, status: "error", error };
        }
        done++;
        options.onTrialDone?.(run, done, trials.length);
        return run;
      }),
    ),
  );

  return aborted === undefined ? { runs } : { runs, aborted };
}
