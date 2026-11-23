import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleTenantsRuntimeEnv,
  handleConsoleTenantStateActionRequest,
} from "../_shared.ts";

export const POST: APIRoute = ({ params, request }) =>
  handleConsoleTenantStateActionRequest(
    params.tenantId ?? "",
    request,
    buildConsoleTenantsRuntimeEnv(env),
  );
