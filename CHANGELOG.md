# Changelog

Todos los cambios relevantes de este proyecto se documentan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado,
[SemVer](https://semver.org/lang/es/).

## [0.1.0] - 2026-11-28

Primera versión (MVP): corre suites contra la API de Claude con calificadores deterministas.

### Agregado

- Formato de suites en YAML validado con zod: modelos (con `effort`), `defaults`, prompt con
  `file://` y `{{variables}}`, casos, 11 tipos de aserción y umbrales. Los errores indican
  archivo, línea, columna y campo, y se reportan todos juntos.
- `AnthropicProvider` sobre el SDK oficial: prompt caching del system, `effort` vía
  `output_config`, `stop_reason` y categoría de rechazo, errores tipados clasificados en
  recuperables y fatales (incluido el tope de gasto).
- `FakeProvider` para probar sin red: reglas, secuencias por trial, rechazos, errores y caché
  simulada.
- Planner (caso × modelo × repetición, con id estable) y runner con concurrencia limitada que
  se detiene ante un error fatal.
- 10 calificadores deterministas: `equals`, `contains`, `not_contains`, `regex`, `max_length`,
  `json_valid`, `json_schema`, `json_path_equals`, `latency_below` y `cost_below`.
- Estadísticas por modelo: tasa de aprobación (promedio por caso), casos inestables, errores,
  tokens y latencia p50/p95.
- Comando `promptcheck run` con `--model`, `--case`, `--trials`, `--concurrency` y
  `--no-color`; reporte en la terminal y códigos de salida 0, 1, 2 y 4.
- CI con lint, tipos, pruebas con cobertura, build y gitleaks; Dependabot.

[0.1.0]: https://github.com/dglvz/promptcheck/releases/tag/v0.1.0
