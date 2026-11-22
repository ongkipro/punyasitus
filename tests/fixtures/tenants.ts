/**
 * Synthetic two-tenant fixtures for local workerd tests (zero production data).
 */
export interface SyntheticTenantFixture {
  readonly id: string;
  readonly handle: string;
  readonly subdomainHost: string;
  readonly siteTitle: string;
}

export const SYNTHETIC_TENANTS: readonly [SyntheticTenantFixture, SyntheticTenantFixture] = [
  {
    id: "01JTESTTENANTALPHA00000001",
    handle: "alpha-studio",
    subdomainHost: "alpha-studio.situsku.click",
    siteTitle: "Alpha Studio Fixture",
  },
  {
    id: "01JTESTTENANTBETA000000002",
    handle: "beta-klinik",
    subdomainHost: "beta-klinik.situsku.click",
    siteTitle: "Beta Klinik Fixture",
  },
] as const;

export const SYNTHETIC_PLATFORM_HOSTS = {
  marketing: "punyasitus.com",
  app: "app.punyasitus.com",
  console: "console.punyasitus.com",
} as const;
