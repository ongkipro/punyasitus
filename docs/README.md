# Documentation Map — PunyaSitus

The one page that connects the project, its development documents and the private research repository. Each document owns one subject; this map only links. Start here when you do not know where something lives.

## The two repositories

| Folder | Repository | Visibility | Holds |
|---|---|---|---|
| `~/Projects/punyasitus` | [`ongkipro/punyasitus`](https://github.com/ongkipro/punyasitus) | public | code + the development contract (everything below except the last section) |
| `~/Projects/punyasitus-docs` | `ongkipro/punyasitus-docs` | private | research, frozen CMSPRO archive, HTML prototype |

Clone both side by side. The code repository never links into the private one with a Markdown link; it cites `punyasitus-docs/docs/...` in backticks (DEC-044). History before 2026-11-22 is in private `ongkipro/punyasitus-history`.

## Read order for a new session

1. [AGENTS.md](../AGENTS.md): rules for agents and contributors.
2. [STATUS.md](../STATUS.md): what is true now, what is next, blockers.
3. [TASKS.md](../TASKS.md): pick the dependency-ready task, then read its contract in [tasks/](tasks/).
4. The contracts that task names: [PRD.md](../PRD.md), [PLAN.md](../PLAN.md), [DESIGN.md](../DESIGN.md), [DECISIONS.md](../DECISIONS.md).

## Development documents (this repository)

### Product and design: what to build

| Document | Owns |
|---|---|
| [PRD.md](../PRD.md) | Product scope and requirements `REQ-001..REQ-110` |
| [PLAN.md](../PLAN.md) | Technical contracts: runtime, tenancy, data, IAM, HTTP, media, SEO, billing, lifecycle; gates in section 1 |
| [DESIGN.md](../DESIGN.md) | Visual direction, admin shell, components |
| [DECISIONS.md](../DECISIONS.md) | Decision index `DEC-001..DEC-048`; full ADRs in [adr/](adr/) |
| [themes/THEME-DEVELOPMENT.md](themes/THEME-DEVELOPMENT.md) | Building a custom or premium theme |
| [plugins/PLUGIN-DEVELOPMENT.md](plugins/PLUGIN-DEVELOPMENT.md) | Building a first-party plugin |
| `api/` (from TASK-024) | OpenAPI contract generated from `packages/core` |

### Execution: how work moves

| Document | Owns |
|---|---|
| [TASKS.md](../TASKS.md) | The only execution queue (index, waves, In progress / Pending / Done) |
| [tasks/](tasks/) | Full task contracts per wave: allowed paths, invariants, verification |
| [STATUS.md](../STATUS.md) | Workflow state (the only authority), Now / Next / Blockers, live verifications |
| `.delivery/` | `delivery-ledger` evidence; tool-owned, never hand-edited |

### Records: what actually happened

| Document | Owns |
|---|---|
| [ARCHITECTURE.md](../ARCHITECTURE.md) | System map as built; outranks PLAN where code and plan differ |
| [BUILD-LOG.md](../BUILD-LOG.md) | Durable implementation notes and evidence, append-only |
| [RELEASE.md](../RELEASE.md) | Current release boundary, risk, rollback |
| [OBSERVABILITY.md](../OBSERVABILITY.md) | Post-deploy probes |
| `operations/`, `security/` (later tasks) | Runbooks and security evidence |

### Code boundaries

Each module folder has a README naming its owner contract and rules: [apps/web](../apps/web/README.md), [packages/core](../packages/core/README.md), [packages/db](../packages/db/README.md), [packages/auth](../packages/auth/README.md), [packages/integrations](../packages/integrations/README.md), [packages/plugins](../packages/plugins/README.md), [infra/cloudflare](../infra/cloudflare/README.md), [tests](../tests/README.md). The full tree is in [README.md](../README.md#repository-layout).

### Checks

```bash
python3 scripts/check-spec.py        # requirements, tasks, index/contract agreement, links, 50 KB budget
python3 scripts/test-check-spec.py   # checker self-tests
```

Application checks (`pnpm lint`, `typecheck`, `test:*`, `build`) arrive with TASK-023.

## Research and history (private `punyasitus-docs`)

Reference only; never an implementation source.

| Path | Holds | Cited by |
|---|---|---|
| `punyasitus-docs/docs/research/` | Dated research notes, gap review, Cloudflare runtime study, CMSPRO design research, market and migration notes | PRD, PLAN, DESIGN, DECISIONS, ADR-0009 |
| `punyasitus-docs/docs/archive/cmspro/` | Frozen CMSPRO pack (spec, ADRs, wireframes) | PRD section 18, DEC-034 |
| `punyasitus-docs/docs/html/` | Static HTML prototype (non-authoritative) | AGENTS.md |
| `punyasitus-docs/docs/MERGE-CMSPRO.md` | CMSPRO adoption ledger | DEC-034, DEC-035 |

## Where a new thing goes

| New thing | Goes to |
|---|---|
| Requirement | PRD.md (`REQ-NNN`), plus a task |
| Task | Record in TASKS.md + contract in `docs/tasks/wave-N.md` (keep each under 50 KB) |
| Decision | DECISIONS.md row; costly to reverse → `docs/adr/ADR-NNNN-<slug>.md` |
| Status or blocker | STATUS.md |
| Evidence, gotcha | BUILD-LOG.md |
| What the code really does | ARCHITECTURE.md |
| Research, competitor or provider study | `punyasitus-docs/docs/research/YYYY-MM-DD-<slug>.md` (private) |
| Anything naming a customer, private account or internal host | private repository only |
