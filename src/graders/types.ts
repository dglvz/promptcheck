import type { Assertion, AssertionType, Effort } from "../config/schema.js";
import type {
  CompletionResult,
  Provider,
  ProviderErrorKind,
  Usage,
} from "../providers/provider.js";

/** Resultado de evaluar una aserción sobre una respuesta (sección 8). */
export interface GradeResult {
  pass: boolean;
  /** Entre 0 y 1. Sirve para el puntaje ponderado; para aprobar cuenta `pass`. */
  score: number;
  /** Explicación legible en español: "esperaba 'cuenta', obtuvo 'facturación'". */
  reason: string;
  /**
   * `true` si no se pudo evaluar (esquema inválido, costo desconocido, juez caído…).
   * Nunca aprueba, pero el reporte lo distingue de un fallo real de la respuesta.
   */
  error?: boolean;
  /** Costo de la evaluación (solo el juez LLM), separado del costo del prompt. */
  costUsd?: number;
  /** Solo el juez LLM: quién evaluó y cuánto consumió (para el "costo de evaluación"). */
  judge?: { model: string; usage: Usage; latencyMs: number };
  /** Solo el juez LLM: error del proveedor del juez, para detectar los fatales. */
  judgeError?: { kind: ProviderErrorKind; message: string; fatal: boolean };
}

export interface JudgeContext {
  provider: Provider;
  model: string;
  effort?: Effort;
}

export interface GradeContext {
  /** Costo del trial en USD. `undefined` si el modelo no tiene precio conocido. */
  costUsd?: number;
  /** Juez configurado en la suite; sin él, `llm_judge` es un error de evaluación. */
  judge?: JudgeContext;
  /** Entrada que originó la respuesta, para que el juez la vea. */
  input?: { system?: string; user: string };
}

export type AssertionOf<T extends AssertionType> = Extract<Assertion, { type: T }>;

/** Todos los calificadores tienen esta firma; el juez LLM es asíncrono, los demás no. */
export type Grader<T extends AssertionType> = (
  output: CompletionResult,
  assertion: AssertionOf<T>,
  ctx: GradeContext,
) => GradeResult | Promise<GradeResult>;

export const passed = (reason: string, score = 1): GradeResult => ({ pass: true, score, reason });
export const failed = (reason: string, score = 0): GradeResult => ({ pass: false, score, reason });
export const gradeError = (reason: string): GradeResult => ({
  pass: false,
  score: 0,
  reason,
  error: true,
});

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Caracteres tal como los ve una persona: "ñ", "🙂" y "👍🏽" valen 1 cada uno. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Recorta un texto para mostrarlo en una razón, sin cortar en medio de un carácter. */
export function preview(text: string, max = 60): string {
  const chars = graphemes(text);
  const shown = chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
  return JSON.stringify(shown);
}
