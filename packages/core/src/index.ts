import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";

export type SurfaceKind = "marketing" | "app" | "console" | "tenant" | "unknown";

export interface SurfaceClassification {
  readonly surface: SurfaceKind;
  readonly host: string;
  readonly tenantHandle: string | null;
}

export const PLATFORM_HOSTS = {
  marketing: "punyasitus.com",
  marketingWww: "www.punyasitus.com",
  app: "app.punyasitus.com",
  console: "console.punyasitus.com",
  saasZone: "situsku.click",
} as const;

export const RESERVED_HANDLES = new Set([
  "www",
  "fallback",
  "cname",
  "app",
  "console",
  "admin",
  "api",
  "mail",
  "notif",
]);

export const DCV_PASS_THROUGH_PREFIXES = [
  "/.well-known/pki-validation/",
  "/.well-known/acme-challenge/",
] as const;

export function isDcvPassThroughPath(pathname: string): boolean {
  if (pathname.includes("..") || pathname.includes("\\")) return false;
  return DCV_PASS_THROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function normalizeHost(rawHost: string | null | undefined): string | null {
  if (!rawHost) return null;
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("@") || /\s/.test(trimmed)) {
    return null;
  }
  // Strip optional port safely (no IPv6 literals accepted outside explicit local fixture)
  const hostOnly = trimmed.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!hostOnly || hostOnly.length > 253) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostOnly)) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(hostOnly)) {
    return null;
  }
  return hostOnly;
}

export function classifySurfaceHost(
  rawHost: string | null | undefined,
  options?: { readonly customTenantHosts?: ReadonlySet<string> },
): SurfaceClassification {
  const host = normalizeHost(rawHost);
  if (!host) {
    return { surface: "unknown", host: "", tenantHandle: null };
  }
  if (host === PLATFORM_HOSTS.marketing || host === PLATFORM_HOSTS.marketingWww) {
    return { surface: "marketing", host, tenantHandle: null };
  }
  if (host === PLATFORM_HOSTS.app) {
    return { surface: "app", host, tenantHandle: null };
  }
  if (host === PLATFORM_HOSTS.console) {
    return { surface: "console", host, tenantHandle: null };
  }
  const saasSuffix = `.${PLATFORM_HOSTS.saasZone}`;
  if (host.endsWith(saasSuffix)) {
    const label = host.slice(0, -saasSuffix.length);
    if (label && !label.includes(".") && !RESERVED_HANDLES.has(label)) {
      return { surface: "tenant", host, tenantHandle: label };
    }
    return { surface: "unknown", host, tenantHandle: null };
  }
  if (options?.customTenantHosts?.has(host)) {
    return { surface: "tenant", host, tenantHandle: null };
  }
  return { surface: "unknown", host, tenantHandle: null };
}

export const ReceiptSmokeInputSchema = z.object({
  receiptNumber: z.string().min(1).max(64),
  tenantName: z.string().min(1).max(120),
  amountIdr: z.number().int().nonnegative(),
});

export type ReceiptSmokeInput = z.infer<typeof ReceiptSmokeInputSchema>;

/**
 * Pure-JS PDF generation probe verifying `pdf-lib` works in both Node and Cloudflare `workerd`.
 */
export async function createReceiptPdfBytes(input: ReceiptSmokeInput): Promise<Uint8Array> {
  const parsed = ReceiptSmokeInputSchema.parse(input);
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 220]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(`PunyaSitus Receipt #${parsed.receiptNumber}`, {
    x: 24,
    y: 170,
    size: 14,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText(`Tenant: ${parsed.tenantName}`, { x: 24, y: 140, size: 11, font });
  page.drawText(`Total: IDR ${parsed.amountIdr.toLocaleString("en-US")}`, {
    x: 24,
    y: 115,
    size: 11,
    font,
  });
  return doc.save();
}
