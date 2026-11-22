import {
  buildMenuTree,
  flattenMenuTree,
  MAX_MENU_ITEMS,
  MenuValidationError,
  toPublicMenuItems,
  validateMenuHref,
  validateMenuLabel,
  type MenuItemInput,
} from "@punyasitus/core/menu-builder";
import { describe, expect, it } from "vitest";

function expectMenuError(fn: () => unknown, expectedCode: string): MenuValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MenuValidationError);
    const menuErr = err as MenuValidationError;
    expect(menuErr.code).toBe(expectedCode);
    return menuErr;
  }
  throw new Error(`Expected MenuValidationError(${expectedCode}) but function succeeded.`);
}

describe("TASK-004 unit — Menu Tree Builder & Strict Validator", () => {
  it("preserves exact sibling order for flat parentId inputs (sortOrder + input index) and nested trees", () => {
    const flatInput: MenuItemInput[] = [
      { id: "contact", parentId: null, sortOrder: 20, label: "Kontak", href: "#kontak" },
      { id: "home", parentId: null, sortOrder: 5, label: "Beranda", href: "/" },
      { id: "services", parentId: null, sortOrder: 10, label: "Layanan", href: "/layanan" },
      { id: "svc-b", parentId: "services", sortOrder: 2, label: "Desain Web", href: "/layanan/web" },
      { id: "svc-a", parentId: "services", sortOrder: 1, label: "Konsultasi SEO", href: "/layanan/seo" },
      { id: "svc-a-2", parentId: "svc-a", sortOrder: 2, label: "Audit Teknis", href: "/layanan/seo/audit" },
      { id: "svc-a-1", parentId: "svc-a", sortOrder: 1, label: "Riset Kata Kunci", href: "/layanan/seo/riset" },
    ];

    const built = buildMenuTree("header", flatInput);
    expect(built.location).toBe("header");
    expect(built.totalItems).toBe(7);
    expect(built.maxDepth).toBe(3);

    // Level 1 order: home (5) -> services (10) -> contact (20)
    expect(built.tree.map((n) => n.id)).toEqual(["home", "services", "contact"]);
    expect(built.tree.map((n) => n.sortOrder)).toEqual([0, 1, 2]);
    expect(built.tree.every((n) => n.depth === 1)).toBe(true);

    // Level 2 order under services: svc-a (1) -> svc-b (2)
    const servicesNode = built.tree[1];
    expect(servicesNode?.children.map((n) => n.id)).toEqual(["svc-a", "svc-b"]);
    expect(servicesNode?.children.map((n) => n.depth)).toEqual([2, 2]);

    // Level 3 order under svc-a: svc-a-1 (1) -> svc-a-2 (2)
    const svcANode = servicesNode?.children[0];
    expect(svcANode?.children.map((n) => n.id)).toEqual(["svc-a-1", "svc-a-2"]);
    expect(svcANode?.children.map((n) => n.depth)).toEqual([3, 3]);

    // Round-trip via flattenMenuTree preserves exact deterministic order
    const flatRoundTrip = flattenMenuTree(built.tree);
    expect(flatRoundTrip.map((i) => i.id)).toEqual([
      "home",
      "services",
      "svc-a",
      "svc-a-1",
      "svc-a-2",
      "svc-b",
      "contact",
    ]);

    const rebuilt = buildMenuTree(
      "header",
      flatRoundTrip.map((item) => ({
        id: item.id,
        parentId: item.parentId,
        sortOrder: item.sortOrder,
        label: item.label,
        href: item.href,
        openInNewTab: item.openInNewTab,
      })),
    );
    expect(rebuilt.tree).toEqual(built.tree);

    // Public DTO projection keeps exact 3-level structure
    const publicDto = toPublicMenuItems(built.tree);
    expect(publicDto[1]?.children[0]?.children[0]?.label).toBe("Riset Kata Kunci");
  });

  it("supports nested tree inputs without explicit ids and preserves exact array order", () => {
    const built = buildMenuTree("footer", [
      {
        label: "Perusahaan",
        href: "/tentang",
        openInNewTab: false,
        children: [
          {
            label: "Tim Kami",
            href: "/tentang/tim",
            openInNewTab: false,
            children: [
              { label: "Karier", href: "/karier", openInNewTab: false },
              { label: "Budaya", href: "/budaya", openInNewTab: false },
            ],
          },
          { label: "Kontak", href: "#kontak", openInNewTab: false },
        ],
      },
      {
        label: "WhatsApp",
        href: "https://wa.me/6281234567890?text=Halo",
      },
    ]);

    expect(built.maxDepth).toBe(3);
    expect(built.tree.map((n) => n.label)).toEqual(["Perusahaan", "WhatsApp"]);
    expect(built.tree[0]?.children.map((n) => n.label)).toEqual(["Tim Kami", "Kontak"]);
    expect(built.tree[0]?.children[0]?.children.map((n) => n.label)).toEqual(["Karier", "Budaya"]);
    expect(built.tree[1]).toMatchObject({
      isExternal: true,
      openInNewTab: true,
      rel: "noopener noreferrer",
      targetType: "whatsapp",
    });
  });

  it("allows depth 1, 2, and 3 but rejects depth 4 in both flat and nested forms", () => {
    // Depth 3 passes
    const validDepth3 = buildMenuTree("mobile", [
      { id: "d1", parentId: null, label: "Level 1", href: "/l1" },
      { id: "d2", parentId: "d1", label: "Level 2", href: "/l2" },
      { id: "d3", parentId: "d2", label: "Level 3", href: "/l3" },
    ]);
    expect(validDepth3.maxDepth).toBe(3);

    // Depth 4 flat fails
    expectMenuError(
      () =>
        buildMenuTree("mobile", [
          { id: "d1", parentId: null, label: "Level 1", href: "/l1" },
          { id: "d2", parentId: "d1", label: "Level 2", href: "/l2" },
          { id: "d3", parentId: "d2", label: "Level 3", href: "/l3" },
          { id: "d4", parentId: "d3", label: "Level 4", href: "/l4" },
        ]),
      "MENU_MAX_DEPTH_EXCEEDED",
    );

    // Depth 4 nested fails
    expectMenuError(
      () =>
        buildMenuTree("header", [
          {
            id: "n1",
            label: "Level 1",
            href: "/l1",
            children: [
              {
                id: "n2",
                label: "Level 2",
                href: "/l2",
                children: [
                  {
                    id: "n3",
                    label: "Level 3",
                    href: "/l3",
                    children: [{ id: "n4", label: "Level 4", href: "/l4" }],
                  },
                ],
              },
            ],
          },
        ]),
      "MENU_MAX_DEPTH_EXCEEDED",
    );
  });

  it("rejects direct self-cycles, 2-cycles, and multi-hop cycles with MENU_CYCLE_DETECTED", () => {
    // Self-parent A -> A
    expectMenuError(
      () =>
        buildMenuTree("header", [
          { id: "a", parentId: "a", label: "Self", href: "/self" },
        ]),
      "MENU_CYCLE_DETECTED",
    );

    // 2-cycle A -> B -> A
    expectMenuError(
      () =>
        buildMenuTree("header", [
          { id: "a", parentId: "b", label: "Node A", href: "/a" },
          { id: "b", parentId: "a", label: "Node B", href: "/b" },
        ]),
      "MENU_CYCLE_DETECTED",
    );

    // 3-cycle A -> B -> C -> A
    expectMenuError(
      () =>
        buildMenuTree("header", [
          { id: "a", parentId: "c", label: "Node A", href: "/a" },
          { id: "b", parentId: "a", label: "Node B", href: "/b" },
          { id: "c", parentId: "b", label: "Node C", href: "/c" },
        ]),
      "MENU_CYCLE_DETECTED",
    );

    // Chain into cycle D -> A -> B -> A
    expectMenuError(
      () =>
        buildMenuTree("header", [
          { id: "d", parentId: "a", label: "Node D", href: "/d" },
          { id: "a", parentId: "b", label: "Node A", href: "/a" },
          { id: "b", parentId: "a", label: "Node B", href: "/b" },
        ]),
      "MENU_CYCLE_DETECTED",
    );
  });

  it("rejects duplicate item IDs, missing parents, cross-menu parents, and cross-tenant references", () => {
    // Duplicate IDs
    expectMenuError(
      () =>
        buildMenuTree("header", [
          { id: "dup", label: "Pertama", href: "/1" },
          { id: "dup", label: "Kedua", href: "/2" },
        ]),
      "MENU_DUPLICATE_ITEM_ID",
    );

    // Missing parent
    expectMenuError(
      () =>
        buildMenuTree("header", [
          { id: "orphan", parentId: "missing-parent", label: "Orphan", href: "/orphan" },
        ]),
      "MENU_PARENT_NOT_FOUND",
    );

    // Cross-menu parent via otherMenuItemIds
    const otherMenuMap = new Map<string, "footer">([["footer-root", "footer"]]);
    expectMenuError(
      () =>
        buildMenuTree(
          "header",
          [{ id: "h1", parentId: "footer-root", label: "Cross Menu", href: "/cross" }],
          { otherMenuItemIds: otherMenuMap },
        ),
      "MENU_CROSS_MENU_PARENT",
    );

    // Cross-menu via mismatched item.menuLocation
    expectMenuError(
      () =>
        buildMenuTree("header", [
          { id: "h1", label: "Wrong Menu", href: "/x", menuLocation: "footer" },
        ]),
      "MENU_CROSS_MENU_PARENT",
    );

    // Cross-tenant via mismatched targetTenantId
    expectMenuError(
      () =>
        buildMenuTree(
          "header",
          [
            {
              id: "h1",
              label: "Tenant B Link",
              href: "/b",
              targetTenantId: "01JTESTTENANTBETA000000002",
            },
          ],
          { tenantId: "01JTESTTENANTALPHA00000001" },
        ),
      "MENU_CROSS_TENANT_REFERENCE",
    );

    // Cross-tenant via forbidden tenant selector key on item
    expectMenuError(
      () =>
        buildMenuTree("header", [
          {
            id: "h1",
            label: "Forged",
            href: "/forged",
            tenantId: "01JTESTTENANTBETA000000002",
          } as unknown as MenuItemInput,
        ]),
      "MENU_CROSS_TENANT_REFERENCE",
    );
  });

  it("rejects unsafe URLs and allows safe relative, anchor, HTTPS, and wa.me URLs with rel metadata", () => {
    const unsafeUrls = [
      "javascript:alert(1)",
      "JavaScript:void(0)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.com/phish",
      "/\\evil.com",
      "http://example.com/insecure",
      "https://localhost/admin",
      "https://127.0.0.1/secret",
      "https://169.254.169.254/latest/meta-data",
      "https://user:pass@example.com",
      "https://example.com/\r\nSet-Cookie: hacked=1",
      "/tentang\u0000",
      "https://wa.me/not-a-number",
      "#",
      "tentang-tanpa-slash",
    ];

    for (const badUrl of unsafeUrls) {
      expectMenuError(() => validateMenuHref(badUrl), "MENU_UNSAFE_URL");
    }

    const internalPath = validateMenuHref("/tentang-kami");
    expect(internalPath).toEqual({
      href: "/tentang-kami",
      isExternal: false,
      isWhatsApp: false,
      rel: null,
      openInNewTab: false,
    });

    const anchor = validateMenuHref("#kontak");
    expect(anchor).toEqual({
      href: "#kontak",
      isExternal: false,
      isWhatsApp: false,
      rel: null,
      openInNewTab: false,
    });

    const external = validateMenuHref("https://tokopedia.com/toko-contoh");
    expect(external).toMatchObject({
      href: "https://tokopedia.com/toko-contoh",
      isExternal: true,
      isWhatsApp: false,
      rel: "noopener noreferrer",
      openInNewTab: true,
    });

    const wa = validateMenuHref("https://wa.me/6281234567890?text=Halo%20Admin");
    expect(wa).toMatchObject({
      href: "https://wa.me/6281234567890?text=Halo%20Admin",
      isExternal: true,
      isWhatsApp: true,
      rel: "noopener noreferrer",
      openInNewTab: true,
    });
  });

  it("enforces bounded item count (<= 100), label length (1-80 chars, no control chars), and strict keys", () => {
    const exact100: MenuItemInput[] = Array.from({ length: MAX_MENU_ITEMS }, (_, i) => ({
      id: `item-${i + 1}`,
      label: `Item ${i + 1}`,
      href: `/item-${i + 1}`,
    }));
    expect(buildMenuTree("header", exact100).totalItems).toBe(100);

    const over100: MenuItemInput[] = [
      ...exact100,
      { id: "item-101", label: "Item 101", href: "/item-101" },
    ];
    expectMenuError(() => buildMenuTree("header", over100), "MENU_MAX_ITEMS_EXCEEDED");

    expectMenuError(() => validateMenuLabel("   "), "MENU_INVALID_LABEL");
    expectMenuError(() => validateMenuLabel("A".repeat(81)), "MENU_INVALID_LABEL");
    expectMenuError(() => validateMenuLabel("Beranda\nInjected"), "MENU_INVALID_LABEL");
    expect(validateMenuLabel("  Beranda Utama  ")).toBe("Beranda Utama");

    expectMenuError(
      () =>
        buildMenuTree("header", [
          {
            id: "x",
            label: "Test",
            href: "/test",
            unexpectedProp: true,
          } as unknown as MenuItemInput,
        ]),
      "UNKNOWN_FIELD",
    );
  });
});
