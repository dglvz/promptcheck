import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { ProviderError } from "./provider.js";
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  StructuredOutput,
} from "./provider.js";

/**
 * Proveedor real contra la API de Claude (sección 9). Es el único módulo que llama a la API.
 *
 * Reglas que respeta (verificadas contra la documentación oficial y el SDK 1.14, nov. 2026):
 * - No envía `temperature`, `top_p` ni `top_k`: los modelos actuales los rechazan.
 * - No envía `thinking`: en Opus 5.5 siempre es adaptativo y `disabled` devuelve 400. La
 *   profundidad se controla con `output_config.effort`, que se manda solo si la suite lo fija.
 * - Sin prefill del asistente: el único mensaje es el del usuario.
 * - Con `cacheSystem`, el system va como bloque con `cache_control: { type: "ephemeral" }`.
 * - Sin `fallbacks` del lado del servidor: mezclar modelos distorsiona la comparación
 *   (decisión de la propuesta; se ofrecerá como opción explícita de la suite).
 * - `stop_reason` se devuelve tal cual; `refusal` trae la categoría de `stop_details`.
 * - Los errores se clasifican por clase tipada del SDK, nunca por el texto del mensaje.
 *   El SDK ya reintenta 408/409/429/5xx y errores de conexión (2 veces por defecto).
 * - Salidas estructuradas: el formato sale de `zodOutputFormat` (el helper del SDK convierte el
 *   esquema zod) y va en `output_config.format`. Se llama a `messages.create` y se interpreta
 *   con el `parse` del mismo helper, en vez de `messages.parse()`: este último lanza si el JSON
 *   no cumple el esquema y se pierden el texto y el `usage` de una llamada ya pagada.
 */

/** Lo mínimo que se usa del cliente; permite inyectar uno simulado en las pruebas. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AnthropicProviderOptions {
  /** Cliente ya construido (en pruebas, uno simulado). Si falta, se crea al primer uso. */
  client?: MessagesClient;
  /** Reintentos del SDK ante 429/5xx/conexión. Por defecto, los del SDK (2). */
  maxRetries?: number;
  /** Tiempo máximo por petición, en milisegundos. Por defecto, el del SDK. */
  timeoutMs?: number;
  /** Reloj inyectable para medir la latencia en pruebas. */
  now?: () => number;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: MessagesClient | undefined;
  private readonly options: AnthropicProviderOptions;
  private readonly now: () => number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options;
    this.client = options.client;
    this.now = options.now ?? (() => performance.now());
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const client = this.getClient();
    const params = buildParams(req);
    const start = this.now();
    let response: Anthropic.Message;
    try {
      response = await client.messages.create(params);
    } catch (err) {
      throw toProviderError(err);
    }
    const latencyMs = Math.round(this.now() - start);
    const result = toResult(response, latencyMs);
    if (req.outputSchema !== undefined) {
      result.structured = parseStructured(req.outputSchema, result.text);
    }
    return result;
  }

  /**
   * Crea el cliente al primer uso, para que construir el proveedor (por ejemplo, en
   * `--dry-run` o en `--help`) no exija credenciales. El SDK resuelve la API key desde
   * `ANTHROPIC_API_KEY` (u otras credenciales del entorno); promptcheck nunca la lee ni la
   * registra por su cuenta.
   */
  private getClient(): MessagesClient {
    if (this.client) return this.client;
    try {
      this.client = new Anthropic({
        ...(this.options.maxRetries === undefined ? {} : { maxRetries: this.options.maxRetries }),
        ...(this.options.timeoutMs === undefined ? {} : { timeout: this.options.timeoutMs }),
      });
    } catch (err) {
      throw new ProviderError(
        "authentication",
        "no se encontraron credenciales de Anthropic: define la variable de entorno ANTHROPIC_API_KEY",
        { cause: err },
      );
    }
    return this.client;
  }
}

