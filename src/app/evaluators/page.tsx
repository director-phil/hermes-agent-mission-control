"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  FlaskConical,
  RefreshCw,
  Target,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState, Eyebrow, Panel, Pill, SectionHeader, Skeleton, rise } from "@/components/ui/kit";
import type {
  LangfuseEvaluationControl,
  ScoreAggregate,
} from "@/lib/langfuse-evaluation-control";
import type { ObservabilityWindow } from "@/lib/langfuse-observability";

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const bust = `ts=${Date.now()}`;
    const urlWithBust = url.includes("?") ? `${url}&${bust}` : `${url}?${bust}`;
    const response = await fetch(urlWithBust, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
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

function fmtValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return value.toLocaleString("en-US");
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function dataTypeBadge(dataType: string): string {
  return dataType.toLowerCase();
}

function scoreDisplay(aggregate: ScoreAggregate): { primary: string; secondary: string } {
  if (aggregate.numeric) {
    return {
      primary: fmtValue(aggregate.numeric.avg),
      secondary: `min ${fmtValue(aggregate.numeric.min)} · max ${fmtValue(aggregate.numeric.max)}`,
    };
  }
  if (aggregate.boolean) {
    return {
      primary: fmtPct(aggregate.boolean.trueRate),
      secondary: `${aggregate.boolean.trueCount} true · ${aggregate.boolean.falseCount} false`,
    };
  }
  if (aggregate.categorical.length) {
    const top = aggregate.categorical[0];
    return { primary: top.value, secondary: `${aggregate.categorical.length} categories` };
  }
  return { primary: `${aggregate.textCount} text`, secondary: `${aggregate.count} total` };
}

function normalizedScore(aggregate: ScoreAggregate): number | null {
  if (aggregate.numeric) return aggregate.numeric.avg;
  if (aggregate.boolean) return aggregate.boolean.trueRate;
  return null;
}

const chartTooltipStyle: CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  color: "var(--text)",
  boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
};

const chartLabelStyle: CSSProperties = {
  color: "var(--text)",
  fontSize: 11,
  fontWeight: 700,
};

function ScoreBarTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload?: { name: string; value: number | null; detail: string } }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-[8px] border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 shadow-2xl">
      <p className="text-[11px] font-semibold text-[var(--text)]">{row.name}</p>
      <p className="num mt-1 text-[12px] text-[var(--accent)]">
        {row.value == null ? "—" : fmtValue(row.value)}
      </p>
      <p className="mt-0.5 text-[10.5px] text-[var(--text-3)]">{row.detail}</p>
    </div>
  );
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
              active ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]"
            }`}
          >
            {window}
          </button>
        );
      })}
    </div>
  );
}

const BAR_COLORS = ["var(--accent)", "var(--up)", "var(--warn)", "var(--down)", "var(--text-2)", "#7c3aed"];

export default function EvaluatorsPage() {
  const [data, setData] = useState<LangfuseEvaluationControl | null>(null);
  const [window, setWindow] = useState<ObservabilityWindow>("24h");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const payload = await getJSON<LangfuseEvaluationControl>(`/api/hermes/evaluation-control?window=${window}`);
    setData(payload);
    setLoaded(true);
  }, [window]);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  const scoreSummary = data?.scores?.data ?? null;
  const aggregates = scoreSummary?.aggregates ?? [];
  const recentScores = scoreSummary?.recentScores ?? [];
  const scoresHealth = data?.scores?.health ?? null;
  const sourceStatus = data?.source?.status ?? "unavailable";

  const evaluatorScores = useMemo(
    () => aggregates.filter((a) => a.source === "EVAL" || a.name.toLowerCase().includes("live")),
    [aggregates],
  );
  const liveEvaluatorNames = useMemo(
    () => new Set(evaluatorScores.map((a) => a.name)),
    [evaluatorScores],
  );

  const chartData = useMemo(
    () =>
      evaluatorScores.map((a) => ({
        name: a.name,
        value: normalizedScore(a),
        detail: a.dataType === "BOOLEAN" ? `${a.boolean?.trueCount ?? 0} events` : `${a.count} events`,
      })),
    [evaluatorScores],
  );

  const recentByRun = useMemo(() => {
    // Bucket recent individual scores by target (a run/observation) so the
    // table reads as "scores of each run" — most recent runs first.
    const byTarget = new Map<string, typeof recentScores>();
    for (const score of recentScores) {
      const key = score.targetId ?? score.id ?? "unknown";
      const bucket = byTarget.get(key) ?? [];
      bucket.push(score);
      byTarget.set(key, bucket);
    }
    return Array.from(byTarget.entries())
      .map(([targetId, scores]) => ({
        targetId,
        targetKind: scores[0].targetKind,
        timestamp: scores.reduce<string | null>(
          (latest, s) => (!latest || (s.timestamp && s.timestamp > latest) ? s.timestamp : latest),
          null,
        ),
        scores: scores.slice(0, 6),
      }))
      .sort((a, b) => (Date.parse(b.timestamp ?? "") || 0) - (Date.parse(a.timestamp ?? "") || 0))
      .slice(0, 20);
  }, [recentScores]);

  return (
    <div className="relative z-10 w-full mx-auto p-8 pb-16 text-[var(--text)]">
      <div className="hq-rise flex flex-wrap items-end justify-between gap-6" style={rise(0)}>
        <div>
          <Eyebrow>Langfuse evaluation</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
            Evaluators
          </h1>
          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-[var(--text-3)]">
            Live evaluator scores per run — deterministic code gates (output validity, tool-call excess) and
            sampled LLM-as-judge quality signals (hallucination, tool-call quality, context bloat, goal relevance).
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <WindowToggle value={window} onChange={setWindow} />
          <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
            <Pill tone={sourceStatus === "ok" ? "up" : "warn"}>
              {sourceStatus === "ok" ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
              {data?.source?.message ?? "Langfuse loading"}
            </Pill>
            {scoresHealth?.truncated && (
              <Pill tone="warn">
                <AlertTriangle className="h-3 w-3" />
                truncated
              </Pill>
            )}
            <Pill tone="neutral">
              <RefreshCw className="h-3 w-3" />
              {timeAgo(scoresHealth?.checkedAt ?? null)}
            </Pill>
          </div>
        </div>
      </div>

      {!loaded ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {[0, 1, 2].map((item) => <Skeleton key={item} className="h-32" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Panel className="p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <Eyebrow>Total scores</Eyebrow>
                <Target className="h-4 w-4 text-[var(--text-3)]" />
              </div>
              <div className="num text-[32px] font-semibold leading-none text-[var(--text)]">
                {scoreSummary ? scoreSummary.totalScores.toLocaleString("en-US") : "—"}
              </div>
              <p className="mt-2 text-[12px] text-[var(--text-3)]">
                across {scoreSummary?.uniqueTargets ?? 0} targets in this window
              </p>
            </Panel>
            <Panel className="p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <Eyebrow>Active evaluators</Eyebrow>
                <FlaskConical className="h-4 w-4 text-[var(--text-3)]" />
              </div>
              <div className="num text-[32px] font-semibold leading-none text-[var(--accent)]">
                {liveEvaluatorNames.size}
              </div>
              <p className="mt-2 truncate text-[12px] text-[var(--text-3)]">
                {Array.from(liveEvaluatorNames).slice(0, 3).join(" · ") || "none detected"}
              </p>
            </Panel>
            <Panel className="p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <Eyebrow>Recent scored runs</Eyebrow>
                <Activity className="h-4 w-4 text-[var(--text-3)]" />
              </div>
              <div className="num text-[32px] font-semibold leading-none text-[var(--text)]">
                {recentByRun.length}
              </div>
              <p className="mt-2 text-[12px] text-[var(--text-3)]">distinct targets scored most recently</p>
            </Panel>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Panel className="min-w-0 p-5">
              <SectionHeader label="Scores" title="Evaluator averages" />
              {chartData.length === 0 ? (
                <EmptyState
                  icon={<BarChart3 className="h-6 w-6" />}
                  title="No evaluator scores"
                  hint="No EVAL-sourced scores were returned for this window."
                />
              ) : (
                <div className="min-w-0 overflow-hidden">
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={chartData} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="name"
                        tick={{ fill: "var(--text-3)", fontSize: 10 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--line)" }}
                        interval={0}
                        angle={-18}
                        textAnchor="end"
                        height={70}
                      />
                      <YAxis
                        domain={[0, "auto"]}
                        tick={{ fill: "var(--text-3)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={38}
                      />
                      <Tooltip
                        content={<ScoreBarTooltip />}
                        contentStyle={chartTooltipStyle}
                        labelStyle={chartLabelStyle}
                        cursor={{ fill: "color-mix(in srgb, var(--accent) 8%, transparent)" }}
                      />
                      <Bar dataKey="value" name="score" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                        {chartData.map((entry, index) => (
                          <Cell key={entry.name} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Panel>

            <Panel className="min-w-0 p-5">
              <SectionHeader label="Evaluator library" title="Score types" />
              {aggregates.length === 0 ? (
                <EmptyState
                  icon={<FlaskConical className="h-6 w-6" />}
                  title="No score types"
                  hint="Langfuse returned no score aggregates for this window."
                />
              ) : (
                <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                  {aggregates.map((aggregate) => {
                    const display = scoreDisplay(aggregate);
                    return (
                      <div
                        key={`${aggregate.name}:${aggregate.source}:${aggregate.dataType}`}
                        className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[12.5px] font-medium text-[var(--text)]">{aggregate.name}</p>
                          <p className="mt-0.5 text-[10.5px] text-[var(--text-4)]">
                            {aggregate.source} · {dataTypeBadge(aggregate.dataType)} · {aggregate.count} events
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="num text-[16px] font-semibold text-[var(--text)]">{display.primary}</p>
                          <p className="mt-0.5 text-[10px] text-[var(--text-4)]">{display.secondary}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          </div>

          <Panel className="mt-8 overflow-hidden p-5">
            <SectionHeader
              label="Per run"
              title="Scores of each run"
              action={<Pill tone="neutral">{recentByRun.length} runs</Pill>}
            />
            {recentByRun.length === 0 ? (
              <EmptyState
                icon={<Activity className="h-6 w-6" />}
                title="No recent scored events"
                hint="Individual scores appear here as evaluators fire against each run's observations."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left">
                  <thead className="border-b border-[var(--line)] text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-4)]">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">Target</th>
                      <th className="px-3 py-2 font-semibold">Kind</th>
                      <th className="px-3 py-2 font-semibold">Scored</th>
                      <th className="py-2 pl-3 font-semibold">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {recentByRun.map((run) => (
                      <tr key={run.targetId}>
                        <td className="py-2.5 pr-3">
                          <p className="num max-w-[260px] truncate text-[11.5px] text-[var(--text-2)]">
                            {run.targetId}
                          </p>
                        </td>
                        <td className="px-3 py-2.5">
                          <Pill tone="neutral" className="!py-0.5 !text-[10px]">{run.targetKind ?? "target"}</Pill>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1.5">
                            {run.scores.map((score) => (
                              <span
                                key={`${run.targetId}:${score.name}`}
                                className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10.5px] text-[var(--text-3)]"
                              >
                                {score.name}{" "}
                                <span className="num text-[var(--text)]">
                                  {score.numeric != null ? fmtValue(score.numeric) : score.boolean != null ? (score.boolean ? "true" : "false") : String(score.value ?? "—")}
                                </span>
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-2.5 pl-3 text-[11.5px] text-[var(--text-3)]">{timeAgo(run.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {liveEvaluatorNames.size > 0 && (
            <p className="mt-4 text-[11.5px] text-[var(--text-4)]">
              Evaluator rules ({liveEvaluatorNames.size}):{" "}
              {Array.from(liveEvaluatorNames).join(", ")}. Deterministic code gates run at 100% sampling;
              LLM-as-judge quality signals run at reduced sampling. Scores flow from Langfuse&apos;s evaluator
              pipeline and are read here from the public scores API.
            </p>
          )}
        </>
      )}
    </div>
  );
}
