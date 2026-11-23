import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleOnboardingAiDraftRequest } from "./_ai-draft-handler.ts";
import { extractOnboardingEnvFromCloudflare } from "./_shared.ts";

export { handleOnboardingAiDraftRequest };

export const POST: APIRoute = ({ request, locals }) =>
  handleOnboardingAiDraftRequest(
    request,
    extractOnboardingEnvFromCloudflare(env as unknown as Record<string, unknown>),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    },
  );
