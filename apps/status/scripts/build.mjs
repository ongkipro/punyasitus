import fs from "node:fs";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(appDir, "public");
const srcDir = path.join(appDir, "src");
const distDir = path.join(appDir, "dist");

const STATUS_LABELS = {
  operational: "Normal",
  degraded: "Menurun",
  partial_outage: "Gangguan Sebagian",
  major_outage: "Gangguan Kritis",
};

const OVERALL_HEADINGS = {
  operational: "Semua Sistem Beroperasi Normal",
  degraded: "Sebagian Layanan Mengalami Penurunan Performa",
  partial_outage: "Sebagian Layanan Mengalami Gangguan",
  major_outage: "Gangguan Layanan Utama Sedang Ditangani",
};

const INCIDENT_STATUS_LABELS = {
  investigating: "Sedang Diinvestigasi",
  identified: "Penyebab Teridentifikasi",
  monitoring: "Pemantauan Pemulihan",
  resolved: "Selesai",
};

const SEVERITY_LABELS = {
  minor: "Minor",
  major: "Mayor",
  critical: "Kritis",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatWib(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return (
    new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta",
    }).format(date) + " WIB"
  );
}

function renderIncidentCard(incident, isActive, componentNameById) {
  const severity = incident.severity in SEVERITY_LABELS ? incident.severity : "minor";
  const status = incident.status in INCIDENT_STATUS_LABELS ? incident.status : "investigating";
  const affectedNames = (incident.affectedComponents ?? []).map(
    (id) => componentNameById.get(id) ?? id,
  );
  const updatesHtml = (incident.updates ?? [])
    .map(
      (u) => `
        <li class="timeline-item">
          <div class="timeline-head">
            <span class="timeline-status">${escapeHtml(INCIDENT_STATUS_LABELS[u.status] ?? u.status)}</span>
            <time class="timeline-time tabular-nums" datetime="${escapeHtml(u.timestamp)}">${escapeHtml(formatWib(u.timestamp))}</time>
          </div>
          <p class="timeline-msg">${escapeHtml(u.message)}</p>
        </li>`,
    )
    .join("");

  const metaParts = [
    `Mulai: ${formatWib(incident.declaredAt)}`,
    incident.resolvedAt ? `Selesai: ${formatWib(incident.resolvedAt)}` : null,
    affectedNames.length > 0 ? `Komponen: ${affectedNames.join(", ")}` : null,
  ].filter(Boolean);

  return `
    <article class="incident-card" data-active="${isActive ? "true" : "false"}" data-severity="${escapeHtml(severity)}">
      <div class="incident-header">
        <h3 class="incident-title">${escapeHtml(incident.title)}</h3>
        <div class="incident-badges">
          <span class="badge" data-tone="${escapeHtml(severity)}">${escapeHtml(SEVERITY_LABELS[severity])}</span>
          <span class="badge" data-tone="${isActive ? escapeHtml(severity) : "resolved"}">${escapeHtml(INCIDENT_STATUS_LABELS[status])}</span>
        </div>
      </div>
      <p class="incident-summary">${escapeHtml(incident.summary)}</p>
      <p class="incident-meta tabular-nums">${escapeHtml(metaParts.join(" • "))}</p>
      ${updatesHtml ? `<ol class="timeline">${updatesHtml}</ol>` : ""}
    </article>`;
}

