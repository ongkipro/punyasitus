# Blog Author Profiles, `content_modified_at` Discipline & Server-Rendered TOC API (`REQ-092`, `TASK-092`)

All endpoints below are tenant-scoped under the authenticated `app.punyasitus.com` surface, require live membership + RBAC (`content:read` for `GET`, `content:write` for mutations, `content:publish` for publication), enforce CSRF `Origin`/`Sec-Fetch-Site` validation on state-changing requests, reject cross-tenant access with neutral `404`, and return `Cache-Control: no-store`.

## 1. Tenant Author Profiles CRUD

Backed by `TenantStore.authors` with additive `role_title` (`0020_blog_author_toc_modified.sql`).

### `GET /api/tenants/:tenantId/posts/authors`
- **Permission:** `content:read` (`owner`, `admin`, `editor`)
- **Query:** `limit` (`1..100`, default `50`)
- **Response (`200`):**
  ```json
  {
    "items": [
      {
        "id": 1,
        "name": "Rina Kartika, S.Ars",
        "slug": "rina-kartika-s-ars",
        "roleTitle": "Principal Architect & Lead Auditor",
        "role_title": "Principal Architect & Lead Auditor",
        "bio": "12 tahun pengalaman audit gedung dan renovasi kantor B2B di Indonesia.",
        "avatarMediaId": 4,
        "avatar_media_id": 4,
        "avatar": {
          "id": 4,
          "url": "https://cdn.punyasitus.com/t/<tenantId>/media/4/w640.webp",
          "alt": "Foto profil Rina Kartika",
          "width": 640,
          "height": 640
        },
        "sameAs": ["https://linkedin.com/in/rinakartika"],
        "postCount": 3,
        "publishedPostCount": 2,
        "version": 1,
        "createdAt": "2026-11-23T10:00:00.000Z",
        "updatedAt": "2026-11-23T10:00:00.000Z"
      }
    ]
  }
  ```

### `POST /api/tenants/:tenantId/posts/authors`
- **Permission:** `content:write` (`owner`, `admin`, `editor`; blocked `403` when tenant is `locked`/`suspended`)
- **Body:** `{ name, roleTitle?, bio?, avatarMediaId?, sameAs?, slug? }` (`role_title` and `avatar_media_id` accepted as aliases)
- **Validation:**
  - `name`: required, `1..120` chars, XSS/control-char sanitized
  - `roleTitle`: optional, `<= 100` chars
  - `bio`: optional, `<= 300` chars
  - `avatarMediaId`: optional; verified against THIS tenant's `media_items` (`kind = 'image'`, `status = 'ready'`, `deleted_at IS NULL`, tenant R2 prefix)
  - `sameAs`: optional, up to `5` public HTTPS URLs
- **Response:** `201 Created` with the created author profile.

### `GET /api/tenants/:tenantId/posts/authors/:authorId`
- **Permission:** `content:read`
- **Response:** `200 OK` or `404 NOT_FOUND`.

### `PATCH /api/tenants/:tenantId/posts/authors/:authorId`
- **Permission:** `content:write`
- **Body:** `{ version, name?, roleTitle?, bio?, avatarMediaId?, sameAs?, slug? }`
- **Concurrency:** Optimistic locking via required `version`/`expectedVersion` (`409 STALE_VERSION` on mismatch).
- **Cache Invalidation:** Atomically increments `PLATFORM_DB.tenants.cache_version` and returns `cacheVersion` so public blog bylines and `Article.author` JSON-LD reflect updates immediately.
- **Response:** `200 OK`.

### `DELETE /api/tenants/:tenantId/posts/authors/:authorId`
- **Permission:** `content:write`
- **Body / Query:** `{ version, detach?: boolean, reassignToAuthorId?: number }` (`version`/`expectedVersion` is **required** via JSON body or `?version=N` query param; `422 REQUIRED` if omitted, `409 STALE_VERSION` on mismatch).
- **Guarded Delete:** Returns `409 CONFLICT` (`reason: "AUTHOR_IN_USE"`) if referenced by non-trashed posts unless `detach: true` or `reassignToAuthorId` is provided.
- **Cache Invalidation:** Increments `PLATFORM_DB.tenants.cache_version` so detached/reassigned author bylines invalidate public caches immediately.
- **Response:** `204 No Content`.

## 2. Blog Posts Extensions (`authorProfileId`, `tocEnabled`, `contentModifiedAt`)

- `POST /api/tenants/:tenantId/posts` and `PATCH /api/tenants/:tenantId/posts/:postId` accept:
  - `authorId` / `authorProfileId` (verified against `TenantStore.authors`)
  - `enableToc` / `showToc` / `tocEnabled` (boolean toggle for server-rendered zero-JS H2/H3 TOC)
  - `primaryCategoryId`, `categoryIds` (categories enforce `<= 3` nesting depth), `tagIds`
- `POST /api/tenants/:tenantId/posts/:postId/publish` enforces strict `content_modified_at` discipline:
  - Computes a deterministic SHA-256 substantive content fingerprint (`title`, `excerpt`, body blocks + sanitized HTML, cover media, author, primary category/categories/tags, TOC toggle, SEO content overrides).
  - Draft autosaves, analytics ticks, view counters, and unrelated settings changes **never** advance `content_modified_at` or sitemap `<lastmod>`.
  - Republishing unchanged substantive content preserves the existing `content_modified_at` (`substantiveChanged: false`).
  - Substantive published edits advance `content_modified_at` (`substantiveChanged: true`), propagating identically to the post response, public `/blog/[slug]` (`Diperbarui ...`), `Article.dateModified` JSON-LD, and `/sitemap.xml` `<lastmod>`.

## 3. Public `/blog/[slug]` Parity & Zero-JS Server-Rendered TOC

- Visible author byline (`name`, `roleTitle`, `bio`, `avatar`, `sameAs`) and `BlogPosting`/`Article` JSON-LD `author` (`Person` with `name`, `jobTitle`, `description`, `image`, `sameAs`) are generated from the same resolved author model.
- Reading-time estimate (`~200 wpm`, minimum `1` minute) and H2/H3 TOC extraction/anchor `id` injection execute server-side in linear `O(n)` time (zero ReDoS) and render `<nav aria-label="Daftar Isi">` anchor links with **zero client JavaScript**.
