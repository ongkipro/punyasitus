import type { AllowedBusinessSchemaType } from "../schema-generator.ts";

/**
 * Closed Code-Defined Business Category -> Google-Supported Schema.org Subtype Mapping
 * (REQ-091, REQ-022, REQ-054, PLAN §5.2, §15.4, §19.5, §19.8; TASK-091).
 *
 * Hard Invariants:
 * - Closed allowlist of Indonesian business verticals & B2B conversion blueprints.
 * - Every category maps deterministically to a current Google-supported Schema.org subtype
 *   (`LocalBusiness` subtypes, `Organization`, or `ProfilePage` + `Person` for personal branding
 *   and individual sales executives).
 * - Default fallback is ALWAYS `"LocalBusiness"`.
 * - Deprecated `ProfessionalService` is STRICTLY FORBIDDEN and NEVER emitted anywhere.
 */

export type BusinessEntityProfileKind = "local_business" | "organization" | "profile_person";

export type BusinessCredentialGroup =
  | "general_local"
  | "b2b_industrial"
  | "sales_affiliated"
  | "personal_authority"
  | "travel_umrah"
  | "regulated_health"
  | "regulated_legal_tax"
  | "offline_outlet_fnb"
  | "education_lkp";

export type IndonesianCredentialKey =
  | "nib"
  | "isoSniTkdn"
  | "skKemenagPpiu"
  | "asitaIata"
  | "sipStr"
  | "barNotaryJurisdiction"
  | "halalBpjh"
  | "pirt"
  | "lkpNpsn";

export interface BusinessCategoryDefinition {
  readonly key: ClosedBusinessCategoryKey;
  readonly labelId: string;
  readonly groupLabelId: string;
  /** Primary Schema.org type for the business/organization node (NEVER `ProfessionalService`). */
  readonly schemaType: AllowedBusinessSchemaType;
  /** Whether the public entity profile is a LocalBusiness, Organization, or ProfilePage + Person. */
  readonly entityProfileKind: BusinessEntityProfileKind;
  readonly credentialGroup: BusinessCredentialGroup;
  /** Contextual optional Indonesian credential keys prompted prominently for this category. */
  readonly promptedCredentials: readonly IndonesianCredentialKey[];
  /** True for medical/dental/legal categories where Permenkes/ethics informational rules apply. */
  readonly isRegulatedProfessional: boolean;
}

