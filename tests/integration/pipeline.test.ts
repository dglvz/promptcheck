import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSuite } from "../../src/config/load.js";
import { gradeTrial } from "../../src/graders/index.js";
import { planSuite } from "../../src/planner/plan.js";
import { FakeProvider, failure } from "../../src/providers/fake.js";
import { runTrials } from "../../src/runner/run.js";

const SUITE = fileURLToPath(new URL("../fixtures/suites/tickets/suite.yaml", import.meta.url));

describe("suite → plan → runner → graders (FakeProvider)", () => {
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

    // Calificación: el caso del correo usa json_schema (leído desde file://) y json_path_equals.
    const graded = await Promise.all(
      runs.map(async (r) =>
        r.status === "completed"
          ? { id: r.trial.id, ...(await gradeTrial(r.completion, r.trial.assertions)) }
          : { id: r.trial.id, pass: false, grades: [] },
      ),
    );
    const byId = new Map(graded.map((g) => [g.id, g]));

    expect(byId.get("correo-reset/claude-opus-5-5@medium/1")).toMatchObject({
      pass: true,
      grades: [{ reason: "cumple el esquema" }, { reason: 'categoria vale "cuenta"' }],
    });
    // Tercer trial de Haiku: responde "otro" en vez de "bug".
    expect(byId.get("app-se-cierra/claude-haiku-5-5/3")?.grades[0]).toMatchObject({
      pass: false,
      reason: 'categoria: esperaba "bug", obtuvo "otro"',
    });
    // gradeTrial sin juez en el contexto: llm_judge queda como error de evaluación.
    expect(byId.get("app-se-cierra/claude-opus-5-5@medium/1")).toMatchObject({
      pass: false,
      grades: [{ pass: true }, { error: true }],
    });
  });
});
