import Table from "cli-table3";
import pc from "picocolors";
import type { SuiteResult, TrialResult } from "../runner/evaluate.js";
import type { CaseStats, ModelStats, SuiteStats, TokenTotals } from "../stats/aggregate.js";

/**
 * Reporte para la terminal (sección 13): una tabla por modelo; si hay más de un modelo, la
 * matriz caso × modelo; y, debajo, los casos que fallaron con la razón de cada trial. Devuelve texto; quien llama decide dónde escribirlo.
 */

export interface TerminalOptions {
  color: boolean;
  /** Trials que se muestran por caso fallido antes de resumir el resto. */
  maxTrialsPerCase?: number;
}

const nf = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const int = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0, useGrouping: "always" });

/** Mínimo de tokens para que un prefijo se cachee (verificado en la documentación, nov. 2026). */
const MIN_CACHE_HINT = "512 tokens en los modelos 5.5";

export const formatCache = (t: TokenTotals): string =>
  t.cacheRead === 0 && t.cacheWrite === 0
    ? "—"
    : `${formatInt(t.cacheRead)} / ${formatInt(t.cacheWrite)}`;

/** `{ cyber: 2, bio: 1 }` → `cyber ×2, bio ×1`. */
export const formatCounts = (counts: Readonly<Record<string, number>>): string =>
  Object.entries(counts)
    .map(([k, n]) => (n === 1 ? k : `${k} ×${n}`))
    .join(", ");

export const formatPercent = (rate: number): string => `${nf.format(rate * 100)} %`;
export const formatInt = (n: number): string => int.format(n);

/** Primera explicación útil de por qué un trial no aprobó. */
export function trialFailureReason(t: TrialResult): string {
  if (t.status === "skipped") return "omitido (la corrida se detuvo)";
  if (t.error) return `[${t.error.kind}] ${t.error.message}`;
  const failedGrades = t.grades.filter((g) => !g.pass);
  const reasons = failedGrades.map((g) => (g.error ? `(no evaluable) ${g.reason}` : g.reason));
  if (t.stopIssue !== undefined) reasons.unshift(t.stopIssue);
  return reasons.join("; ") || "no aprobó";
}

type Colors = ReturnType<typeof pc.createColors>;

/** Celda de la matriz: `3/3 ✔` (aprueba siempre), `1/3 ~` (inestable), `0/3 ✘` (nunca). */
export function matrixCell(cs: CaseStats | undefined, c: Colors): string {
  if (cs === undefined || cs.executed === 0) return c.dim("—");
  const count = `${cs.passed}/${cs.executed}`;
  if (cs.flaky) return c.yellow(`${count} ~`);
  return cs.passed === cs.executed ? c.green(`${count} ✔`) : c.red(`${count} ✘`);
}

/** Casos en filas y modelos en columnas, en el orden del plan. */
function caseMatrix(stats: SuiteStats, c: Colors): string {
  const models = stats.models.map((m) => m.model);
  const table = new Table({ head: ["Caso", ...models], style: { head: [], border: [] } });
  const caseIds = [...new Set(stats.cases.map((cs) => cs.caseId))];
  for (const caseId of caseIds) {
    table.push([
      caseId,
      ...models.map((model) =>
        matrixCell(
          stats.cases.find((cs) => cs.caseId === caseId && cs.model === model),
          c,
        ),
      ),
    ]);
  }
  return table.toString();
}

function modelRow(m: ModelStats, c: Colors): string[] {
  const rate =
    m.passRate === null
      ? c.dim("—")
      : (m.meetsThreshold ? c.green : c.red)(
          `${formatPercent(m.passRate)} ${m.meetsThreshold ? "✔" : "✘"}`,
        );
  return [
    m.model,
    rate,
    `${m.passed}/${m.executed}`,
    m.flakyCases.length === 0 ? "0" : c.yellow(String(m.flakyCases.length)),
    m.errors === 0 ? "0" : c.red(String(m.errors)),
    `${formatInt(m.tokens.input)} / ${formatInt(m.tokens.output)}`,
    formatCache(m.tokens),
    m.latency === null ? "—" : `${formatInt(m.latency.p50)} / ${formatInt(m.latency.p95)} ms`,
  ];
}

