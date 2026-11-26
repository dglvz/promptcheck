import { describe, expect, it } from "vitest";
import {
  FakeProvider,
  estimateTokens,
  failure,
  refusal,
  truncated,
} from "../../../src/providers/fake.js";
import { ProviderError } from "../../../src/providers/provider.js";
import type { CompletionRequest } from "../../../src/providers/provider.js";

const req = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "claude-haiku-5-5",
  user: "Hola",
  maxTokens: 100,
  ...overrides,
});

describe("FakeProvider", () => {
  it("responde con el default y completa los campos del resultado", async () => {
    const fake = new FakeProvider({ default: "respuesta" });
    const result = await fake.complete(req({ system: "12345678", user: "abcd" }));
    expect(result).toEqual({
      text: "respuesta",
      stopReason: "end_turn",
      model: "claude-haiku-5-5",
      latencyMs: 0,
      usage: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("registra las llamadas en orden", async () => {
    const fake = new FakeProvider({ default: "x" });
    await fake.complete(req({ user: "a" }));
    await fake.complete(req({ user: "b" }));
    expect(fake.calls.map((c) => c.user)).toEqual(["a", "b"]);
  });

  it("falla con un mensaje claro si no hay respuesta programada", async () => {
    const fake = new FakeProvider();
    await expect(fake.complete(req({ user: "sin regla" }))).rejects.toThrow(
      'FakeProvider: no hay respuesta programada para model="claude-haiku-5-5", user="sin regla"',
    );
  });

  it("exige al menos una respuesta por regla", () => {
    expect(() => new FakeProvider().when({ user: "x" })).toThrow(/al menos una respuesta/);
  });

  describe("reglas", () => {
    it("coinciden por modelo, por texto contenido y por RegExp", async () => {
      const fake = new FakeProvider({ default: "default" })
        .when({ model: "claude-opus-5-5" }, "opus")
        .when({ user: "contraseña" }, "cuenta")
        .when({ system: /^Eres un juez/ }, "juez");

      expect((await fake.complete(req({ model: "claude-opus-5-5" }))).text).toBe("opus");
      expect((await fake.complete(req({ user: "olvidé la contraseña" }))).text).toBe("cuenta");
      expect((await fake.complete(req({ system: "Eres un juez estricto" }))).text).toBe("juez");
      expect((await fake.complete(req({ system: "No. Eres un juez" }))).text).toBe("default");
      expect((await fake.complete(req())).text).toBe("default");
    });

    it("un patrón de system no coincide si la petición no tiene system", async () => {
      const fake = new FakeProvider({ default: "default" }).when({ system: "" }, "con system");
      expect((await fake.complete(req())).text).toBe("default");
      expect((await fake.complete(req({ system: "s" }))).text).toBe("con system");
    });

    it("todos los campos de la regla deben coincidir", async () => {
      const fake = new FakeProvider({ default: "no" }).when(
        { model: "claude-opus-5-5", user: "hola" },
        "sí",
      );
      expect((await fake.complete(req({ user: "hola" }))).text).toBe("no");
      expect((await fake.complete(req({ model: "claude-opus-5-5", user: "hola" }))).text).toBe(
        "sí",
      );
    });

    it("gana la primera regla registrada que coincide", async () => {
      const fake = new FakeProvider()
        .when({ user: "a" }, "primera")
        .when({ user: "ab" }, "segunda");
      expect((await fake.complete(req({ user: "ab" }))).text).toBe("primera");
    });

    it("acepta un predicado", async () => {
      const fake = new FakeProvider().when((r) => r.maxTokens > 500, "largo");
      expect((await fake.complete(req({ maxTokens: 1000 }))).text).toBe("largo");
    });
  });

  describe("secuencias por trial", () => {
    it("entrega una respuesta por llamada y repite la última", async () => {
      const fake = new FakeProvider().when({}, "uno", "dos", "tres");
      const texts = [];
      for (let i = 0; i < 5; i++) texts.push((await fake.complete(req())).text);
      expect(texts).toEqual(["uno", "dos", "tres", "tres", "tres"]);
    });

    it("cada regla lleva su propio contador", async () => {
      const fake = new FakeProvider()
        .when({ model: "a" }, "a1", "a2")
        .when({ model: "b" }, "b1", "b2");
      const order = ["a", "b", "b", "a"].map((model) => fake.complete(req({ model })));
      expect((await Promise.all(order)).map((r) => r.text)).toEqual(["a1", "b1", "b2", "a2"]);
    });

    it("las funciones reciben la petición y pueden ser asíncronas", async () => {
      const fake = new FakeProvider().when({}, (r) => Promise.resolve(`eco: ${r.user}`));
      expect((await fake.complete(req({ user: "ping" }))).text).toBe("eco: ping");
    });
  });

  describe("resultados especiales", () => {
    it("simula un rechazo", async () => {
      const fake = new FakeProvider().when({}, refusal("cyber"));
      expect(await fake.complete(req())).toMatchObject({
        text: "",
        stopReason: "refusal",
        refusalCategory: "cyber",
      });
    });

    it("simula una respuesta cortada por max_tokens", async () => {
      const fake = new FakeProvider().when({}, truncated('{"categoria": "cu'));
      expect(await fake.complete(req())).toMatchObject({ stopReason: "max_tokens" });
    });

    it("simula un fallback: el modelo que responde es otro", async () => {
      const fake = new FakeProvider().when({}, { text: "x", model: "claude-sonnet-5-5" });
      expect((await fake.complete(req())).model).toBe("claude-sonnet-5-5");
    });

    it("permite fijar usage y latencia", async () => {
      const fake = new FakeProvider().when(
        {},
        { text: "x", latencyMs: 1234, usage: { input: 1000, output: 50 } },
      );
      expect(await fake.complete(req())).toMatchObject({
        latencyMs: 1234,
        usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 },
      });
    });
  });

  describe("errores simulados", () => {
    it("lanza un ProviderError con su tipo y estado", async () => {
      const fake = new FakeProvider().when({}, failure("rate_limit", "demasiadas", 429));
      const err: unknown = await fake.complete(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: "rate_limit", status: 429, message: "demasiadas" });
      expect((err as ProviderError).fatal).toBe(false);
    });

    it("permite un error en un trial y éxito en el siguiente", async () => {
      const fake = new FakeProvider().when({}, failure("overloaded"), "ok");
      await expect(fake.complete(req())).rejects.toThrow("error simulado: overloaded");
      expect((await fake.complete(req())).text).toBe("ok");
    });
  });

  describe("prompt caching simulado", () => {
    const system = "Instrucciones largas del sistema".repeat(4);

    it("escribe en caché la primera vez y lee las siguientes", async () => {
      const fake = new FakeProvider({ default: "x" });
      const first = await fake.complete(req({ system, cacheSystem: true }));
      const second = await fake.complete(req({ system, cacheSystem: true }));
      const tokens = estimateTokens(system);
      expect(first.usage).toMatchObject({ cacheWrite: tokens, cacheRead: 0, input: 1 });
      expect(second.usage).toMatchObject({ cacheWrite: 0, cacheRead: tokens, input: 1 });
    });

    it("sin cacheSystem el system cuenta como entrada normal", async () => {
      const fake = new FakeProvider({ default: "x" });
      const result = await fake.complete(req({ system }));
      expect(result.usage).toMatchObject({
        input: estimateTokens(system) + 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
    });
  });

  it("mide la concurrencia máxima observada", async () => {
    const fake = new FakeProvider({ default: "x", delayMs: 20 });
    await Promise.all([1, 2, 3].map(() => fake.complete(req())));
    expect(fake.maxInFlight).toBe(3);
    await fake.complete(req());
    expect(fake.maxInFlight).toBe(3);
  });

  it("reporta la espera simulada como latencia", async () => {
    const fake = new FakeProvider({ default: "x", delayMs: 15 });
    expect((await fake.complete(req())).latencyMs).toBe(15);
  });
});

describe("ProviderError", () => {
  it.each([
    ["authentication", true],
    ["permission", true],
    ["bad_request", true],
    ["not_found", true],
    ["rate_limit", false],
    ["overloaded", false],
    ["server", false],
    ["timeout", false],
    ["connection", false],
    ["unknown", false],
  ] as const)("%s → fatal: %s", (kind, fatal) => {
    expect(new ProviderError(kind, "m").fatal).toBe(fatal);
  });

  it("conserva la causa original", () => {
    const cause = new Error("original");
    const err = new ProviderError("server", "envuelto", { status: 500, cause });
    expect(err.cause).toBe(cause);
    expect(err.status).toBe(500);
    expect(err.name).toBe("ProviderError");
  });
});
