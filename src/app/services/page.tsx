"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Cpu,
  Gauge,
  Globe,
  HardDrive,
  Lock,
  MemoryStick,
  PauseCircle,
  PlayCircle,
  Server,
  ShieldCheck,
} from "lucide-react";
import { EmptyState, Eyebrow, Panel, Pill, SectionHeader, Skeleton, rise } from "@/components/ui/kit";
import type { MonitoringSnapshot, ProbeStatus, ServiceStatus } from "@/lib/monitoring";

type Tone = "up" | "down" | "warn" | "neutral" | "accent";

function statusTone(status: ProbeStatus | null): Tone {
  if (status === "up") return "up";
  if (status === "down") return "down";
  if (status === "degraded") return "warn";
  return "neutral";
}

function statusLabel(status: ProbeStatus | null): string {
  return status ?? "—";
}

function timeAgo(d: string | null): string {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface HostMetrics {
  cpu_load1: number;
  cpu_load5: number;
  cpu_load15: number;
  ram_pct: number;
  disk_pct: number | null;
  net_rx_mb: number;
  net_tx_mb: number;
}

function parseHostMetrics(metric: string | null): HostMetrics | null {
  if (!metric) return null;
  try {
    const m = JSON.parse(metric) as HostMetrics;
    if (typeof m.ram_pct !== "number") return null;
    return m;
  } catch {
    return null;
  }
}

function barColor(pct: number): string {
  if (pct >= 90) return "var(--down)";
  if (pct >= 75) return "var(--warn)";
  return "var(--up)";
}

function MetricBar({ label, pct, icon }: { label: string; pct: number | null; icon: React.ReactNode }) {
  const value = pct ?? 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-[var(--text-3)]">
        <span className="flex items-center gap-1.5">{icon}{label}</span>
        <span className="num font-medium text-[var(--text)]">{pct != null ? `${pct}%` : "—"}</span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--line)_60%,transparent)]">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(value, 100)}%`, background: barColor(value) }} />
      </div>
    </div>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <Panel className="p-5">
      <Eyebrow>{label}</Eyebrow>
      <div className="num mt-2 text-[32px] font-semibold leading-none tracking-[-0.02em]" style={{ color: tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : tone === "warn" ? "var(--warn)" : "var(--text)" }}>
        {value}
      </div>
    </Panel>
  );
}

function HostMetricsPanel({ service }: { service: ServiceStatus | undefined }) {
  const metrics = service ? parseHostMetrics(service.latest?.metric ?? null) : null;
  if (!metrics) {
    return (
      <Panel className="p-5">
        <SectionHeader label="Host metrics" title="Hermes host" />
        <EmptyState icon={<Cpu className="h-6 w-6" />} title="No host metrics yet" hint="The host probe runs every 60s." />
      </Panel>
    );
  }
  return (
    <Panel className="p-5">
      <SectionHeader
        label="Host metrics"
        title="Hermes host (CPU · RAM · disk · net)"
        action={service ? <Pill tone={statusTone(service.latest?.status ?? null)}>{statusLabel(service.latest?.status ?? null)}</Pill> : undefined}
      />
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="rounded-[var(--r-sm)] border border-[var(--line)] p-4">
          <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--text-3)]"><Gauge className="h-3.5 w-3.5" />CPU load (1/5/15m)</div>
          <div className="num mt-2 flex items-baseline gap-3">
            <span className="text-[26px] font-semibold text-[var(--text)]">{metrics.cpu_load1.toFixed(2)}</span>
            <span className="text-[12px] text-[var(--text-4)]">{metrics.cpu_load5.toFixed(2)} · {metrics.cpu_load15.toFixed(2)}</span>
          </div>
        </Panel>
        <Panel className="rounded-[var(--r-sm)] border border-[var(--line)] p-4">
          <MetricBar label="RAM used" pct={metrics.ram_pct} icon={<MemoryStick className="h-3.5 w-3.5" />} />
          <div className="mt-3"><MetricBar label="Disk /" pct={metrics.disk_pct} icon={<HardDrive className="h-3.5 w-3.5" />} /></div>
        </Panel>
        <Panel className="rounded-[var(--r-sm)] border border-[var(--line)] p-4">
          <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--text-3)]"><Activity className="h-3.5 w-3.5" />Network (cumulative)</div>
          <div className="num mt-2 text-[13px] text-[var(--text-2)]">↓ {metrics.net_rx_mb.toLocaleString()} MB</div>
          <div className="num mt-1 text-[13px] text-[var(--text-2)]">↑ {metrics.net_tx_mb.toLocaleString()} MB</div>
        </Panel>
      </div>
    </Panel>
  );
}

