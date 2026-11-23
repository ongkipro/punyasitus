# Content Revision History API Contract (`TASK-064` / `REQ-048`)

> Canonical contract for bounded per-resource content revision history and safe draft-only restoration across **Pages** (`page`), **Blog Posts** (`post`), and **Catalog Offerings** (`offering`).
>
> **Surface:** `app.punyasitus.com` only (`404` on tenant, marketing, and console hosts).
> **Cache policy:** `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`.

---

## Core Invariants

1. **Latest-20 Retention (`MAX_CONTENT_REVISIONS_PER_RESOURCE = 20`):**
   Every save (`create` / `update`), `publish`, and `restore` of a `page`, `post`, or `offering` records a schema-versioned (`schemaVersion = 1`) revision snapshot inside the tenant's physically isolated `TenantStore` SQLite Durable Object and atomically prunes older revisions beyond the latest **20** per `(resource_type, resource_id)`.
2. **Draft-Only Restore (Zero Public Side Effects):**
   `POST /api/tenants/:tenantId/revisions/:revisionId/restore` writes **strictly to draft state**. Live `published_sections_json`, `published_body_json`, `published_snapshot_json`, `published_at`, `content_modified_at`, and `PLATFORM_DB.tenants.cache_version` remain **100% untouched** until an authorized member explicitly clicks **Terbitkan (Publish)**.
3. **No PII / Secrets in Snapshots:**
   Revisions store only validated editorial content snapshots (`page`, `post`, `offering`). Lead data, credentials, tokens, and full user records are never persisted in `content_revisions`.
4. **Hard-Purge Cleanup:**
   Permanently purging a trashed resource (manual or 30-day scheduled expiry via `TASK-044`) atomically removes all associated `content_revisions` rows for `(resource_type, resource_id)` while preserving shared `media_items`.
5. **Tenant Isolation, CSRF, RBAC & Lifecycle Enforcement:**
   - Unauthenticated requests: `401 UNAUTHENTICATED`
   - Cross-tenant list/read/restore: `404 NOT_FOUND`
   - Missing or mismatched `Origin`/CSRF on `POST`: `403 FORBIDDEN`
   - Insufficient RBAC (`content:write` required for restore): `403 FORBIDDEN`
   - Tenant in `locked` or `suspended` lifecycle state on restore: `403 SUBSCRIPTION_LOCKED`

---

## Revision Identifier Format

Each revision has a deterministic tenant-scoped identifier:

```
{resourceType}-{resourceId}-{revisionNumber}
```

Examples: `page-12-5`, `post-7-14`, `offering-3-2` (colon separators `page:12:5` are also accepted on input and normalized to hyphenated form).

---

## Endpoints

### 1. List Latest Revisions for a Resource

`GET /api/tenants/{tenantId}/revisions?resourceType={page|post|offering}&resourceId={id}&limit={1..20}`

- **Permission:** `content:read` (`owner`, `admin`, `editor`)
- **Query Parameters:**
  - `resourceType` (required): `"page" | "post" | "offering"`
  - `resourceId` (required): positive sequential integer ID
  - `limit` (optional): integer `1..20` (default `20`)

#### Response `200 OK`

```json
{
  "items": [
    {
      "id": "page-12-5",
      "revisionId": "page-12-5",
      "resourceType": "page",
      "resourceId": 12,
      "revisionNumber": 5,
      "schemaVersion": 1,
      "triggerKind": "save",
      "actorUserId": "usr_01...",
      "summary": "Simpan draf \"Tentang Kami\" (/tentang)",
      "title": "Tentang Kami",
      "slug": "tentang",
      "createdAt": "2026-11-23T08:15:00.000Z"
    }
  ],
  "resourceType": "page",
  "resourceId": 12,
  "currentVersion": 6,
  "resourceStatus": "published",
  "maxRetained": 20
}
```

#### Errors
- `401 UNAUTHENTICATED`
- `403 SUBSCRIPTION_LOCKED` (suspended tenant)
- `404 NOT_FOUND` (cross-tenant handle/ID or nonexistent resource)
- `422 VALIDATION_ERROR` (invalid `resourceType`, `resourceId`, or `limit`)

---

### 2. Inspect Single Revision & Reference Health

`GET /api/tenants/{tenantId}/revisions/{revisionId}`

- **Permission:** `content:read`

#### Response `200 OK`

