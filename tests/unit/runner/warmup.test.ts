import pLimit from "p-limit";
import { describe, expect, it } from "vitest";
import type { Trial } from "../../../src/planner/plan.js";
import { FakeProvider } from "../../../src/providers/fake.js";
import { cachePrefixKey } from "../../../src/providers/provider.js";
import type { CompletionRequest } from "../../../src/providers/provider.js";
import { runTrials } from "../../../src/runner/run.js";
import { mapWithWarmup } from "../../../src/runner/warmup.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cachePrefixKey", () => {
  const req = (o: Partial<CompletionRequest> = {}): CompletionRequest => ({
    model: "m",
    user: "u",
    maxTokens: 10,
    system: "s",
    cacheSystem: true,
    ...o,
  });

  it("sin caché o sin system no hay prefijo", () => {
    expect(cachePrefixKey(req({ cacheSystem: false }))).toBeUndefined();
    expect(cachePrefixKey(req({ system: "" }))).toBeUndefined();
    const { system: _s, ...noSystem } = req();
    expect(cachePrefixKey(noSystem)).toBeUndefined();
  });

  it("el prefijo depende del modelo, del effort y del system, no del mensaje del usuario", () => {
    expect(cachePrefixKey(req({ user: "a" }))).toBe(cachePrefixKey(req({ user: "b" })));
    expect(cachePrefixKey(req())).not.toBe(cachePrefixKey(req({ model: "otro" })));
    expect(cachePrefixKey(req())).not.toBe(cachePrefixKey(req({ effort: "low" })));
    expect(cachePrefixKey(req())).not.toBe(cachePrefixKey(req({ system: "t" })));
  });
});

describe("mapWithWarmup", () => {
  it("el primero de cada grupo termina antes de que empiecen los demás de su grupo", async () => {
    const log: string[] = [];
    const items = ["a1", "a2", "a3", "b1", "b2", "x"];
    const results = await mapWithWarmup(
      items,
      pLimit(4),
      (i) => (i === "x" ? undefined : i[0]),
      async (i) => {
        log.push(`start ${i}`);
        await sleep(i.endsWith("1") ? 20 : 5);
        log.push(`end ${i}`);
        return i.toUpperCase();
      },
    );
    expect(results).toEqual(["A1", "A2", "A3", "B1", "B2", "X"]);
    for (const g of ["a", "b"]) {
      const leaderEnd = log.indexOf(`end ${g}1`);
      expect(log.indexOf(`start ${g}2`)).toBeGreaterThan(leaderEnd);
    }
    // Los líderes de distintos grupos y los sin grupo arrancan juntos.
    expect(log.slice(0, 3).sort()).toEqual(["start a1", "start b1", "start x"]);
  });

  it("no se traba con concurrencia 1 y muchos grupos", async () => {
    const items = Array.from({ length: 20 }, (_, i) => `g${i % 5}-${i}`);
    const results = await mapWithWarmup(
      items,
      pLimit(1),
      (i) => i.split("-")[0],
      async (i) => {
        await sleep(1);
        return i;
      },
    );
    expect(results).toEqual(items);
  });

  it("si el líder falla, los demás de su grupo corren igual", async () => {
    const ran: string[] = [];
    const all = mapWithWarmup(
      ["a1", "a2", "a3"],
      pLimit(2),
      () => "a",
      (i) => {
        ran.push(i);
        return i === "a1" ? Promise.reject(new Error("falló")) : Promise.resolve(i);
      },
    );
    await expect(all).rejects.toThrow("falló");
    await sleep(10);
    expect(ran.sort()).toEqual(["a1", "a2", "a3"]);
  });
});

describe("runTrials con prompt caching", () => {
  const SYSTEM = "Instrucciones largas y fijas.".repeat(40);
  const trials = (n: number, models = ["claude-haiku-5-5"]): Trial[] =>
    models.flatMap((model) =>
      Array.from({ length: n }, (_, i) => ({
        id: `c/${model}/${i + 1}`,
        caseId: "c",
        model: { id: model },
        modelLabel: model,
        trial: i + 1,
        request: { model, system: SYSTEM, user: `p${i}`, maxTokens: 50, cacheSystem: true },
        assertions: [],
      })),
    );

  const cacheUse = (runs: Awaited<ReturnType<typeof runTrials>>["runs"]) =>
    runs.map((r) =>
      r.status === "completed" ? (r.completion.usage.cacheRead > 0 ? "read" : "write") : r.status,
    );

  it("con precalentamiento: 1 escritura y el resto lecturas, aun en paralelo", async () => {
    const fake = new FakeProvider({ default: "ok", delayMs: 10 });
    const { runs } = await runTrials(trials(4), { provider: fake, concurrency: 4 });
    expect(cacheUse(runs)).toEqual(["write", "read", "read", "read"]);
  });

  it("sin precalentamiento (prefijos todos distintos) cada petición en paralelo escribe", async () => {
    // Referencia: así se comportaría la API si los 4 trials salieran a la vez.
    const fake = new FakeProvider({ default: "ok", delayMs: 10 });
    const reqs = trials(4).map((t) => t.request);
    const usages = await Promise.all(reqs.map((r) => fake.complete(r)));
    expect(usages.map((u) => (u.usage.cacheRead > 0 ? "read" : "write"))).toEqual([
      "write",
      "write",
      "write",
      "write",
    ]);
  });

  it("cada modelo tiene su propio prefijo y los modelos no se esperan entre sí", async () => {
    const fake = new FakeProvider({ default: "ok", delayMs: 10 });
    const { runs } = await runTrials(trials(2, ["claude-opus-5-5", "claude-haiku-5-5"]), {
      provider: fake,
      concurrency: 4,
    });
    expect(cacheUse(runs)).toEqual(["write", "read", "write", "read"]);
    expect(fake.maxInFlight).toBe(2);
  });
});
