"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Database,
  Gauge,
  Layers3,
  Link2,
  RefreshCw,
  Repeat2,
  Wrench,
} from "lucide-react";
import { Button, Delta, EmptyState, Eyebrow, Panel, Pill, SectionHeader, Skeleton, rise } from "@/components/ui/kit";
import type {
  AccountingSummary,
  AmplificationMetrics,
  CorrelationCoverage,
  HermesObservability,
  ModelAggregate,
  ObservabilityCompleteness,
  ObservabilityTotals,
  ObservabilityWindow,
  OperationAggregate,
  ProviderAggregate,
  SessionTraceAggregate,
  SourceHealth,
  ToolAggregate,
  WasteFlag,
} from "@/lib/langfuse-observability";

type Tone = "neutral" | "up" | "down" | "warn" | "accent";

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return value.toLocaleString("en-US");
}

function fmtUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function timeAgo(d: string | null): string {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(value >= 10 ? 0 : 1)}x`;
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function fmtCostBasis(value: string | null | undefined): string {
  if (!value) return "basis unknown";
  return value.replaceAll("_", " ");
}

function fmtMaybeUsd(value: number | null | undefined): string {
  return value == null ? "—" : fmtUsd(value);
}

function fmtRange(value: { low: number; high: number; basis: string } | undefined): string {
  if (!value) return "range unavailable";
  return `${fmtUsd(value.low)}-${fmtUsd(value.high)} · ${value.basis}`;
}

function shortId(value: string | null | undefined, size = 12): string {
  if (!value) return "—";
  if (value.length <= size) return value;
  return `${value.slice(0, size)}…`;
}

function sourceTone(status: SourceHealth["status"] | undefined): Tone {
  if (status === "ok") return "up";
  if (status === "error") return "down";
  return "warn";
}

function coverageTone(status: CorrelationCoverage["status"] | AccountingSummary["reconciliation"] | undefined): Tone {
  if (status === "observed") return "up";
  if (status === "missing" || status === "invalid") return "down";
  if (status === "partial") return "warn";
  return "neutral";
}

function WindowToggle({
  value,
  onChange,
}: {
  value: ObservabilityWindow;
  onChange: (value: ObservabilityWindow) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-[var(--line)] p-0.5">
      {(["24h", "7d"] as const).map((window) => {
        const active = value === window;
        return (
          <button
            key={window}
            type="button"
            onClick={() => onChange(window)}
            className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${
              active
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--text-3)] hover:text-[var(--text-2)]"
            }`}
          >
            {window}
          </button>
        );
      })}
    </div>
  );
}

function MetricTile({
  label,
  value,
  sub,
  secondary,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  secondary?: string;
  icon: React.ReactNode;
}) {
  return (
    <Panel className="p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Eyebrow>{label}</Eyebrow>
        <span className="text-[var(--text-3)]">{icon}</span>
      </div>
      <div className="num text-[32px] font-semibold leading-none tracking-[-0.02em] text-[var(--text)]">{value}</div>
      {sub && <p className="mt-2 truncate text-[12px] text-[var(--text-3)]">{sub}</p>}
      {secondary && <p className="mt-1 truncate text-[11px] text-[var(--text-4)]">{secondary}</p>}
    </Panel>
  );
}

function StatCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-3">
      <Eyebrow className="!text-[10px]">{label}</Eyebrow>
      <p className="num mt-2 truncate text-[20px] font-semibold leading-none text-[var(--text)]">{value}</p>
      {sub && <p className="mt-1 truncate text-[11px] text-[var(--text-3)]">{sub}</p>}
    </div>
  );
}

