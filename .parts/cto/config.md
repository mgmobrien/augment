# CTO config — Augment

## Scan targets

- All `src/*.ts` files — the full codebase
- `package.json` — dependencies, scripts
- `tsconfig.json` — TypeScript config
- `esbuild.config.mjs` — build configuration

## Build command

```bash
cd /Users/mattobrien/Development/augment-plugin && npm run build 2>&1 | tail -20
```

Fallback: `npx tsc --noEmit`

## Scale context

~1,400 lines of TypeScript across 5 modules + 155-line Python PTY bridge. Keep assessments proportional to the project's actual scale.