/** Traduce la petición de promptcheck a los parámetros del SDK. Función pura. */
export function buildParams(req: CompletionRequest): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: [{ role: "user", content: req.user }],
  };
  if (req.system !== undefined && req.system !== "") {
    params.system =
      req.cacheSystem === true
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : req.system;
  }
  if (req.effort !== undefined || req.outputSchema !== undefined) {
    params.output_config = {
      ...(req.effort === undefined ? {} : { effort: req.effort }),
      ...(req.outputSchema === undefined
        ? {}
        : { format: { type: "json_schema", schema: formatFor(req.outputSchema).schema } }),
    };
  }
  return params;
}

type OutputFormat = ReturnType<typeof zodOutputFormat>;
const formats = new WeakMap<z.ZodType, OutputFormat>();

/** El formato del helper del SDK, convertido una sola vez por esquema. */
function formatFor(schema: z.ZodType): OutputFormat {
  let format = formats.get(schema);
  if (format === undefined) {
    format = zodOutputFormat(schema);
    formats.set(schema, format);
  }
  return format;
}

/** Interpreta la salida estructurada con el validador del helper del SDK. Nunca lanza. */
export function parseStructured(schema: z.ZodType, text: string): StructuredOutput {
  try {
    return { ok: true, value: formatFor(schema).parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Traduce la respuesta del SDK al resultado de promptcheck. Función pura. */
export function toResult(response: Anthropic.Message, latencyMs: number): CompletionResult {
  // Solo los bloques de texto forman la respuesta; los de thinking se ignoran.
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const stopReason = response.stop_reason ?? "unknown";
  const result: CompletionResult = {
    text,
    stopReason,
    model: response.model,
    latencyMs,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
  if (stopReason === "refusal") {
    result.refusalCategory = response.stop_details?.category ?? "unspecified";
  }
  return result;
}

const SPEND_LIMIT = "enforced_spend_limit_reached";

/**
 * Clasifica un error del SDK de lo más específico a lo más general. El orden importa:
 * `APIConnectionTimeoutError` hereda de `APIConnectionError`, `OverloadedError` de
 * `InternalServerError`, y todos heredan de `APIError`.
 */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const wrap = (kind: ProviderError["kind"], message: string, status?: number) =>
    new ProviderError(
      kind,
      message,
      status === undefined ? { cause: err } : { status, cause: err },
    );

  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return wrap("timeout", "la petición a la API superó el tiempo máximo");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return wrap("connection", `no se pudo conectar con la API: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    const detail = err.message;
    if (err instanceof Anthropic.AuthenticationError) {
      return wrap("authentication", `credenciales inválidas: ${detail}`, status);
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      return wrap("permission", `sin permiso para esta petición: ${detail}`, status);
    }
    if (err instanceof Anthropic.PaymentRequiredError) {
      return wrap("billing", `problema de facturación: ${detail}`, status);
    }
    if (err instanceof Anthropic.NotFoundError) {
      return wrap("not_found", `modelo o recurso no encontrado: ${detail}`, status);
    }
    if (
      err instanceof Anthropic.BadRequestError ||
      err instanceof Anthropic.UnprocessableEntityError ||
      err instanceof Anthropic.ContentTooLargeError
    ) {
      return wrap("bad_request", `petición rechazada por la API: ${detail}`, status);
    }
    if (err instanceof Anthropic.RateLimitError) {
      // El tope de gasto mensual también es un 429, pero reintentar no sirve.
      return err.errorCode === SPEND_LIMIT
        ? wrap("billing", `se alcanzó el tope de gasto de la cuenta: ${detail}`, status)
        : wrap("rate_limit", `límite de peticiones alcanzado: ${detail}`, status);
    }
    if (err instanceof Anthropic.OverloadedError) {
      return wrap("overloaded", `la API está sobrecargada: ${detail}`, status);
    }
    if (err instanceof Anthropic.InternalServerError) {
      return wrap("server", `error del servidor de la API: ${detail}`, status);
    }
    return wrap("unknown", `error de la API: ${detail}`, status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return wrap("unknown", `error inesperado al llamar a la API: ${message}`);
}
