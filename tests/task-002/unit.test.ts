import {
  computeEffectiveTenantStatus,
  MAX_HOST_CACHE_TTL_MS,
  MOVED_HOST_QUARANTINE_MS,
} from "@punyasitus/db/routing/index";
import { describe, expect, it } from "vitest";
import {
  buildTenantEdgeCacheKey,
  createStatePageResponse,
  evaluateRequestGate,
  sanitizeTenantResponseHeaders,
  STATE_PAGE_MESSAGES,
} from "../../apps/web/src/core/tenant.ts";

describe("TASK-002 unit tests — lifecycle status, cache keys, neutral state pages, cookie isolation", () => {
  it("computes effective tenant lifecycle status per PLAN §17.1 precedence", () => {
    const base = 1_800_000_000_000;
    const hour = 60 * 60 * 1000;

    // Terminal/provisioning states never resurrect even with operatorHold
    for (const status of ["provisioning", "purging", "purged"] as const) {
      expect(
        computeEffectiveTenantStatus(
          { storedStatus: status, operatorHold: true, trialEndsAt: null, paidThrough: base + 1000 },
          base,
        ),
      ).toBe(status);
    }

    // Operator hold overrides active/grace/locked/trial to suspended
    expect(
      computeEffectiveTenantStatus(
        { storedStatus: "active", operatorHold: true, trialEndsAt: null, paidThrough: base + 1000 },
        base,
      ),
    ).toBe("suspended");

    // Recovery and suspended persist
    expect(
      computeEffectiveTenantStatus(
        { storedStatus: "recovery", operatorHold: false, trialEndsAt: null, paidThrough: null },
        base,
      ),
    ).toBe("recovery");

    // Trial deadline boundary
    expect(
      computeEffectiveTenantStatus(
        { storedStatus: "trial", operatorHold: false, trialEndsAt: base + 1000, paidThrough: null },
        base,
      ),
    ).toBe("trial");
    expect(
      computeEffectiveTenantStatus(
        { storedStatus: "trial", operatorHold: false, trialEndsAt: base, paidThrough: null },
        base,
      ),
    ).toBe("suspended");

    // Paid -> grace (H+1..H+3) -> locked (H+4..H+7) -> suspended (H+8+)
    const paidThrough = base;
    expect(
      computeEffectiveTenantStatus(
        { storedStatus: "active", operatorHold: false, trialEndsAt: null, paidThrough },
        paidThrough - 1,
      ),
    ).toBe("active");
    expect(
      computeEffectiveTenantStatus(
        { storedStatus: "active", operatorHold: false, trialEndsAt: null, paidThrough },
        paidThrough + 10 * hour,
      ),
    ).toBe("grace");
    expect(
      computeEffectiveTenantStatus(
        { storedStatus: "active", operatorHold: false, trialEndsAt: null, paidThrough },
        paidThrough + 72 * hour,
      ),
    ).toBe("locked");
    expect(
      computeEffectiveTenantStatus(
        { storedStatus: "active", operatorHold: false, trialEndsAt: null, paidThrough },
        paidThrough + 168 * hour,
      ),
    ).toBe("suspended");
  });

  it("enforces cache TTL and quarantine constants and canonical edge cache keys", () => {
    expect(MAX_HOST_CACHE_TTL_MS).toBe(5_000);
    expect(MOVED_HOST_QUARANTINE_MS).toBe(60_000);

    expect(
      buildTenantEdgeCacheKey("01JTESTTENANTALPHA00000001", 3, "alpha-studio.situsku.click", "/layanan"),
    ).toBe("https://cache.punyasitus.com/t/01JTESTTENANTALPHA00000001/v3/alpha-studio.situsku.click/layanan");

    expect(
      buildTenantEdgeCacheKey("01JTESTTENANTALPHA00000001", 4, "www.alpha.id", "produk"),
    ).toBe("https://cache.punyasitus.com/t/01JTESTTENANTALPHA00000001/v4/www.alpha.id/produk");
  });

  it("builds neutral HTML and JSON state pages with restrictive headers and zero leaks", async () => {
    const html404 = createStatePageResponse("not_found", { pathname: "/profil", surface: "unknown" });
    expect(html404.status).toBe(404);
    expect(html404.headers.get("Cache-Control")).toBe("no-store");
    expect(html404.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(html404.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(html404.headers.get("Retry-After")).toBeNull();
    const html404Body = await html404.text();
    expect(html404Body).toContain(STATE_PAGE_MESSAGES.notFound);
    expect(html404Body).not.toContain("punyasitus.com");

    const api404 = createStatePageResponse("not_found", { pathname: "/api/leads", surface: "unknown" });
    expect(api404.status).toBe(404);
    expect(api404.headers.get("Content-Type")).toContain("application/json");
    expect(await api404.json()).toEqual({ success: false, code: "NOT_FOUND" });

    const cases = [
      ["suspended", STATE_PAGE_MESSAGES.suspended, "SITE_SUSPENDED"],
      ["recovery", STATE_PAGE_MESSAGES.recovery, "SITE_RECOVERY"],
      ["unavailable", STATE_PAGE_MESSAGES.unavailable, "SERVICE_UNAVAILABLE"],
    ] as const;

    for (const [kind, message, code] of cases) {
      const htmlRes = createStatePageResponse(kind, { pathname: "/", surface: "tenant" });
      expect(htmlRes.status).toBe(503);
      expect(htmlRes.headers.get("Retry-After")).toBe("60");
      expect(htmlRes.headers.get("Cache-Control")).toBe("no-store");
      expect(htmlRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(htmlRes.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(await htmlRes.text()).toContain(message);

      const apiRes = createStatePageResponse(kind, { pathname: "/api/events", surface: "tenant" });
      expect(apiRes.status).toBe(503);
      expect(apiRes.headers.get("Retry-After")).toBe("60");
      expect(await apiRes.json()).toEqual({ success: false, code });
    }
  });

  it("strips any Set-Cookie containing Domain= on tenant hosts while keeping host-only __Host- cookies", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "tossed=1; Domain=situsku.click; Path=/");
    headers.append("Set-Cookie", "other=2; path=/; DOMAIN=.situsku.click");
    headers.append("Set-Cookie", "__Host-ps_consent=analytics:1; Path=/; Secure; HttpOnly; SameSite=Lax");

    const sanitized = sanitizeTenantResponseHeaders(
      new Response("ok", { status: 200, headers }),
      { surface: "tenant", noindex: true },
    );

    const setCookies = (
      sanitized.headers as Headers & { getSetCookie: () => string[] }
    ).getSetCookie();
    expect(setCookies).toEqual([
      "__Host-ps_consent=analytics:1; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
    expect(sanitized.headers.get("X-PunyaSitus-Surface")).toBe("tenant");
    expect(sanitized.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("allows local loopback ONLY when APP_ENV === 'local' and passes Step 0 DCV paths", async () => {
    const dcvDecision = await evaluateRequestGate(
      new Request("https://pending.example.id/.well-known/acme-challenge/tok-1"),
      { APP_ENV: "production" },
    );
    expect(dcvDecision).toEqual({
      action: "dcv_passthrough",
      pathname: "/.well-known/acme-challenge/tok-1",
    });

    const localAllowed = await evaluateRequestGate(
      new Request("http://127.0.0.1:4321/_dev/design-fixtures"),
      { APP_ENV: "local" },
    );
    expect(localAllowed.action).toBe("serve");
    if (localAllowed.action === "serve") {
      expect(localAllowed.isLocalLoopback).toBe(true);
      expect(localAllowed.noindex).toBe(true);
    }

    const prodLoopback = await evaluateRequestGate(
      new Request("http://127.0.0.1:4321/_dev/design-fixtures"),
      { APP_ENV: "production" },
    );
    expect(prodLoopback.action).toBe("respond");
    if (prodLoopback.action === "respond") {
      expect(prodLoopback.response.status).toBe(404);
    }
  });
});