```json
{
  "id": "post-7-3",
  "revisionId": "post-7-3",
  "resourceType": "post",
  "resourceId": 7,
  "revisionNumber": 3,
  "schemaVersion": 1,
  "triggerKind": "publish",
  "actorUserId": "usr_01...",
  "summary": "Terbitkan \"Panduan Layanan\" (/blog/panduan-layanan)",
  "title": "Panduan Layanan",
  "slug": "panduan-layanan",
  "createdAt": "2026-11-23T07:00:00.000Z",
  "currentVersion": 5,
  "resourceStatus": "published",
  "snapshot": { "...": "validated resource snapshot data" },
  "referenceReport": {
    "referencedMediaIds": [101, 205],
    "validMediaIds": [101],
    "missingMediaIds": [205],
    "trashedMediaIds": [],
    "unavailableMediaIds": [],
    "detachedMediaIds": [205],
    "missingTaxonomyIds": [],
    "missingAuthorId": null,
    "warnings": [
      {
        "kind": "media",
        "id": 205,
        "status": "missing",
        "field": "media",
        "message": "Media #205 tidak ditemukan di pustaka media situs ini dan telah dilepaskan dari draf."
      }
    ]
  }
}
```

#### Errors
- `404 NOT_FOUND` (unknown/malformed `revisionId` or cross-tenant access)
- `422 VALIDATION_ERROR` (corrupted snapshot JSON or unsupported `schemaVersion`)

---

### 3. Restore Revision as Draft Only

`POST /api/tenants/{tenantId}/revisions/{revisionId}/restore`

- **Permission:** `content:write` (`owner`, `admin`, `editor`; denied on `locked`/`suspended` tenants)
- **Headers:** Same-origin `Origin` header required (admin CSRF protection)

#### Request Body

```json
{
  "expectedVersion": 5,
  "detachMissingReferences": true
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `expectedVersion` (or `version`) | integer `>= 1` | **Yes** | Current resource `version` for optimistic concurrency control (`409 STALE_VERSION` on mismatch). |
| `detachMissingReferences` | boolean | No (default `true`) | When `true`, deleted/missing media, taxonomy, or author IDs are safely detached and returned in `warnings`. When `false`, missing references fail with `422`. |

> Forbidden tenant-selector keys (`tenantId`, `organizationId`, `tenant_id`, etc.) and unknown fields are strictly rejected with `422 VALIDATION_ERROR`.

#### Response `200 OK`

```json
{
  "restored": true,
  "revisionId": "post-7-6",
  "resourceType": "post",
  "resourceId": 7,
  "restoredFromRevisionNumber": 3,
  "newRevisionNumber": 6,
  "version": 6,
  "status": "published",
  "draftOnly": true,
  "hasUnpublishedChanges": true,
  "referenceReport": {
    "referencedMediaIds": [101, 205],
    "validMediaIds": [101],
    "missingMediaIds": [205],
    "trashedMediaIds": [],
    "unavailableMediaIds": [],
    "detachedMediaIds": [205],
    "missingTaxonomyIds": [],
    "missingAuthorId": null,
    "warnings": [
      {
        "kind": "media",
        "id": 205,
        "status": "missing",
        "field": "media",
        "message": "Media #205 tidak ditemukan di pustaka media situs ini dan telah dilepaskan dari draf."
      }
    ]
  },
  "warnings": [
    {
      "kind": "media",
      "id": 205,
      "status": "missing",
      "field": "media",
      "message": "Media #205 tidak ditemukan di pustaka media situs ini dan telah dilepaskan dari draf."
    }
  ],
  "restoredAt": "2026-11-23T09:00:00.000Z",
  "resource": { "...": "updated draft resource DTO" }
}
```

#### Errors
- `401 UNAUTHENTICATED` — missing/expired session
- `403 FORBIDDEN` — failed CSRF/Origin or missing `content:write`
- `403 SUBSCRIPTION_LOCKED` — tenant is `locked` or `suspended`
- `404 NOT_FOUND` — cross-tenant request, missing resource, or missing revision
- `409 STALE_VERSION` — `expectedVersion` does not match the live resource version (no writes occurred)
- `409 CONFLICT` — target resource is currently in Trash (`RESOURCE_TRASHED`; restore from Sampah first)
- `422 VALIDATION_ERROR` — unsupported snapshot `schemaVersion` (`UNSUPPORTED_REVISION_SCHEMA`), corrupted snapshot JSON, forbidden tenant selector, unknown field, or missing references when `detachMissingReferences: false`