export function buildStatusSite() {
  const statusJsonPath = path.join(publicDir, "status.json");
  const rawJson = fs.readFileSync(statusJsonPath, "utf8");
  const data = JSON.parse(rawJson);

  if (!Array.isArray(data.components) || data.components.length === 0) {
    throw new Error("apps/status/public/status.json must define at least one component.");
  }

  const componentNameById = new Map(data.components.map((c) => [c.id, c.name]));
  const overallStatus =
    data.overallStatus in OVERALL_HEADINGS ? data.overallStatus : "operational";
  const overallHeading = OVERALL_HEADINGS[overallStatus];

  const componentsHtml = data.components
    .map((comp) => {
      const tone = comp.status in STATUS_LABELS ? comp.status : "operational";
      const label = STATUS_LABELS[tone];
      return `
        <li class="component-row" data-component-id="${escapeHtml(comp.id)}">
          <div class="component-info">
            <p class="component-name">${escapeHtml(comp.name)}</p>
            <p class="component-desc">${escapeHtml(comp.description)}</p>
          </div>
          <span class="badge" data-tone="${escapeHtml(tone)}" data-component-badge="${escapeHtml(comp.id)}">
            <span class="badge-dot" aria-hidden="true"></span>
            <span data-component-label="${escapeHtml(comp.id)}">${escapeHtml(label)}</span>
          </span>
        </li>`;
    })
    .join("");

  const activeIncidents = Array.isArray(data.activeIncidents) ? data.activeIncidents : [];
  const resolvedIncidents = Array.isArray(data.resolvedIncidents) ? data.resolvedIncidents : [];

  const activeHtml =
    activeIncidents.length > 0
      ? `<div class="incident-list">${activeIncidents.map((inc) => renderIncidentCard(inc, true, componentNameById)).join("")}</div>`
      : `<div class="empty-box" data-testid="status-no-active-incidents">Tidak ada insiden aktif yang dilaporkan saat ini.</div>`;

  const resolvedHtml =
    resolvedIncidents.length > 0
      ? `<div class="incident-list">${resolvedIncidents.map((inc) => renderIncidentCard(inc, false, componentNameById)).join("")}</div>`
      : `<div class="empty-box">Belum ada riwayat insiden terbaru.</div>`;

  const html = `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Status Layanan — ${escapeHtml(data.serviceName ?? "PunyaSitus")}</title>
    <meta name="description" content="Halaman status operasional independen PunyaSitus untuk memantau ketersediaan Situs Publik, Dashboard & CMS, Domain & SSL, Pembayaran, dan Notifikasi Email." />
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23176b51'/%3E%3Ctext x='16' y='21' text-anchor='middle' font-family='sans-serif' font-size='14' font-weight='700' fill='%23ffffff'%3EPS%3C/text%3E%3C/svg%3E" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="site-header">
      <div class="container header-inner">
        <a class="brand" href="./" aria-label="Status Layanan PunyaSitus">
          <span class="brand-mark" aria-hidden="true">PS</span>
          <span class="brand-text">
            <span class="brand-name">Status Layanan PunyaSitus</span>
            <span class="brand-sub">${escapeHtml(data.statusHost ?? "status.punyasitus.com")}</span>
          </span>
        </a>
        <div class="header-actions">
          <button type="button" class="btn" data-refresh-status>Muat Ulang Status</button>
          <a class="btn" href="https://app.punyasitus.com">Buka Dashboard</a>
        </div>
      </div>
    </header>

    <main>
      <div class="container stack">
        <section
          class="overall-banner"
          aria-label="Ringkasan status platform"
          data-overall-banner
          data-status="${escapeHtml(overallStatus)}"
          data-testid="status-overall-banner"
        >
          <div class="overall-top">
            <h1 class="overall-title" data-overall-title>${escapeHtml(overallHeading)}</h1>
            <span class="badge" data-tone="${escapeHtml(overallStatus)}">
              <span class="badge-dot" aria-hidden="true"></span>
              <span>${escapeHtml(STATUS_LABELS[overallStatus])}</span>
            </span>
          </div>
          <p class="overall-summary" data-overall-summary>${escapeHtml(data.overallSummary ?? "")}</p>
          <p class="overall-meta tabular-nums" data-overall-updated>
            Pembaruan status terakhir: ${escapeHtml(formatWib(data.updatedAt))}
          </p>
          <p class="overall-meta tabular-nums" data-last-checked aria-live="polite"></p>
        </section>

        <section aria-label="Status komponen layanan">
          <h2 class="section-heading">Komponen Layanan</h2>
          <div class="card">
            <ul class="component-list" data-testid="status-component-list">
              ${componentsHtml}
            </ul>
          </div>
        </section>

        <section aria-label="Insiden aktif">
          <h2 class="section-heading">Insiden Aktif</h2>
          <div data-active-incidents-container>
            ${activeHtml}
          </div>
        </section>

        <section aria-label="Riwayat insiden terbaru">
          <h2 class="section-heading">Riwayat Insiden Terbaru</h2>
          <div data-resolved-incidents-container>
            ${resolvedHtml}
          </div>
        </section>

        <aside class="independence-note" aria-label="Informasi infrastruktur halaman status">
          Halaman status ini dijalankan sebagai situs statis independen di luar Worker utama PunyaSitus sehingga tetap dapat diakses saat terjadi gangguan layanan inti maupun pemeliharaan terjadwal.
        </aside>
      </div>
    </main>

    <footer class="site-footer">
      <div class="container footer-inner">
        <span>&copy; 2026 PunyaSitus. Seluruh waktu ditampilkan dalam WIB (UTC+7).</span>
        <nav class="footer-links" aria-label="Tautan bantuan">
          <a href="./status.json">Snapshot JSON</a>
          <a href="https://punyasitus.com/bantuan">Pusat Bantuan</a>
          <a href="https://punyasitus.com">punyasitus.com</a>
        </nav>
      </div>
    </footer>

    <script src="./app.js" defer></script>
  </body>
</html>
`;

  const headersFile = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'

/status.json
  Cache-Control: public, max-age=30, must-revalidate
  Content-Type: application/json; charset=utf-8
`;

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), html, "utf8");
  fs.writeFileSync(path.join(distDir, "status.json"), rawJson, "utf8");
  fs.copyFileSync(path.join(srcDir, "styles.css"), path.join(distDir, "styles.css"));
  fs.copyFileSync(path.join(srcDir, "app.js"), path.join(distDir, "app.js"));
  fs.writeFileSync(path.join(distDir, "_headers"), headersFile, "utf8");

  return {
    distDir,
    files: ["index.html", "status.json", "styles.css", "app.js", "_headers"],
    componentCount: data.components.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildStatusSite();
  console.log(
    `[apps/status] Built static status page -> ${result.distDir} (${result.files.length} files, ${result.componentCount} components)`,
  );
}