function HeaderHero({
  data,
  window,
  onWindowChange,
}: {
  data: HermesObservability | null;
  window: ObservabilityWindow;
  onWindowChange: (value: ObservabilityWindow) => void;
}) {
  const source = data?.source;
  return (
    <div className="hq-rise pt-4 pb-10 flex flex-wrap items-end justify-between gap-6" style={rise(0)}>
      <div>
        <Eyebrow>Cost and waste</Eyebrow>
        <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--hq-text)]">
          Observability
        </h1>
        <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-[var(--hq-text-ghost)]">
          Token burn, effective cost, repeated tool calls, and context amplification for shifting work to local models and stopping cloud waste.
        </p>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <WindowToggle value={window} onChange={onWindowChange} />
        <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
          <Pill tone={sourceTone(source?.status)}>
            {source?.status === "ok" ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
            {source?.message ?? "Langfuse loading"}
          </Pill>
          <Pill tone={source?.truncated ? "warn" : "neutral"}>
            <Database className="h-3 w-3" />
            <span className="num">{source ? `${source.includedRows}/${source.rows}` : "—"}</span>
            rows
            {source?.truncated ? " · truncated" : ""}
          </Pill>
          <Pill tone="neutral">
            <RefreshCw className="h-3 w-3" />
            {timeAgo(source?.lastSync ?? null)}
          </Pill>
        </div>
        {source?.warning && <p className="max-w-xl text-right text-[11.5px] text-[var(--warn)]">{source.warning}</p>}
        {source && source.filteredRows > 0 && (
          <p className="max-w-xl text-right text-[11.5px] text-[var(--text-3)]">
            Filtered <span className="num">{source.filteredRows}</span> synthetic/test rows from totals.
          </p>
        )}
      </div>
    </div>
  );
}

function MetricTiles({ totals }: { totals: ObservabilityTotals | null }) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
      <MetricTile
        label="Total tokens"
        value={totals ? fmtTokens(totals.totalTokens) : "—"}
        sub={totals ? `${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.outputTokens)} out` : "token totals unavailable"}
        secondary={totals ? `${fmtTokens(totals.cacheReadTokens)} cache read · ${fmtTokens(totals.cacheWriteTokens)} cache write` : undefined}
        icon={<Gauge className="h-4 w-4" />}
      />
      <MetricTile
        label="Effective cost"
        value={totals ? fmtUsd(totals.effectiveCost) : "—"}
        sub={totals ? `reported ${fmtUsd(totals.reportedCost)} · ${fmtCostBasis(totals.costBasis)}` : "cost unavailable"}
        secondary={totals ? `estimated ${fmtRange(totals.estimatedCostRange)}` : undefined}
        icon={<CircleDollarSign className="h-4 w-4" />}
      />
      <MetricTile
        label="Generation / tools"
        value={totals ? `${totals.generationCalls} / ${totals.toolCalls}` : "—"}
        sub={totals ? `${totals.errors} error nodes` : "call counts unavailable"}
        secondary={totals?.latestTimestamp ? `latest ${timeAgo(totals.latestTimestamp)}` : undefined}
        icon={<Wrench className="h-4 w-4" />}
      />
      <MetricTile
        label="Sessions / traces"
        value={totals ? `${totals.uniqueSessions} / ${totals.uniqueTraces}` : "—"}
        sub="unique sessions / unique traces"
        secondary={totals ? `${totals.generationCalls + totals.toolCalls} observed calls` : undefined}
        icon={<Activity className="h-4 w-4" />}
      />
    </div>
  );
}

