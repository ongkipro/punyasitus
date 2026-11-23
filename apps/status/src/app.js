/* Progressive enhancement for status.punyasitus.com — safe DOM updates only (zero innerHTML) */
(() => {
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

  function escapeSelectorValue(value) {
    const str = String(value);
    if (typeof window !== "undefined" && window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(str);
    }
    return str.replace(/[^A-Za-z0-9_-]/g, "\\$&");
  }

  function formatWib(iso) {
    try {
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
    } catch {
      return String(iso);
    }
  }

  function createBadge(text, tone) {
    const span = document.createElement("span");
    span.className = "badge";
    span.setAttribute("data-tone", tone);
    span.textContent = text;
    return span;
  }

  function buildIncidentCardNode(incident, isActive, componentNameById) {
    const severity = incident.severity in SEVERITY_LABELS ? incident.severity : "minor";
    const status = incident.status in INCIDENT_STATUS_LABELS ? incident.status : "investigating";

    const article = document.createElement("article");
    article.className = "incident-card";
    article.setAttribute("data-active", isActive ? "true" : "false");
    article.setAttribute("data-severity", severity);

    const header = document.createElement("div");
    header.className = "incident-header";

    const title = document.createElement("h3");
    title.className = "incident-title";
    title.textContent = String(incident.title || "");

    const badges = document.createElement("div");
    badges.className = "incident-badges";
    badges.appendChild(createBadge(SEVERITY_LABELS[severity], severity));
    badges.appendChild(createBadge(INCIDENT_STATUS_LABELS[status], isActive ? severity : "resolved"));

    header.appendChild(title);
    header.appendChild(badges);
    article.appendChild(header);

    const summary = document.createElement("p");
    summary.className = "incident-summary";
    summary.textContent = String(incident.summary || "");
    article.appendChild(summary);

    const affectedNames = Array.isArray(incident.affectedComponents)
      ? incident.affectedComponents.map((id) => componentNameById.get(id) || String(id))
      : [];
    const metaParts = [
      `Mulai: ${formatWib(incident.declaredAt)}`,
      incident.resolvedAt ? `Selesai: ${formatWib(incident.resolvedAt)}` : null,
      affectedNames.length > 0 ? `Komponen: ${affectedNames.join(", ")}` : null,
    ].filter(Boolean);

    const meta = document.createElement("p");
    meta.className = "incident-meta tabular-nums";
    meta.textContent = metaParts.join(" • ");
    article.appendChild(meta);

    if (Array.isArray(incident.updates) && incident.updates.length > 0) {
      const timeline = document.createElement("ol");
      timeline.className = "timeline";
      for (const u of incident.updates) {
        const li = document.createElement("li");
        li.className = "timeline-item";

        const head = document.createElement("div");
        head.className = "timeline-head";

        const st = document.createElement("span");
        st.className = "timeline-status";
        st.textContent = INCIDENT_STATUS_LABELS[u.status] || String(u.status || "");

        const tm = document.createElement("time");
        tm.className = "timeline-time tabular-nums";
        tm.setAttribute("datetime", String(u.timestamp || ""));
        tm.textContent = formatWib(u.timestamp);

        head.appendChild(st);
        head.appendChild(tm);

        const msg = document.createElement("p");
        msg.className = "timeline-msg";
        msg.textContent = String(u.message || "");

        li.appendChild(head);
        li.appendChild(msg);
        timeline.appendChild(li);
      }
      article.appendChild(timeline);
    }

    return article;
  }

  function renderIncidentsSection(container, incidents, isActive, emptyText, componentNameById) {
    if (!container) return;
    const frag = document.createDocumentFragment();
    if (!Array.isArray(incidents) || incidents.length === 0) {
      const box = document.createElement("div");
      box.className = "empty-box";
      if (isActive) box.setAttribute("data-testid", "status-no-active-incidents");
      box.textContent = emptyText;
      frag.appendChild(box);
    } else {
      const list = document.createElement("div");
      list.className = "incident-list";
      for (const inc of incidents) {
        list.appendChild(buildIncidentCardNode(inc, isActive, componentNameById));
      }
      frag.appendChild(list);
    }
    container.replaceChildren(frag);
  }

  const refreshBtn = document.querySelector("[data-refresh-status]");
  const lastCheckedEl = document.querySelector("[data-last-checked]");
  const overallBanner = document.querySelector("[data-overall-banner]");
  const overallTitle = document.querySelector("[data-overall-title]");
  const overallSummary = document.querySelector("[data-overall-summary]");
  const overallUpdated = document.querySelector("[data-overall-updated]");
  const activeIncidentsContainer = document.querySelector("[data-active-incidents-container]");
  const resolvedIncidentsContainer = document.querySelector("[data-resolved-incidents-container]");

  if (!refreshBtn) return;

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.setAttribute("disabled", "true");
    refreshBtn.textContent = "Memuat ulang...";
    try {
      const res = await fetch(`./status.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP_" + res.status);
      const data = await res.json();

      if (overallBanner && typeof data.overallStatus === "string") {
        overallBanner.setAttribute("data-status", data.overallStatus);
      }
      if (overallTitle && typeof data.overallStatus === "string") {
        overallTitle.textContent =
          OVERALL_HEADINGS[data.overallStatus] || OVERALL_HEADINGS.operational;
      }
      if (overallSummary && typeof data.overallSummary === "string") {
        overallSummary.textContent = data.overallSummary;
      }
      if (overallUpdated && typeof data.updatedAt === "string") {
        overallUpdated.textContent = `Pembaruan status terakhir: ${formatWib(data.updatedAt)}`;
      }

      const componentNameById = new Map();
      if (Array.isArray(data.components)) {
        for (const comp of data.components) {
          if (typeof comp.id !== "string") continue;
          componentNameById.set(comp.id, String(comp.name || comp.id));
          const safeId = escapeSelectorValue(comp.id);
          const badge = document.querySelector(`[data-component-badge="${safeId}"]`);
          const label = document.querySelector(`[data-component-label="${safeId}"]`);
          if (badge && typeof comp.status === "string") {
            badge.setAttribute("data-tone", comp.status);
          }
          if (label && typeof comp.status === "string") {
            label.textContent = STATUS_LABELS[comp.status] || STATUS_LABELS.operational;
          }
        }
      }

      renderIncidentsSection(
        activeIncidentsContainer,
        data.activeIncidents,
        true,
        "Tidak ada insiden aktif yang dilaporkan saat ini.",
        componentNameById,
      );
      renderIncidentsSection(
        resolvedIncidentsContainer,
        data.resolvedIncidents,
        false,
        "Belum ada riwayat insiden terbaru.",
        componentNameById,
      );

      if (lastCheckedEl) {
        lastCheckedEl.textContent = `Diperiksa pada ${formatWib(new Date().toISOString())}`;
      }
    } catch {
      if (lastCheckedEl) {
        lastCheckedEl.textContent =
          "Gagal menyegarkan data terbaru; menampilkan snapshot status terakhir.";
      }
    } finally {
      refreshBtn.removeAttribute("disabled");
      refreshBtn.textContent = "Muat Ulang Status";
    }
  });
})();
