import type { Effort } from "../config/schema.js";

/**
 * Contrato entre el runner/juez y un proveedor de LLM (sección 5).
 *
 * Es el único punto de contacto con la red: `AnthropicProvider` lo implementa contra la API
 * y `FakeProvider` lo implementa en memoria para las pruebas.
 */

export interface CompletionRequest {
  model: string;
  system?: string;
  user: string;
  maxTokens: number;
  effort?: Effort;
  /** Marca el system prompt como cacheable (prompt caching). */
  cacheSystem?: boolean;
}

/**
 * Motivos de parada conocidos. Se acepta cualquier otro texto para no romper si la API agrega
 * uno nuevo; quien lo consuma debe tratar los desconocidos como "no terminó normalmente".
 */
export type StopReason =
  "end_turn" | "max_tokens" | "stop_sequence" | "refusal" | "pause_turn" | (string & {});

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CompletionResult {
  text: string;
  stopReason: StopReason;
  /** Modelo que respondió de verdad (puede diferir del pedido si hubo fallback). */
  model: string;
  latencyMs: number;
  usage: Usage;
  /** Solo si `stopReason === "refusal"`: categoría informada por la API. */
  refusalCategory?: string;
}

export interface Provider {
  /** Nombre para reportes y mensajes (por ejemplo, "anthropic" o "fake"). */
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Clasificación de fallos del proveedor. El runner decide con esto si el trial cuenta como
 * error recuperable (se reporta y se sigue) o si hay que abortar (código de salida 4).
 */
export type ProviderErrorKind =
  | "rate_limit"
  | "overloaded"
  | "server"
  | "timeout"
  | "connection"
  | "authentication"
  | "permission"
  | "bad_request"
  | "not_found"
  | "unknown";

/** Fallos que no se arreglan reintentando ni corriendo otro trial: hay que corregir algo. */
const FATAL_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  "authentication",
  "permission",
  "bad_request",
  "not_found",
]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options?.status;
  }

  /** `true` si el error invalida toda la corrida (credenciales, petición mal formada…). */
  get fatal(): boolean {
    return FATAL_KINDS.has(this.kind);
  }
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
