import { z } from "zod";

/**
 * Esquema de las suites de promptcheck (sección 6 de la propuesta).
 *
 * Todos los objetos son estrictos: una llave desconocida (por ejemplo `expcet`) es un error,
 * no algo que se ignora en silencio. Los tipos públicos se derivan de aquí con `z.infer`.
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;

const nonEmpty = z.string().trim().min(1, "no puede estar vacío");

/** Un modelo puede escribirse como `claude-haiku-5-5` o como `{ id, effort }`. */
export const ModelConfig = z.preprocess(
  (m) => (typeof m === "string" ? { id: m } : m),
  z.strictObject({ id: nonEmpty, effort: Effort.optional() }),
);
export type ModelConfig = z.output<typeof ModelConfig>;

/**
 * Cómo se nombra un modelo en los trials y en el reporte: `id`, o `id@effort` si la suite fija
 * el esfuerzo. Así una suite puede comparar el mismo modelo con distintos esfuerzos.
 */
export const modelLabel = (m: ModelConfig): string =>
  m.effort === undefined ? m.id : `${m.id}@${m.effort}`;

export const Defaults = z.strictObject({
  max_tokens: z.int().positive().default(1024),
  trials: z.int().positive().default(1),
  cache_system: z.boolean().default(false),
});
export type Defaults = z.output<typeof Defaults>;

export const Prompt = z.strictObject({
  system: z.string().optional(),
  user: nonEmpty,
});
export type Prompt = z.output<typeof Prompt>;

export const JudgeConfig = z.strictObject({
  model: nonEmpty,
  effort: Effort.optional(),
});
export type JudgeConfig = z.output<typeof JudgeConfig>;

export const Thresholds = z.strictObject({
  pass_rate: z.number().min(0).max(1).default(1),
  max_regression: z.number().min(0).max(1).default(0.05),
});
export type Thresholds = z.output<typeof Thresholds>;

/** Campos comunes a todas las aserciones. `weight` cuenta para el puntaje, no para aprobar. */
const base = { weight: z.number().positive().default(1) };

const textOrList = z.union([z.string(), z.array(z.string()).min(1)]);

const isValidRegex = (pattern: string, flags?: string): boolean => {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
};

export const ASSERTION_TYPES = [
  "equals",
  "contains",
  "not_contains",
  "regex",
  "max_length",
  "json_valid",
  "json_schema",
  "json_path_equals",
  "latency_below",
  "cost_below",
  "llm_judge",
] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

