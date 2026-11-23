import { z } from "zod";

/**
 * Dismissible 5-Step Guided Dashboard Onboarding Checklist
 * (`packages/core/src/presets/checklist.ts`; REQ-093, PLAN §19.5, DESIGN.md §3.3 & §6, TASK-093).
 *
 * Steps:
 * 1. `profile_whatsapp` — Profil & WhatsApp
 * 2. `logo`             — Logo
 * 3. `offering_page`    — Penawaran/Halaman
 * 4. `theme`            — Tema
 * 5. `publish`          — Publikasikan
 *
 * Guarantees:
 * - Every step can be automatically satisfied from tenant facts, manually completed,
 *   or individually dismissed; the entire checklist can also be dismissed and restored.
 * - Strict Zod v4 serialization enforces unique non-overlapping step IDs and valid ISO
 *   timestamps while storing ZERO PII or secrets.
 */

export const GUIDED_ONBOARDING_STEP_IDS = [
  "profile_whatsapp",
  "logo",
  "offering_page",
  "theme",
  "publish",
] as const;

export type GuidedOnboardingStepId = (typeof GUIDED_ONBOARDING_STEP_IDS)[number];

export type GuidedOnboardingStepStatus = "completed" | "dismissed" | "pending";

export const GuidedOnboardingStepIdSchema = z.enum(GUIDED_ONBOARDING_STEP_IDS);

const UniqueStepIdArraySchema = z
  .array(GuidedOnboardingStepIdSchema)
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Daftar langkah checklist tidak boleh memuat ID duplikat",
  });

export const GuidedOnboardingChecklistStateSchema = z
  .object({
    version: z.literal(1).default(1),
    completedStepIds: UniqueStepIdArraySchema.default([]),
    dismissedStepIds: UniqueStepIdArraySchema.default([]),
    dismissedAll: z.boolean().default(false),
    updatedAt: z.iso.datetime().nullable().default(null),
  })
  .strict()
  .superRefine((data, ctx) => {
    const completedSet = new Set(data.completedStepIds);
    for (const id of data.dismissedStepIds) {
      if (completedSet.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["dismissedStepIds"],
          message: `Langkah "${id}" tidak boleh berada di completedStepIds dan dismissedStepIds sekaligus`,
        });
      }
    }
  });

export type GuidedOnboardingChecklistState = z.infer<
  typeof GuidedOnboardingChecklistStateSchema
>;

export interface GuidedOnboardingFacts {
  readonly handle: string;
  readonly offeringMenuLabel?: string;
  readonly hasBusinessProfileAndWhatsApp: boolean;
  readonly hasLogo: boolean;
  readonly hasOfferingOrPage: boolean;
  readonly hasReviewedTheme: boolean;
  readonly hasPublishedSite: boolean;
}

export interface GuidedOnboardingStepView {
  readonly id: GuidedOnboardingStepId;
  readonly order: number;
  readonly label: string;
  readonly description: string;
  readonly status: GuidedOnboardingStepStatus;
  readonly completedByFacts: boolean;
  readonly actionLabel: string;
  readonly actionHref: string;
}

export interface GuidedOnboardingChecklistSummary {
  readonly steps: readonly GuidedOnboardingStepView[];
  readonly completedCount: number;
  readonly dismissedCount: number;
  readonly resolvedCount: number;
  readonly totalCount: 5;
  readonly percentComplete: number;
  readonly dismissedAll: boolean;
  readonly allResolved: boolean;
  readonly isVisible: boolean;
  readonly updatedAt: string | null;
}

export function createInitialGuidedChecklistState(): GuidedOnboardingChecklistState {
  return {
    version: 1,
    completedStepIds: [],
    dismissedStepIds: [],
    dismissedAll: false,
    updatedAt: null,
  };
}

