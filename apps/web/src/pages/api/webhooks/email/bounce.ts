import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS,
  handleEmailBounceWebhook,
  signEmailWebhookPayload,
  type HandleEmailBounceWebhookDeps,
  type SignEmailWebhookInput,
} from "./bounce-handler.ts";

export {
  DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS,
  handleEmailBounceWebhook,
  signEmailWebhookPayload,
  type HandleEmailBounceWebhookDeps,
  type SignEmailWebhookInput,
};

function readOptionalEnvString(key: string): string | undefined {
  const bag = env as unknown as Record<string, unknown>;
  const value = bag[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export const POST: APIRoute = async ({ request }) => {
  return handleEmailBounceWebhook(request, {
    db: env.PLATFORM_DB,
    secret: readOptionalEnvString("EMAIL_WEBHOOK_SECRET"),
    suppressionSalt: readOptionalEnvString("EMAIL_SUPPRESSION_SALT"),
  });
};
