import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Tier 2 — `TenantStore` (Per-Tenant SQLite Durable Object) Drizzle SQLite schema.
 * Pre-declares the finalized v1 per-tenant tables (PLAN §5.2, §7.1, ADR-0009).
 */

// ---------------------------------------------------------------------------
// 1. Atomic Per-Tenant Sequential ID Allocator (PLAN §7.1)
// ---------------------------------------------------------------------------
export const sequences = sqliteTable("sequences", {
  kind: text("kind").primaryKey(),
  next: integer("next").notNull().default(0),
});

// ---------------------------------------------------------------------------
// 2. Site Identity, Business Profile, Branches, Theme Configs & Menus
// ---------------------------------------------------------------------------
export const siteSettings = sqliteTable("site_settings", {
  id: integer("id").primaryKey(),
  siteTitle: text("site_title").notNull(),
  tagline: text("tagline"),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  locale: text("locale").notNull().default("id-ID"),
  activeThemeId: text("active_theme_id").notNull().default("compro"),
  faviconMediaId: integer("favicon_media_id"),
  ogImageMediaId: integer("og_image_media_id"),
  blogEnabled: integer("blog_enabled", { mode: "boolean" }).notNull().default(true),
  catalogEnabled: integer("catalog_enabled", { mode: "boolean" }).notNull().default(true),
  aiTrainingPolicy: text("ai_training_policy", { enum: ["allow", "disallow"] })
    .notNull()
    .default("allow"),
  analyticsConfigJson: text("analytics_config_json"),
  analyticsRiskAckAt: integer("analytics_risk_ack_at", { mode: "timestamp_ms" }),
  draftJson: text("draft_json"),
  publishedJson: text("published_json"),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  contentModifiedAt: integer("content_modified_at", { mode: "timestamp_ms" }),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const businessProfile = sqliteTable("business_profile", {
  id: integer("id").primaryKey(),
  businessName: text("business_name").notNull(),
  businessCategory: text("business_category").notNull().default("LocalBusiness"),
  description: text("description"),
  address: text("address"),
  city: text("city"),
  province: text("province"),
  postalCode: text("postal_code"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  mapsUrl: text("maps_url"),
  weekdayHoursJson: text("weekday_hours_json"),
  holidayHoursJson: text("holiday_hours_json"),
  serviceAreasJson: text("service_areas_json"),
  whatsappE164: text("whatsapp_e164"),
  phone: text("phone"),
  email: text("email"),
  socialLinksJson: text("social_links_json"),
  draftJson: text("draft_json"),
  publishedJson: text("published_json"),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  contentModifiedAt: integer("content_modified_at", { mode: "timestamp_ms" }),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const branches = sqliteTable("branches", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  phone: text("phone"),
  whatsappE164: text("whatsapp_e164"),
  mapsUrl: text("maps_url"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  weekdayHoursJson: text("weekday_hours_json"),
  holidayHoursJson: text("holiday_hours_json"),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const themeConfigs = sqliteTable("theme_configs", {
  themeId: text("theme_id").primaryKey(),
  tokensJson: text("tokens_json").notNull(),
  variantsJson: text("variants_json").notNull(),
  draftJson: text("draft_json"),
  publishedJson: text("published_json"),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const menus = sqliteTable("menus", {
  id: integer("id").primaryKey(),
  location: text("location", { enum: ["header", "footer", "mobile"] }).notNull().unique(),
  itemsJson: text("items_json").notNull(),
  draftItemsJson: text("draft_items_json"),
  publishedItemsJson: text("published_items_json"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------------------------------------------------------------------------
// 3. Media Library & Atomic Storage Usage Quota
// ---------------------------------------------------------------------------
export const mediaItems = sqliteTable("media_items", {
  id: integer("id").primaryKey(),
  kind: text("kind", { enum: ["image", "video"] }).notNull(),
  r2Key: text("r2_key").notNull().unique(),
  mimeType: text("mime_type").notNull(),
  bytes: integer("bytes").notNull(),
  sha256: text("sha256").notNull(),
  width: integer("width"),
  height: integer("height"),
  altText: text("alt_text").notNull().default(""),
  variantsJson: text("variants_json"),
  durationSeconds: real("duration_seconds"),
  posterR2Key: text("poster_r2_key"),
  captionsR2Key: text("captions_r2_key"),
  status: text("status", { enum: ["processing", "ready", "failed", "quarantined"] })
    .notNull()
    .default("ready"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const storageUsage = sqliteTable("storage_usage", {
  id: integer("id").primaryKey(),
  usedBytes: integer("used_bytes").notNull().default(0),
  quotaBytes: integer("quota_bytes").notNull().default(104_857_600),
  hourlyUploads: integer("hourly_uploads").notNull().default(0),
  hourlyWindowStart: integer("hourly_window_start").notNull().default(0),
  dailyUploads: integer("daily_uploads").notNull().default(0),
  dailyWindowStart: integer("daily_window_start").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------------------------------------------------------------------------
// 4. Pages, Authors, Taxonomies, Posts & Offerings
// ---------------------------------------------------------------------------
export const pages = sqliteTable(
  "pages",
  {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    isHomepage: integer("is_homepage", { mode: "boolean" }).notNull().default(false),
    draftSectionsJson: text("draft_sections_json").notNull().default("[]"),
    publishedSectionsJson: text("published_sections_json"),
    seoJson: text("seo_json"),
    status: text("status", { enum: ["draft", "published", "trashed"] })
      .notNull()
      .default("draft"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    contentModifiedAt: integer("content_modified_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("pages_single_homepage_idx")
      .on(t.isHomepage)
      .where(sql`${t.isHomepage} = 1 AND ${t.deletedAt} IS NULL`),
  ],
);

export const authors = sqliteTable("authors", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  bio: text("bio"),
  avatarMediaId: integer("avatar_media_id").references(() => mediaItems.id),
  socialUrl: text("social_url"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const taxonomies = sqliteTable(
  "taxonomies",
  {
    id: integer("id").primaryKey(),
    taxonomyType: text("taxonomy_type", {
      enum: ["post_category", "post_tag", "offering_category"],
    }).notNull(),
    offeringType: text("offering_type", {
      enum: ["service", "product", "tour", "vehicle"],
    }),
    parentId: integer("parent_id"),
    depth: integer("depth").notNull().default(0),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("taxonomies_parent_idx").on(t.parentId),
    uniqueIndex("taxonomies_type_slug_uidx").on(t.taxonomyType, t.slug),
  ],
);

export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    draftBodyJson: text("draft_body_json").notNull(),
    publishedBodyJson: text("published_body_json"),
    primaryCategoryId: integer("primary_category_id").references(() => taxonomies.id),
    authorId: integer("author_id").references(() => authors.id),
    coverMediaId: integer("cover_media_id").references(() => mediaItems.id),
    readingTimeMinutes: integer("reading_time_minutes").notNull().default(1),
    showToc: integer("show_toc", { mode: "boolean" }).notNull().default(false),
    seoJson: text("seo_json"),
    status: text("status", { enum: ["draft", "published", "trashed"] })
      .notNull()
      .default("draft"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    contentModifiedAt: integer("content_modified_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("posts_status_published_idx").on(t.status, t.publishedAt)],
);

export const postTaxonomies = sqliteTable(
  "post_taxonomies",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    taxonomyId: integer("taxonomy_id")
      .notNull()
      .references(() => taxonomies.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.postId, t.taxonomyId] })],
);

export const offerings = sqliteTable(
  "offerings",
  {
    id: integer("id").primaryKey(),
    offeringType: text("offering_type", {
      enum: ["service", "product", "tour", "vehicle"],
    }).notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    description: text("description"),
    coverMediaId: integer("cover_media_id").references(() => mediaItems.id),
    galleryMediaIdsJson: text("gallery_media_ids_json").notNull().default("[]"),
    videoMediaId: integer("video_media_id").references(() => mediaItems.id),
    youtubeVideoId: text("youtube_video_id"),
    priceMode: text("price_mode", {
      enum: ["fixed", "from", "range", "on_request"],
    })
      .notNull()
      .default("on_request"),
    price: integer("price"),
    priceMax: integer("price_max"),
    negotiable: integer("negotiable", { mode: "boolean" }).notNull().default(false),
    originalAmount: integer("original_amount"),
    badge: text("badge"),
    ctaMode: text("cta_mode", {
      enum: ["whatsapp", "external_link", "inquiry", "book"],
    })
      .notNull()
      .default("whatsapp"),
    externalUrl: text("external_url"),
    unitStatus: text("unit_status", { enum: ["available", "booked", "sold"] }),
    attributesVersion: integer("attributes_version").notNull().default(1),
    attributesJson: text("attributes_json").notNull().default("{}"),
    draftSnapshotJson: text("draft_snapshot_json"),
    publishedSnapshotJson: text("published_snapshot_json"),
    seoJson: text("seo_json"),
    status: text("status", { enum: ["draft", "published", "trashed"] })
      .notNull()
      .default("draft"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    contentModifiedAt: integer("content_modified_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("offerings_type_status_idx").on(t.offeringType, t.status),
    uniqueIndex("offerings_type_slug_uidx").on(t.offeringType, t.slug),
  ],
);

export const offeringTaxonomies = sqliteTable(
  "offering_taxonomies",
  {
    offeringId: integer("offering_id")
      .notNull()
      .references(() => offerings.id, { onDelete: "cascade" }),
    taxonomyId: integer("taxonomy_id")
      .notNull()
      .references(() => taxonomies.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.offeringId, t.taxonomyId] })],
);

// ---------------------------------------------------------------------------
// 5. Former-Slug 308 Registry & Content Revisions
// ---------------------------------------------------------------------------
export const resourceSlugs = sqliteTable(
  "resource_slugs",
  {
    namespace: text("namespace", {
      enum: [
        "pages",
        "blog",
        "layanan",
        "produk",
        "tour",
        "kendaraan",
        "blog_category",
        "blog_tag",
        "offering_category",
      ],
    }).notNull(),
    slug: text("slug").notNull(),
    resourceId: integer("resource_id").notNull(),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
    redirectTargetSlug: text("redirect_target_slug"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.slug] }),
    index("resource_slugs_resource_idx").on(t.namespace, t.resourceId),
  ],
);

export const contentRevisions = sqliteTable(
  "content_revisions",
  {
    resourceType: text("resource_type", { enum: ["page", "post", "offering"] }).notNull(),
    resourceId: integer("resource_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.resourceType, t.resourceId, t.revisionNumber] })],
);

// ---------------------------------------------------------------------------
// 6. Custom Forms & Leads
// ---------------------------------------------------------------------------
export const tenantForms = sqliteTable("tenant_forms", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  fieldsJson: text("fields_json").notNull(),
  afterSubmitAction: text("after_submit_action", {
    enum: ["text", "whatsapp", "url"],
  }).notNull(),
  afterSubmitConfigJson: text("after_submit_config_json").notNull(),
  publishedDefinitionJson: text("published_definition_json"),
  publishedVersion: integer("published_version").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey(),
    formId: integer("form_id").references(() => tenantForms.id),
    formSnapshotJson: text("form_snapshot_json"),
    name: text("name").notNull(),
    phoneE164: text("phone_e164").notNull(),
    email: text("email"),
    message: text("message").notNull(),
    preferredDate: text("preferred_date"),
    preferredTime: text("preferred_time", { enum: ["pagi", "siang", "sore", "malam"] }),
    branchId: integer("branch_id").references(() => branches.id),
    sourceCategory: text("source_category").notNull().default("direct"),
    utmJson: text("utm_json"),
    pagePath: text("page_path"),
    status: text("status", { enum: ["new", "contacted", "closed"] })
      .notNull()
      .default("new"),
    internalNotes: text("internal_notes"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("leads_status_created_idx").on(t.status, t.createdAt)],
);

export const leadDedup = sqliteTable("lead_dedup", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  payloadHash: text("payload_hash").notNull(),
  leadId: integer("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------------------------------------------------------------------------
// 7. Analytics, AI Writing Usage, Redirects, Rate Limits, Activity & Plugins
// ---------------------------------------------------------------------------
export const analyticsDaily = sqliteTable(
  "analytics_daily",
  {
    day: text("day").notNull(),
    path: text("path").notNull(),
    pageviews: integer("pageviews").notNull().default(0),
    uniqueVisitors: integer("unique_visitors").notNull().default(0),
    waClicks: integer("wa_clicks").notNull().default(0),
    externalClicks: integer("external_clicks").notNull().default(0),
    leadSubmits: integer("lead_submits").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.path] })],
);

export const analyticsHourlySources = sqliteTable(
  "analytics_hourly_sources",
  {
    hourBucket: text("hour_bucket").notNull(),
    sourceBucket: text("source_bucket", {
      enum: ["direct", "organic_search", "social", "referral", "ai_assistant", "campaign"],
    }).notNull(),
    utmSource: text("utm_source").notNull().default(""),
    visits: integer("visits").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.hourBucket, t.sourceBucket, t.utmSource] })],
);

export const analyticsEventDedup = sqliteTable(
  "analytics_event_dedup",
  {
    dedupKey: text("dedup_key").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("analytics_event_dedup_expires_idx").on(t.expiresAt)],
);

export const aiWritingUsage = sqliteTable(
  "ai_writing_usage",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    feature: text("feature").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("ai_writing_usage_created_idx").on(t.createdAt)],
);

export const redirects = sqliteTable("redirects", {
  sourcePath: text("source_path").primaryKey(),
  targetPath: text("target_path").notNull(),
  statusCode: integer("status_code").notNull().default(308),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const notFoundDaily = sqliteTable(
  "not_found_daily",
  {
    day: text("day").notNull(),
    path: text("path").notNull(),
    hits: integer("hits").notNull().default(0),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.path] })],
);

export const rateLimitBuckets = sqliteTable("rate_limit_buckets", {
  bucketKey: text("bucket_key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const tenantActivityLog = sqliteTable(
  "tenant_activity_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorUserId: text("actor_user_id"),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    summary: text("summary").notNull(),
    metadataJson: text("metadata_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("tenant_activity_log_created_idx").on(t.createdAt)],
);

export const installedPlugins = sqliteTable("installed_plugins", {
  pluginId: text("plugin_id").primaryKey(),
  version: text("version").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  configJson: text("config_json").notNull().default("{}"),
  schemaVersion: integer("schema_version").notNull().default(0),
  installedAt: integer("installed_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const tenantSchema = {
  sequences,
  siteSettings,
  businessProfile,
  branches,
  themeConfigs,
  menus,
  mediaItems,
  storageUsage,
  pages,
  authors,
  taxonomies,
  posts,
  postTaxonomies,
  offerings,
  offeringTaxonomies,
  resourceSlugs,
  contentRevisions,
  tenantForms,
  leads,
  leadDedup,
  analyticsDaily,
  analyticsHourlySources,
  analyticsEventDedup,
  aiWritingUsage,
  redirects,
  notFoundDaily,
  rateLimitBuckets,
  tenantActivityLog,
  installedPlugins,
} as const;

export type TenantSchema = typeof tenantSchema;