export function renderTerminalReport(
  result: SuiteResult,
  stats: SuiteStats,
  options: TerminalOptions,
): string {
  const c = pc.createColors(options.color);
  const maxTrials = options.maxTrialsPerCase ?? 3;
  const lines: string[] = [];

  lines.push(`${c.bold(result.name)}  ${c.dim(result.file)}`);

  const table = new Table({
    head: [
      "Modelo",
      "Aprobación",
      "Trials",
      "Inestables",
      "Errores",
      "Tokens (ent/sal)",
      "Caché (lect/escr)",
      "Latencia p50/p95",
    ],
    style: { head: [], border: [] },
  });
  for (const m of stats.models) table.push(modelRow(m, c));
  lines.push(table.toString());
  lines.push(c.dim(`Umbral de aprobación: ${formatPercent(result.thresholds.pass_rate)}`));

  if (stats.judge) {
    const j = stats.judge;
    lines.push(
      c.dim(
        `Juez (${j.models.join(", ")}): ${j.calls} evaluación(es) · tokens ` +
          `${formatInt(j.tokens.input)} / ${formatInt(j.tokens.output)} · caché ${formatCache(j.tokens)}`,
      ),
    );
  }

  for (const m of stats.models) {
    const refusals = Object.values(m.refusals).reduce((a, b) => a + b, 0);
    if (refusals > 0) {
      lines.push(
        c.yellow(`⚠ ${m.model}: ${refusals} rechazo(s) del modelo (${formatCounts(m.refusals)})`),
      );
    }
    if (m.truncated > 0) {
      lines.push(
        c.yellow(
          `⚠ ${m.model}: ${m.truncated} respuesta(s) cortada(s) por max_tokens; ` +
            `prueba a subir defaults.max_tokens (ahora ${formatInt(result.maxTokens)})`,
        ),
      );
    }
    if (m.errors > 0) {
      lines.push(
        c.yellow(
          `⚠ ${m.model}: ${m.errors} error(es) del proveedor (${formatCounts(m.errorKinds)})`,
        ),
      );
    }
  }

  const flaky = stats.cases.filter((cs) => cs.flaky).length;
  if (flaky > 0) {
    lines.push(
      c.yellow(
        `⚠ ${flaky} caso(s) inestable(s): aprueban en unos trials y fallan en otros; ` +
          `suele indicar un prompt ambiguo.`,
      ),
    );
  }

  const unused = stats.models.filter((m) => m.cacheUnused).map((m) => m.model);
  if (unused.length > 0) {
    lines.push(
      c.yellow(
        `⚠ cache_system está activo pero no se cacheó nada en ${unused.join(", ")}: ` +
          `el system prompt probablemente es más corto que el mínimo cacheable del modelo ` +
          `(${MIN_CACHE_HINT}).`,
      ),
    );
  }
  if (stats.judge?.cacheUnused === true) {
    lines.push(
      c.yellow(
        `⚠ El prefijo del juez no se cacheó: instrucciones + system + rúbrica quedan por debajo ` +
          `del mínimo cacheable (${MIN_CACHE_HINT}).`,
      ),
    );
  }

  if (stats.models.length > 1) {
    lines.push("", c.bold("Resultados por caso:"), caseMatrix(stats, c));
    lines.push(c.dim("✔ aprueba en todos los trials · ~ inestable · ✘ falla en todos"));
  }

  // Casos con algún trial no aprobado, agrupados por caso × modelo.
  const failing = stats.cases.filter((cs) => cs.passed < cs.executed);
  if (failing.length > 0) {
    lines.push("", c.bold("Casos con fallos:"));
    for (const cs of failing) {
      const tag = cs.flaky ? c.yellow(" inestable") : "";
      lines.push(
        `  ${c.red("✘")} ${cs.caseId} · ${cs.model} ${c.dim(`(${cs.passed}/${cs.executed} aprobados)`)}${tag}`,
      );
      const trials = result.results.filter(
        (t) => t.caseId === cs.caseId && t.model === cs.model && t.status !== "skipped" && !t.pass,
      );
      for (const t of trials.slice(0, maxTrials)) {
        lines.push(`      trial ${t.trial}: ${trialFailureReason(t)}`);
      }
      if (trials.length > maxTrials) {
        lines.push(c.dim(`      … y ${trials.length - maxTrials} trial(s) más`));
      }
    }
  }

  lines.push("");
  if (result.aborted) {
    lines.push(c.red(`✘ Corrida detenida: [${result.aborted.kind}] ${result.aborted.message}`));
    const skipped = stats.models.reduce((s, m) => s + m.skipped, 0);
    if (skipped > 0) lines.push(c.dim(`  ${skipped} trial(s) no se ejecutaron.`));
  } else if (stats.pass) {
    lines.push(c.green("✔ Suite aprobada"));
  } else {
    const below = stats.models.filter((m) => !m.meetsThreshold).map((m) => m.model);
    lines.push(c.red(`✘ Suite no aprobada: bajo el umbral en ${below.join(", ")}`));
  }
  return lines.join("\n");
}
