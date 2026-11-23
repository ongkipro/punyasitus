import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { buildConsoleRuntimeEnv, handleConsoleProvisioningRequest } from "./_shared.ts";

export const GET: APIRoute = ({ request }) =>
  handleConsoleProvisioningRequest(request, buildConsoleRuntimeEnv(env));

export const POST: APIRoute = ({ request }) =>
  handleConsoleProvisioningRequest(request, buildConsoleRuntimeEnv(env));
