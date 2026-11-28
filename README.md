# promptcheck

[![CI](https://github.com/dglvz/promptcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/dglvz/promptcheck/actions/workflows/ci.yml)

Mini framework para evaluar prompts de Claude como si fueran pruebas unitarias: suites en YAML, comparación de modelos, costos y detección de regresiones en CI.

> 🚧 En desarrollo. La v0.1 (MVP) ya corre suites con calificadores deterministas; el juez LLM, los costos y el modo CI llegan en v0.2 y v0.3.

## Uso

```bash
export ANTHROPIC_API_KEY=...        # solo se lee del entorno
promptcheck run                     # corre todas las suites de evals/
promptcheck run evals/tickets.yaml  # una suite
promptcheck run evals/ --model claude-haiku-5-5 --trials 5
```

Una suite es un YAML con modelos, prompt y casos de prueba:

```yaml
name: Clasificación de tickets de soporte
models:
  - id: claude-opus-5-5
    effort: medium
  - claude-haiku-5-5
defaults:
  trials: 3 # repeticiones por caso y modelo
prompt:
  system: file://prompts/clasificador.md
  user: "Ticket del cliente:\n{{texto}}"
cases:
  - id: correo-reset
    vars: { texto: "No me llega el correo para cambiar la contraseña" }
    expect:
      - type: json_schema
        schema: file://schemas/ticket.json
      - type: json_path_equals
        path: categoria
        value: cuenta
thresholds:
  pass_rate: 0.9
```

### Flags de `run`

| Flag                | Qué hace                                                  |
| ------------------- | --------------------------------------------------------- |
| `-m, --model <ids>` | Solo estos modelos (repetible o separados por comas)      |
| `-c, --case <ids>`  | Solo estos casos (repetible o separados por comas)        |
| `-t, --trials <n>`  | Repeticiones por caso y modelo (reemplaza la de la suite) |
| `--concurrency <n>` | Llamadas simultáneas a la API (por defecto 4)             |
| `--no-color`        | Salida sin colores                                        |

### Aserciones

`equals`, `contains`, `not_contains`, `regex`, `max_length`, `json_valid`, `json_schema`, `json_path_equals`, `latency_below`, `cost_below` (y `llm_judge` en v0.2). Un trial aprueba si **todas** sus aserciones aprueban y la respuesta terminó normalmente (un rechazo o un corte por `max_tokens` no aprueban).

### Cómo se calcula la aprobación

- **Tasa del caso**: trials aprobados / trials ejecutados.
- **Tasa de la suite** (por modelo): promedio de las tasas de sus casos; cada caso pesa igual.
- **Caso inestable**: aprueba en unos trials y falla en otros; suele indicar un prompt ambiguo.
- La suite aprueba si todos sus modelos llegan a `thresholds.pass_rate`.

### Códigos de salida

| Código | Significado                                                                |
| ------ | -------------------------------------------------------------------------- |
| `0`    | Todo aprobado                                                              |
| `1`    | Alguna suite bajo el umbral                                                |
| `2`    | Error de configuración (YAML inválido, ruta o flag incorrectos)            |
| `3`    | Tope de gasto alcanzado (`--max-cost`, v0.2)                               |
| `4`    | Error de API no recuperable (credenciales, facturación, petición inválida) |

Todas las suites se validan **antes** de llamar a la API: un error de configuración nunca gasta tokens.

> ⚠️ Los reportes contienen los prompts y las respuestas completos: no los versiones si incluyen datos sensibles.

## Desarrollo

Requiere Node.js 24 o superior.

```bash
npm install
npm run check   # lint + formato + tipos + pruebas + build
```

| Script                  | Qué hace                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| `npm run build`         | Empaqueta la CLI en ESM con tsup                                   |
| `npm run typecheck`     | `tsc --noEmit`                                                     |
| `npm run lint`          | ESLint (reglas estrictas con tipos)                                |
| `npm run format:check`  | Prettier en modo verificación                                      |
| `npm test`              | Vitest (nunca llama a la API: usa `FakeProvider`)                  |
| `npm run test:coverage` | Vitest con cobertura (v8)                                          |
| `npm run smoke`         | Prueba de humo **real** contra Haiku 5.5 (manual, cuesta centavos) |

## Licencia

[MIT](LICENSE)
