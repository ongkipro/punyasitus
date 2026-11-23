-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0016_custom_forms_indexes
-- Additive performance & uniqueness indexes for custom forms & form-scoped leads (REQ-080, PLAN §19.2, TASK-080).
-- Preserves all existing tenant_forms and leads rows; zero destructive changes.

CREATE INDEX IF NOT EXISTS tenant_forms_active_updated_idx ON tenant_forms(active, updated_at);
CREATE INDEX IF NOT EXISTS leads_form_id_idx ON leads(form_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_forms_active_published_slug_idx
  ON tenant_forms(json_extract(published_definition_json, '$.slug'))
  WHERE active = 1 AND published_definition_json IS NOT NULL;
