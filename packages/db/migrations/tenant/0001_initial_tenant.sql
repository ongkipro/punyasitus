-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0001_initial_tenant
-- Additive initial schema pre-declaring finalized v1 per-tenant tables (PLAN §5.2, §7.1, ADR-0009).

-- ---------------------------------------------------------------------------
-- 1. Atomic Per-Tenant Sequential ID Allocator (PLAN §7.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sequences (
  kind TEXT PRIMARY KEY,
  next INTEGER NOT NULL DEFAULT 0 CHECK (next >= 0)
);

-- ---------------------------------------------------------------------------
-- 2. Site Identity, Business Profile, Branches & Theme Configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_title TEXT NOT NULL,
  tagline TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  locale TEXT NOT NULL DEFAULT 'id-ID',
  active_theme_id TEXT NOT NULL DEFAULT 'compro',
  favicon_media_id INTEGER,
  og_image_media_id INTEGER,
  blog_enabled INTEGER NOT NULL DEFAULT 1 CHECK (blog_enabled IN (0, 1)),
  catalog_enabled INTEGER NOT NULL DEFAULT 1 CHECK (catalog_enabled IN (0, 1)),
  ai_training_policy TEXT NOT NULL DEFAULT 'allow' CHECK (ai_training_policy IN ('allow', 'disallow')),
  analytics_config_json TEXT,
  analytics_risk_ack_at INTEGER,
  draft_json TEXT,
  published_json TEXT,
  published_at INTEGER,
  content_modified_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS business_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL,
  business_category TEXT NOT NULL DEFAULT 'LocalBusiness' CHECK (business_category != 'ProfessionalService'),
  description TEXT,
  address TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  latitude REAL,
  longitude REAL,
  maps_url TEXT,
  weekday_hours_json TEXT,
  holiday_hours_json TEXT,
  service_areas_json TEXT,
  whatsapp_e164 TEXT,
  phone TEXT,
  email TEXT,
  social_links_json TEXT,
  draft_json TEXT,
  published_json TEXT,
  published_at INTEGER,
  content_modified_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT,
  whatsapp_e164 TEXT,
  maps_url TEXT,
  latitude REAL,
  longitude REAL,
  weekday_hours_json TEXT,
  holiday_hours_json TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS theme_configs (
  theme_id TEXT PRIMARY KEY,
  tokens_json TEXT NOT NULL,
  variants_json TEXT NOT NULL,
  draft_json TEXT,
  published_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS menus (
  id INTEGER PRIMARY KEY,
  location TEXT NOT NULL UNIQUE CHECK (location IN ('header', 'footer', 'mobile')),
  items_json TEXT NOT NULL,
  draft_items_json TEXT,
  published_items_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 3. Media Library & Atomic Storage Usage Quota (REQ-010, REQ-062, REQ-064)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  r2_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  alt_text TEXT NOT NULL DEFAULT '',
  variants_json TEXT,
  duration_seconds REAL,
  poster_r2_key TEXT,
  captions_r2_key TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed', 'quarantined')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  quota_bytes INTEGER NOT NULL DEFAULT 104857600 CHECK (quota_bytes > 0),
  hourly_uploads INTEGER NOT NULL DEFAULT 0 CHECK (hourly_uploads >= 0),
  hourly_window_start INTEGER NOT NULL DEFAULT 0,
  daily_uploads INTEGER NOT NULL DEFAULT 0 CHECK (daily_uploads >= 0),
  daily_window_start INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 4. Pages, Authors, Taxonomies, Posts & Hybrid Offerings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  is_homepage INTEGER NOT NULL DEFAULT 0 CHECK (is_homepage IN (0, 1)),
  draft_sections_json TEXT NOT NULL DEFAULT '[]',
  published_sections_json TEXT,
  seo_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'trashed')),
  published_at INTEGER,
  content_modified_at INTEGER,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_single_homepage_idx
  ON pages(is_homepage)
  WHERE is_homepage = 1 AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  bio TEXT,
  avatar_media_id INTEGER REFERENCES media_items(id),
  social_url TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS taxonomies (
  id INTEGER PRIMARY KEY,
  taxonomy_type TEXT NOT NULL CHECK (taxonomy_type IN ('post_category', 'post_tag', 'offering_category')),
  offering_type TEXT CHECK (offering_type IS NULL OR offering_type IN ('service', 'product', 'tour', 'vehicle')),
  parent_id INTEGER REFERENCES taxonomies(id),
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0 AND depth <= 3),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (taxonomy_type, slug)
);
CREATE INDEX IF NOT EXISTS taxonomies_parent_idx ON taxonomies(parent_id);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT,
  draft_body_json TEXT NOT NULL,
  published_body_json TEXT,
  primary_category_id INTEGER REFERENCES taxonomies(id),
  author_id INTEGER REFERENCES authors(id),
  cover_media_id INTEGER REFERENCES media_items(id),
  reading_time_minutes INTEGER NOT NULL DEFAULT 1 CHECK (reading_time_minutes >= 1),
  show_toc INTEGER NOT NULL DEFAULT 0 CHECK (show_toc IN (0, 1)),
  seo_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'trashed')),
  published_at INTEGER,
  content_modified_at INTEGER,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_status_published_idx ON posts(status, published_at);

CREATE TABLE IF NOT EXISTS post_taxonomies (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  taxonomy_id INTEGER NOT NULL REFERENCES taxonomies(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, taxonomy_id)
);

