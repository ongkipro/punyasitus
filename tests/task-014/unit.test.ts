import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsLivePresenceClaim,
  deriveInitials,
  FLOATING_WA_DEFAULTS,
  resolveFloatingWhatsAppConfig,
  sanitizeAvatarUrl,
  sanitizeOperatingHoursText,
} from "../../apps/web/src/themes/default/components/FloatingWhatsApp.ts";

const root = path.resolve(import.meta.dirname, "../..");
const componentDir = path.join(root, "apps/web/src/themes/default/components");
const astroPath = path.join(componentDir, "FloatingWhatsApp.astro");
const logicPath = path.join(componentDir, "FloatingWhatsApp.ts");

describe("TASK-014: Floating WhatsApp Widget (Unit)", () => {
  it("normalizes Indonesian E.164 numbers and builds canonical wa.me URL via TASK-010 helper", () => {
    const cases = ["0812-3456-7890", "+62 812 3456 7890", "6281234567890", "(+62) 812.3456.7890"];

    for (const rawPhone of cases) {
      const resolved = resolveFloatingWhatsAppConfig({
        phone: rawPhone,
        businessName: "PT Nusantara Arsitek",
        primaryOrigin: "https://nusantara.situsku.click",
        canonicalPath: "/layanan/desain-kantor?utm_source=ig#hero",
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.phone).toBe("6281234567890");
      expect(resolved?.waUrl.startsWith("https://wa.me/6281234567890?text=")).toBe(true);

      const decodedText = decodeURIComponent(resolved!.waUrl.split("?text=")[1] ?? "");
      expect(decodedText).toContain("PT Nusantara Arsitek");
      expect(decodedText).toContain("https://nusantara.situsku.click/layanan/desain-kantor");
      // Visitor query string and hash must be stripped by TASK-010 helper
      expect(decodedText).not.toContain("utm_source");
      expect(decodedText).not.toContain("#hero");
    }
  });

  it("supports custom TASK-010 templates with item price, literal dollar sequences, and bare wa.me mode", () => {
    const withTemplate = resolveFloatingWhatsAppConfig({
      phone: "0813-9876-5432",
      businessName: "Toko $100 $$ & Co",
      itemTitle: "Paket $& Premium",
      itemPrice: { model: "from", amountIdr: 1_500_000, negotiable: true },
      pageUrl: "https://contoh.situsku.click/paket/premium?ref=ads",
      messageTemplate: "Halo, info {{item_title}} ({{item_price}}) di {{page_url}}",
    });

    expect(withTemplate).not.toBeNull();
    const decoded = decodeURIComponent(withTemplate!.waUrl.split("?text=")[1] ?? "");
    expect(decoded).toBe(
      "Halo, info Paket $& Premium (Mulai Rp 1.500.000 (Nego)) di https://contoh.situsku.click/paket/premium",
    );

    const bare = resolveFloatingWhatsAppConfig({
      phone: "6281234567890",
      messageTemplate: "",
    });
    expect(bare).not.toBeNull();
    expect(bare?.waUrl).toBe("https://wa.me/6281234567890");
    expect(bare?.prefillMessage).toBe("");
  });

  it("fails closed (returns null) when phone is missing, invalid, unsafe, or disabled", () => {
    const invalidInputs = [
      { phone: null },
      { phone: undefined },
      { phone: "" },
      { phone: "   " },
      { phone: "javascript:alert(1)" },
      { phone: "021-5551234" }, // Indonesian landline, not mobile 628...
      { phone: "+1-415-555-2671" }, // Non-Indonesian prefix
      { phone: "0812345" }, // Too short (< 10 E.164 digits)
      { phone: "081234567890123456" }, // Too long (> 15 E.164 digits)
      { phone: "0812-abc-7890" }, // Letters disallowed
      { phone: "628012345678" }, // Invalid prefix 6280
      { phone: "6281234567890", enabled: false },
    ];

    for (const input of invalidInputs) {
      expect(resolveFloatingWhatsAppConfig(input)).toBeNull();
    }
  });

  it("reads phone, business name, and operating hours from TenantShellData shortcut and falls back safely on hostile URLs/templates", () => {
    const resolved = resolveFloatingWhatsAppConfig({
      shell: {
        site: { title: "Situs Resmi" },
        business: {
          name: "Bengkel Sejahtera",
          whatsappE164: "6281122334455",
          weekdayHours: "Senin–Sabtu 08.00–17.00 WIB",
          holidayHours: "Minggu Tutup",
        },
      },
      pageUrl: "javascript:alert(1)",
      messageTemplate: "Halo {{unknown_token}}",
      greetingMessage: "Halo!\nSilakan tanya estimasi servis kendaraan Anda.",
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.phone).toBe("6281122334455");
    expect(resolved?.businessName).toBe("Bengkel Sejahtera");
    expect(resolved?.initials).toBe("BS");
    expect(resolved?.hasGreeting).toBe(true);
    expect(resolved?.operatingHours).toBe("Senin–Sabtu 08.00–17.00 WIB");
    expect(resolved?.holidayHours).toBe("Minggu Tutup");
    expect(resolved?.waUrl.startsWith("https://wa.me/6281122334455?text=")).toBe(true);
    expect(resolved?.waUrl).not.toContain("javascript:");
    expect(resolved?.waUrl).not.toContain("unknown_token");
  });

  it("preserves honest operating hours and rejects fake live-presence claims", () => {
    expect(sanitizeOperatingHoursText("Senin–Jumat 08.30–17.00 WIB")).toBe(
      "Senin–Jumat 08.30–17.00 WIB",
    );
    expect(sanitizeOperatingHoursText("Buka setiap hari 09.00–21.00 WITA")).toBe(
      "Buka setiap hari 09.00–21.00 WITA",
    );

    const fakePresenceClaims = [
      "Online sekarang",
      "Sedang online - siap membantu",
      "Sedang aktif",
      "Balas dalam 1 menit",
      "Membalas dalam 30 detik",
      "Active now",
      "Online now",
      "Replies in 2 minutes",
      "Replies instantly",
    ];

    for (const claim of fakePresenceClaims) {
      expect(containsLivePresenceClaim(claim)).toBe(true);
      expect(sanitizeOperatingHoursText(claim)).toBeNull();
    }

    const resolved = resolveFloatingWhatsAppConfig({
      phone: "081234567890",
      businessName: "Klinik Aman",
      greetingMessage: "Silakan kirim pesan untuk jadwal konsultasi.",
      operatingHours: "Online sekarang — Balas dalam 1 menit",
      agentSubtitle: "Sedang aktif",
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.operatingHours).toBeNull();
    expect(resolved?.agentSubtitle).toBeNull();
  });

  it("validates avatar URLs strictly and derives safe initials fallback", () => {
    expect(sanitizeAvatarUrl("/media/avatar.webp")).toBe("/media/avatar.webp");
    expect(sanitizeAvatarUrl("https://cdn.punyasitus.com/t/avatar.webp")).toBe(
      "https://cdn.punyasitus.com/t/avatar.webp",
    );

    expect(sanitizeAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeAvatarUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
    expect(sanitizeAvatarUrl("http://insecure.example/a.png")).toBeNull();
    expect(sanitizeAvatarUrl("//evil.example/a.png")).toBeNull();
    expect(sanitizeAvatarUrl("https://127.0.0.1/internal.png")).toBeNull();

    expect(deriveInitials("PT Nusantara Arsitek")).toBe("PN");
    expect(deriveInitials("   ")).toBe("WA");
    expect(FLOATING_WA_DEFAULTS.buttonLabel).toBe("WhatsApp");
  });

  it("enforces TASK-010 reuse, zero React/admin imports, zero fake presence, and < 4 KiB CSS+JS bundle budget", () => {
    const astroSource = fs.readFileSync(astroPath, "utf8");
    const logicSource = fs.readFileSync(logicPath, "utf8");

    // Must reuse TASK-010 dispatcher
    expect(logicSource).toContain('from "@punyasitus/core/wa-dispatcher"');

    // Surface isolation & zero React/Base-UI/Radix/unsafe HTML injection
    for (const src of [astroSource, logicSource]) {
      expect(src).not.toContain("@radix-ui/");
      expect(src).not.toContain("asChild");
      expect(src).not.toContain("@base-ui/react");
      expect(src).not.toContain("from \"react\"");
      expect(src).not.toContain("from 'react'");
      expect(src).not.toContain("styles/admin");
      expect(src).not.toContain("components/ui");
    }
    expect(astroSource).not.toContain("set:html");
    expect(astroSource).not.toContain("client:load");
    expect(astroSource).not.toContain("client:idle");
    expect(astroSource).not.toContain("client:visible");

    // Zero hardcoded fake online presence or pulse animations in template/CSS
    expect(astroSource.toLowerCase()).not.toContain("online sekarang");
    expect(astroSource.toLowerCase()).not.toContain("sedang aktif");
    expect(astroSource.toLowerCase()).not.toContain("balas dalam");
    expect(astroSource.toLowerCase()).not.toContain("@keyframes");

    // Measure inline script and style budgets
    const styleMatch = astroSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    const scriptMatch = astroSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    expect(styleMatch).not.toBeNull();
    expect(scriptMatch).not.toBeNull();

    const styleBytes = Buffer.byteLength(styleMatch![1] ?? "", "utf8");
    const scriptBytes = Buffer.byteLength(scriptMatch![1] ?? "", "utf8");
    const totalBytes = styleBytes + scriptBytes;

    // Tiny progressive enhancement inline JS (< 1.2 KiB uncompressed; <= 1024 B target)
    expect(scriptBytes).toBeLessThanOrEqual(1024);
    // Combined CSS + JS strictly within 4 KiB uncompressed budget
    expect(totalBytes).toBeLessThan(4096);
  });
});
