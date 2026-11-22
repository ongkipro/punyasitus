import { classifySurfaceHost, isDcvPassThroughPath } from "@punyasitus/core";
import type { JobQueuePayload, PunyasitusEnv } from "../../apps/web/src/worker/env.d.ts";
import { handleQueueBatch, handleScheduledTick } from "../../apps/web/src/worker/handlers.ts";

export { TenantStore } from "../../apps/web/src/worker/tenant-store.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (isDcvPassThroughPath(url.pathname)) {
      return new Response("dcv-pass-through", {
        status: 200,
        headers: { "X-DCV-Pass-Through": "1" },
      });
    }
    const rawHost = request.headers.get("host") ?? url.host;
    const classified = classifySurfaceHost(rawHost);
    const status = classified.surface === "unknown" ? 404 : 200;
    return Response.json(classified, {
      status,
      headers: {
        "X-PunyaSitus-Surface": classified.surface,
        ...(classified.surface === "app" || classified.surface === "console" || status === 404
          ? { "X-Robots-Tag": "noindex, nofollow" }
          : {}),
      },
    });
  },

  async queue(batch: MessageBatch<JobQueuePayload>, env: PunyasitusEnv): Promise<void> {
    await handleQueueBatch(batch, env);
  },

  async scheduled(controller: ScheduledController, env: PunyasitusEnv): Promise<void> {
    await handleScheduledTick(controller, env);
  },
};
