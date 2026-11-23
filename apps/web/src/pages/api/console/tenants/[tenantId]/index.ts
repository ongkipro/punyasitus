import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleTenantsRuntimeEnv,
  handleConsoleTenantDetailRequest,
} from "../_shared.ts";

export const GET: APIRoute = ({ params, request }) =>
  handleConsoleTenantDetailRequest(params.tenantId ?? "", request, buildConsoleTenantsRuntimeEnv(env));