export const BUSINESS_CATEGORY_CATALOG = [
  {
    key: "local_business",
    labelId: "Usaha Lokal Umum",
    groupLabelId: "Umum & Korporasi",
    schemaType: "LocalBusiness",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "organization",
    labelId: "Perusahaan / Organisasi",
    groupLabelId: "Umum & Korporasi",
    schemaType: "Organization",
    entityProfileKind: "organization",
    credentialGroup: "b2b_industrial",
    promptedCredentials: ["nib", "isoSniTkdn"],
    isRegulatedProfessional: false,
  },
  {
    key: "b2b_corporate",
    labelId: "Perusahaan B2B / Manufaktur / Distributor",
    groupLabelId: "Umum & Korporasi",
    schemaType: "Organization",
    entityProfileKind: "organization",
    credentialGroup: "b2b_industrial",
    promptedCredentials: ["nib", "isoSniTkdn"],
    isRegulatedProfessional: false,
  },
  {
    key: "contractor",
    labelId: "Kontraktor & Konstruksi",
    groupLabelId: "Umum & Korporasi",
    schemaType: "HomeAndConstructionBusiness",
    entityProfileKind: "local_business",
    credentialGroup: "b2b_industrial",
    promptedCredentials: ["nib", "isoSniTkdn"],
    isRegulatedProfessional: false,
  },
  {
    key: "sales_executive",
    labelId: "Konsultan Penjualan / Sales Resmi (Otomotif, Properti, Asuransi)",
    groupLabelId: "Personal & Konsultan",
    schemaType: "LocalBusiness",
    entityProfileKind: "profile_person",
    credentialGroup: "sales_affiliated",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "personal_brand",
    labelId: "Personal Brand / Pembicara / Coach / Konsultan Independen",
    groupLabelId: "Personal & Konsultan",
    schemaType: "LocalBusiness",
    entityProfileKind: "profile_person",
    credentialGroup: "personal_authority",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "travel_umrah_agency",
    labelId: "Biro Perjalanan Wisata & Umrah (PPIU / PIHK)",
    groupLabelId: "Travel & Hospitality",
    schemaType: "TravelAgency",
    entityProfileKind: "local_business",
    credentialGroup: "travel_umrah",
    promptedCredentials: ["skKemenagPpiu", "asitaIata", "nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "hotel_lodging",
    labelId: "Hotel / Villa / Penginapan",
    groupLabelId: "Travel & Hospitality",
    schemaType: "Hotel",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "lodging_business",
    labelId: "Homestay / Guest House",
    groupLabelId: "Travel & Hospitality",
    schemaType: "LodgingBusiness",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "auto_dealer",
    labelId: "Dealer Mobil / Showroom",
    groupLabelId: "Otomotif",
    schemaType: "AutoDealer",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "motorcycle_dealer",
    labelId: "Dealer Motor",
    groupLabelId: "Otomotif",
    schemaType: "MotorcycleDealer",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "auto_repair",
    labelId: "Bengkel & Servis Kendaraan",
    groupLabelId: "Otomotif",
    schemaType: "AutoRepair",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "automotive_business",
    labelId: "Usaha Otomotif Lainnya",
    groupLabelId: "Otomotif",
    schemaType: "AutomotiveBusiness",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "restaurant",
    labelId: "Restoran / Rumah Makan",
    groupLabelId: "Kuliner & Outlet",
    schemaType: "Restaurant",
    entityProfileKind: "local_business",
    credentialGroup: "offline_outlet_fnb",
    promptedCredentials: ["halalBpjh", "pirt", "nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "cafe",
    labelId: "Kafe & Kedai Kopi",
    groupLabelId: "Kuliner & Outlet",
    schemaType: "CafeOrCoffeeShop",
    entityProfileKind: "local_business",
    credentialGroup: "offline_outlet_fnb",
    promptedCredentials: ["halalBpjh", "pirt", "nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "bakery",
    labelId: "Toko Roti & Kue (Bakery)",
    groupLabelId: "Kuliner & Outlet",
    schemaType: "Bakery",
    entityProfileKind: "local_business",
    credentialGroup: "offline_outlet_fnb",
    promptedCredentials: ["halalBpjh", "pirt", "nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "food_catering",
    labelId: "Katering & Usaha Kuliner",
    groupLabelId: "Kuliner & Outlet",
    schemaType: "FoodEstablishment",
    entityProfileKind: "local_business",
    credentialGroup: "offline_outlet_fnb",
    promptedCredentials: ["halalBpjh", "pirt", "nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "retail_store",
    labelId: "Toko Ritel / Katalog Produk",
    groupLabelId: "Kuliner & Outlet",
    schemaType: "Store",
    entityProfileKind: "local_business",
    credentialGroup: "offline_outlet_fnb",
    promptedCredentials: ["nib", "halalBpjh", "pirt"],
    isRegulatedProfessional: false,
  },
  {
    key: "medical_clinic",
    labelId: "Klinik Medis / Praktik Dokter",
    groupLabelId: "Profesi Teregulasi",
    schemaType: "MedicalClinic",
    entityProfileKind: "local_business",
    credentialGroup: "regulated_health",
    promptedCredentials: ["sipStr", "nib"],
    isRegulatedProfessional: true,
  },
  {
    key: "dentist",
    labelId: "Klinik & Praktik Dokter Gigi",
    groupLabelId: "Profesi Teregulasi",
    schemaType: "Dentist",
    entityProfileKind: "local_business",
    credentialGroup: "regulated_health",
    promptedCredentials: ["sipStr", "nib"],
    isRegulatedProfessional: true,
  },
  {
    key: "legal_service",
    labelId: "Kantor Hukum / Advokat / Notaris & PPAT",
    groupLabelId: "Profesi Teregulasi",
    schemaType: "LegalService",
    entityProfileKind: "local_business",
    credentialGroup: "regulated_legal_tax",
    promptedCredentials: ["barNotaryJurisdiction", "nib"],
    isRegulatedProfessional: true,
  },
  {
    key: "accounting_service",
    labelId: "Kantor Akuntan / Konsultan Pajak",
    groupLabelId: "Profesi Teregulasi",
    schemaType: "AccountingService",
    entityProfileKind: "local_business",
    credentialGroup: "regulated_legal_tax",
    promptedCredentials: ["barNotaryJurisdiction", "nib"],
    isRegulatedProfessional: true,
  },
  {
    key: "financial_service",
    labelId: "Layanan Keuangan & Perencanaan",
    groupLabelId: "Profesi Teregulasi",
    schemaType: "FinancialService",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "real_estate_agent",
    labelId: "Agen & Kantor Properti",
    groupLabelId: "Jasa & Gaya Hidup",
    schemaType: "RealEstateAgent",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "beauty_salon",
    labelId: "Salon Kecantikan & Barbershop",
    groupLabelId: "Jasa & Gaya Hidup",
    schemaType: "BeautySalon",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "health_and_beauty",
    labelId: "Klinik Estetika & Perawatan Tubuh",
    groupLabelId: "Jasa & Gaya Hidup",
    schemaType: "HealthAndBeautyBusiness",
    entityProfileKind: "local_business",
    credentialGroup: "regulated_health",
    promptedCredentials: ["sipStr", "nib"],
    isRegulatedProfessional: true,
  },
  {
    key: "education_course",
    labelId: "Lembaga Kursus / Pelatihan (LKP) & Pendidikan",
    groupLabelId: "Jasa & Gaya Hidup",
    schemaType: "EducationalOrganization",
    entityProfileKind: "organization",
    credentialGroup: "education_lkp",
    promptedCredentials: ["lkpNpsn", "nib"],
    isRegulatedProfessional: false,
  },
  {
    key: "sports_activity",
    labelId: "Pusat Kebugaran / Olahraga",
    groupLabelId: "Jasa & Gaya Hidup",
    schemaType: "SportsActivityLocation",
    entityProfileKind: "local_business",
    credentialGroup: "general_local",
    promptedCredentials: ["nib"],
    isRegulatedProfessional: false,
  },
] as const;

export type ClosedBusinessCategoryKey = (typeof BUSINESS_CATEGORY_CATALOG)[number]["key"];

export const CLOSED_BUSINESS_CATEGORY_KEYS: readonly ClosedBusinessCategoryKey[] =
  BUSINESS_CATEGORY_CATALOG.map((item) => item.key);

const DEFINITION_BY_KEY: ReadonlyMap<string, BusinessCategoryDefinition> = new Map(
  BUSINESS_CATEGORY_CATALOG.map((item) => [item.key, item]),
);

/**
 * Direct Schema.org subtype names & canonical legacy blueprint aliases accepted cleanly
 * for backwards compatibility with TASK-008 / TASK-015 / onboarding blueprints.
 * Notice: `ProfessionalService` is NEVER in this map and is explicitly rejected/mapped away.
 */
const ALIAS_TO_CATEGORY_KEY: Readonly<Record<string, ClosedBusinessCategoryKey>> = {
  // Exact Schema.org subtype names (lowercased)
  localbusiness: "local_business",
  organization: "organization",
  travelagency: "travel_umrah_agency",
  autodealer: "auto_dealer",
  motorcycledealer: "motorcycle_dealer",
  automotivebusiness: "automotive_business",
  autorepair: "auto_repair",
  restaurant: "restaurant",
  cafeorcoffeeshop: "cafe",
  bakery: "bakery",
  foodestablishment: "food_catering",
  store: "retail_store",
  medicalclinic: "medical_clinic",
  dentist: "dentist",
  legalservice: "legal_service",
  accountingservice: "accounting_service",
  realestateagent: "real_estate_agent",
  homeandconstructionbusiness: "contractor",
  healthandbeautybusiness: "health_and_beauty",
  beautysalon: "beauty_salon",
  educationalorganization: "education_course",
  financialservice: "financial_service",
  lodgingbusiness: "lodging_business",
  hotel: "hotel_lodging",
  sportsactivitylocation: "sports_activity",
  // Friendly & blueprint aliases
  company: "organization",
  corporate: "b2b_corporate",
  manufacturer: "b2b_corporate",
  logistics: "b2b_corporate",
  offline_multibranch: "local_business",
  travel: "travel_umrah_agency",
  travel_agency: "travel_umrah_agency",
  umrah: "travel_umrah_agency",
  dealer: "auto_dealer",
  car_dealer: "auto_dealer",
  resto: "restaurant",
  coffee_shop: "cafe",
  shop: "retail_store",
  catalog: "retail_store",
  wa_catalog_showcase: "retail_store",
  clinic: "medical_clinic",
  legal: "legal_service",
  law_firm: "legal_service",
  notary: "legal_service",
  notary_ppat: "legal_service",
  accounting: "accounting_service",
  regulated_professional: "medical_clinic",
  real_estate: "real_estate_agent",
  property: "real_estate_agent",
  construction: "contractor",
  salon: "beauty_salon",
  education: "education_course",
  course: "education_course",
  hotel_alias: "hotel_lodging",
  lodging: "lodging_business",
};

const DEFAULT_CATEGORY_DEFINITION: BusinessCategoryDefinition =
  DEFINITION_BY_KEY.get("local_business")!;

/**
 * Returns `true` when the raw input attempts to supply deprecated `ProfessionalService`
 * (regardless of casing, underscores, hyphens, or whitespace).
 */
export function isDeprecatedProfessionalService(rawCategory: unknown): boolean {
  if (typeof rawCategory !== "string") return false;
  const compact = rawCategory
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return compact === "professionalservice";
}

/**
 * Strictly resolves a raw category input against the closed allowlist.
 * Returns `null` if unknown, empty, or deprecated `ProfessionalService`.
 */
export function lookupClosedBusinessCategory(
  rawCategory: string | null | undefined,
): BusinessCategoryDefinition | null {
  if (typeof rawCategory !== "string") return null;
  const trimmed = rawCategory.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (isDeprecatedProfessionalService(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  const direct = DEFINITION_BY_KEY.get(lower);
  if (direct) return direct;

  const aliasedKey = ALIAS_TO_CATEGORY_KEY[lower];
  if (aliasedKey) {
    return DEFINITION_BY_KEY.get(aliasedKey) ?? null;
  }
  return null;
}

/**
 * Safely resolves ANY category string into a valid closed `BusinessCategoryDefinition`.
 * Unknown inputs and deprecated `ProfessionalService` ALWAYS fall back to `local_business`
 * (`LocalBusiness`).
 */
export function resolveBusinessCategoryDefinition(
  rawCategory: string | null | undefined,
): BusinessCategoryDefinition {
  return lookupClosedBusinessCategory(rawCategory) ?? DEFAULT_CATEGORY_DEFINITION;
}

/**
 * Maps any closed `business_category` (or Schema.org subtype string) to a valid current
 * Google-supported Schema.org subtype.
 *
 * Hard guarantee:
 * - NEVER returns `"ProfessionalService"`.
 * - Falls back to `"LocalBusiness"` for unknown, empty, or deprecated inputs.
 */
export function mapBusinessCategoryToSchemaOrg(
  rawCategory: string | null | undefined,
): AllowedBusinessSchemaType {
  const def = lookupClosedBusinessCategory(rawCategory);
  return def ? def.schemaType : "LocalBusiness";
}

/**
 * Returns `true` when the business category represents an individual profile
 * (`personal_brand` or `sales_executive`) that emits `ProfilePage` + `Person` JSON-LD
 * (REQ-091, PLAN §19.8).
 */
export function isPersonProfileCategory(rawCategory: string | null | undefined): boolean {
  const def = lookupClosedBusinessCategory(rawCategory);
  return def?.entityProfileKind === "profile_person";
}