export default function ServicesPage() {
  const [data, setData] = useState<MonitoringSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/services", { cache: "no-store" });
      if (!res.ok) {
        setError(`Services API ${res.status}`);
        return;
      }
      const snap = (await res.json()) as MonitoringSnapshot;
      setData(snap);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const toggleMaintenance = useCallback(async (probeId: string, active: boolean) => {
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ probe_id: probeId, active }),
      });
      if (!res.ok) throw new Error(`POST ${res.status}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to toggle maintenance");
    }
  }, [load]);

  const globalTone: Tone =
    data?.global_status === "critical" ? "down" : data?.global_status === "warning" ? "warn" : "up";

  const hostService = data?.services.find((s) => s.probe.kind === "server");
  const sslServices = data?.services.filter((s) => s.probe.kind === "ssl") ?? [];
  const nonSslServices = data?.services.filter((s) => s.probe.kind !== "ssl" && s.probe.kind !== "server") ?? [];

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-10 flex flex-wrap items-end justify-between gap-6" style={rise(0)}>
        <div>
          <Eyebrow>Infrastructure</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--hq-text)]">
            Services
          </h1>
          <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-[var(--hq-text-ghost)]">
            CheckCle-style monitoring of every internal + external service: model seats, the Hermes gateway, Qdrant, the goal conveyor, host resources, the RT / Supabase plane, source APIs, and Vercel deployments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <Pill tone={globalTone}>
              {globalTone === "up" ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
              {data.global_status}
            </Pill>
          )}
          <Pill tone="neutral">updated {data ? timeAgo(data.generated_ts) : "…"}</Pill>
        </div>
      </div>

      {error && (
        <Panel className="mb-5 p-5">
          <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title="Services unavailable" hint={error} />
        </Panel>
      )}

      {!loaded && !data ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
          <Skeleton className="h-80 lg:col-span-4" />
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
            <MetricTile label="Total services" value={String(data.total)} tone="neutral" />
            <MetricTile label="Up" value={String(data.up)} tone="up" />
            <MetricTile label="Degraded" value={String(data.degraded)} tone="warn" />
            <MetricTile label="Down" value={String(data.down)} tone="down" />
          </div>

          <div className="mt-8">
            <HostMetricsPanel service={hostService} />
          </div>

          <Panel className="mt-8 overflow-hidden p-5">
            <SectionHeader
              label="Service board"
              title="All services"
              action={
                <Pill tone="neutral">
                  <Server className="h-3 w-3" />
                  {data.services.filter((s) => s.probe.group === "internal").length} internal · {data.services.filter((s) => s.probe.group === "external").length} external
                </Pill>
              }
            />
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[1100px] text-left">
                <thead className="border-b border-[var(--line)] text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-4)]">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Service</th>
                    <th className="px-3 py-2 font-semibold">Target</th>
                    <th className="px-3 py-2 text-right font-semibold">Latency</th>
                    <th className="px-3 py-2 text-right font-semibold">24h</th>
                    <th className="px-3 py-2 text-right font-semibold">7d</th>
                    <th className="px-3 py-2 text-right font-semibold">30d</th>
                    <th className="py-2 pl-3 font-semibold">Detail</th>
                    <th className="py-2 pl-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {nonSslServices.map((service) => {
                    const tone = statusTone(service.latest?.status ?? null);
                    const isInternal = service.probe.group === "internal";
                    return (
                      <tr key={service.probe.id} className="text-[12px] text-[var(--text-2)]">
                        <td className="py-3 pr-3">
                          {service.maintenance ? (
                            <Pill tone="neutral" className="!py-0.5 !text-[10px]"><PauseCircle className="h-3 w-3" />paused</Pill>
                          ) : (
                            <Pill tone={tone} className="!py-0.5 !text-[10px]">{statusLabel(service.latest?.status ?? null)}</Pill>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            {isInternal ? <Server className="h-3.5 w-3.5 shrink-0 text-[var(--text-3)]" /> : <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--text-3)]" />}
                            <div className="min-w-0">
                              <p className="truncate text-[var(--text)]">{service.probe.name}</p>
                              <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-4)]">
                                {service.probe.group} · {service.probe.kind} · {service.probe.cadenceSeconds}s
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="max-w-[240px] px-3 py-3 font-mono text-[11px] text-[var(--text-3)]">{service.probe.target}</td>
                        <td className="num px-3 py-3 text-right">{service.latest?.latency_ms != null ? `${service.latest.latency_ms}ms` : "—"}</td>
                        <td className="num px-3 py-3 text-right">{service.uptimePct24h != null ? `${service.uptimePct24h}%` : "—"}</td>
                        <td className="num px-3 py-3 text-right">{service.uptimePct7d != null ? `${service.uptimePct7d}%` : "—"}</td>
                        <td className="num px-3 py-3 text-right">{service.uptimePct30d != null ? `${service.uptimePct30d}%` : "—"}</td>
                        <td className="max-w-[260px] py-3 pl-3">
                          {service.latest?.metric && <p className="truncate font-mono text-[11px] text-[var(--text-3)]">{service.latest.metric}</p>}
                          {service.latest?.error && <p className="truncate font-mono text-[11px] text-[var(--down)]" title={service.latest.error}>{service.latest.error}</p>}
                        </td>
                        <td className="py-3 pl-3 text-right">
                          <button
                            type="button"
                            onClick={() => toggleMaintenance(service.probe.id, !service.maintenance)}
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--text-2)] transition-colors hover:border-[var(--up)] hover:text-[var(--text)]"
                            title={service.maintenance ? "Resume monitoring" : "Pause monitoring"}
                          >
                            {service.maintenance ? <><PlayCircle className="h-3 w-3" />Resume</> : <><PauseCircle className="h-3 w-3" />Pause</>}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel className="mt-8 p-5">
            <SectionHeader
              label="SSL & domains"
              title="TLS certificates"
              action={<Pill tone="neutral"><Lock className="h-3 w-3" />{sslServices.length} monitored</Pill>}
            />
            {sslServices.length === 0 ? (
              <EmptyState icon={<Lock className="h-6 w-6" />} title="No SSL probes" hint="Add SSL probes to track issuer + expiry." />
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                {sslServices.map((service) => {
                  const tone = statusTone(service.latest?.status ?? null);
                  return (
                    <div key={service.probe.id} className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--line)] p-4">
                      <div className="flex items-center gap-3">
                        <Lock className="h-4 w-4 shrink-0 text-[var(--text-3)]" />
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[12.5px] text-[var(--text)]">{service.probe.target}</p>
                          <p className="mt-0.5 truncate text-[11px] text-[var(--text-3)]">{service.latest?.metric ?? "pending first check"}</p>
                        </div>
                      </div>
                      <Pill tone={tone} className="!py-0.5 !text-[10px]">{statusLabel(service.latest?.status ?? null)}</Pill>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel className="mt-8 p-5">
            <SectionHeader
              label="Incidents"
              title="Open incidents"
              action={<Pill tone={data.open_incidents.length ? "down" : "up"}>{data.open_incidents.length} open</Pill>}
            />
            {data.open_incidents.length === 0 ? (
              <EmptyState icon={<ShieldCheck className="h-6 w-6" />} title="No open incidents" hint="Every service is currently passing its checks." />
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-3">
                {data.open_incidents.map((incident) => (
                  <div key={incident.id} className="rounded-[var(--r-md)] border border-[color-mix(in_srgb,var(--down)_24%,transparent)] bg-[color-mix(in_srgb,var(--down)_8%,transparent)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--down)]" />
                        <p className="text-[14px] font-medium text-[var(--text)]">{incident.probe_name}</p>
                      </div>
                      <Pill tone="down" className="!py-0.5 !text-[10px]">{incident.last_status}</Pill>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--text-3)]">opened {timeAgo(incident.opened_ts)}</p>
                    {incident.last_error && <p className="mt-1 font-mono text-[11px] text-[var(--down)]">{incident.last_error}</p>}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="mt-8 p-5">
            <SectionHeader
              label="History"
              title="Recent incidents"
              action={<Pill tone="neutral"><CalendarClock className="h-3 w-3" />{data.recent_incidents.length} resolved</Pill>}
            />
            {data.recent_incidents.length === 0 ? (
              <EmptyState icon={<CalendarClock className="h-6 w-6" />} title="No incident history" hint="Resolved incidents will appear here." />
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left">
                  <thead className="border-b border-[var(--line)] text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-4)]">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">Service</th>
                      <th className="px-3 py-2 font-semibold">Opened</th>
                      <th className="px-3 py-2 font-semibold">Resolved</th>
                      <th className="px-3 py-2 font-semibold">Last status</th>
                      <th className="py-2 pl-3 font-semibold">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {data.recent_incidents.map((incident) => (
                      <tr key={incident.id} className="text-[12px] text-[var(--text-2)]">
                        <td className="py-2.5 pr-3 text-[var(--text)]">{incident.probe_name}</td>
                        <td className="px-3 py-2.5 text-[var(--text-3)]">{timeAgo(incident.opened_ts)}</td>
                        <td className="px-3 py-2.5 text-[var(--text-3)]">{incident.resolved_ts ? timeAgo(incident.resolved_ts) : "—"}</td>
                        <td className="px-3 py-2.5"><Pill tone={statusTone(incident.last_status)} className="!py-0.5 !text-[10px]">{incident.last_status}</Pill></td>
                        <td className="max-w-[280px] py-2.5 pl-3 font-mono text-[11px] text-[var(--text-3)]">{incident.last_error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
