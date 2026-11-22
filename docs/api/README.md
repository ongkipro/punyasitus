# PunyaSitus OpenAPI 3.1 Contract (`docs/api`)

`openapi.json` is the single machine-readable HTTP contract for PunyaSitus (`PLAN.md` §4 & §6, `TASK-024`).

- **Source of truth:** Modular Zod v4 schema modules under [`packages/core/src/schemas/`](../../packages/core/src/schemas/index.ts), assembled by `buildOpenApiDocument()` using Zod 4's native `z.toJSONSchema()` (zero external OpenAPI dependencies).
- **Do not hand-edit `openapi.json`.** Update the corresponding domain schema module under `packages/core/src/schemas/<domain>.ts` and regenerate `docs/api/openapi.json`.
- **Drift check in CI:** `tests/task-024/unit.test.ts` compares `serializeOpenApiDocument()` against `docs/api/openapi.json` byte-for-byte and fails `pnpm test:unit` on any drift.
- **Authorization contract:** Role permissions, cross-tenant denial (404 vs 403), service-state overrides, and the 4-surface routing matrix live in [`packages/auth/src/permissions.ts`](../../packages/auth/src/permissions.ts).

## Regenerating `openapi.json`

```bash
node -e 'import("./packages/core/src/schemas/index.ts").then(async ({ serializeOpenApiDocument }) => { const fs = await import("node:fs"); fs.writeFileSync("docs/api/openapi.json", serializeOpenApiDocument(), "utf8"); });'
```
