import { handle } from "@astrojs/cloudflare/handler";
import { isDcvPassThroughPath } from "@punyasitus/core";
import type { JobQueuePayload, PunyasitusEnv } from "./env.d.ts";
import { handleQueueBatch, handleScheduledTick } from "./handlers.ts";

// Durable Object class export (only handlers + DO classes may be exported by a Worker entrypoint)
export { TenantStore } from "./tenant-store.ts";

type AstroRequest = Parameters<typeof handle>[0];
type AstroEnv = Parameters<typeof handle>[1];
type AstroCtx = Parameters<typeof handle>[2];

export default {
  async fetch(
    request: Request,
    env: PunyasitusEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    // Step 0 (PLAN §3.3, ADR-0009): pass HTTP DCV paths through untouched before host/tenant checks.
    if (isDcvPassThroughPath(url.pathname)) {
      return fetch(request);
    }
    return handle(
      request as unknown as AstroRequest,
      env as unknown as AstroEnv,
      ctx as unknown as AstroCtx,
    );
  },

  async queue(batch: MessageBatch<JobQueuePayload>, env: PunyasitusEnv): Promise<void> {
    await handleQueueBatch(batch, env);
  },

  async scheduled(controller: ScheduledController, env: PunyasitusEnv): Promise<void> {
    await handleScheduledTick(controller, env);
  },
};
