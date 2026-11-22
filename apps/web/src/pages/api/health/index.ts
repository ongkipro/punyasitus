import type { APIRoute } from "astro";
import { handleLivenessProbe } from "./probe-helpers.ts";

export { handleLivenessProbe };

export const GET: APIRoute = async () => {
  return handleLivenessProbe();
};