CREATE TABLE IF NOT EXISTS offerings (
  id INTEGER PRIMARY KEY,
  offering_type TEXT NOT NULL CHECK (offering_type IN ('service', 'product', 'tour', 'vehicle')),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  description TEXT,
  cover_media_id INTEGER REFERENCES media_items(id),
  gallery_media_ids_json TEXT NOT NULL DEFAULT '[]',
  video_media_id INTEGER REFERENCES media_items(id),
  youtube_video_id TEXT,
  price_mode TEXT NOT NULL DEFAULT 'on_request' CHECK (price_mode IN ('fixed', 'from', 'range', 'on_request')),
  price INTEGER CHECK (price IS NULL OR (price >= 0 AND price <= 999999999999)),
  price_max INTEGER CHECK (price_max IS NULL OR (price_max >= 0 AND price_max <= 999999999999)),
  negotiable INTEGER NOT NULL DEFAULT 0 CHECK (negotiable IN (0, 1)),
  original_amount INTEGER CHECK (original_amount IS NULL OR (original_amount >= 0 AND original_amount <= 999999999999)),
  badge TEXT,
  cta_mode TEXT NOT NULL DEFAULT 'whatsapp' CHECK (cta_mode IN ('whatsapp', 'external_link', 'inquiry', 'book')),
  external_url TEXT,
  unit_status TEXT CHECK (unit_status IS NULL OR unit_status IN ('available', 'booked', 'sold')),
  attributes_version INTEGER NOT NULL DEFAULT 1,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  draft_snapshot_json TEXT,
  published_snapshot_json TEXT,
  seo_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'trashed')),
  published_at INTEGER,
  content_modified_at INTEGER,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (offering_type, slug)
);
CREATE INDEX IF NOT EXISTS offerings_type_status_idx ON offerings(offering_type, status);

CREATE TABLE IF NOT EXISTS offering_taxonomies (
  offering_id INTEGER NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  taxonomy_id INTEGER NOT NULL REFERENCES taxonomies(id) ON DELETE CASCADE,
  PRIMARY KEY (offering_id, taxonomy_id)
);

-- ---------------------------------------------------------------------------
-- 5. Former-Slug 308 Redirect Registry & Content Revisions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resource_slugs (
  namespace TEXT NOT NULL CHECK (
    namespace IN ('pages', 'blog', 'layanan', 'produk', 'tour', 'kendaraan', 'blog_category', 'blog_tag', 'offering_category')
  ),
  slug TEXT NOT NULL,
  resource_id INTEGER NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  redirect_target_slug TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, slug)
);
CREATE INDEX IF NOT EXISTS resource_slugs_resource_idx ON resource_slugs(namespace, resource_id);

CREATE TABLE IF NOT EXISTS content_revisions (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'post', 'offering')),
  resource_id INTEGER NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  snapshot_json TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_type, resource_id, revision_number)
);

-- ---------------------------------------------------------------------------
-- 6. Custom Forms & Leads (REQ-031..032, REQ-072, REQ-080, REQ-094)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_forms (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  after_submit_action TEXT NOT NULL CHECK (after_submit_action IN ('text', 'whatsapp', 'url')),
  after_submit_config_json TEXT NOT NULL,
  published_definition_json TEXT,
  published_version INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  form_id INTEGER REFERENCES tenant_forms(id),
  form_snapshot_json TEXT,
  name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  email TEXT,
  message TEXT NOT NULL,
  preferred_date TEXT,
  preferred_time TEXT CHECK (preferred_time IS NULL OR preferred_time IN ('pagi', 'siang', 'sore', 'malam')),
  branch_id INTEGER REFERENCES branches(id),
  source_category TEXT NOT NULL DEFAULT 'direct',
  utm_json TEXT,
  page_path TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  internal_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_status_created_idx ON leads(status, created_at);

CREATE TABLE IF NOT EXISTS lead_dedup (
  idempotency_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 7. Analytics, AI Writing Usage, Redirects, Rate Limits, Activity & Plugins
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0 CHECK (pageviews >= 0),
  unique_visitors INTEGER NOT NULL DEFAULT 0 CHECK (unique_visitors >= 0),
  wa_clicks INTEGER NOT NULL DEFAULT 0 CHECK (wa_clicks >= 0),
  external_clicks INTEGER NOT NULL DEFAULT 0 CHECK (external_clicks >= 0),
  lead_submits INTEGER NOT NULL DEFAULT 0 CHECK (lead_submits >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, path)
);

CREATE TABLE IF NOT EXISTS analytics_hourly_sources (
  hour_bucket TEXT NOT NULL,
  source_bucket TEXT NOT NULL CHECK (
    source_bucket IN ('direct', 'organic_search', 'social', 'referral', 'ai_assistant', 'campaign')
  ),
  utm_source TEXT NOT NULL DEFAULT '',
  visits INTEGER NOT NULL DEFAULT 0 CHECK (visits >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (hour_bucket, source_bucket, utm_source)
);

CREATE TABLE IF NOT EXISTS analytics_event_dedup (
  dedup_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS analytics_event_dedup_expires_idx ON analytics_event_dedup(expires_at);

CREATE TABLE IF NOT EXISTS ai_writing_usage (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_writing_usage_created_idx ON ai_writing_usage(created_at);

CREATE TABLE IF NOT EXISTS redirects (
  source_path TEXT PRIMARY KEY,
  target_path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 308 CHECK (status_code IN (301, 302, 307, 308)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS not_found_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day, path)
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tenant_activity_log_created_idx ON tenant_activity_log(created_at);

CREATE TABLE IF NOT EXISTS installed_plugins (
  plugin_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
