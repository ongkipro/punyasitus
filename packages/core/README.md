# packages/core

Boundary note; `PLAN.md` §2 owns the contract. Runtime-neutral code shared by the Worker and tests: Zod schemas (the OpenAPI source, TASK-024), money/IDR, slugs and identifiers (PLAN §7.1), WhatsApp and URL helpers, SEO, theme and plugin contracts, presets.

No secrets, provider clients, database bindings or `env` access. Anything a browser bundle may import must stay pure.
