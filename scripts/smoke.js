// Prueba de humo MANUAL contra la API real (sección 15). Nunca corre en CI.
// Hace 2 llamadas cortas a Claude Haiku 5.5 (costo de fracciones de centavo).
// Uso: npm run smoke   (requiere ANTHROPIC_API_KEY en el entorno)
import { AnthropicProvider, ProviderError } from "../dist/index.js";

const MODEL = process.env.PROMPTCHECK_SMOKE_MODEL ?? "claude-haiku-5-5";
const provider = new AnthropicProvider({ maxRetries: 1 });

const checks = [
  {
    name: "texto simple",
    req: {
      model: MODEL,
      user: "Responde exactamente con la palabra: pong",
      maxTokens: 64,
      effort: "low",
    },
    ok: (r) => r.stopReason === "end_turn" && /pong/i.test(r.text),
  },
  {
    name: "system cacheable + JSON",
    req: {
      model: MODEL,
      system: "Responde solo con JSON válido, sin texto adicional ni bloques de código.",
      user: 'Devuelve {"ok": true}',
      maxTokens: 64,
      effort: "low",
      cacheSystem: true,
    },
    ok: (r) => {
      try {
        return JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, "")).ok === true;
      } catch {
        return false;
      }
    },
  },
];

let failed = 0;
for (const check of checks) {
  try {
    const r = await provider.complete(check.req);
    const pass = check.ok(r);
    if (!pass) failed++;
    console.log(`${pass ? "✔" : "✘"} ${check.name}`);
    console.log(
      `    modelo=${r.model} stop=${r.stopReason} latencia=${r.latencyMs}ms ` +
        `tokens(in=${r.usage.input} out=${r.usage.output} ` +
        `cacheRead=${r.usage.cacheRead} cacheWrite=${r.usage.cacheWrite})`,
    );
    console.log(`    respuesta: ${JSON.stringify(r.text.slice(0, 120))}`);
  } catch (err) {
    failed++;
    if (err instanceof ProviderError) {
      console.log(`✘ ${check.name}: [${err.kind}${err.fatal ? ", fatal" : ""}] ${err.message}`);
      if (err.fatal) break;
    } else {
      throw err;
    }
  }
}

console.log(failed === 0 ? "\nHumo OK." : `\n${failed} verificación(es) fallaron.`);
process.exitCode = failed === 0 ? 0 : 1;
