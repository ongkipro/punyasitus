import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleRuntimeEnv,
  handleConsoleTenantStateRequest,
} from "../../provisioning/_shared.ts";

export const POST: APIRoute = ({ params, request }) =>
  handleConsoleTenantStateRequest(params.tenantId ?? "", request, buildConsoleRuntimeEnv(env));
