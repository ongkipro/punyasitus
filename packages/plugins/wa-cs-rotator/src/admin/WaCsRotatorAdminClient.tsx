import { useState } from "react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  CheckCircle2Icon,
  ClockIcon,
  LockIcon,
  PlusIcon,
  SaveIcon,
  ScaleIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface WaRotatorAdminAgent {
  readonly id: string;
  readonly name: string;
  readonly roleLabel: string;
  readonly phoneE164: string;
  readonly weight: number;
  readonly scheduleDays: readonly number[];
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly isOnShiftNow: boolean;
  readonly totalClicks: number;
}

export interface WaCsRotatorAdminClientProps {
  readonly basePath: string;
  readonly apiBaseUrl: string;
  readonly enabled: boolean;
  readonly initialStrategy: "round_robin" | "weighted";
  readonly initialFallbackPhone: string;
  readonly initialTimezone: string;
  readonly initialFallbackClicks: number;
  readonly initialAgents: readonly WaRotatorAdminAgent[];
  readonly permissions: {
    readonly roleLabel: string;
    readonly isLocked: boolean;
    readonly canManagePlugins: boolean;
  };
}

const DAY_LABELS: readonly { readonly day: number; readonly short: string; readonly full: string }[] =
  [
    { day: 1, short: "Sen", full: "Senin" },
    { day: 2, short: "Sel", full: "Selasa" },
    { day: 3, short: "Rab", full: "Rabu" },
    { day: 4, short: "Kam", full: "Kamis" },
    { day: 5, short: "Jum", full: "Jumat" },
    { day: 6, short: "Sab", full: "Sabtu" },
    { day: 0, short: "Min", full: "Minggu" },
  ];

function formatDaysSummary(days: readonly number[]): string {
  const set = new Set(days);
  const labels = DAY_LABELS.filter((d) => set.has(d.day)).map((d) => d.short);
  return labels.length > 0 ? labels.join(", ") : "Tidak ada hari";
}