function ModelsTable({ models }: { models: ModelAggregate[] }) {
  const sorted = useMemo(() => [...models].sort((a, b) => b.effectiveCost - a.effectiveCost), [models]);
  return (
    <Panel className="mt-8 overflow-hidden p-5">
      <SectionHeader label="Cost and tokens by model" title="Model burn rate" />
      {sorted.length === 0 ? (
        <EmptyState icon={<Gauge className="h-6 w-6" />} title="No model rows" hint="Langfuse did not return model aggregates for this window." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1060px] text-left">
            <thead className="border-b border-[var(--line)] text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-4)]">
              <tr>
                <th className="py-2 pr-3 font-semibold">Model</th>
                <th className="px-3 py-2 font-semibold">Provider</th>
                <th className="px-3 py-2 text-right font-semibold">Calls</th>
                <th className="px-3 py-2 text-right font-semibold">Input</th>
                <th className="px-3 py-2 text-right font-semibold">Output</th>
                <th className="px-3 py-2 text-right font-semibold">Total tokens</th>
                <th className="px-3 py-2 text-right font-semibold">Cache read</th>
                <th className="px-3 py-2 text-right font-semibold">Cache write</th>
                <th className="px-3 py-2 text-right font-semibold">Reported $</th>
                <th className="px-3 py-2 text-right font-semibold">Estimated $</th>
                <th className="px-3 py-2 text-right font-semibold">Effective $</th>
                <th className="py-2 pl-3 font-semibold">Cost basis</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {sorted.map((model) => (
                <tr key={`${model.provider ?? "unknown"}:${model.model}`} className="text-[12px] text-[var(--text-2)]">
                  <td className="max-w-[220px] py-3 pr-3">
                    <p className="truncate text-[var(--text)]">{model.model || "unknown"}</p>
                    {model.estimatedCostRange && <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-4)]">{fmtRange(model.estimatedCostRange)}</p>}
                  </td>
                  <td className="px-3 py-3">{model.provider ?? "—"}</td>
                  <td className="num px-3 py-3 text-right">{model.calls}</td>
                  <td className="num px-3 py-3 text-right">{fmtTokens(model.inputTokens)}</td>
                  <td className="num px-3 py-3 text-right">{fmtTokens(model.outputTokens)}</td>
                  <td className="num px-3 py-3 text-right text-[var(--text)]">{fmtTokens(model.totalTokens)}</td>
                  <td className="num px-3 py-3 text-right">{fmtTokens(model.cacheReadTokens)}</td>
                  <td className="num px-3 py-3 text-right">{fmtTokens(model.cacheWriteTokens)}</td>
                  <td className="num px-3 py-3 text-right">{fmtUsd(model.reportedCost)}</td>
                  <td className="num px-3 py-3 text-right">{fmtMaybeUsd(model.estimatedCost)}</td>
                  <td className="num px-3 py-3 text-right text-[var(--text)]">{fmtUsd(model.effectiveCost)}</td>
                  <td className="py-3 pl-3">
                    <span className="text-[10.5px] text-[var(--text-3)]">{fmtCostBasis(model.costBasis)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ProviderSplit({ providers }: { providers: ProviderAggregate[] }) {
  const sorted = useMemo(
    () => [...providers].sort((a, b) => a.modelClass.localeCompare(b.modelClass) || b.effectiveCost - a.effectiveCost),
    [providers],
  );
  const local = providers.filter((provider) => provider.modelClass === "local");
  const cloud = providers.filter((provider) => provider.modelClass === "cloud");
  const localCalls = local.reduce((sum, provider) => sum + provider.calls, 0);
  const localTokens = local.reduce((sum, provider) => sum + provider.totalTokens, 0);
  const cloudCalls = cloud.reduce((sum, provider) => sum + provider.calls, 0);
  const cloudTokens = cloud.reduce((sum, provider) => sum + provider.totalTokens, 0);
  const cloudCost = cloud.reduce((sum, provider) => sum + provider.effectiveCost, 0);

  return (
    <Panel className="mt-8 p-5">
      <SectionHeader
        label="Local vs cloud"
        title="Provider routing split"
        action={
          <Pill tone="accent">
            Local: <span className="num">{localCalls}</span> calls / <span className="num">{fmtTokens(localTokens)}</span> tokens / $0
            <span className="text-[var(--text-3)]">•</span>
            Cloud: <span className="num">{cloudCalls}</span> calls / <span className="num">{fmtTokens(cloudTokens)}</span> tokens / <span className="num">{fmtUsd(cloudCost)}</span>
          </Pill>
        }
      />
      {sorted.length === 0 ? (
        <EmptyState icon={<Layers3 className="h-6 w-6" />} title="No provider rows" hint="Provider aggregation is empty for this window." />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(["local", "cloud", "unknown"] as const).map((modelClass) => {
            const rows = sorted.filter((provider) => provider.modelClass === modelClass);
            if (rows.length === 0) return null;
            return (
              <div key={modelClass} className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <Eyebrow>{modelClass}</Eyebrow>
                  <Pill tone={modelClass === "cloud" ? "warn" : modelClass === "local" ? "up" : "neutral"} className="!py-0.5 !text-[10px]">
                    {rows.length} provider{rows.length === 1 ? "" : "s"}
                  </Pill>
                </div>
                <div className="divide-y divide-[var(--line)]">
                  {rows.map((provider) => (
                    <div key={provider.provider} className="grid grid-cols-[1fr_auto] gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] text-[var(--text)]">{provider.provider}</p>
                        <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-3)]">{fmtCostBasis(provider.costBasis)}</p>
                      </div>
                      <div className="text-right">
                        <p className="num text-[12px] text-[var(--text)]">{fmtUsd(provider.effectiveCost)}</p>
                        <p className="num mt-0.5 text-[10.5px] text-[var(--text-3)]">
                          {provider.calls} calls · {fmtTokens(provider.totalTokens)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function RatioCard({
  label,
  value,
  kind,
  hint,
}: {
  label: string;
  value: number | null | undefined;
  kind: "ratio" | "pct";
  hint: string;
}) {
  const numeric = value ?? null;
  const extreme =
    numeric != null &&
    ((label === "Input/output ratio" && numeric >= 8) ||
      (label === "Context amplification" && numeric >= 4) ||
      (label === "Cache write ratio" && numeric >= 0.35));
  const warn = numeric != null && !extreme && ((kind === "ratio" && numeric >= 4) || (kind === "pct" && numeric >= 0.2));
  const tone: Tone = extreme ? "down" : warn ? "warn" : "neutral";
  const color = extreme ? "var(--down)" : warn ? "var(--warn)" : "var(--text)";
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-4">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow className="!text-[10px]">{label}</Eyebrow>
        <Pill tone={tone} className="!py-0.5 !text-[10px]">{extreme ? "extreme" : warn ? "watch" : "normal"}</Pill>
      </div>
      <div className="mt-3 flex items-end gap-2">
        <p className="num text-[28px] font-semibold leading-none" style={{ color }}>
          {kind === "ratio" ? fmtRatio(numeric) : fmtPct(numeric)}
        </p>
        {numeric != null && <Delta value={numeric} format={(n) => (kind === "ratio" ? `${n.toFixed(1)}x` : `${(n * 100).toFixed(0)}%`)} className="mb-0.5" />}
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-3)]">{hint}</p>
    </div>
  );
}

function AmplificationPanel({ amplification }: { amplification: AmplificationMetrics | null }) {
  return (
    <Panel className="mt-8 p-5">
      <SectionHeader
        label="Context amplification"
        title="Routing and context pressure"
        action={<Pill tone={(amplification?.deterministicFlags.length ?? 0) > 0 ? "warn" : "up"}>{amplification?.deterministicFlags.length ?? 0} deterministic flags</Pill>}
      />
      {!amplification ? (
        <EmptyState icon={<Gauge className="h-6 w-6" />} title="No amplification metrics" hint="No token ratio evidence was available in this window." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <RatioCard label="Input/output ratio" value={amplification.inputOutputRatio} kind="ratio" hint="More input than output. High values usually mean wasted context re-sending." />
            <RatioCard label="Context amplification" value={amplification.contextAmplification} kind="ratio" hint="Total context pressure relative to generated output. High means oversized prompt history." />
            <RatioCard label="Cache read ratio" value={amplification.cacheReadRatio} kind="pct" hint="Share of tokens served from cache reads. Higher is usually good when prompts repeat." />
            <RatioCard label="Cache write ratio" value={amplification.cacheWriteRatio} kind="pct" hint="Share of tokens written to cache. High values can mean repeated expensive prompt prefixes." />
          </div>
          {amplification.deterministicFlags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {amplification.deterministicFlags.map((flag) => (
                <Pill key={flag} tone="warn">{flag}</Pill>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function WasteFlagsPanel({ flags }: { flags: WasteFlag[] }) {
  return (
    <Panel className="mt-8 p-5">
      <SectionHeader label="Waste flags" title="Actionable token waste signals" action={<Pill tone={flags.length ? "warn" : "up"}>{flags.length} flags</Pill>} />
      {flags.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title="No waste flags" hint="No repeated-tool, large-session, or high-ratio flags were emitted for this window." />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {flags.map((flag, index) => (
            <div key={`${flag.kind}:${flag.label}:${flag.sessionId ?? flag.traceId ?? index}`} className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Pill tone={flag.severity} className="!py-0.5 !text-[10px]">{flag.severity}</Pill>
                <span className="num text-[11px] text-[var(--text-3)]">{flag.value.toLocaleString("en-US")}</span>
              </div>
              <p className="text-[14px] font-medium text-[var(--text)]">{flag.label}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-2)]">{flag.detail}</p>
              {(flag.sessionId || flag.traceId) && (
                <p className="num mt-3 text-[10.5px] text-[var(--text-3)]">
                  session {shortId(flag.sessionId)} · trace {shortId(flag.traceId)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function TopTracesPanel({ large, expensive }: { large: SessionTraceAggregate[]; expensive: SessionTraceAggregate[] }) {
  const rows = useMemo(() => {
    const map = new Map<string, SessionTraceAggregate>();
    [...large, ...expensive].forEach((trace) => map.set(trace.id, trace));
    return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.effectiveCost - a.effectiveCost);
  }, [large, expensive]);

  return (
    <Panel className="mt-8 overflow-hidden p-5">
      <SectionHeader label="Top token-burning sessions" title="Worst offenders" />
      {rows.length === 0 ? (
        <EmptyState icon={<Activity className="h-6 w-6" />} title="No large sessions" hint="No expensive or large trace aggregates were returned." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead className="border-b border-[var(--line)] text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-4)]">
              <tr>
                <th className="py-2 pr-3 font-semibold">Session</th>
                <th className="px-3 py-2 font-semibold">Models</th>
                <th className="px-3 py-2 font-semibold">Provider</th>
                <th className="px-3 py-2 text-right font-semibold">Tokens</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
                <th className="px-3 py-2 text-right font-semibold">Tools</th>
                <th className="py-2 pl-3 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {rows.map((trace) => (
                <tr key={trace.id} className="text-[12px] text-[var(--text-2)]">
                  <td className="py-3 pr-3">
                    <p className="num text-[var(--text)]">{shortId(trace.sessionId ?? trace.traceId ?? trace.id, 18)}</p>
                    <p className="num mt-0.5 text-[10.5px] text-[var(--text-3)]">trace {shortId(trace.traceId)}</p>
                  </td>
                  <td className="max-w-[220px] px-3 py-3">
                    <p className="truncate">{trace.models.join(", ") || "unknown"}</p>
                  </td>
                  <td className="px-3 py-3">{trace.provider ?? "—"}</td>
                  <td className="num px-3 py-3 text-right text-[var(--text)]">{fmtTokens(trace.totalTokens)}</td>
                  <td className="num px-3 py-3 text-right">{fmtUsd(trace.effectiveCost)}</td>
                  <td className="num px-3 py-3 text-right">{trace.toolCallCount}</td>
                  <td className="py-3 pl-3 text-right">
                    <Pill tone={trace.status === "ok" ? "up" : "down"} className="!py-0.5 !text-[10px]">{trace.status}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function OperationsPanel({
  operations,
  accounting,
  coverage,
}: {
  operations: OperationAggregate[];
  accounting: AccountingSummary;
  coverage: CorrelationCoverage;
}) {
  const sorted = useMemo(() => [...operations].sort((a, b) => b.effectiveCost - a.effectiveCost), [operations]);
  const warnings = accounting.warnings ?? [];

  return (
    <Panel className="mt-8 overflow-hidden p-5">
      <SectionHeader
        label="Operations accounting"
        title="Correlated work units"
        action={<Pill tone={coverageTone(accounting.reconciliation)}><Link2 className="h-3 w-3" />{accounting.reconciliation}</Pill>}
      />
      {warnings.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {warnings.map((warning) => (
            <div key={warning} className="flex items-start gap-2 rounded-[8px] border border-[color-mix(in_srgb,var(--warn)_24%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-3 text-[12.5px] text-[var(--text-2)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warn)]" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyState
          icon={<Link2 className="h-6 w-6" />}
          title="No correlated operations"
          hint={`Correlation coverage is ${coverage.percentage == null ? "unknown" : fmtPct(coverage.percentage)} with ${coverage.status} status.`}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left">
            <thead className="border-b border-[var(--line)] text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-4)]">
              <tr>
                <th className="py-2 pr-3 font-semibold">Operation</th>
                <th className="px-3 py-2 font-semibold">Goal</th>
                <th className="px-3 py-2 font-semibold">Run</th>
                <th className="px-3 py-2 text-right font-semibold">Calls</th>
                <th className="px-3 py-2 text-right font-semibold">Generations</th>
                <th className="px-3 py-2 text-right font-semibold">Tools</th>
                <th className="px-3 py-2 text-right font-semibold">Tokens</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
                <th className="py-2 pl-3 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {sorted.map((operation) => (
                <tr key={operation.operationId} className="text-[12px] text-[var(--text-2)]">
                  <td className="py-3 pr-3">
                    <p className="num text-[var(--text)]">{shortId(operation.operationId, 18)}</p>
                    <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-3)]">{operation.models[0] ?? "unknown model"}</p>
                  </td>
                  <td className="num px-3 py-3">{shortId(operation.goalId, 16)}</td>
                  <td className="num px-3 py-3">{shortId(operation.runId, 16)}</td>
                  <td className="num px-3 py-3 text-right">{operation.calls}</td>
                  <td className="num px-3 py-3 text-right">{operation.generationCalls}</td>
                  <td className="num px-3 py-3 text-right">{operation.toolCalls}</td>
                  <td className="num px-3 py-3 text-right text-[var(--text)]">{fmtTokens(operation.totalTokens)}</td>
                  <td className="num px-3 py-3 text-right">{fmtUsd(operation.effectiveCost)}</td>
                  <td className="py-3 pl-3 text-right">
                    <Pill tone={operation.status === "ok" ? "up" : "down"} className="!py-0.5 !text-[10px]">{operation.status}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ToolColumn({ title, tools, empty }: { title: string; tools: ToolAggregate[]; empty: string }) {
  const sorted = useMemo(() => [...tools].sort((a, b) => b.count - a.count), [tools]);
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-4">
      <Eyebrow>{title}</Eyebrow>
      {sorted.length === 0 ? (
        <p className="mt-3 text-[12.5px] text-[var(--text-3)]">{empty}</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {sorted.map((tool) => (
            <span key={tool.name} className="rounded-full border border-[var(--line)] px-2.5 py-1 text-[11px] text-[var(--text-2)]">
              {tool.name}<span className="num ml-1 text-[var(--text-3)]">x{tool.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolsPanel({ recent, repeated }: { recent: ToolAggregate[]; repeated: ToolAggregate[] }) {
  return (
    <Panel className="mt-8 p-5">
      <SectionHeader label="Tool usage" title="Repeated calls and recent tools" action={<Repeat2 className="h-4 w-4 text-[var(--text-3)]" />} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ToolColumn title="Recent" tools={recent} empty="No recent tool calls in this window." />
        <ToolColumn title="Repeated" tools={repeated} empty="No repeated tool calls in this window." />
      </div>
    </Panel>
  );
}

function RecommendationsPanel({ recommendations }: { recommendations: string[] }) {
  return (
    <Panel className="mt-8 p-5">
      <SectionHeader label="Recommendations" title="Optimization actions" action={<Pill tone={recommendations.length ? "accent" : "neutral"}>{recommendations.length} actions</Pill>} />
      {recommendations.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title="No recommendations" hint="No concrete optimization actions were emitted for this window." />
      ) : (
        <ul className="space-y-2">
          {recommendations.map((recommendation) => (
            <li key={recommendation} className="rounded-[8px] border border-[color-mix(in_srgb,var(--accent)_22%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] p-3 text-[12.5px] leading-relaxed text-[var(--text-2)]">
              {recommendation}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function CompletenessFooter({
  completeness,
  coverage,
}: {
  completeness: ObservabilityCompleteness | null;
  coverage: CorrelationCoverage;
}) {
  return (
    <Panel className="mt-8 p-5">
      <SectionHeader label="Completeness" title="Trust and correlation quality" action={<Pill tone={coverageTone(coverage.status)}>{coverage.status}</Pill>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCell label="Session rows" value={String(completeness?.sessionRows ?? "—")} sub={`${completeness?.includedObservations ?? 0} observations`} />
        <StatCell label="Missing sessions" value={String(completeness?.missingSessionIdRows ?? "—")} sub="rows without sessionId" />
        <StatCell label="Missing traces" value={String(completeness?.missingTraceIdRows ?? "—")} sub="rows without traceId" />
        <StatCell label="Unknown tokens" value={String(completeness?.unknownTokenRows ?? "—")} sub="token evidence gaps" />
        <StatCell label="Unknown cost" value={String(completeness?.unknownCostRows ?? "—")} sub={`${completeness?.partialCostRows ?? 0} partial`} />
        <StatCell label="Correlation" value={fmtPct(coverage.percentage)} sub={`${coverage.fullyCorrelatedObservations}/${coverage.eligibleObservations} full`} />
      </div>
      <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--text-3)]">
        Parent edges <span className="num">{completeness?.parentEdges ?? 0}</span> · logical roots{" "}
        <span className="num">{completeness?.logicalRootCount ?? 0}</span> · invalid IDs{" "}
        <span className="num">{coverage.invalidIdentifierObservations}</span>.
      </p>
    </Panel>
  );
}

export default function ObservabilityPage() {
  const [window, setWindow] = useState<ObservabilityWindow>("24h");
  const [data, setData] = useState<HermesObservability | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const observability = await getJSON<HermesObservability>(`/api/hermes/observability?window=${window}`);
    if (observability) setData(observability);
    setLoaded(true);
  }, [window]);

  useEffect(() => {
    setLoaded(false);
    const firstLoad = setTimeout(() => {
      void load();
    }, 0);
    const interval = setInterval(load, 30_000);
    return () => {
      clearTimeout(firstLoad);
      clearInterval(interval);
    };
  }, [load]);

  return (
    <div className="relative z-10 w-full mx-auto pb-16">
      <HeaderHero data={data} window={window} onWindowChange={setWindow} />

      {!loaded ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-36" />)}
          <Skeleton className="h-96 lg:col-span-4" />
          <Skeleton className="h-72 lg:col-span-2" />
          <Skeleton className="h-72 lg:col-span-2" />
        </div>
      ) : !data ? (
        <Panel className="p-5">
          <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title="Observability unavailable" hint="The Langfuse observability endpoint did not return a payload." />
        </Panel>
      ) : (
        <>
          <MetricTiles totals={data.totals} />
          <ModelsTable models={data.byModel ?? []} />
          <ProviderSplit providers={data.byProvider ?? []} />
          <AmplificationPanel amplification={data.amplification ?? null} />
          <WasteFlagsPanel flags={data.wasteFlags ?? []} />
          <TopTracesPanel large={data.topLargeTraces ?? []} expensive={data.topExpensiveTraces ?? []} />
          <OperationsPanel operations={data.operations ?? []} accounting={data.accounting} coverage={data.correlationCoverage} />
          <ToolsPanel recent={data.tools?.recent ?? []} repeated={data.tools?.repeated ?? []} />
          <RecommendationsPanel recommendations={data.recommendations ?? []} />
          <CompletenessFooter completeness={data.completeness ?? null} coverage={data.correlationCoverage} />
        </>
      )}
    </div>
  );
}
