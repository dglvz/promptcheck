# promptcheck

Mini framework para evaluar prompts de Claude como si fueran pruebas unitarias: suites en YAML, comparación de modelos, costos y detección de regresiones en CI.

> 🚧 En desarrollo — v0.1 (MVP) en curso.

## Licencia

[MIT](LICENSE)

## Desarrollo

Requiere Node.js 24 o superior.

```bash
npm install
npm run check   # lint + formato + tipos + pruebas + build
```

| Script                  | Qué hace                            |
| ----------------------- | ----------------------------------- |
| `npm run build`         | Empaqueta la CLI en ESM con tsup    |
| `npm run typecheck`     | `tsc --noEmit`                      |
| `npm run lint`          | ESLint (reglas estrictas con tipos) |
| `npm run format:check`  | Prettier en modo verificación       |
| `npm test`              | Vitest                              |
| `npm run test:coverage` | Vitest con cobertura (v8)           |
