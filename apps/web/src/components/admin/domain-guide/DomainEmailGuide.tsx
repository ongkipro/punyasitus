import * as React from "react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  CloudIcon,
  ExternalLinkIcon,
  GlobeIcon,
  InfoIcon,
  MailIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DNS_EMAIL_PATHS,
  DNS_PRESERVATION_ITEMS,
  DOMAIN_PURCHASE_OVERVIEW,
  type DnsEmailPathId,
} from "./guide-data";

export interface DomainEmailGuideProps {
  readonly handle: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly currentRole: string;
  readonly canReadDomains: boolean;
  readonly cnameTarget: string;
  readonly domainsHref: string;
  readonly billingHref: string;
}

type PathFilterValue = "all" | DnsEmailPathId;

const FILTER_OPTIONS: ReadonlyArray<{
  readonly id: PathFilterValue;
  readonly label: string;
  readonly helper: string;
}> = [
  {
    id: "all",
    label: "Semua Jalur (3)",
    helper: "Tampilkan perbandingan lengkap ketiga jalur DNS & email bisnis.",
  },
  {
    id: "cloudflare_dns",
    label: "Jalur A: Cloudflare DNS",
    helper: "Domain memakai nameserver Cloudflare & Email Routing.",
  },
  {
    id: "registrar_forwarding",
    label: "Jalur B: Forwarding Registrar",
    helper: "DNS tetap di registrar dengan penerusan email bawaan.",
  },
  {
    id: "paid_mailbox",
    label: "Jalur C: Mailbox Berbayar",
    helper: "Kotak surat penuh (Google Workspace, Microsoft 365, Zoho Mail).",
  },
];

function pathIcon(pathId: DnsEmailPathId) {
  switch (pathId) {
    case "cloudflare_dns":
      return <CloudIcon className="size-4 text-primary shrink-0" aria-hidden="true" />;
    case "registrar_forwarding":
      return <GlobeIcon className="size-4 text-primary shrink-0" aria-hidden="true" />;
    case "paid_mailbox":
      return <MailIcon className="size-4 text-primary shrink-0" aria-hidden="true" />;
  }
}

