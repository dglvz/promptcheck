import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSuite } from "../../src/config/load.js";
import { planSuite } from "../../src/planner/plan.js";
import { FakeProvider, failure } from "../../src/providers/fake.js";
import { runTrials } from "../../src/runner/run.js";

const SUITE = fileURLToPath(new URL("../fixtures/suites/tickets/suite.yaml", import.meta.url));

describe("suite → plan → runner (FakeProvider)", () => {
  it("corre el fixture de tickets de punta a punta", async () => {
    const suite = await loadSuite(SUITE);
    const plan = planSuite(suite);
    // 2 casos × 2 modelos × 3 trials
    expect(plan).toHaveLength(12);

    const fake = new FakeProvider()
      .when({ user: "contraseña" }, '{"categoria":"cuenta","prioridad":"media","resumen":"reset"}')
      .when(
        { user: "escáner", model: "claude-haiku-5-5" },
        '{"categoria":"bug","prioridad":"alta","resumen":"falla el escáner"}',
        failure("overloaded"),
        '{"categoria":"otro","prioridad":"baja","resumen":"?"}',
      )
      .when({ user: "escáner" }, '{"categoria":"bug","prioridad":"alta","resumen":"escáner"}');

    const { runs, aborted } = await runTrials(plan, { provider: fake, concurrency: 1 });
    expect(aborted).toBeUndefined();
    expect(runs.filter((r) => r.status === "completed")).toHaveLength(11);

    const haikuScanner = runs.filter(
      (r) => r.trial.caseId === "app-se-cierra" && r.trial.model.id === "claude-haiku-5-5",
    );
    expect(haikuScanner.map((r) => r.status)).toEqual(["completed", "error", "completed"]);

    // El system leído desde file:// llega al proveedor, marcado como cacheable.
    expect(fake.calls[0]).toMatchObject({
      model: "claude-opus-5-5",
      effort: "medium",
      cacheSystem: true,
      maxTokens: 1024,
      user: "Ticket del cliente:\nNo me llega el correo para cambiar la contraseña",
    });
    expect(fake.calls[0]?.system).toContain("Eres un clasificador de tickets");
  });
});