export const Assertion = z.discriminatedUnion(
  "type",
  [
    z.strictObject({
      ...base,
      type: z.literal("equals"),
      value: z.string(),
      trim: z.boolean().default(true),
    }),
    z.strictObject({
      ...base,
      type: z.literal("contains"),
      value: textOrList,
      case_insensitive: z.boolean().default(false),
    }),
    z.strictObject({
      ...base,
      type: z.literal("not_contains"),
      value: textOrList,
      case_insensitive: z.boolean().default(false),
    }),
    z
      .strictObject({
        ...base,
        type: z.literal("regex"),
        pattern: z.string().min(1, "no puede estar vacío"),
        flags: z
          .string()
          .regex(/^[dgimsuvy]*$/, "solo se permiten las banderas d, g, i, m, s, u, v, y")
          .optional(),
      })
      .refine((a) => isValidRegex(a.pattern, a.flags), {
        error: "la expresión regular no es válida",
        path: ["pattern"],
      }),
    z
      .strictObject({
        ...base,
        type: z.literal("max_length"),
        chars: z.int().positive().optional(),
        words: z.int().positive().optional(),
      })
      .refine((a) => (a.chars === undefined) !== (a.words === undefined), {
        error: "indica exactamente uno de `chars` o `words`",
      }),
    z.strictObject({ ...base, type: z.literal("json_valid") }),
    z.strictObject({
      ...base,
      type: z.literal("json_schema"),
      // Inline o leído desde file:// por el cargador antes de validar.
      schema: z.record(z.string(), z.unknown(), {
        error: (iss) =>
          typeof iss.input === "string"
            ? "usa un JSON Schema en línea o una ruta con prefijo, por ejemplo `file://schemas/x.json`"
            : undefined,
      }),
    }),
    z.strictObject({
      ...base,
      type: z.literal("json_path_equals"),
      path: z
        .string()
        .regex(/^[^.]+(\.[^.]+)*$/, "usa puntos para separar los niveles, por ejemplo `a.b.0`"),
      // Cualquier valor del YAML (texto, número, booleano, null, lista u objeto), pero presente.
      value: z.custom<unknown>((v) => v !== undefined, { error: "campo requerido" }),
    }),
    z.strictObject({ ...base, type: z.literal("latency_below"), ms: z.number().positive() }),
    z.strictObject({ ...base, type: z.literal("cost_below"), usd: z.number().positive() }),
    z.strictObject({
      ...base,
      type: z.literal("llm_judge"),
      rubric: nonEmpty,
      threshold: z.number().min(0).max(1).default(0.7),
    }),
  ],
  {
    error: (iss) =>
      typeof iss.input === "object" && iss.input !== null && "type" in iss.input
        ? `tipo de aserción desconocido; los válidos son: ${ASSERTION_TYPES.join(", ")}`
        : "cada aserción debe ser un objeto con `type`",
  },
);
export type Assertion = z.output<typeof Assertion>;

const VarValue = z.union([z.string(), z.number(), z.boolean()]);

export const Case = z.strictObject({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/i,
      "usa solo letras, números, `-` y `_` (sirve como identificador estable)",
    ),
  description: z.string().optional(),
  vars: z.record(z.string(), VarValue).default({}),
  expect: z.array(Assertion).min(1, "cada caso necesita al menos una aserción"),
});
export type Case = z.output<typeof Case>;

export const Suite = z
  .strictObject({
    name: nonEmpty,
    description: z.string().optional(),
    models: z.array(ModelConfig).min(1, "indica al menos un modelo"),
    defaults: Defaults.default(() => Defaults.parse({})),
    prompt: Prompt,
    judge: JudgeConfig.optional(),
    fallbacks: z.literal("default").optional(),
    cases: z.array(Case).min(1, "la suite necesita al menos un caso"),
    thresholds: Thresholds.default(() => Thresholds.parse({})),
  })
  .superRefine((suite, ctx) => {
    const seen = new Map<string, number>();
    suite.cases.forEach((c, i) => {
      const first = seen.get(c.id);
      if (first === undefined) {
        seen.set(c.id, i);
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["cases", i, "id"],
          message: `id repetido: "${c.id}" ya se usa en cases[${first}]`,
        });
      }
    });

    const seenModels = new Set<string>();
    suite.models.forEach((m, i) => {
      const label = modelLabel(m);
      if (seenModels.has(label)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", i],
          message: `modelo repetido: "${label}" (para compararlo consigo mismo, usa otro effort)`,
        });
      }
      seenModels.add(label);
    });

    if (suite.judge === undefined) {
      suite.cases.forEach((c, i) => {
        c.expect.forEach((a, j) => {
          if (a.type === "llm_judge") {
            ctx.addIssue({
              code: "custom",
              path: ["cases", i, "expect", j],
              message: "las aserciones `llm_judge` requieren una sección `judge` en la suite",
            });
          }
        });
      });
    }
  });
export type SuiteInput = z.input<typeof Suite>;
export type Suite = z.output<typeof Suite>;

/** Mapa de errores en español; distingue "falta el campo" de "tipo incorrecto". */
export const spanishErrors: z.core.$ZodErrorMap = (iss) => {
  if ((iss.code === "invalid_type" || iss.code === "invalid_union") && iss.input === undefined) {
    return "campo requerido";
  }
  return z.locales.es().localeError(iss);
};
