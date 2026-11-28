import type { LimitFunction } from "p-limit";
export { cachePrefixKey } from "../providers/provider.js";

/**
 * Precalentamiento del prompt caching.
 *
 * Una entrada de caché solo se puede leer cuando la primera respuesta que la escribe empieza a
 * llegar: N peticiones en paralelo con el mismo prefijo pagan N escrituras y no leen ninguna.
 * Por eso el primer elemento de cada grupo (mismo prefijo cacheable) corre antes que el resto
 * de su grupo; los demás grupos no esperan.
 */

/**
 * Como `Promise.all(items.map(fn))` con límite de concurrencia, pero dentro de cada grupo el
 * primer elemento termina antes de que empiecen los demás. El resultado conserva el orden.
 *
 * Los que esperan lo hacen fuera del límite: si esperaran ocupando un lugar, podrían llenar
 * todos los lugares mientras su líder sigue en la cola, y nada avanzaría.
 */
export function mapWithWarmup<T, R>(
  items: readonly T[],
  limit: LimitFunction,
  groupOf: (item: T) => string | undefined,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const leaders = new Map<string, Promise<unknown>>();
  return Promise.all(
    items.map((item) => {
      const key = groupOf(item);
      if (key === undefined) return limit(() => fn(item));
      const leader = leaders.get(key);
      if (leader !== undefined) return leader.then(() => limit(() => fn(item)));
      const first = limit(() => fn(item));
      // Los demás esperan aunque el líder falle: su resultado se reporta igual por su lado.
      leaders.set(
        key,
        first.catch(() => undefined),
      );
      return first;
    }),
  );
}
