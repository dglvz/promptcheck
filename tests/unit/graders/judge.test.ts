import { describe, expect, it } from "vitest";
import {
  JUDGE_INSTRUCTIONS,
  JUDGE_MAX_TOKENS,
  JudgeVerdict,
  buildJudgePrompt,
  gradeAssertion,
} from "../../../src/graders/index.js";
import type { GradeContext } from "../../../src/graders/index.js";
import { FakeProvider, failure, refusal, truncated } from "../../../src/providers/fake.js";
import type { CompletionResult, Provider } from "../../../src/providers/provider.js";
import { assertion, out } from "./helpers.js";

const verdict = (
  score: number,
  reasoning = "La respuesta menciona el escáner.",
  pass = score >= 0.7,
) => JSON.stringify({ reasoning, score, pass });

const RUBRIC = "La prioridad es 'alta' o 'media' y el resumen menciona el escáner.";

function setup(judge: FakeProvider, extra: Partial<GradeContext> = {}) {
  const ctx: GradeContext = {
    judge: { provider: judge, model: "claude-opus-5-5", effort: "low" },
    input: {
      system: "Eres un clasificador.",
      user: "Ticket: la app se cierra al abrir el escáner",
    },
    ...extra,
  };
  const grade = (threshold?: number, response = '{"prioridad":"alta"}') =>
    gradeAssertion(
      out(response, { model: "claude-haiku-5-5" }),
      assertion({
        type: "llm_judge",
        rubric: RUBRIC,
        ...(threshold === undefined ? {} : { threshold }),
      }),
      ctx,
    );
  return { grade };
}

describe("buildJudgePrompt", () => {
  const prompt = buildJudgePrompt({
    rubric: RUBRIC,
    system: "Eres un clasificador.",
    user: "Ticket: X",
    response: "Respuesta Y",
  });

  it("pone lo fijo en el system: instrucciones, system evaluado y rúbrica, en ese orden", () => {
    expect(prompt.system.startsWith(JUDGE_INSTRUCTIONS)).toBe(true);
    const iSystem = prompt.system.indexOf("<system_del_prompt_evaluado>");
    const iRubric = prompt.system.indexOf("<rubrica>");
    expect(iSystem).toBeGreaterThan(0);
    expect(iRubric).toBeGreaterThan(iSystem);
    expect(prompt.system).toContain(RUBRIC);
  });

  it("pone lo variable en el mensaje del usuario: entrada y respuesta", () => {
    expect(prompt.user).toBe(
      "<entrada>\nTicket: X\n</entrada>\n\n<respuesta>\nRespuesta Y\n</respuesta>",
    );
    expect(prompt.system).not.toContain("Respuesta Y");
  });

  it("el system no cambia entre respuestas distintas (prefijo cacheable)", () => {
    const other = buildJudgePrompt({
      rubric: RUBRIC,
      system: "Eres un clasificador.",
      user: "Z",
      response: "W",
    });
    expect(other.system).toBe(prompt.system);
  });

  it("omite el bloque de system si el prompt evaluado no tiene", () => {
    const p = buildJudgePrompt({ rubric: RUBRIC, user: "u", response: "r" });
    expect(p.system).not.toContain("<system_del_prompt_evaluado>");
  });
});

