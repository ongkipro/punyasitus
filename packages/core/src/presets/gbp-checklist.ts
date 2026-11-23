import {
  GOOGLE_BUSINESS_PROFILE_HELP_URL,
  GOOGLE_BUSINESS_PROFILE_REVIEW_HELP_URL,
  PUNYASITUS_GBP_HELP_ARTICLE_PATH,
  validateGoogleMapsReviewUrl,
} from "../settings/google-maps-review.ts";

/**
 * Google Business Profile Onboarding Checklist Step & Verification Card
 * (`packages/core/src/presets/gbp-checklist.ts`; TASK-073, REQ-074, PLAN §18.4).
 *
 * Guarantees:
 * - Zero Google Business Profile API calls, zero OAuth integrations, zero review scraping/import.
 * - Links strictly to official Google Business Profile Help URLs and PunyaSitus Help Center
 *   (`/bantuan/mengoptimalkan-seo-dan-visibilitas-ai`).
 * - Never fabricates ratings, reviews, or verification status.
 */

export const GBP_CHECKLIST_STEP_ID = "google_business_profile" as const;

export const GBP_CHECKLIST_STEP_LABEL =
  "Tambahkan website ke Google Business Profile" as const;

export const GBP_OFFICIAL_HELP_URLS = {
  addWebsiteToProfile: GOOGLE_BUSINESS_PROFILE_HELP_URL,
  shareReviewLink: GOOGLE_BUSINESS_PROFILE_REVIEW_HELP_URL,
  punyasitusHelpArticle: PUNYASITUS_GBP_HELP_ARTICLE_PATH,
} as const;

export interface GoogleBusinessProfileGuideStep {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly detail: string;
}

export interface GoogleBusinessProfileChecklistStepView {
  readonly id: typeof GBP_CHECKLIST_STEP_ID;
  readonly label: typeof GBP_CHECKLIST_STEP_LABEL;
  readonly description: string;
  readonly status: "done" | "optional_pending";
  readonly requiredForPublish: false;
  readonly detail: string;
  readonly actionLabel: string;
  readonly actionHref: string;
  readonly officialHelpUrl: typeof GOOGLE_BUSINESS_PROFILE_HELP_URL;
  readonly officialReviewLinkHelpUrl: typeof GOOGLE_BUSINESS_PROFILE_REVIEW_HELP_URL;
  readonly helpArticleHref: typeof PUNYASITUS_GBP_HELP_ARTICLE_PATH;
  readonly manualSteps: readonly GoogleBusinessProfileGuideStep[];
  readonly noApiNotice: string;
}

export interface GoogleBusinessProfileChecklistFacts {
  readonly handle: string;
  readonly publicSiteHref?: string | null;
  readonly googleMapsReviewUrl?: string | null;
  readonly hasPublishedReviewUrl?: boolean;
  readonly isSitePublished?: boolean;
}

export interface GoogleBusinessProfileVerificationItem {
  readonly id: "website_url_ready" | "review_link_configured" | "review_link_published";
  readonly label: string;
  readonly detail: string;
  readonly done: boolean;
}

export interface GoogleBusinessProfileChecklistCardSummary {
  readonly step: GoogleBusinessProfileChecklistStepView;
  readonly publicSiteUrl: string;
  readonly hasValidReviewUrl: boolean;
  readonly hasPublishedReviewUrl: boolean;
  readonly items: readonly GoogleBusinessProfileVerificationItem[];
  readonly completedCount: number;
  readonly totalCount: number;
}

const GBP_MANUAL_GUIDE_STEPS: readonly GoogleBusinessProfileGuideStep[] = [
  {
    id: "open_gbp",
    order: 1,
    title: "Buka profil usaha Anda di Google Business Profile",
    detail:
      "Masuk ke akun Google yang mengelola profil bisnis Anda lalu pilih menu Edit profil > Kontak > Situs web.",
  },
  {
    id: "paste_website_url",
    order: 2,
    title: "Tempel alamat situs PunyaSitus Anda",
    detail:
      "Masukkan alamat situs web aktif Anda (subdomain atau domain kustom) dan pastikan nama bisnis serta nomor telepon konsisten.",
  },
  {
    id: "copy_review_link",
    order: 3,
    title: "Salin tautan ulasan Google Maps lalu simpan di sini",
    detail:
      "Dari menu Minta ulasan di Google Business Profile, salin tautan resmi (g.page/r/.../review atau maps.app.goo.gl/...) lalu tempel pada kolom Tautan Ulasan Google Maps.",
  },
] as const;