export function DomainEmailGuide({
  handle,
  tenantName,
  tenantStatus,
  currentRole,
  canReadDomains,
  cnameTarget,
  domainsHref,
  billingHref,
}: DomainEmailGuideProps) {
  const [selectedFilter, setSelectedFilter] = React.useState<PathFilterValue>("all");
  const filterButtonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  // Editor permission denial screen — strictly mirrors Settings > Domains (REQ-034, REQ-071)
  if (!canReadDomains) {
    return (
      <section className="space-y-6" aria-labelledby="domain-guide-denied-heading">
        <div className="space-y-1">
          <h1
            id="domain-guide-denied-heading"
            className="text-2xl font-semibold tracking-tight text-foreground"
          >
            Panduan Domain &amp; Email Bisnis
          </h1>
          <p className="text-sm text-muted-foreground">
            Panduan domain untuk situs{" "}
            <span className="font-medium text-foreground">{tenantName}</span>.
          </p>
        </div>

        <Alert variant="destructive" data-testid="domain-guide-permission-denied">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Akses Panduan Domain Ditolak (403)</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Peran Anda saat ini (<strong className="font-semibold">{currentRole}</strong>) tidak
              memiliki izin untuk membuka pengaturan maupun panduan domain. Halaman ini hanya dapat
              diakses oleh Pemilik Situs dan Admin.
            </p>
            <div>
              <Button
                variant="outline"
                className="min-h-11"
                render={<a href={`/dashboard/${encodeURIComponent(handle)}`} />}
              >
                Kembali ke Beranda
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const visiblePaths =
    selectedFilter === "all"
      ? DNS_EMAIL_PATHS
      : DNS_EMAIL_PATHS.filter((item) => item.id === selectedFilter);

  const isTrial = tenantStatus === "trial";

  function handleFilterKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % FILTER_OPTIONS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + FILTER_OPTIONS.length) % FILTER_OPTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = FILTER_OPTIONS.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      const targetOption = FILTER_OPTIONS[nextIndex];
      if (targetOption) {
        setSelectedFilter(targetOption.id);
        filterButtonRefs.current[nextIndex]?.focus();
      }
    }
  }

  return (
    <section
      className="space-y-6"
      aria-labelledby="domain-guide-heading"
      data-testid="domain-email-guide"
    >
      {/* Top Breadcrumb / Back Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          data-testid="back-to-domains-link"
          render={<a href={domainsHref} />}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Kembali ke Pengaturan Domain
        </Button>

        <Badge variant="outline" className="gap-1.5">
          <BookOpenIcon className="size-3" aria-hidden="true" />
          Panduan Informasi · Tanpa Kredensial
        </Badge>
      </div>

      {/* Page Header */}
      <div className="space-y-1.5">
        <h1
          id="domain-guide-heading"
          className="text-2xl font-semibold tracking-tight text-foreground"
        >
          Panduan Domain &amp; Email Bisnis
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Langkah praktis menyiapkan nama domain milik sendiri dan alamat email profesional (seperti{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            info@bisnisanda.id
          </code>
          ) untuk situs <span className="font-medium text-foreground">{tenantName}</span> sesuai
          tempat pengelolaan DNS Anda.
        </p>
      </div>

      {/* Strict Informational & Non-Mailbox Boundary Disclosure (REQ-071, PLAN §18.2) */}
      <Alert variant="info" data-testid="informational-boundary-notice">
        <InfoIcon className="size-4" aria-hidden="true" />
        <AlertTitle>Halaman Panduan Saja — Domain &amp; Email Dikelola di Akun Anda Sendiri</AlertTitle>
        <AlertDescription className="space-y-1.5 text-sm">
          <p>
            PunyaSitus <strong>tidak menyediakan kotak surat (mailbox)</strong>, tidak menjual atau
            membeli domain atas nama pelanggan, dan <strong>tidak pernah meminta kata sandi, token API,
            maupun akses login</strong> registrar atau penyedia email Anda.
          </p>
          <p className="text-xs text-current/85">
            Pembelian domain serta pengaturan email bisnis dilakukan langsung di akun resmi penyedia
            pilihan Anda. Tidak ada koneksi otomatis ke API penyedia eksternal dari halaman panduan ini.
          </p>
        </AlertDescription>
      </Alert>

      {/* Section 1: Getting a Domain */}
      <Card data-testid="domain-purchase-section">
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2 text-lg">
            <GlobeIcon className="size-4 text-primary shrink-0" aria-hidden="true" />
            {DOMAIN_PURCHASE_OVERVIEW.title}
          </CardTitle>
          <CardDescription>{DOMAIN_PURCHASE_OVERVIEW.summary}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="space-y-2 text-sm text-foreground">
            {DOMAIN_PURCHASE_OVERVIEW.tips.map((tip, index) => (
              <li key={tip} className="flex items-start gap-2.5">
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="leading-relaxed">{tip}</span>
              </li>
            ))}
          </ol>

          <Separator />

          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Tautan Resmi Registri &amp; Registrar
            </h2>
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {DOMAIN_PURCHASE_OVERVIEW.officialLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-official-provider-link="true"
                  className="group flex min-h-11 items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 text-left transition-colors outline-none hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-sm font-semibold text-foreground group-hover:text-primary">
                      {link.label}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {link.description}
                    </p>
                  </div>
                  <ExternalLinkIcon
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-primary"
                    aria-hidden="true"
                  />
                </a>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Three DNS Paths for Business Email (REQ-071 / PLAN §18.2) */}
      <div className="space-y-4" data-testid="dns-paths-section">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            2. Pilih Jalur Email Bisnis Berdasarkan Lokasi DNS Anda
          </h2>
          <p className="text-sm text-muted-foreground">
            Di mana DNS domain Anda dikelola saat ini? Pilih jalur di bawah untuk menyaring panduan,
            atau baca ketiga jalur sekaligus untuk membandingkan opsi yang paling sesuai.
          </p>
        </div>

        {/* Keyboard-accessible DNS Branching Selector */}
        <div
          role="group"
          aria-label="Filter jalur panduan berdasarkan lokasi DNS"
          data-testid="dns-path-filter"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
        >
          {FILTER_OPTIONS.map((opt, idx) => {
            const active = selectedFilter === opt.id;
            return (
              <button
                key={opt.id}
                ref={(el) => {
                  filterButtonRefs.current[idx] = el;
                }}
                type="button"
                aria-pressed={active}
                data-path-filter={opt.id}
                onClick={() => setSelectedFilter(opt.id)}
                onKeyDown={(e) => handleFilterKeyDown(e, idx)}
                className={`flex min-h-11 flex-col items-start gap-1 rounded-lg border px-3.5 py-2.5 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  active
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border bg-card hover:bg-muted/50"
                }`}
              >
                <span className="text-sm font-semibold text-foreground">{opt.label}</span>
                <span className="text-xs leading-snug text-muted-foreground">{opt.helper}</span>
              </button>
            );
          })}
        </div>

        {selectedFilter !== "all" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
            <span>
              Menampilkan 1 dari 3 jalur DNS. Anda dapat kembali menampilkan seluruh jalur kapan saja.
            </span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 bg-card"
              data-testid="reset-path-filter-btn"
              onClick={() => setSelectedFilter("all")}
            >
              Tampilkan Semua 3 Jalur
            </Button>
          </div>
        ) : null}

        {/* Rendered DNS Path Cards */}
        <div className="space-y-4">
          {visiblePaths.map((path) => (
            <Card key={path.id} data-testid={`dns-path-${path.id}`}>
              <CardHeader className="border-b border-border gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    {pathIcon(path.id)}
                    <Badge variant="default">{path.code}</Badge>
                    <Badge variant="secondary">{path.badge}</Badge>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">
                    {path.dnsHostSummary}
                  </span>
                </div>
                <CardTitle className="text-base">{path.title}</CardTitle>
                <CardDescription className="leading-relaxed">{path.summary}</CardDescription>
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="rounded-md border border-border bg-muted/35 px-3.5 py-2.5 text-xs leading-relaxed text-foreground">
                  <strong className="font-semibold">Kapan memilih jalur ini:</strong> {path.bestFor}
                </div>

                {/* Mandatory Cloudflare DNS requirement callout on Path A */}
                {path.requirementCallout ? (
                  <Alert variant="warning" data-testid={path.requirementCallout.testId}>
                    <AlertTriangleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>{path.requirementCallout.title}</AlertTitle>
                    <AlertDescription className="text-xs leading-relaxed">
                      {path.requirementCallout.body}
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Langkah Penyiapan</h3>
                  <ol className="space-y-2 text-sm text-foreground">
                    {path.steps.map((step, stepIdx) => (
                      <li key={step} className="flex items-start gap-2.5">
                        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-foreground tabular-nums">
                          {stepIdx + 1}
                        </span>
                        <span className="leading-relaxed">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="space-y-1.5 rounded-md border border-border bg-card p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Catatan Penting
                  </h3>
                  <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                    {path.notes.map((note) => (
                      <li key={note} className="flex items-start gap-2">
                        <CheckCircle2Icon
                          className="mt-0.5 size-3.5 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        <span>{note}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Official Documentation Links */}
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Dokumentasi Resmi Penyedia
                  </h3>
                  <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                    {path.officialLinks.map((link) => (
                      <a
                        key={link.href}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-official-provider-link="true"
                        className="group flex min-h-11 items-start justify-between gap-3 rounded-md border border-border bg-muted/25 p-3 text-left transition-colors outline-none hover:bg-muted/65 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-sm font-semibold text-foreground group-hover:text-primary">
                            {link.label}
                          </div>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {link.description}
                          </p>
                        </div>
                        <ExternalLinkIcon
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-primary"
                          aria-hidden="true"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Section 3: DNS Coexistence Safety Reminder (MX / SPF / DKIM / DMARC vs Website CNAME) */}
      <Card data-testid="dns-coexistence-reminder">
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheckIcon className="size-4 text-primary shrink-0" aria-hidden="true" />
            3. Pastikan Record Email Tidak Terganggu Saat Menghubungkan Website
          </CardTitle>
          <CardDescription>
            Website PunyaSitus menggunakan record{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              CNAME
            </code>{" "}
            (mengarah ke{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {cnameTarget}
            </code>
            ). Saat memasang record website tersebut di panel DNS, <strong>jangan mengubah atau
            menghapus</strong> record email bisnis berikut agar pengiriman dan penerimaan email tetap
            berjalan normal:
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <Alert variant="warning">
            <AlertTriangleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Peringatan DNS: Pertahankan MX, SPF, DKIM, dan DMARC Anda</AlertTitle>
            <AlertDescription className="text-xs leading-relaxed">
              Menghapus atau menimpa record <strong>MX</strong>, <strong>SPF</strong>,{" "}
              <strong>DKIM</strong>, atau <strong>DMARC</strong> dapat menyebabkan email bisnis gagal
              diterima atau ditandai sebagai spam. Jika penyedia DNS Anda tidak mendukung CNAME
              flattening pada domain root, gunakan{" "}
              <code className="rounded bg-card/70 px-1 py-0.5 font-mono">www.bisnisanda.id</code>{" "}
              untuk website agar record email pada root domain tetap aman.
            </AlertDescription>
          </Alert>

          {/* Mobile stacked list (< md) — zero horizontal overflow at 360px */}
          <div className="space-y-2.5 md:hidden">
            {DNS_PRESERVATION_ITEMS.map((item) => (
              <div
                key={item.recordType}
                className="space-y-1.5 rounded-md border border-border bg-muted/25 p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="outline" className="font-mono">
                    {item.recordType}
                  </Badge>
                  <code className="font-mono text-muted-foreground break-all">
                    {item.hostExample}
                  </code>
                </div>
                <p className="text-foreground leading-relaxed">{item.role}</p>
                <p className="font-medium text-primary leading-relaxed">{item.action}</p>
              </div>
            ))}
          </div>

          {/* Desktop compact table (>= md) */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Tipe Record</TableHead>
                  <TableHead className="w-44">Contoh Host</TableHead>
                  <TableHead>Fungsi untuk Email</TableHead>
                  <TableHead>Tindakan Saat Pasang Website</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {DNS_PRESERVATION_ITEMS.map((item) => (
                  <TableRow key={item.recordType}>
                    <TableCell className="align-top">
                      <Badge variant="outline" className="font-mono">
                        {item.recordType}
                      </Badge>
                    </TableCell>
                    <TableCell className="align-top font-mono text-xs text-muted-foreground whitespace-normal">
                      {item.hostExample}
                    </TableCell>
                    <TableCell className="align-top text-xs whitespace-normal">
                      {item.role}
                    </TableCell>
                    <TableCell className="align-top text-xs font-medium text-foreground whitespace-normal">
                      {item.action}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Section 4: Next Step CTA — Connect Domain Flow */}
      <Card data-testid="connect-domain-cta-card">
        <CardHeader>
          <CardTitle className="text-base">
            Siap Menghubungkan Domain Kustom ke Website Anda?
          </CardTitle>
          <CardDescription>
            {isTrial
              ? "Domain kustom dapat dihubungkan setelah Anda mengaktifkan paket berbayar. Anda tetap dapat melihat alur koneksi dan instruksi DNS di Pengaturan Domain."
              : "Lanjutkan ke Pengaturan > Domain Kustom untuk memilih mode koneksi (Domain Baru, Pindahan Tanpa Downtime, atau Domain di Cloudflare) dan menyalin record DNS website."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              className="min-h-11"
              data-testid="connect-domain-link"
              render={<a href={domainsHref} />}
            >
              Hubungkan Domain Kustom
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Button>

            {isTrial ? (
              <Button
                variant="outline"
                className="min-h-11"
                data-testid="guide-billing-link"
                render={<a href={billingHref} />}
              >
                Lihat Paket Berbayar
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
