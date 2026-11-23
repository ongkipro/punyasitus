import { ArrowRightIcon, InboxIcon } from "lucide-react";
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

export interface OverviewLeadSummaryCardProps {
  readonly last7DaysCount: number;
  readonly previous7DaysCount: number;
  readonly unreadNewCount: number;
  readonly leadsHref: string;
}

function formatCountId(n: number): string {
  return new Intl.NumberFormat("id-ID").format(Math.max(0, Math.round(n)));
}

export function OverviewLeadSummaryCard({
  last7DaysCount,
  previous7DaysCount,
  unreadNewCount,
  leadsHref,
}: OverviewLeadSummaryCardProps) {
  const delta = last7DaysCount - previous7DaysCount;
  const deltaText =
    delta > 0
      ? `+${formatCountId(delta)} dibanding 7 hari sebelumnya`
      : delta < 0
        ? `${formatCountId(delta)} dibanding 7 hari sebelumnya`
        : "Sama dengan 7 hari sebelumnya";

  return (
    <Card data-testid="overview-lead-summary-card">
      <CardHeader className="border-b border-border">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2">
              <InboxIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>Ringkasan Pesan Masuk</span>
            </CardTitle>
            {unreadNewCount > 0 && (
              <Badge variant="default" className="tabular-nums">
                {formatCountId(unreadNewCount)} baru
              </Badge>
            )}
          </div>
          <CardDescription>
            Perbandingan pesan formulir 7 hari terakhir terhadap 7 hari sebelumnya.
          </CardDescription>
        </div>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            render={<a href={leadsHref} />}
          >
            <span>Buka Pesan Masuk</span>
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">7 hari terakhir</p>
          <p
            className="mt-1 text-2xl font-bold tracking-tight text-foreground tabular-nums"
            data-testid="lead-summary-last-7d"
          >
            {formatCountId(last7DaysCount)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{deltaText}</p>
        </div>

        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">7 hari sebelumnya</p>
          <p
            className="mt-1 text-2xl font-bold tracking-tight text-foreground tabular-nums"
            data-testid="lead-summary-prev-7d"
          >
            {formatCountId(previous7DaysCount)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Periode pembanding langsung</p>
        </div>

        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">Belum ditindaklanjuti</p>
          <p
            className="mt-1 text-2xl font-bold tracking-tight text-primary tabular-nums"
            data-testid="lead-summary-new"
          >
            {formatCountId(unreadNewCount)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {unreadNewCount > 0 ? "Siap dibalas via WhatsApp" : "Semua pesan sudah ditinjau"}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