function dedupeSteps(
  ids: readonly GuidedOnboardingStepId[],
): GuidedOnboardingStepId[] {
  const seen = new Set<GuidedOnboardingStepId>();
  const out: GuidedOnboardingStepId[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function completeGuidedChecklistStep(
  state: GuidedOnboardingChecklistState,
  stepId: GuidedOnboardingStepId,
  nowIso: string = new Date().toISOString(),
): GuidedOnboardingChecklistState {
  const parsed = GuidedOnboardingChecklistStateSchema.parse(state);
  const completedStepIds = dedupeSteps([...parsed.completedStepIds, stepId]);
  const dismissedStepIds = parsed.dismissedStepIds.filter((id) => id !== stepId);
  return GuidedOnboardingChecklistStateSchema.parse({
    version: 1,
    completedStepIds,
    dismissedStepIds,
    dismissedAll: parsed.dismissedAll,
    updatedAt: nowIso,
  });
}

export function dismissGuidedChecklistStep(
  state: GuidedOnboardingChecklistState,
  stepId: GuidedOnboardingStepId,
  nowIso: string = new Date().toISOString(),
): GuidedOnboardingChecklistState {
  const parsed = GuidedOnboardingChecklistStateSchema.parse(state);
  const dismissedStepIds = dedupeSteps([...parsed.dismissedStepIds, stepId]);
  const completedStepIds = parsed.completedStepIds.filter((id) => id !== stepId);
  return GuidedOnboardingChecklistStateSchema.parse({
    version: 1,
    completedStepIds,
    dismissedStepIds,
    dismissedAll: parsed.dismissedAll,
    updatedAt: nowIso,
  });
}

export function resetGuidedChecklistStep(
  state: GuidedOnboardingChecklistState,
  stepId: GuidedOnboardingStepId,
  nowIso: string = new Date().toISOString(),
): GuidedOnboardingChecklistState {
  const parsed = GuidedOnboardingChecklistStateSchema.parse(state);
  return GuidedOnboardingChecklistStateSchema.parse({
    version: 1,
    completedStepIds: parsed.completedStepIds.filter((id) => id !== stepId),
    dismissedStepIds: parsed.dismissedStepIds.filter((id) => id !== stepId),
    dismissedAll: false,
    updatedAt: nowIso,
  });
}

export function dismissAllGuidedChecklist(
  state: GuidedOnboardingChecklistState,
  nowIso: string = new Date().toISOString(),
): GuidedOnboardingChecklistState {
  const parsed = GuidedOnboardingChecklistStateSchema.parse(state);
  return GuidedOnboardingChecklistStateSchema.parse({
    ...parsed,
    dismissedAll: true,
    updatedAt: nowIso,
  });
}

export function restoreGuidedChecklist(
  state: GuidedOnboardingChecklistState,
  nowIso: string = new Date().toISOString(),
): GuidedOnboardingChecklistState {
  const parsed = GuidedOnboardingChecklistStateSchema.parse(state);
  return GuidedOnboardingChecklistStateSchema.parse({
    ...parsed,
    dismissedAll: false,
    updatedAt: nowIso,
  });
}

export function serializeGuidedChecklistState(
  state: GuidedOnboardingChecklistState,
): string {
  return JSON.stringify(GuidedOnboardingChecklistStateSchema.parse(state));
}

export function parseGuidedChecklistState(
  raw: string | null | undefined,
): GuidedOnboardingChecklistState {
  if (!raw) return createInitialGuidedChecklistState();
  try {
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = GuidedOnboardingChecklistStateSchema.safeParse(parsedJson);
    if (parsed.success) {
      return parsed.data;
    }
    return createInitialGuidedChecklistState();
  } catch {
    return createInitialGuidedChecklistState();
  }
}

export function evaluateGuidedOnboardingChecklist(
  facts: GuidedOnboardingFacts,
  persistedState: GuidedOnboardingChecklistState = createInitialGuidedChecklistState(),
): GuidedOnboardingChecklistSummary {
  const state = GuidedOnboardingChecklistStateSchema.parse(persistedState);
  const completedSet = new Set<GuidedOnboardingStepId>(state.completedStepIds);
  const dismissedSet = new Set<GuidedOnboardingStepId>(state.dismissedStepIds);
  const base = `/dashboard/${encodeURIComponent(facts.handle)}`;
  const offeringLabel = facts.offeringMenuLabel?.trim() || "Penawaran";

  const definitions: readonly {
    readonly id: GuidedOnboardingStepId;
    readonly label: string;
    readonly description: string;
    readonly completedByFacts: boolean;
    readonly actionLabel: string;
    readonly actionHref: string;
  }[] = [
    {
      id: "profile_whatsapp",
      label: "Profil & WhatsApp",
      description:
        "Lengkapi nama usaha, kategori bisnis, alamat, dan nomor WhatsApp utama untuk tombol hubungi.",
      completedByFacts: facts.hasBusinessProfileAndWhatsApp,
      actionLabel: "Atur Profil",
      actionHref: `${base}/settings/identity`,
    },
    {
      id: "logo",
      label: "Logo",
      description:
        "Unggah logo usaha agar favicon 32×32, 180×180, dan kartu berbagi WhatsApp terbentuk otomatis.",
      completedByFacts: facts.hasLogo,
      actionLabel: "Unggah Logo",
      actionHref: `${base}/settings/identity#logo`,
    },
    {
      id: "offering_page",
      label: "Penawaran/Halaman",
      description: `Tambahkan item ${offeringLabel.toLowerCase()} pertama atau sunting teks contoh pada halaman beranda.`,
      completedByFacts: facts.hasOfferingOrPage,
      actionLabel: `Kelola ${offeringLabel}`,
      actionHref: `${base}/catalog`,
    },
    {
      id: "theme",
      label: "Tema",
      description:
        "Pilih tema dan warna merek yang kontrasnya sudah diuji WCAG AA tanpa kehilangan isi situs.",
      completedByFacts: facts.hasReviewedTheme,
      actionLabel: "Pilih Tema",
      actionHref: `${base}/appearance/themes`,
    },
    {
      id: "publish",
      label: "Publikasikan",
      description:
        "Periksa pratinjau desktop & seluler lalu terbitkan situs agar siap dibagikan ke calon klien.",
      completedByFacts: facts.hasPublishedSite,
      actionLabel: "Siapkan Terbit",
      actionHref: `${base}/onboarding`,
    },
  ];

  const steps: GuidedOnboardingStepView[] = definitions.map((def, idx) => {
    let status: GuidedOnboardingStepStatus = "pending";
    if (def.completedByFacts || completedSet.has(def.id)) {
      status = "completed";
    } else if (dismissedSet.has(def.id)) {
      status = "dismissed";
    }
    return {
      id: def.id,
      order: idx + 1,
      label: def.label,
      description: def.description,
      status,
      completedByFacts: def.completedByFacts,
      actionLabel: def.actionLabel,
      actionHref: def.actionHref,
    };
  });

  const completedCount = steps.filter((s) => s.status === "completed").length;
  const dismissedCount = steps.filter((s) => s.status === "dismissed").length;
  const resolvedCount = completedCount + dismissedCount;
  const totalCount = 5 as const;
  const percentComplete = Math.round((completedCount / totalCount) * 100);
  const allResolved = resolvedCount === totalCount;

  return {
    steps,
    completedCount,
    dismissedCount,
    resolvedCount,
    totalCount,
    percentComplete,
    dismissedAll: state.dismissedAll,
    allResolved,
    isVisible: !state.dismissedAll,
    updatedAt: state.updatedAt,
  };
}