describe("llm_judge", () => {
  it("aprueba con puntaje ≥ umbral y muestra el razonamiento", async () => {
    const { grade } = setup(new FakeProvider().when({}, verdict(0.85)));
    const r = await grade();
    expect(r).toMatchObject({
      pass: true,
      score: 0.85,
      reason: "juez: 0.85 ≥ 0.7 — La respuesta menciona el escáner.",
    });
    expect(r.error).toBeUndefined();
  });

  it.each([
    [0.7, 0.7, true],
    [0.69, 0.7, false],
    [0.85, 0.9, false],
    [0, 0, true],
  ])("puntaje %f con umbral %f → %s", async (score, threshold, pass) => {
    const { grade } = setup(new FakeProvider().when({}, verdict(score)));
    expect((await grade(threshold)).pass).toBe(pass);
  });

  it("decide por el puntaje, no por el pass que declara el juez", async () => {
    const { grade } = setup(new FakeProvider().when({}, verdict(0.9, "ok", false)));
    expect((await grade()).pass).toBe(true);
  });

  it("arma la petición al juez: modelo, esfuerzo, caché, salida estructurada y sin el modelo evaluado", async () => {
    const judge = new FakeProvider().when({}, verdict(1));
    const { grade } = setup(judge);
    await grade();
    const req = judge.calls[0];
    expect(req).toMatchObject({
      model: "claude-opus-5-5",
      effort: "low",
      cacheSystem: true,
      maxTokens: JUDGE_MAX_TOKENS,
      outputSchema: JudgeVerdict,
    });
    expect(req?.user).toContain("la app se cierra al abrir el escáner");
    expect(req?.user).toContain('{"prioridad":"alta"}');
    expect(`${req?.system ?? ""}${req?.user ?? ""}`).not.toContain("claude-haiku-5-5");
  });

  it("registra quién evaluó y cuánto consumió", async () => {
    const judge = new FakeProvider().when(
      {},
      {
        text: verdict(1),
        latencyMs: 321,
        usage: { input: 900, output: 80, cacheRead: 600, cacheWrite: 0 },
      },
    );
    const { grade } = setup(judge);
    expect((await grade()).judge).toEqual({
      model: "claude-opus-5-5",
      latencyMs: 321,
      usage: { input: 900, output: 80, cacheRead: 600, cacheWrite: 0 },
    });
  });

  describe("errores de evaluación (nunca aprueban ni reprueban en silencio)", () => {
    it.each([
      ["JSON inválido", "no es json", /^el juez devolvió un veredicto inválido: JSON inválido/],
      [
        "forma incorrecta",
        JSON.stringify({ score: 0.9 }),
        /^el juez devolvió un veredicto inválido/,
      ],
      ["puntaje > 1", verdict(1.5), /^el juez devolvió un puntaje fuera de rango \(1.5\)$/],
      ["puntaje < 0", verdict(-0.1), /^el juez devolvió un puntaje fuera de rango \(-0.1\)$/],
    ])("%s", async (_name, reply, reason) => {
      const { grade } = setup(new FakeProvider().when({}, reply));
      const r = await grade();
      expect(r).toMatchObject({ pass: false, score: 0, error: true });
      expect(r.reason).toMatch(reason);
      expect(r.judge).toBeDefined();
    });

    it("rechazo del juez", async () => {
      const { grade } = setup(new FakeProvider().when({}, refusal("cyber")));
      expect(await grade()).toMatchObject({
        error: true,
        reason: "el juez rechazó evaluar (cyber)",
      });
    });

    it("veredicto cortado por max_tokens", async () => {
      const { grade } = setup(new FakeProvider().when({}, truncated('{"reasoning": "La resp')));
      expect(await grade()).toMatchObject({
        error: true,
        reason: "la respuesta del juez se cortó por max_tokens",
      });
    });

    it("error del proveedor del juez", async () => {
      const { grade } = setup(new FakeProvider().when({}, failure("overloaded", "sobrecargada")));
      expect(await grade()).toEqual({
        pass: false,
        score: 0,
        error: true,
        reason: "el juez falló: [overloaded] sobrecargada",
      });
    });

    it("sin juez configurado", async () => {
      const r = await gradeAssertion(out("x"), assertion({ type: "llm_judge", rubric: "r" }), {});
      expect(r).toMatchObject({
        error: true,
        reason: expect.stringMatching(/necesita un juez/) as string,
      });
    });

    /** Proveedor mínimo que devuelve exactamente lo indicado (o lanza). */
    const custom = (result: Partial<CompletionResult> | Error): Provider => ({
      name: "custom",
      complete: () =>
        result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve({ ...out("{}"), ...result }),
    });

    it.each([
      ["un proveedor que ignora outputSchema", {}, "el juez devolvió un veredicto inválido"],
      [
        "un valor estructurado con otra forma",
        { structured: { ok: true as const, value: { nota: 9 } } },
        "el juez devolvió un veredicto con otra forma",
      ],
    ])("%s", async (_name, result, reason) => {
      const { grade } = setup(new FakeProvider(), {
        judge: { provider: custom(result), model: "claude-opus-5-5" },
      });
      expect(await grade()).toMatchObject({ error: true, reason });
    });

    it("un error que no es del proveedor", async () => {
      const { grade } = setup(new FakeProvider(), {
        judge: { provider: custom(new TypeError("boom")), model: "claude-opus-5-5" },
      });
      expect(await grade()).toMatchObject({
        error: true,
        reason: "el juez falló: TypeError: boom",
      });
    });
  });
});
