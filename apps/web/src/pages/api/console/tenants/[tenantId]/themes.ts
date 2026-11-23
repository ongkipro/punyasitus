import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleTenantsRuntimeEnv,
  handleConsoleTenantThemesRequest,
} from "../_shared.ts";

export const GET: APIRoute = ({ params, request }) =>
  handleConsoleTenantThemesRequest(params.tenantId ?? "", request, buildConsoleTenantsRuntimeEnv(env));

export const POST: APIRoute = ({ params, request }) =>
  handleConsoleTenantThemesRequest(params.tenantId ?? "", request, buildConsoleTenantsRuntimeEnv(env));
