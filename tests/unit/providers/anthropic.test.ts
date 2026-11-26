import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  buildParams,
  toProviderError,
  toResult,
} from "../../../src/providers/anthropic.js";
import type { MessagesClient } from "../../../src/providers/anthropic.js";
import { ProviderError } from "../../../src/providers/provider.js";
import type { CompletionRequest } from "../../../src/providers/provider.js";

const req = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "claude-haiku-5-5",
  user: "Hola",
  maxTokens: 256,
  ...overrides,
});

/** Respuesta con la forma de `Anthropic.Message`; solo se completan los campos que se usan. */
function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: "respuesta", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
    ...overrides,
  } as Anthropic.Message;
}

/** Cliente simulado que registra los parámetros y responde o falla según se le indique. */
function fakeClient(respond: () => Anthropic.Message | Error) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      create: (params) => {
        calls.push(params);
        const r = respond();
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
    },
  };
  return { client, calls };
}

const apiError = (status: number, type: string, body: Record<string, unknown> = {}) =>
  Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message: `mensaje ${type}`, ...body } },
    undefined,
    new Headers(),
  );

describe("buildParams", () => {
  it("arma una petición mínima con un único mensaje de usuario", () => {
    expect(buildParams(req())).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "Hola" }],
    });
  });

  it("nunca envía parámetros de muestreo ni thinking", () => {
    const params = buildParams(req({ system: "s", effort: "high", cacheSystem: true }));
    for (const key of ["temperature", "top_p", "top_k", "thinking", "fallbacks"]) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it("envía el system como texto plano sin caché", () => {
    expect(buildParams(req({ system: "Eres breve." })).system).toBe("Eres breve.");
  });

  it("marca el system como cacheable con cacheSystem", () => {
    expect(buildParams(req({ system: "Eres breve.", cacheSystem: true })).system).toEqual([
      { type: "text", text: "Eres breve.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("omite un system vacío", () => {
    expect(buildParams(req({ system: "", cacheSystem: true }))).not.toHaveProperty("system");
  });

  it("envía el esfuerzo dentro de output_config, solo si se indica", () => {
    expect(buildParams(req({ effort: "low" })).output_config).toEqual({ effort: "low" });
    expect(buildParams(req())).not.toHaveProperty("output_config");
  });
});

describe("toResult", () => {
  it("toma el texto, el modelo que respondió, el motivo y el uso", () => {
    const result = toResult(
      message({
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 0,
        } as Anthropic.Usage,
      }),
      321,
    );
    expect(result).toEqual({
      text: "respuesta",
      stopReason: "end_turn",
      model: "claude-sonnet-5-5",
      latencyMs: 321,
      usage: { input: 100, output: 20, cacheRead: 600, cacheWrite: 0 },
    });
  });

  it("une los bloques de texto e ignora los de thinking", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "uno ", citations: null },
      { type: "text", text: "dos", citations: null },
    ] as Anthropic.ContentBlock[];
    expect(toResult(message({ content }), 0).text).toBe("uno dos");
  });

  it("trata los usos de caché nulos como cero", () => {
    expect(toResult(message(), 0).usage).toEqual({
      input: 12,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("registra la categoría de un rechazo", () => {
    const result = toResult(
      message({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      }),
      0,
    );
    expect(result).toMatchObject({ text: "", stopReason: "refusal", refusalCategory: "cyber" });
  });

  it("usa 'unspecified' si el rechazo no trae categoría", () => {
    const result = toResult(message({ stop_reason: "refusal", stop_details: null }), 0);
    expect(result.refusalCategory).toBe("unspecified");
  });

  it("no agrega refusalCategory a respuestas normales ni cortadas", () => {
    expect(toResult(message({ stop_reason: "max_tokens" }), 0)).not.toHaveProperty(
      "refusalCategory",
    );
  });

  it("marca como 'unknown' un stop_reason ausente", () => {
    expect(toResult(message({ stop_reason: null }), 0).stopReason).toBe("unknown");
  });
});

describe("toProviderError", () => {
  it.each([
    [400, "invalid_request_error", "bad_request", true],
    [401, "authentication_error", "authentication", true],
    [402, "billing_error", "billing", true],
    [403, "permission_error", "permission", true],
    [404, "not_found_error", "not_found", true],
    [413, "request_too_large", "bad_request", true],
    [422, "invalid_request_error", "bad_request", true],
    [429, "rate_limit_error", "rate_limit", false],
    [500, "api_error", "server", false],
    [503, "api_error", "server", false],
    [529, "overloaded_error", "overloaded", false],
    [418, "api_error", "unknown", false],
  ] as const)("HTTP %i (%s) → %s, fatal: %s", (status, type, kind, fatal) => {
    const err = toProviderError(apiError(status, type));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.fatal).toBe(fatal);
  });

  it("distingue el tope de gasto (429 fatal) de un rate limit normal", () => {
    const capped = Anthropic.APIError.generate(
      429,
      {
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "límite",
          details: { error_code: "enforced_spend_limit_reached" },
        },
      },
      undefined,
      new Headers(),
    );
    expect(capped.errorCode).toBe("enforced_spend_limit_reached");
    const err = toProviderError(capped);
    expect(err.kind).toBe("billing");
    expect(err.fatal).toBe(true);
  });

  it("clasifica timeout antes que conexión", () => {
    expect(toProviderError(new Anthropic.APIConnectionTimeoutError()).kind).toBe("timeout");
    expect(toProviderError(new Anthropic.APIConnectionError({ message: "ECONNRESET" })).kind).toBe(
      "connection",
    );
  });

  it("conserva la causa original y deja pasar un ProviderError", () => {
    const original = apiError(500, "api_error");
    expect(toProviderError(original).cause).toBe(original);
    const already = new ProviderError("timeout", "x");
    expect(toProviderError(already)).toBe(already);
  });

  it("envuelve errores que no son del SDK", () => {
    const err = toProviderError(new TypeError("boom"));
    expect(err.kind).toBe("unknown");
    expect(err.message).toBe("error inesperado al llamar a la API: boom");
    expect(toProviderError("texto").message).toContain("texto");
  });
});

describe("AnthropicProvider", () => {
  it("llama al cliente con los parámetros y mide la latencia", async () => {
    const { client, calls } = fakeClient(() => message());
    let t = 1000;
    const provider = new AnthropicProvider({ client, now: () => (t += 250) });
    const result = await provider.complete(req({ effort: "medium" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "medium" },
    });
    expect(result.latencyMs).toBe(250);
    expect(result.text).toBe("respuesta");
    expect(provider.name).toBe("anthropic");
  });

  it("traduce los errores del SDK a ProviderError", async () => {
    const { client } = fakeClient(() => apiError(401, "authentication_error"));
    const provider = new AnthropicProvider({ client });
    await expect(provider.complete(req())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "authentication",
      fatal: true,
    });
  });

  it("no crea el cliente real hasta la primera llamada", () => {
    expect(() => new AnthropicProvider()).not.toThrow();
  });
});
