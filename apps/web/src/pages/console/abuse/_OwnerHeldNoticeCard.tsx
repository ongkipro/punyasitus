import { ClockIcon, ShieldAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export interface OwnerHeldNoticeCardProps {
  readonly resourceTitle?: string;
  readonly resourceTypeLabel?: string;
  readonly reviewId?: string;
  readonly heldAtLabel?: string;
  readonly compact?: boolean;
}

/**
 * Tenant-facing notice rendered whenever publish-time screening holds a draft item
 * (`REQ-103`, `PLAN.md` §20.1, `TASK-103`).
 *
 * Security invariant: displays ONLY the generic Indonesian hold notice
 * ("Konten ditahan untuk ditinjau") and status ("Draf") — NEVER discloses matched
 * keywords, denylisted domains, rule IDs, or operator notes.
 */
export function OwnerHeldNoticeCard({
  resourceTitle,
  resourceTypeLabel = "Konten",
  reviewId,
  heldAtLabel,
  compact = false,
}: OwnerHeldNoticeCardProps) {
  return (
    <Alert
      variant="warning"
      data-testid="owner-held-notice"
      className={compact ? "space-y-1.5" : "space-y-2"}
    >
      <ShieldAlertIcon className="size-4 shrink-0" aria-hidden="true" />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        <span>Konten ditahan untuk ditinjau</span>
        <Badge variant="outline" className="text-xs font-medium">
          Status: Draf
        </Badge>
      </AlertTitle>
      <AlertDescription className="space-y-2 text-sm">
        <p>
          {resourceTitle ? (
            <>
              {resourceTypeLabel} <strong className="font-semibold">{resourceTitle}</strong> belum
              dipublikasikan dan tetap tersimpan aman sebagai draf sambil menunggu pemeriksaan tim
              keamanan platform.
            </>
          ) : (
            <>
              Perubahan belum dipublikasikan dan tetap tersimpan aman sebagai draf sambil menunggu
              pemeriksaan tim keamanan platform.
            </>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          Jika ini adalah kekeliruan, Anda dapat memperbarui draf atau menunggu tim kami merilis
          publikasi setelah peninjauan selesai.
        </p>
        {(reviewId || heldAtLabel) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5 text-xs text-muted-foreground">
            {reviewId && (
              <span className="break-all font-mono">Referensi tinjauan: {reviewId}</span>
            )}
            {heldAtLabel && (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
                {heldAtLabel}
              </span>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
