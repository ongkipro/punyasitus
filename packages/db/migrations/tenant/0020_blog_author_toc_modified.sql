-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0020_blog_author_toc_modified
-- Additive Blog Author Profiles (`role_title`), `content_modified_at` substantive fingerprint,
-- and index support for author/category blog lookups (REQ-092, PLAN §5.2 & §19.5, TASK-092).
-- Preserves all existing `authors` and `posts` rows from 0001_initial_tenant; zero destructive changes.

ALTER TABLE authors ADD COLUMN role_title TEXT;
ALTER TABLE posts ADD COLUMN content_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS posts_author_status_idx
  ON posts(author_id, status);

CREATE INDEX IF NOT EXISTS posts_primary_category_status_idx
  ON posts(primary_category_id, status, published_at);
