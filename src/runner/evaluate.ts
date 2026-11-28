import type { Suite, Thresholds } from "../config/schema.js";
import { gradeTrial } from "../graders/index.js";
import type { GradeResult } from "../graders/index.js";
import { planSuite } from "../planner/plan.js";
import type { PlanOptions } from "../planner/plan.js";
import type { CompletionResult, Provider } from "../providers/provider.js";
import { runTrials } from "./run.js";
import type { TrialError, TrialRun } from "./run.js";

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
  results: TrialResult[];
  /** Presente si la corrida se cortó por un error fatal del proveedor. */
  aborted?: TrialError;
}

export interface EvaluateOptions {
  provider: Provider;
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

async function toResult(run: TrialRun): Promise<TrialResult> {
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
  const graded = await gradeTrial(run.completion, run.trial.assertions);
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
  const results = await Promise.all(runs.map(toResult));
  return {
    name: suite.name,
    file,
    thresholds: suite.thresholds,
    results,
    ...(aborted === undefined ? {} : { aborted }),
  };
}
