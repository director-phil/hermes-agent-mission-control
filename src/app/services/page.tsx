"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Globe, Server, ShieldCheck } from "lucide-react";
import { EmptyState, Eyebrow, Panel, Pill, SectionHeader, Skeleton, rise } from "@/components/ui/kit";
import type { MonitoringSnapshot, ProbeStatus } from "@/lib/monitoring";

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

  const globalTone: Tone =
    data?.global_status === "critical" ? "down" : data?.global_status === "warning" ? "warn" : "up";

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <div className="hq-rise pt-4 pb-10 flex flex-wrap items-end justify-between gap-6" style={rise(0)}>
        <div>
          <Eyebrow>Infrastructure</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--hq-text)]">
            Services
          </h1>
          <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-[var(--hq-text-ghost)]">
            Live probe of every internal + external service: model seats, the Hermes gateway, Qdrant, the goal conveyor, and the RT / Supabase plane.
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
              <table className="w-full min-w-[900px] text-left">
                <thead className="border-b border-[var(--line)] text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-4)]">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Service</th>
                    <th className="px-3 py-2 font-semibold">Target</th>
                    <th className="px-3 py-2 text-right font-semibold">Latency</th>
                    <th className="px-3 py-2 text-right font-semibold">Uptime 24h</th>
                    <th className="py-2 pl-3 font-semibold">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {data.services.map((service) => {
                    const tone = statusTone(service.latest?.status ?? null);
                    const isInternal = service.probe.group === "internal";
                    return (
                      <tr key={service.probe.id} className="text-[12px] text-[var(--text-2)]">
                        <td className="py-3 pr-3">
                          <Pill tone={tone} className="!py-0.5 !text-[10px]">{statusLabel(service.latest?.status ?? null)}</Pill>
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
                        <td className="max-w-[260px] py-3 pl-3">
                          {service.latest?.metric && <p className="truncate font-mono text-[11px] text-[var(--text-3)]">{service.latest.metric}</p>}
                          {service.latest?.error && <p className="truncate font-mono text-[11px] text-[var(--down)]" title={service.latest.error}>{service.latest.error}</p>}
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
        </>
      ) : null}
    </div>
  );
}
