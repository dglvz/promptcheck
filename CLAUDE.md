# CLAUDE.md

Convenciones de `promptcheck` para Claude Code. La propuesta completa está en `docs/` (es local y no se versiona).

## Qué es

Es una CLI en TypeScript que evalúa prompts de Claude como si fueran pruebas unitarias. Las suites se escriben en YAML y se corren contra uno o varios modelos, con N repeticiones. Cada respuesta se califica con reglas deterministas o con un juez LLM, y la herramienta reporta aprobación, costo y latencia. Con `--ci`, falla si hay una regresión contra el baseline.

## Comandos

- `npm run check`: lint, formato, tipos, pruebas y build. **Tiene que pasar antes de cada commit.**
- `npm test` / `npm run test:watch` / `npm run test:coverage`
- `npm run lint:fix` y `npm run format` para corregir el estilo.
- `npm run build`: tsup genera `dist/`. El binario es `dist/cli/index.js`.

## Arquitectura

Flujo de una corrida: `config → planner → runner → provider → graders → stats → report`, todo en `src/`.

| Módulo       | Responsabilidad                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `config/`    | Carga el YAML, resuelve `file://`, interpola `{{var}}`, valida con zod. Errores con archivo, línea y campo. |
| `planner/`   | Expande la suite en trials (caso × modelo × repetición) con un id estable.                                  |
| `runner/`    | Ejecuta con `p-limit`, consulta la caché y lleva el gasto acumulado (`--max-cost`).                         |
| `providers/` | `Provider`, `AnthropicProvider` y `FakeProvider`. **Es el único lugar que llama a la API.**                 |
| `graders/`   | Un calificador por tipo de aserción, todos con la misma firma. El juez recibe un `Provider` inyectado.      |
| `pricing/`   | Tabla de precios con fecha y cálculo de costo. **Es el único lugar con precios.**                           |
| `cache/`     | Respuestas guardadas por hash en `.promptcheck/cache/`.                                                     |
| `stats/`     | Tasas de aprobación, casos inestables y comparación con el baseline.                                        |
| `report/`    | Terminal, JSON versionado, HTML autocontenido y resumen para GitHub.                                        |
| `cli/`       | Comandos y flags. Traduce los resultados en códigos de salida.                                              |

**Regla de diseño:** `config`, `planner`, los graders deterministas, `stats` y `pricing` son funciones puras, sin red ni disco. La E/S vive en los bordes: `cli`, `runner`, `providers`, `cache` y `report`.

Códigos de salida:

- `0`: todo aprobado
- `1`: suite bajo el umbral o regresión
- `2`: error de configuración
- `3`: tope de gasto alcanzado
- `4`: error de API no recuperable

## Código

- TypeScript estricto (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), solo ESM. Los imports relativos llevan la extensión `.js`.
- Los imports de tipos van con `import type`, porque `verbatimModuleSyntax` está activo.
- Los tipos se derivan de los esquemas zod (`z.infer`) en vez de duplicarse a mano.
- Nada de `any`. Para datos externos, usar `unknown` y validar con zod.
- Los mensajes para el usuario (errores, razones de los calificadores, ayuda de la CLI) se escriben en español. Los identificadores del código, en inglés.
- Las versiones de las dependencias son exactas (`.npmrc` tiene `save-exact`). TypeScript se mantiene en la versión 6.x hasta que typescript-eslint soporte la 7.

## Reglas de la API de Claude

Antes de implementar algo en `providers/` o `pricing/`, verificar los IDs de modelo, los precios y los parámetros en la documentación oficial.

- No enviar `temperature`, `top_p` ni `top_k`. La variabilidad se maneja con repeticiones.
- El esfuerzo se controla con `output_config: { effort }` y se fija siempre de forma explícita.
- Las salidas estructuradas se piden con `client.messages.parse()` + `zodOutputFormat`.
- Sin prefill del asistente: devuelve un error 400.
- Revisar `stop_reason` antes de leer el contenido. `max_tokens` y `refusal` son resultados propios del trial, no errores genéricos.
- Para los errores, usar las clases tipadas del SDK, de la más específica a la más general. Nunca comparar textos de error.
- Prompt caching: `cache_control: { type: "ephemeral" }` en el system prompt. El contenido fijo va primero y el variable al final.
- Un modelo sin precio conocido se reporta con costo "desconocido", nunca con 0.

## Pruebas

- **Ninguna prueba llama a la API real.** Todo pasa por `Provider`; en las pruebas se inyecta `FakeProvider`.
- Ubicación: `tests/unit/`, `tests/integration/` (corrida completa con `FakeProvider`) y `tests/fixtures/`.
- Los calificadores se prueban con tablas de casos (`it.each`).
- Meta de cobertura: 85 % o más en `config`, `graders`, `stats` y `pricing` (lo exige `vitest.config.ts`).
- La prueba de humo real (`npm run smoke`, contra Haiku) es manual y nunca corre en CI.

## Flujo de trabajo

- `main` siempre está estable. Cada issue tiene su rama (`feat/…`, `fix/…`, `docs/…`, `chore/…`, `ci/…`) y su PR con descripción y checklist. Se mergea con squash cuando el CI pasa.
- Commits convencionales: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`, `refactor:`.
- Los issues de GitHub se etiquetan con `mvp`, `v0.2`, `v0.3` o `extra`.
- Versionado SemVer, con `CHANGELOG.md` por versión y tags `vX.Y.Z`.

## Seguridad

- La API key solo se lee de `ANTHROPIC_API_KEY`. Nunca se escribe en reportes, logs ni fixtures.
- `.env` y `.promptcheck/` están ignorados en git, y gitleaks corre en cada PR.
- Los reportes contienen los prompts y las respuestas completos: no versionarlos si incluyen datos sensibles.

## Regla del proyecto

Todo lo que entra al repo tiene que poder explicarse en una entrevista. Preferir lo simple y explícito a lo ingenioso.
