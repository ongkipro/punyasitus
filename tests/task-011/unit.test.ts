import {
  buildExternalLinkRel,
  ExternalLinkValidationError,
  MAX_EXTERNAL_URL_LENGTH,
  sanitizeExternalLink,
  validateExternalLink,
} from "@punyasitus/core/link-sanitizer";
import { describe, expect, it } from "vitest";

function expectLinkError(fn: () => unknown, code: ExternalLinkValidationError["code"]): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ExternalLinkValidationError);
  expect((caught as ExternalLinkValidationError).code).toBe(code);
}

describe("TASK-011: External Link-Out Validation", () => {
  describe("valid HTTPS marketplace and external CTA URLs", () => {
    it("accepts Shopee, Tokopedia, TikTok Shop, booking engine, and Google Form HTTPS URLs", () => {
      const validUrls = [
        "https://shopee.co.id/product/12345/67890?sp_atk=abc",
        "https://www.tokopedia.com/alphastudio/paket-kopi-arabika",
        "https://shop.tiktok.com/view/product/17294810293",
        "https://docs.google.com/forms/d/e/1FAIpQLSfExample/viewform",
        "https://booking.example.co.id/reserve/room-deluxe#top",
      ];

      for (const raw of validUrls) {
        const sanitized = sanitizeExternalLink(raw);
        expect(sanitized.href).toBe(new URL(raw).href);
        expect(sanitized.target).toBe("_blank");
        expect(sanitized.rel).toBe("noopener noreferrer");
        expect(sanitized.href).not.toBe("#");

        const result = validateExternalLink(raw);
        expect(result).toEqual({ ok: true, link: sanitized });
      }
    });

    it("supports optional policy rel attributes while always retaining noopener noreferrer", () => {
      expect(buildExternalLinkRel()).toBe("noopener noreferrer");
      expect(buildExternalLinkRel({ nofollow: true })).toBe("noopener noreferrer nofollow");
      expect(buildExternalLinkRel({ sponsored: true })).toBe("noopener noreferrer sponsored");
      expect(buildExternalLinkRel({ nofollow: true, sponsored: true, ugc: true })).toBe(
        "noopener noreferrer nofollow sponsored ugc",
      );

      const paid = sanitizeExternalLink("https://shopee.co.id/aff/item-1", {
        nofollow: true,
        sponsored: true,
      });
      expect(paid.target).toBe("_blank");
      expect(paid.rel).toBe("noopener noreferrer nofollow sponsored");
    });

    it("normalizes uppercase scheme/host and trims outer ASCII spaces", () => {
      const sanitized = sanitizeExternalLink("  HTTPS://SHOPEE.CO.ID/Item/1  ");
      expect(sanitized.href).toBe("https://shopee.co.id/Item/1");
      expect(sanitized.hostname).toBe("shopee.co.id");
    });
  });

  describe("strict rejection of unsafe schemes, credentials, local/private hosts, and malformed input", () => {
    it("rejects non-HTTPS schemes including http, javascript, data, vbscript, and file", () => {
      const badSchemes = [
        "http://shopee.co.id/product/1",
        "HTTP://www.tokopedia.com/item",
        "javascript:alert(1)",
        "JAVASCRIPT:void(0)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "ftp://files.example.com/catalog.pdf",
        "mailto:sales@example.com",
        "tel:+6281234567890",
      ];

      for (const raw of badSchemes) {
        expectLinkError(() => sanitizeExternalLink(raw), "UNSUPPORTED_PROTOCOL");
        const checked = validateExternalLink(raw);
        expect(checked.ok).toBe(false);
        if (!checked.ok) {
          expect(checked.code).toBe("UNSUPPORTED_PROTOCOL");
        }
      }
    });

    it("rejects control characters (preventing WHATWG whitespace/tab/newline scheme smuggling)", () => {
      const smuggled = [
        "java\tscript:alert(1)",
        "https://shopee.co.id/\npath",
        "https://shopee.co.id/\r\nSet-Cookie:a=b",
        "https://shopee.co.id/\0null",
        "\thttps://shopee.co.id/item",
      ];

      for (const raw of smuggled) {
        expectLinkError(() => sanitizeExternalLink(raw), "CONTROL_CHARACTER");
      }
    });

    it("rejects embedded credentials including empty @ authority forms", () => {
      const withCredentials = [
        "https://user:pass@shopee.co.id/item",
        "https://admin@tokopedia.com/item",
        "https://:secret@tokopedia.com/item",
        "https://@shopee.co.id/item",
        "https://:@shopee.co.id/item",
      ];

      for (const raw of withCredentials) {
        expectLinkError(() => sanitizeExternalLink(raw), "EMBEDDED_CREDENTIALS");
      }
    });

    it("rejects localhost, .local, .internal, dotless hosts, and private/loopback/link-local/CGNAT IPs", () => {
      const forbiddenHosts = [
        // Localhost and reserved internal domains (including trailing dot)
        "https://localhost/admin",
        "https://localhost:4321/",
        "https://localhost./",
        "https://app.localhost/path",
        "https://printer.local/",
        "https://printer.local./",
        "https://api.internal/v1",
        "https://service.internal./v1",
        "https://host.localdomain/",
        "https://router.home.arpa/",
        "https://intranet/secret",
        // IPv4 unspecified, loopback, private, link-local, CGNAT, multicast/broadcast
        "https://0.0.0.0/",
        "https://127.0.0.1/",
        "https://127.255.255.254:8443/",
        "https://10.0.0.1/",
        "https://10.255.255.255/",
        "https://172.16.0.1/",
        "https://172.31.255.254/",
        "https://192.168.0.1/",
        "https://192.168.1.100:8080/",
        "https://169.254.169.254/latest/meta-data/",
        "https://100.64.0.1/",
        "https://100.127.255.254/",
        "https://224.0.0.1/",
        "https://255.255.255.255/",
        // Obfuscated IPv4 literals normalized by WHATWG URL
        "https://0x7f000001/",
        "https://2130706433/",
        "https://0177.0.0.1/",
        "https://127.1/",
        // IPv6 loopback, unspecified, ULA, link-local, multicast, IPv4-mapped & NAT64
        "https://[::1]/",
        "https://[0:0:0:0:0:0:0:1]/",
        "https://[::]/",
        "https://[fc00::1]/",
        "https://[fd12:3456:789a::1]/",
        "https://[fe80::1]/",
        "https://[febf::1]/",
        "https://[ff02::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:10.0.0.1]/",
        "https://[::ffff:169.254.169.254]/",
        "https://[::ffff:192.168.1.1]/",
        "https://[64:ff9b::127.0.0.1]/",
      ];

      for (const raw of forbiddenHosts) {
        expectLinkError(() => sanitizeExternalLink(raw), "FORBIDDEN_HOST");
        const checked = validateExternalLink(raw);
        expect(checked.ok).toBe(false);
      }
    });

    it("never silently falls back to '#' on malformed, relative, empty, or oversized inputs", () => {
      expectLinkError(() => sanitizeExternalLink(""), "EMPTY_URL");
      expectLinkError(() => sanitizeExternalLink("   "), "EMPTY_URL");
      expectLinkError(
        () => sanitizeExternalLink(`https://shopee.co.id/${"a".repeat(MAX_EXTERNAL_URL_LENGTH)}`),
        "URL_TOO_LONG",
      );

      const malformed = [
        "#",
        "#section",
        "/produk/kopi",
        "//shopee.co.id/item",
        "shopee.co.id/item",
        "https://",
        "https:shopee.co.id/item",
        "https:\\\\shopee.co.id/item",
        "https://evil.com\\@shopee.co.id/item",
        "not a url at all",
      ];

      for (const raw of malformed) {
        expectLinkError(() => sanitizeExternalLink(raw), "MALFORMED_URL");
        const checked = validateExternalLink(raw);
        expect(checked.ok).toBe(false);
        expect(JSON.stringify(checked)).not.toContain('href":"#"');
      }
    });
  });
});
