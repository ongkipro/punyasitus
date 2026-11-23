import * as React from "react";
import { AlertCircleIcon, CheckIcon, CopyIcon, MapPinIcon } from "lucide-react";
import type { BlueprintLocalListingsCard } from "@punyasitus/core/presets/blueprints";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface LocalListingsCopyCardProps {
  readonly card: BlueprintLocalListingsCard;
}

export function LocalListingsCopyCard({ card }: LocalListingsCopyCardProps) {
  const [copyStatus, setCopyStatus] = React.useState<"idle" | "copied" | "unavailable">("idle");

  const handleCopy = async () => {
    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== "function"
    ) {
      setCopyStatus("unavailable");
      return;
    }

    try {
      await navigator.clipboard.writeText(card.copyPlainText);
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 2500);
    } catch {
      setCopyStatus("unavailable");
    }
  };

  return (
    <Card data-testid="local-listings-copy-card">
      <CardHeader className="border-b border-border">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2">
            <MapPinIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{card.title}</span>
          </CardTitle>
          <CardDescription>
            Salin data usaha persis seperti tercantum di situs agar profil lokal Anda konsisten di
            Google dan Bing tanpa integrasi API eksternal.
          </CardDescription>
        </div>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={handleCopy}
            data-testid="local-listings-copy-button"
          >
            {copyStatus === "copied" ? (
              <>
                <CheckIcon className="size-3.5 text-primary" aria-hidden="true" />
                <span>Tersalin</span>
              </>
            ) : (
              <>
                <CopyIcon className="size-3.5" aria-hidden="true" />
                <span>Salin Data NAP</span>
              </>
            )}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {card.platforms.map((platform) => (
            <Badge key={platform} variant="secondary">
              {platform}
            </Badge>
          ))}
        </div>

        {copyStatus === "unavailable" && (
          <p
            role="status"
            data-testid="local-listings-copy-fallback"
            className="flex items-center gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning"
          >
            <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Salin otomatis tidak tersedia di browser ini. Silakan salin data usaha secara manual
              dari ringkasan di bawah.
            </span>
          </p>
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 rounded-md border border-border bg-muted/40 p-3.5 text-xs sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-muted-foreground">Nama Usaha</dt>
            <dd className="mt-0.5 text-sm font-medium text-foreground">{card.businessName}</dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Kategori</dt>
            <dd className="mt-0.5 text-sm text-foreground">{card.categoryLabel}</dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Alamat</dt>
            <dd className="mt-0.5 text-sm text-foreground">{card.address}</dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Telepon / WhatsApp</dt>
            <dd className="mt-0.5 text-sm text-foreground tabular-nums">{card.phoneOrWhatsApp}</dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Jam Hari Kerja</dt>
            <dd className="mt-0.5 text-sm text-foreground">{card.weekdayHours}</dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Jam Akhir Pekan / Libur</dt>
            <dd className="mt-0.5 text-sm text-foreground" data-testid="local-listings-holiday-hours">
              {card.holidayHours}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-semibold text-muted-foreground">Situs</dt>
            <dd className="mt-0.5 truncate font-mono text-xs text-primary">{card.websiteUrl}</dd>
          </div>
        </dl>

        <ul className="space-y-1 text-xs text-muted-foreground">
          {card.syncGuideNotes.map((note) => (
            <li key={note}>• {note}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