export function WaCsRotatorAdminClient({
  basePath,
  apiBaseUrl,
  enabled: initialEnabled,
  initialStrategy,
  initialFallbackPhone,
  initialTimezone,
  initialFallbackClicks,
  initialAgents,
  permissions,
}: WaCsRotatorAdminClientProps) {
  const [enabled] = useState(initialEnabled);
  const [strategy, setStrategy] = useState<"round_robin" | "weighted">(initialStrategy);
  const [fallbackPhone, setFallbackPhone] = useState(initialFallbackPhone);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [agents, setAgents] = useState<WaRotatorAdminAgent[]>([...initialAgents]);
  const [fallbackClicks] = useState(initialFallbackClicks);

  // Add agent form state
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState("Sales CS");
  const [agentPhone, setAgentPhone] = useState("");
  const [agentWeight, setAgentWeight] = useState(1);
  const [agentStart, setAgentStart] = useState("08:00");
  const [agentEnd, setAgentEnd] = useState("17:00");
  const [agentDays, setAgentDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);

  const [savingSettings, setSavingSettings] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [notice, setNotice] = useState<{
    readonly variant: "success" | "destructive" | "info";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  const onShiftCount = agents.filter((a) => a.isActive && a.isOnShiftNow).length;
  const totalAgentClicks = agents.reduce((sum, a) => sum + a.totalClicks, 0);
  const totalAllClicks = totalAgentClicks + fallbackClicks;

  function toggleDay(dayNum: number) {
    setAgentDays((prev) =>
      prev.includes(dayNum)
        ? prev.filter((d) => d !== dayNum)
        : [...prev, dayNum].sort((a, b) => a - b),
    );
  }

  async function handleSaveSettings(event: { readonly preventDefault: () => void }) {
    event.preventDefault();
    if (!permissions.canManagePlugins || savingSettings) return;
    setSavingSettings(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy,
          fallbackWhatsappPhone: fallbackPhone,
          timezone,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly state?: {
          readonly strategy?: "round_robin" | "weighted";
          readonly fallbackWhatsappPhone?: string;
          readonly timezone?: string;
        };
        readonly error?: { readonly message?: string };
      };
      if (!response.ok) {
        setNotice({
          variant: "destructive",
          title: "Gagal menyimpan strategi rotasi",
          description: data.error?.message ?? "Periksa kembali pengaturan rotator.",
        });
        return;
      }
      if (data.state?.strategy) setStrategy(data.state.strategy);
      if (typeof data.state?.fallbackWhatsappPhone === "string") {
        setFallbackPhone(data.state.fallbackWhatsappPhone);
      }
      if (typeof data.state?.timezone === "string") {
        setTimezone(data.state.timezone);
      }
      setNotice({
        variant: "success",
        title: "Pengaturan rotator tersimpan",
        description:
          (data.state?.strategy ?? strategy) === "weighted"
            ? "Distribusi WhatsApp kini menggunakan mode Berbobot (Weighted Round-Robin)."
            : "Distribusi WhatsApp kini menggunakan mode Giliran Merata (Round-Robin).",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Pengaturan belum tersimpan. Silakan coba lagi.",
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleAddAgent(event: { readonly preventDefault: () => void }) {
    event.preventDefault();
    if (!permissions.canManagePlugins || addingAgent) return;
    setAddingAgent(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: agentName,
          roleLabel: agentRole,
          phone: agentPhone,
          weight: agentWeight,
          scheduleDays: agentDays,
          startTime: agentStart,
          endTime: agentEnd,
          timezone,
          isActive: true,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly agent?: WaRotatorAdminAgent;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.agent) {
        setNotice({
          variant: "destructive",
          title: "Gagal menambahkan agen CS",
          description:
            data.error?.message ?? "Pastikan nomor WhatsApp Indonesia (08.../+628...) dan jam aktif valid.",
        });
        return;
      }
      setAgents((prev) => [...prev, data.agent!]);
      setAgentName("");
      setAgentPhone("");
      setAgentWeight(1);
      setNotice({
        variant: "success",
        title: "Agen CS ditambahkan",
        description: `${data.agent.name} siap menerima distribusi klik WhatsApp sesuai jam aktif.`,
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Data agen belum tersimpan. Silakan coba kembali.",
      });
    } finally {
      setAddingAgent(false);
    }
  }

  async function handleToggleAgent(agent: WaRotatorAdminAgent) {
    if (!permissions.canManagePlugins) return;
    try {
      const response = await fetch(`${apiBaseUrl}/agents/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !agent.isActive }),
      });
      if (!response.ok) return;
      setAgents((prev) =>
        prev.map((row) => (row.id === agent.id ? { ...row, isActive: !row.isActive } : row)),
      );
    } catch {
      // Keep UI responsive
    }
  }

  async function handleDeleteAgent(agent: WaRotatorAdminAgent) {
    if (!permissions.canManagePlugins) return;
    try {
      const response = await fetch(`${apiBaseUrl}/agents/${encodeURIComponent(agent.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) return;
      setAgents((prev) => prev.filter((row) => row.id !== agent.id));
      setNotice({
        variant: "info",
        title: "Agen dihapus",
        description: `Agen ${agent.name} telah dikeluarkan dari rotasi WhatsApp.`,
      });
    } catch {
      // Keep UI responsive
    }
  }

  return (
    <section
      className="space-y-6"
      data-testid="wa-rotator-admin-shell"
      aria-labelledby="wa-rotator-admin-heading"
    >
      {/* Top action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 px-2 md:min-h-8"
          render={<a href={`${basePath}/plugins`} />}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Kembali ke daftar Plugin
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={enabled ? "success" : "outline"}>
            {enabled ? (
              <>
                <CheckCircle2Icon className="size-3" aria-hidden="true" />
                Aktif
              </>
            ) : (
              "Nonaktif (Kembali ke WA Tunggal)"
            )}
          </Badge>
          <Badge variant="secondary">Add-on Pro</Badge>
        </div>
      </div>

      {/* Heading */}
      <div className="space-y-1">
        <h1
          id="wa-rotator-admin-heading"
          className="text-xl font-semibold tracking-tight text-foreground"
        >
          WhatsApp CS Rotator
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Distribusikan klik WhatsApp secara otomatis ke beberapa agen sales berdasarkan giliran
          merata, bobot, dan jadwal jam aktif. Jika seluruh agen sedang di luar jam shift atau
          plugin dinonaktifkan, situs otomatis kembali ke nomor WhatsApp utama.
        </p>
      </div>

      {/* Guardrail alerts */}
      {permissions.isLocked ? (
        <Alert variant="warning" data-testid="wa-rotator-locked-alert">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Langganan terkunci (Mode hanya-baca)</AlertTitle>
          <AlertDescription>
            Perpanjang langganan untuk menambah agen atau mengubah jadwal rotasi WhatsApp.
          </AlertDescription>
        </Alert>
      ) : !permissions.canManagePlugins ? (
        <Alert variant="info">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode lihat saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription>
            Hubungi Pemilik Situs atau Admin untuk mengelola agen CS WhatsApp.
          </AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant={notice.variant} data-testid="wa-rotator-admin-notice">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Agen Sedang Bertugas</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="wa-kpi-onshift">
              {onShiftCount} / {agents.length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Klik Terdistribusi ke Agen</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="wa-kpi-agent-clicks">
              {totalAgentClicks}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Klik Fallback WA Utama</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="wa-kpi-fallback-clicks">
              {fallbackClicks}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Mode Distribusi</CardDescription>
            <CardTitle className="text-lg">
              {strategy === "weighted" ? "Berbobot (Weighted)" : "Round-Robin"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Strategy & Fallback Form */}
        <Card className="min-w-0 lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScaleIcon className="size-4 text-primary" aria-hidden="true" />
              Strategi & Nomor Cadangan
            </CardTitle>
            <CardDescription>
              Atur algoritma rotasi serta nomor WhatsApp cadangan saat seluruh agen sedang libur.
            </CardDescription>
          </CardHeader>
          <form onSubmit={(e) => void handleSaveSettings(e)}>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="wa-strategy" className="text-sm font-medium text-foreground">
                  Strategi Distribusi
                </label>
                <select
                  id="wa-strategy"
                  className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                  value={strategy}
                  disabled={!permissions.canManagePlugins || savingSettings}
                  onChange={(e) =>
                    setStrategy(e.target.value === "weighted" ? "weighted" : "round_robin")
                  }
                >
                  <option value="round_robin">Round-Robin (Giliran Merata)</option>
                  <option value="weighted">Berbobot (Smooth Weighted)</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="wa-fallback-phone" className="text-sm font-medium text-foreground">
                  Nomor WhatsApp Utama (Fallback)
                </label>
                <Input
                  id="wa-fallback-phone"
                  value={fallbackPhone}
                  disabled={!permissions.canManagePlugins || savingSettings}
                  onChange={(e) => setFallbackPhone(e.target.value)}
                  placeholder="081234567890"
                />
                <p className="text-xs text-muted-foreground">
                  Disarankan diisi agar rute publik /wa-rotator selalu memiliki nomor cadangan
                  otomatis saat seluruh agen di luar jam aktif atau di bawah isolasi database plugin.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="wa-timezone" className="text-sm font-medium text-foreground">
                  Zona Waktu Jadwal
                </label>
                <select
                  id="wa-timezone"
                  className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                  value={timezone}
                  disabled={!permissions.canManagePlugins || savingSettings}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  <option value="Asia/Jakarta">Asia/Jakarta (WIB / UTC+7)</option>
                  <option value="Asia/Makassar">Asia/Makassar (WITA / UTC+8)</option>
                  <option value="Asia/Jayapura">Asia/Jayapura (WIT / UTC+9)</option>
                </select>
              </div>
            </CardContent>
            <CardFooter className="justify-end">
              <Button
                type="submit"
                size="sm"
                className="min-h-11 md:min-h-9"
                disabled={!permissions.canManagePlugins || savingSettings}
              >
                <SaveIcon className="size-4" aria-hidden="true" />
                {savingSettings ? "Menyimpan..." : "Simpan Strategi"}
              </Button>
            </CardFooter>
          </form>
        </Card>

        {/* Agent Builder + Attribution Table */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UsersIcon className="size-4 text-primary" aria-hidden="true" />
                Tambah Agen Sales CS
              </CardTitle>
              <CardDescription>
                Nomor wajib berformat seluler Indonesia (08... atau +628...). Jadwal jam aktif
                mengikuti zona waktu situs.
              </CardDescription>
            </CardHeader>
            <form onSubmit={(e) => void handleAddAgent(e)}>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label htmlFor="wa-agent-name" className="text-sm font-medium text-foreground">
                      Nama Agen
                    </label>
                    <Input
                      id="wa-agent-name"
                      value={agentName}
                      disabled={!permissions.canManagePlugins || addingAgent}
                      onChange={(e) => setAgentName(e.target.value)}
                      placeholder="Contoh: Rina Wijaya"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="wa-agent-role" className="text-sm font-medium text-foreground">
                      Label Peran
                    </label>
                    <Input
                      id="wa-agent-role"
                      value={agentRole}
                      disabled={!permissions.canManagePlugins || addingAgent}
                      onChange={(e) => setAgentRole(e.target.value)}
                      placeholder="Sales CS / Admin Pemesanan"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="wa-agent-phone" className="text-sm font-medium text-foreground">
                      Nomor WhatsApp Agen
                    </label>
                    <Input
                      id="wa-agent-phone"
                      value={agentPhone}
                      disabled={!permissions.canManagePlugins || addingAgent}
                      onChange={(e) => setAgentPhone(e.target.value)}
                      placeholder="081234567890"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="wa-agent-weight" className="text-sm font-medium text-foreground">
                      Bobot Distribusi (1–100)
                    </label>
                    <Input
                      id="wa-agent-weight"
                      type="number"
                      min={1}
                      max={100}
                      value={agentWeight}
                      disabled={!permissions.canManagePlugins || addingAgent}
                      onChange={(e) => setAgentWeight(Math.max(1, Number(e.target.value) || 1))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="wa-agent-start" className="text-sm font-medium text-foreground">
                      Jam Mulai Aktif
                    </label>
                    <Input
                      id="wa-agent-start"
                      type="time"
                      value={agentStart}
                      disabled={!permissions.canManagePlugins || addingAgent}
                      onChange={(e) => setAgentStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="wa-agent-end" className="text-sm font-medium text-foreground">
                      Jam Selesai Aktif
                    </label>
                    <Input
                      id="wa-agent-end"
                      type="time"
                      value={agentEnd}
                      disabled={!permissions.canManagePlugins || addingAgent}
                      onChange={(e) => setAgentEnd(e.target.value)}
                    />
                  </div>
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-foreground">Hari Aktif Shift</legend>
                  <div className="flex flex-wrap gap-2">
                    {DAY_LABELS.map((item) => {
                      const checkboxId = `wa-agent-day-${item.day}`;
                      const checked = agentDays.includes(item.day);
                      return (
                        <label
                          key={item.day}
                          htmlFor={checkboxId}
                          className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground"
                        >
                          <input
                            id={checkboxId}
                            type="checkbox"
                            className="size-3.5 accent-primary"
                            checked={checked}
                            disabled={!permissions.canManagePlugins || addingAgent}
                            onChange={() => toggleDay(item.day)}
                          />
                          <span>{item.short}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </CardContent>
              <CardFooter className="justify-end">
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={!permissions.canManagePlugins || addingAgent}
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  {addingAgent ? "Menambahkan..." : "Tambah Agen"}
                </Button>
              </CardFooter>
            </form>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3Icon className="size-4 text-primary" aria-hidden="true" />
                Atribusi Klik per Agen & Jadwal Shift
              </CardTitle>
              <CardDescription>
                Statistik klik pihak pertama tanpa menyimpan nomor atau data pribadi pengunjung.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {agents.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  Belum ada agen CS. Semua klik WhatsApp saat ini diarahkan ke nomor fallback utama.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agen</TableHead>
                      <TableHead>Jadwal</TableHead>
                      <TableHead className="text-right">Bobot</TableHead>
                      <TableHead className="text-right">Klik</TableHead>
                      <TableHead className="text-right">Aksi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agents.map((agent) => {
                      const share =
                        totalAllClicks > 0
                          ? Math.round((agent.totalClicks / totalAllClicks) * 1000) / 10
                          : 0;
                      return (
                        <TableRow key={agent.id} data-testid={`wa-admin-agent-${agent.id}`}>
                          <TableCell>
                            <div className="space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
                                <span>{agent.name}</span>
                                <Badge
                                  variant={
                                    !agent.isActive
                                      ? "outline"
                                      : agent.isOnShiftNow
                                        ? "success"
                                        : "warning"
                                  }
                                >
                                  {!agent.isActive
                                    ? "Nonaktif"
                                    : agent.isOnShiftNow
                                      ? "Bertugas"
                                      : "Luar Jam"}
                                </Badge>
                              </div>
                              <p className="font-mono text-xs text-muted-foreground">
                                +{agent.phoneE164} · {agent.roleLabel}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
                              <span>
                                {agent.startTime}–{agent.endTime}
                              </span>
                            </div>
                            <p>{formatDaysSummary(agent.scheduleDays)}</p>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {agent.weight}x
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {agent.totalClicks}{" "}
                            <span className="text-xs text-muted-foreground">({share}%)</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!permissions.canManagePlugins}
                                onClick={() => void handleToggleAgent(agent)}
                              >
                                {agent.isActive ? "Jeda" : "Aktifkan"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Hapus agen ${agent.name}`}
                                disabled={!permissions.canManagePlugins}
                                onClick={() => void handleDeleteAgent(agent)}
                              >
                                <Trash2Icon className="size-3.5 text-destructive" aria-hidden="true" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
