import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleTenantsRuntimeEnv,
  handleConsoleTenantsCollectionRequest,
} from "./_shared.ts";

export const GET: APIRoute = ({ request }) =>
  handleConsoleTenantsCollectionRequest(request, buildConsoleTenantsRuntimeEnv(env));

export const POST: APIRoute = ({ request }) =>
  handleConsoleTenantsCollectionRequest(request, buildConsoleTenantsRuntimeEnv(env));
