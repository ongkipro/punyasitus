import type { OfferingType } from "@punyasitus/core/schemas/common";
import type { SectionOfferingItem } from "@punyasitus/core/theme/index";

/**
 * Pure Public Presentation DTO Types for `custom-sample-agency` Routes.
 * Contains ONLY typed public data props — zero DB, auth, or runtime secret types.
 */

export interface PublicBlogSummaryDto {
  readonly slug: string;
  readonly title: string;
  readonly excerpt?: string | null;
  readonly categoryName?: string | null;
  readonly authorName?: string | null;
  readonly publishedAt?: string | null;
  readonly readingTimeMinutes?: number | null;
}

export interface PublicBlogDetailDto extends PublicBlogSummaryDto {
  readonly bodyHtml: string;
  readonly authorRoleTitle?: string | null;
  readonly tags?: readonly string[];
}

export interface PublicPaginationDto {
  readonly currentPage: number;
  readonly totalPages: number;
  readonly prevHref?: string | null;
  readonly nextHref?: string | null;
}

export interface PublicOfferingDetailDto extends SectionOfferingItem {
  readonly descriptionHtml?: string | null;
  readonly highlights?: readonly string[];
  readonly facts?: readonly { readonly label: string; readonly value: string }[];
}

export interface SampleAgencyHomeRouteData {
  readonly kind: "home";
  readonly sections: unknown;
  readonly primaryOrigin?: string;
}

export interface SampleAgencyPageRouteData {
  readonly kind: "page";
  readonly slug: string;
  readonly title: string;
  readonly description?: string | null;
  readonly sections: unknown;
  readonly primaryOrigin?: string;
}

export interface SampleAgencyBlogIndexRouteData {
  readonly kind: "blog_index";
  readonly heading?: string;
  readonly intro?: string | null;
  readonly posts: readonly PublicBlogSummaryDto[];
  readonly pagination?: PublicPaginationDto | null;
}

export interface SampleAgencyBlogPostRouteData {
  readonly kind: "blog_post";
  readonly post: PublicBlogDetailDto;
}

export interface SampleAgencyCatalogIndexRouteData {
  readonly kind: "catalog_index";
  readonly offeringType: OfferingType;
  readonly heading?: string;
  readonly intro?: string | null;
  readonly items: readonly SectionOfferingItem[];
  readonly primaryOrigin?: string;
  readonly pagination?: PublicPaginationDto | null;
}

export interface SampleAgencyCatalogDetailRouteData {
  readonly kind: "catalog_detail";
  readonly item: PublicOfferingDetailDto;
  readonly primaryOrigin?: string;
}

export interface SampleAgencyNotFoundRouteData {
  readonly kind: "not_found";
  readonly requestedPath?: string;
}

export type SampleAgencyRouteData =
  | SampleAgencyHomeRouteData
  | SampleAgencyPageRouteData
  | SampleAgencyBlogIndexRouteData
  | SampleAgencyBlogPostRouteData
  | SampleAgencyCatalogIndexRouteData
  | SampleAgencyCatalogDetailRouteData
  | SampleAgencyNotFoundRouteData;
