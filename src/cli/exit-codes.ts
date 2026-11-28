/** Códigos de salida de la CLI (sección 7). */
export const EXIT = {
  /** Todo aprobado. */
  OK: 0,
  /** Alguna suite bajo el umbral (o, en --ci, con regresión). */
  FAILED: 1,
  /** Error de configuración: YAML inválido, archivo inexistente, flag mal escrito… */
  CONFIG: 2,
  /** Se alcanzó el tope de gasto (--max-cost). */
  BUDGET: 3,
  /** Error de API no recuperable: credenciales, petición inválida, facturación… */
  API: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
