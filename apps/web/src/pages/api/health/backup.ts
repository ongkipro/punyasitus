import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleBackupHealthProbe } from "./probe-helpers.ts";

export { handleBackupHealthProbe };

export const GET: APIRoute = async () => {
  return handleBackupHealthProbe({
    backupBucket: env.BACKUP_BUCKET,
  });
};
