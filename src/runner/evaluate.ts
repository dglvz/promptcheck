import pLimit from "p-limit";
import type { Suite, Thresholds } from "../config/schema.js";
import { gradeTrial } from "../graders/index.js";
import type { GradeResult, JudgeContext } from "../graders/index.js";
import { planSuite } from "../planner/plan.js";
import type { PlanOptions } from "../planner/plan.js";
import { ProviderError } from "../providers/provider.js";
import type { CompletionResult, Provider } from "../providers/provider.js";
import { DEFAULT_CONCURRENCY, runTrials, toTrialError } from "./run.js";
import type { TrialError, TrialRun } from "./run.js";
import { mapWithWarmup } from "./warmup.js";

/**
 * Corre una suite completa: plan → runner → calificadores. Devuelve un resultado por trial,
 * listo para las estadísticas y los reportes (y serializable a JSON).
 */

export interface TrialResult {
  id: string;
  caseId: string;
  model: string;
  trial: number;
  status: TrialRun["status"];
  completion: CompletionResult | null;
  error?: TrialError;
  grades: GradeResult[];
  pass: boolean;
  score: number;
  /**
   * Si la respuesta no terminó normalmente (`refusal`, `max_tokens`…), el trial no aprueba
   * aunque sus aserciones pasen: un texto cortado o un rechazo no es una respuesta válida.
   */
  stopIssue?: string;
}

export interface SuiteResult {
  name: string;
  file: string;
  thresholds: Thresholds;
  /** Si la suite pidió prompt caching del system (para avisar cuando no tuvo efecto). */
  cacheSystem: boolean;
  /** `defaults.max_tokens` de la suite (para sugerir subirlo si hubo cortes). */
  maxTokens: number;
  results: TrialResult[];
  /** Presente si la corrida se cortó por un error fatal del proveedor (de los trials o del juez). */
  aborted?: TrialError;
}

export interface EvaluateOptions {
  provider: Provider;
  /** Proveedor del juez LLM; por defecto, el mismo que el de los trials. */
  judgeProvider?: Provider;
  plan?: PlanOptions;
  concurrency?: number;
  onTrialDone?: (done: number, total: number) => void;
}

const NORMAL_STOPS: ReadonlySet<string> = new Set(["end_turn", "stop_sequence"]);

export function describeStop(completion: CompletionResult): string | undefined {
  if (NORMAL_STOPS.has(completion.stopReason)) return undefined;
  if (completion.stopReason === "refusal") {
    return `el modelo rechazó la petición (${completion.refusalCategory ?? "sin categoría"})`;
  }
  if (completion.stopReason === "max_tokens") {
    return "la respuesta se cortó por max_tokens";
  }
  return `la respuesta terminó por ${completion.stopReason}`;
}

async function toResult(run: TrialRun, judge: JudgeContext | undefined): Promise<TrialResult> {
  const base = {
    id: run.trial.id,
    caseId: run.trial.caseId,
    model: run.trial.model.id,
    trial: run.trial.trial,
    status: run.status,
  };
  if (run.status !== "completed") {
    return {
      ...base,
      completion: null,
      ...(run.status === "error" ? { error: run.error } : {}),
      grades: [],
      pass: false,
      score: 0,
    };
  }
  const { system, user } = run.trial.request;
  const graded = await gradeTrial(run.completion, run.trial.assertions, {
    ...(judge === undefined ? {} : { judge }),
    input: { user, ...(system === undefined ? {} : { system }) },
  });
  const stopIssue = describeStop(run.completion);
  return {
    ...base,
    completion: run.completion,
    grades: graded.grades,
    pass: graded.pass && stopIssue === undefined,
    score: graded.score,
    ...(stopIssue === undefined ? {} : { stopIssue }),
  };
}

export async function evaluateSuite(
  suite: Suite,
  file: string,
  options: EvaluateOptions,
): Promise<SuiteResult> {
  const plan = planSuite(suite, options.plan);
  const { runs, aborted } = await runTrials(plan, {
    provider: options.provider,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.onTrialDone === undefined
      ? {}
      : { onTrialDone: (_run, done, total) => options.onTrialDone?.(done, total) }),
  });

  // El juez también llama a la API: sus llamadas respetan el mismo límite de concurrencia.
  const judgeProvider = stopAfterFatal(options.judgeProvider ?? options.provider);
  const judge: JudgeContext | undefined =
    suite.judge === undefined
      ? undefined
      : {
          provider: judgeProvider,
          model: suite.judge.model,
          ...(suite.judge.effort === undefined ? {} : { effort: suite.judge.effort }),
        };
  const limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
  // El prefijo del juez (instrucciones + system evaluado + rúbrica) es el mismo para todos los
  // trials de un caso: el primero de cada caso se califica solo, para que el resto lea la caché.
  const judgeGroup = (run: TrialRun): string | undefined =>
    judge !== undefined &&
    run.status === "completed" &&
    run.trial.assertions.some((a) => a.type === "llm_judge")
      ? run.trial.caseId
      : undefined;
  const results = await mapWithWarmup(runs, limit, judgeGroup, (run) => toResult(run, judge));

  // Un error fatal del juez (por ejemplo, judge.model inexistente) invalida la corrida igual
  // que uno de los trials: código de salida 4 en vez de "no evaluable" en cada trial.
  const judgeFatal = judgeProvider.fatal();
  const stopped =
    aborted ??
    (judgeFatal === undefined
      ? undefined
      : { ...judgeFatal, message: `juez (${suite.judge?.model ?? "?"}): ${judgeFatal.message}` });
  return {
    name: suite.name,
    file,
    thresholds: suite.thresholds,
    cacheSystem: suite.defaults.cache_system,
    maxTokens: suite.defaults.max_tokens,
    results,
    ...(stopped === undefined ? {} : { aborted: stopped }),
  };
}

/**
 * Envuelve un proveedor para que, tras el primer error fatal, las llamadas siguientes fallen
 * al instante con ese mismo error en vez de repetir una petición que no puede funcionar.
 */
export function stopAfterFatal(provider: Provider): Provider & { fatal(): TrialError | undefined } {
  let fatal: ProviderError | undefined;
  return {
    name: provider.name,
    fatal: () => (fatal === undefined ? undefined : toTrialError(fatal)),
    async complete(req) {
      if (fatal !== undefined) throw fatal;
      try {
        return await provider.complete(req);
      } catch (err) {
        if (err instanceof ProviderError && err.fatal) fatal ??= err;
        throw err;
      }
    },
  };
}
