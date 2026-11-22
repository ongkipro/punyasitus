# packages/plugins

Boundary note; `docs/plugins/PLUGIN-DEVELOPMENT.md` and ADR-0010 own the contract. One folder per plugin: `seo-ai-autopilot`, `bio-links`, `wa-cs-rotator`, `wp-importer`, `lead-notifier`, then client and paid add-ons.

Isolated `plg_<id>__*` tables in `TenantStore`, zero runtime cost when inactive. `seo-ai-autopilot` is the only head, schema and sitemap authority (DEC-039). Arbitrary uploaded or third-party code is forbidden.
