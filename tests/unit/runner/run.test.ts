import { describe, expect, it } from "vitest";
import type { Trial } from "../../../src/planner/plan.js";
import { FakeProvider, failure, refusal } from "../../../src/providers/fake.js";
import { ProviderError } from "../../../src/providers/provider.js";
import { DEFAULT_CONCURRENCY, runTrials, toTrialError } from "../../../src/runner/run.js";
import type { TrialRun } from "../../../src/runner/run.js";

const trials = (n: number, model = "claude-haiku-5-5"): Trial[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `caso-${i}/${model}/1`,
    caseId: `caso-${i}`,
    model: { id: model },
    trial: 1,
    request: { model, user: `pregunta ${i}`, maxTokens: 100 },
    assertions: [],
  }));

const statuses = (runs: TrialRun[]) =>
  runs.map((r) => (r.status === "completed" ? r.completion.text : r.status));

describe("runTrials", () => {
  it("devuelve los resultados en el orden del plan aunque terminen desordenados", async () => {
    const fake = new FakeProvider().when({}, async (req) => {
      const i = Number(req.user.split(" ")[1]);
      await new Promise((r) => setTimeout(r, (5 - i) * 5));
      return `r${i}`;
    });
    const { runs, aborted } = await runTrials(trials(5), { provider: fake });
    expect(statuses(runs)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(runs.map((r) => r.trial.id)).toEqual(trials(5).map((t) => t.id));
    expect(aborted).toBeUndefined();
  });

  it.each([1, 2, 4])("respeta concurrency = %i", async (concurrency) => {
    const fake = new FakeProvider({ default: "x", delayMs: 10 });
    await runTrials(trials(10), { provider: fake, concurrency });
    expect(fake.maxInFlight).toBe(concurrency);
    expect(fake.calls).toHaveLength(10);
  });

  it("usa la concurrencia por defecto", async () => {
    const fake = new FakeProvider({ default: "x", delayMs: 10 });
    await runTrials(trials(10), { provider: fake });
    expect(fake.maxInFlight).toBe(DEFAULT_CONCURRENCY);
  });

  it.each([0, -1, 2.5])("rechaza concurrency = %s", async (concurrency) => {
    await expect(
      runTrials(trials(1), { provider: new FakeProvider(), concurrency }),
    ).rejects.toThrow(RangeError);
  });

  it("registra errores no fatales y sigue con el resto", async () => {
    const fake = new FakeProvider({ default: "ok" }).when(
      { user: "pregunta 1" },
      failure("rate_limit", "demasiadas", 429),
    );
    const { runs, aborted } = await runTrials(trials(3), { provider: fake, concurrency: 1 });
    expect(statuses(runs)).toEqual(["ok", "error", "ok"]);
    expect(runs[1]).toMatchObject({
      status: "error",
      error: { kind: "rate_limit", message: "demasiadas", fatal: false, status: 429 },
    });
    expect(aborted).toBeUndefined();
  });

  it("un rechazo no es un error: el trial se completa con su stop_reason", async () => {
    const fake = new FakeProvider().when({}, refusal("cyber"));
    const { runs } = await runTrials(trials(1), { provider: fake });
    expect(runs[0]).toMatchObject({
      status: "completed",
      completion: { stopReason: "refusal", refusalCategory: "cyber" },
    });
  });

  it("ante un error fatal deja de lanzar trials y marca el resto como omitidos", async () => {
    const fake = new FakeProvider({ default: "ok" }).when(
      { user: "pregunta 2" },
      failure("authentication", "key inválida", 401),
    );
    const { runs, aborted } = await runTrials(trials(6), { provider: fake, concurrency: 1 });
    expect(statuses(runs)).toEqual(["ok", "ok", "error", "skipped", "skipped", "skipped"]);
    expect(fake.calls).toHaveLength(3);
    expect(aborted).toEqual({
      kind: "authentication",
      message: "key inválida",
      fatal: true,
      status: 401,
    });
  });

  it("con concurrencia, los trials en curso terminan aunque otro falle fatalmente", async () => {
    const fake = new FakeProvider({ default: "ok", delayMs: 10 }).when(
      { user: "pregunta 0" },
      failure("bad_request"),
    );
    const { runs, aborted } = await runTrials(trials(8), { provider: fake, concurrency: 4 });
    // Los 4 primeros ya estaban lanzados; los otros 4 no llegan a empezar.
    expect(statuses(runs)).toEqual([
      "error",
      "ok",
      "ok",
      "ok",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(aborted?.kind).toBe("bad_request");
  });

  it("informa el progreso de cada trial terminado", async () => {
    const fake = new FakeProvider({ default: "ok" });
    const progress: string[] = [];
    await runTrials(trials(3), {
      provider: fake,
      concurrency: 1,
      onTrialDone: (run, done, total) => progress.push(`${done}/${total} ${run.trial.caseId}`),
    });
    expect(progress).toEqual(["1/3 caso-0", "2/3 caso-1", "3/3 caso-2"]);
  });

  it("acepta un plan vacío", async () => {
    expect(await runTrials([], { provider: new FakeProvider() })).toEqual({ runs: [] });
  });
});

describe("toTrialError", () => {
  it("serializa un ProviderError", () => {
    expect(toTrialError(new ProviderError("server", "caído", { status: 500 }))).toEqual({
      kind: "server",
      message: "caído",
      fatal: false,
      status: 500,
    });
    expect(toTrialError(new ProviderError("timeout", "lento"))).not.toHaveProperty("status");
  });

  it("registra otros errores como unknown y no fatales", () => {
    expect(toTrialError(new Error("bug"))).toEqual({
      kind: "unknown",
      message: "bug",
      fatal: false,
    });
    expect(toTrialError("texto")).toMatchObject({ message: "texto" });
  });
});
