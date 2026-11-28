import type { z } from "zod";
import { ProviderError } from "./provider.js";
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderErrorKind,
  StopReason,
  StructuredOutput,
  Usage,
} from "./provider.js";

/**
 * Proveedor en memoria para las pruebas (sección 15): nunca toca la red.
 *
 * ```ts
 * const fake = new FakeProvider({ default: '{"categoria":"otro"}' })
 *   .when({ user: "contraseña" }, '{"categoria":"cuenta"}')
 *   .when({ model: "claude-haiku-5-5" }, "ok", refusal(), failure("rate_limit"));
 * ```
 *
 * - Las reglas se evalúan en el orden en que se registran; gana la primera que coincide.
 * - Cada regla lleva su propio contador: la llamada N recibe la respuesta N y, al agotarse,
 *   se repite la última. Así se programan respuestas distintas por trial.
 * - Sin regla que coincida ni `default`, la llamada falla con un mensaje que dice por qué,
 *   para que una prueba mal armada no pase en silencio.
 */

export interface FakeCompletion {
  text: string;
  stopReason?: StopReason;
  model?: string;
  latencyMs?: number;
  usage?: Partial<Usage>;
  refusalCategory?: string;
}

export interface FakeFailure {
  error: ProviderError;
}

export type FakeReply =
  | string
  | FakeCompletion
  | FakeFailure
  | ((req: CompletionRequest, call: number) => FakeReply | Promise<FakeReply>);

/** Texto: coincide si lo contiene. RegExp: si coincide. Todos los campos dados deben coincidir. */
export interface FakeMatch {
  model?: string;
  system?: string | RegExp;
  user?: string | RegExp;
}

export interface FakeProviderOptions {
  /** Respuesta cuando ninguna regla coincide. */
  default?: FakeReply;
  /** Espera real antes de responder; útil para observar la concurrencia. */
  delayMs?: number;
}

interface Rule {
  matches: (req: CompletionRequest) => boolean;
  replies: readonly FakeReply[];
  calls: number;
}

/** Estimación determinista de tokens (≈ 4 caracteres por token). Solo para pruebas. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const matchText = (pattern: string | RegExp | undefined, value: string | undefined): boolean => {
  if (pattern === undefined) return true;
  if (value === undefined) return false;
  return typeof pattern === "string" ? value.includes(pattern) : pattern.test(value);
};

const toPredicate = (match: FakeMatch | ((req: CompletionRequest) => boolean)) =>
  typeof match === "function"
    ? match
    : (req: CompletionRequest) =>
        (match.model === undefined || match.model === req.model) &&
        matchText(match.system, req.system) &&
        matchText(match.user, req.user);

const isFailure = (r: FakeReply): r is FakeFailure => typeof r === "object" && "error" in r;

export class FakeProvider implements Provider {
  readonly name = "fake";
  /** Todas las peticiones recibidas, en orden de llegada. */
  readonly calls: CompletionRequest[] = [];
  /** Máximo de llamadas simultáneas observado (para probar `--concurrency`). */
  maxInFlight = 0;

  private inFlight = 0;
  private readonly rules: Rule[] = [];
  private readonly seenSystems = new Set<string>();
  private readonly options: FakeProviderOptions;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
  }

  /** Programa una o más respuestas para las peticiones que coincidan. */
  when(match: FakeMatch | ((req: CompletionRequest) => boolean), ...replies: FakeReply[]): this {
    if (replies.length === 0) throw new Error("FakeProvider.when necesita al menos una respuesta");
    this.rules.push({ matches: toPredicate(match), replies, calls: 0 });
    return this;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const delay = this.options.delayMs ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      let reply = this.pick(req);
      let call = 0;
      while (typeof reply === "function") {
        reply = await reply(req, call++);
      }
      if (isFailure(reply)) throw reply.error;
      return this.toResult(req, typeof reply === "string" ? { text: reply } : reply, delay);
    } finally {
      this.inFlight--;
    }
  }

  private pick(req: CompletionRequest): FakeReply {
    const rule = this.rules.find((r) => r.matches(req));
    if (rule) {
      const reply = rule.replies[Math.min(rule.calls, rule.replies.length - 1)];
      rule.calls++;
      if (reply !== undefined) return reply;
    }
    if (this.options.default !== undefined) return this.options.default;
    throw new Error(
      `FakeProvider: no hay respuesta programada para model="${req.model}", ` +
        `user=${JSON.stringify(req.user.slice(0, 80))}`,
    );
  }

  private toResult(req: CompletionRequest, reply: FakeCompletion, delay: number): CompletionResult {
    const system = req.system ?? "";
    const systemTokens = estimateTokens(system);
    let cacheRead = 0;
    let cacheWrite = 0;
    if (req.cacheSystem === true && system !== "") {
      // Imita el prompt caching: la primera vez se escribe, las siguientes se lee.
      if (this.seenSystems.has(system)) cacheRead = systemTokens;
      else cacheWrite = systemTokens;
      this.seenSystems.add(system);
    }
    const usage: Usage = {
      input: (cacheRead > 0 || cacheWrite > 0 ? 0 : systemTokens) + estimateTokens(req.user),
      output: estimateTokens(reply.text),
      cacheRead,
      cacheWrite,
      ...reply.usage,
    };
    return {
      text: reply.text,
      stopReason: reply.stopReason ?? "end_turn",
      model: reply.model ?? req.model,
      latencyMs: reply.latencyMs ?? delay,
      usage,
      ...(reply.refusalCategory === undefined ? {} : { refusalCategory: reply.refusalCategory }),
      ...(req.outputSchema === undefined
        ? {}
        : { structured: parseFakeStructured(req.outputSchema, reply.text) }),
    };
  }
}

/** Igual que el proveedor real: JSON del texto validado con el esquema; nunca lanza. */
function parseFakeStructured(schema: z.ZodType, text: string): StructuredOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: `JSON inválido: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
}

/** Respuesta de rechazo (`stop_reason: "refusal"`). */
export const refusal = (category = "unspecified", text = ""): FakeCompletion => ({
  text,
  stopReason: "refusal",
  refusalCategory: category,
});

/** Respuesta cortada por `max_tokens`. */
export const truncated = (text: string): FakeCompletion => ({ text, stopReason: "max_tokens" });

/** Error simulado del proveedor. */
export const failure = (
  kind: ProviderErrorKind,
  message = `error simulado: ${kind}`,
  status?: number,
): FakeFailure => ({
  error: new ProviderError(kind, message, status === undefined ? undefined : { status }),
});
