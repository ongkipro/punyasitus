# packages/integrations

Boundary note. Server-only adapters for external providers, one folder per provider (`src/autolaris/` first, TASK-057 and TASK-058). Provider origins are fixed constants, never client-supplied. Business rules stay in `packages/core`; an adapter only translates.