export const GBP_NO_API_NOTICE =
  "PunyaSitus tidak terhubung ke API Google Business Profile dan tidak menyalin teks ulasan atau skema rating. Tautan hanya mengarahkan pengunjung langsung ke halaman Google Maps resmi Anda." as const;

export function buildGoogleBusinessProfileChecklistStep(
  facts: GoogleBusinessProfileChecklistFacts,
): GoogleBusinessProfileChecklistStepView {
  const base = `/dashboard/${encodeURIComponent(facts.handle)}`;
  const hasValidReviewUrl = Boolean(
    facts.googleMapsReviewUrl && validateGoogleMapsReviewUrl(facts.googleMapsReviewUrl).ok,
  );
  const isDone = hasValidReviewUrl && (facts.hasPublishedReviewUrl ?? true);

  return {
    id: GBP_CHECKLIST_STEP_ID,
    label: GBP_CHECKLIST_STEP_LABEL,
    description:
      "Tautkan alamat website Anda di Google Business Profile dan simpan tautan ulasan Google Maps resmi agar pengunjung mudah membuka ulasan asli.",
    status: isDone ? "done" : "optional_pending",
    requiredForPublish: false,
    detail: hasValidReviewUrl
      ? facts.hasPublishedReviewUrl === false
        ? "Tautan ulasan Google Maps tersimpan di draf — klik Terbitkan ke situs agar tampil di publik."
        : "Tautan ulasan Google Maps resmi sudah terpasang dan siap dilihat pengunjung."
      : "Opsional — tambahkan URL situs ke Google Business Profile Anda, lalu tempel tautan ulasan Google Maps di Pengaturan Bisnis.",
    actionLabel: "Atur Tautan Ulasan",
    actionHref: `${base}/settings/business#google-maps-review`,
    officialHelpUrl: GOOGLE_BUSINESS_PROFILE_HELP_URL,
    officialReviewLinkHelpUrl: GOOGLE_BUSINESS_PROFILE_REVIEW_HELP_URL,
    helpArticleHref: PUNYASITUS_GBP_HELP_ARTICLE_PATH,
    manualSteps: GBP_MANUAL_GUIDE_STEPS,
    noApiNotice: GBP_NO_API_NOTICE,
  };
}

export function evaluateGoogleBusinessProfileChecklist(
  facts: GoogleBusinessProfileChecklistFacts,
): GoogleBusinessProfileChecklistCardSummary {
  const step = buildGoogleBusinessProfileChecklistStep(facts);
  const publicSiteUrl =
    facts.publicSiteHref?.trim() || `https://${facts.handle}.situsku.click`;
  const hasValidReviewUrl = Boolean(
    facts.googleMapsReviewUrl && validateGoogleMapsReviewUrl(facts.googleMapsReviewUrl).ok,
  );
  const hasPublishedReviewUrl = Boolean(facts.hasPublishedReviewUrl && hasValidReviewUrl);

  const items: readonly GoogleBusinessProfileVerificationItem[] = [
    {
      id: "website_url_ready",
      label: "Alamat situs siap ditempel ke Google Business Profile",
      detail: `Salin ${publicSiteUrl} lalu masukkan ke kolom Situs web pada profil Google bisnis Anda.`,
      done: Boolean(facts.isSitePublished ?? true),
    },
    {
      id: "review_link_configured",
      label: "Tautan ulasan Google Maps tervalidasi",
      detail: hasValidReviewUrl
        ? "Format tautan Google Maps resmi sudah valid."
        : "Tempel tautan g.page/r/.../review, maps.app.goo.gl/..., google.com/maps/..., atau search.google.com/local/writereview?placeid=....",
      done: hasValidReviewUrl,
    },
    {
      id: "review_link_published",
      label: "Diterbitkan ke bagian Testimoni & Kontak",
      detail: hasPublishedReviewUrl
        ? "Tautan polos aktif tampil di bagian testimoni dan kontak situs publik."
        : "Simpan draf lalu tekan Terbitkan ke situs agar tautan ulasan tampil di publik.",
      done: hasPublishedReviewUrl,
    },
  ];

  const completedCount = items.filter((item) => item.done).length;

  return {
    step,
    publicSiteUrl,
    hasValidReviewUrl,
    hasPublishedReviewUrl,
    items,
    completedCount,
    totalCount: items.length,
  };
}
