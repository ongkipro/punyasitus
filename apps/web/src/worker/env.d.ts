import type { TenantStore } from "./tenant-store.ts";

export interface JobQueuePayload {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly payload?: Record<string, unknown>;
}

export interface PunyasitusEnv {
  readonly APP_ENV: string;
  readonly PLATFORM_DOMAIN: string;
  readonly SAAS_ZONE: string;
  readonly ASSETS: Fetcher;
  readonly PLATFORM_DB: D1Database;
  readonly TENANT_STORE: DurableObjectNamespace<TenantStore>;
  readonly MEDIA_BUCKET: R2Bucket;
  readonly BACKUP_BUCKET: R2Bucket;
  readonly IMAGES: unknown;
  readonly JOBS_QUEUE: Queue<JobQueuePayload>;
  readonly AI: unknown;
  readonly EMAIL: {
    send(message: unknown): Promise<void>;
  };
}

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends PunyasitusEnv {}
  }
}

declare module "cloudflare:workers" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends PunyasitusEnv {}
}
