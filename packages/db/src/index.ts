export * from "./connections/index.ts";
export {
  PLATFORM_MIGRATIONS,
  LATEST_PLATFORM_SCHEMA_VERSION,
} from "./platform/migrations.ts";
export {
  CrossTenantAccessError,
  createTenantScopedPlatformRepo,
  resolveHostRecord,
  type TenantScope,
} from "./platform/repositories.ts";
export { platformSchema, type PlatformSchema } from "./platform/schema.ts";
export {
  TENANT_MIGRATIONS,
  LATEST_TENANT_SCHEMA_VERSION,
} from "./tenant/migrations.ts";
export { tenantSchema, type TenantSchema } from "./tenant/schema.ts";
