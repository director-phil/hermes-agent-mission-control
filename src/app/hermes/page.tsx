"use client";

import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  Inbox,
  Activity as ActivityIcon,
} from "lucide-react";
import {
  Panel,
  SectionHeader,
  Pill,
  EmptyState,
  Skeleton,
  Eyebrow,
} from "@/components/ui/kit";
import { HermesDispatches } from "@/components/hermes-dispatches";
import { HermesRuns } from "@/components/hermes-runs";

// ── Types ─────────────────────────────────────────────────
type ReqStatus =
  | "queued"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "done"
  | "failed"
  | "rejected";

interface Req {
  id: string;
  origin: string;
  kind: string;
  title: string;
  prompt: string | null;
  sideEffecting: boolean;
  status: ReqStatus;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

type EvLevel = "info" | "up" | "warn" | "down";
interface Ev {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  agent: string | null;
  level: EvLevel;
  createdAt: string;
}

interface Health {
  online: boolean;
  gateway: string | null;
  detail: string | null;
  lastSeen: string | null;
  stale?: boolean;
  checks?: {
    db: boolean;
    hermesCli: boolean;
    nativeSnapshot: boolean;
  };
}

type GoalState = "ready" | "running" | "done" | "failed";

interface NativeGoal {
  id: string;
  title: string;
  state: GoalState;
  source: "live-native" | "archive";
  status: string | null;
  updatedAt: string | null;
  evidence: string[];
  bytes: number;
  sha256?: string;
}

interface NativeSnapshot {
  source: {
    mode?: "local-native" | "remote-native-source";
    status: "ok" | "warning" | "error";
    message: string;
    warnings: string[];
    errors?: string[];
    checkedAt: string;
    lastSeen?: string | null;
    stale?: boolean;
  };
  operatorTasks: {
    updatedAt: string | null;
    tasks: Array<{
      id: string;
      title: string;
      status: "in_progress" | "pending" | "done" | "blocked";
      priority: "high" | "medium" | "low";
      updatedAt: string | null;
    }>;
    counts: Record<string, number>;
  };
  goals: {
    live: Record<GoalState, NativeGoal[]>;
    counts: Record<GoalState, number>;
    current: NativeGoal | null;
    recentFailed: NativeGoal[];
  };
  archive: {
    counts: { done: number; failed: number; total: number };
    artifact_counts: { done: number; failed: number; total: number };
    manifestSha256: string | null;
    recent: NativeGoal[];
  };
}

// ── Helpers ───────────────────────────────────────────────
function timeAgo(d: string | null): string {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function levelColor(l: EvLevel): string {
  if (l === "up") return "var(--up)";
  if (l === "down") return "var(--down)";
  if (l === "warn") return "var(--warn)";
  return "var(--text-3)";
}

// ── Health chip ───────────────────────────────────────────
function HealthChip({ health }: { health: Health | null }) {
  const online = !!health?.online;
  const color = online ? "var(--up)" : "var(--warn)";
  return (
    <div
      className="flex items-center gap-2 rounded-full border px-3 py-1.5"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 22%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
      }}
    >
      <span className="relative flex w-1.5 h-1.5">
        {online && (
          <span
            className="absolute inline-flex h-full w-full rounded-full animate-ping"
            style={{ background: "color-mix(in srgb, var(--up) 60%, transparent)" }}
          />
        )}
        <span
          className="relative inline-flex w-1.5 h-1.5 rounded-full"
          style={{ background: color }}
        />
      </span>
      <span className="text-[12px] font-semibold">
        {online ? "Online" : "Offline · native source unavailable"}
      </span>
      {health?.lastSeen && (
        <span className="num text-[10.5px] text-[var(--text-3)]">
          {timeAgo(health.lastSeen)}
        </span>
      )}
    </div>
  );
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const NATIVE_GOAL_LABEL: Record<GoalState, string> = {
  running: "Running now",
  ready: "Ready",
  failed: "Failed",
  done: "Done",
};

function NativeGoalCard({ goal }: { goal: NativeGoal }) {
  const tone = goal.state === "running" ? "accent" : goal.state === "failed" ? "down" : goal.state === "done" ? "up" : "neutral";
  return (
    <div className="rounded-[10px] border border-[var(--line)] bg-[var(--surface-1)] p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium leading-snug text-[var(--text)]">{goal.title}</p>
        <Pill tone={tone} className="!py-0.5 !text-[10px]">{goal.status ?? goal.state}</Pill>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 num text-[10.5px] text-[var(--text-3)]">
        <span>{fmtBytes(goal.bytes)}</span>
        <span>{timeAgo(goal.updatedAt)}</span>
        {goal.sha256 && <span>sha {goal.sha256.slice(0, 10)}</span>}
      </div>
      {goal.evidence.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {goal.evidence.map((item) => (
            <span key={item} className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10.5px] text-[var(--text-3)]">
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function NativeWorkPanel({ snapshot }: { snapshot: NativeSnapshot | null }) {
  const live = snapshot?.goals.live ?? { ready: [], running: [], done: [], failed: [] };
  const operatorTasks = snapshot?.operatorTasks.tasks ?? [];
  const sourceLabel = snapshot?.source.mode === "remote-native-source" ? "remote native source" : "local native";
  const sourceMessage = snapshot?.source.errors?.[0] ?? snapshot?.source.warnings[0] ?? null;

  return (
    <>
      <SectionHeader
        label="Native work state"
        title="Goals, operator tasks, archive"
        action={
          <div className="flex items-center gap-3">
            <Pill tone={snapshot?.source.status === "ok" ? "up" : "warn"}>
              {snapshot?.source.stale ? "stale " : ""}{sourceLabel}
            </Pill>
            <span className="num text-[11px] text-[var(--text-3)]">
              archive {snapshot?.archive.counts.total ?? 0}
            </span>
          </div>
        }
      />

      {sourceMessage ? (
        <Panel className="mb-4 p-4">
          <p className="text-[12.5px] text-[var(--text-2)]">
            {sourceMessage}
          </p>
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
        <Panel className="p-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
            {(["running", "ready", "failed", "done"] as const).map((state) => (
              <div key={state} className="min-h-44 rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <Eyebrow>{NATIVE_GOAL_LABEL[state]}</Eyebrow>
                  <span className="num text-[11px] text-[var(--text-3)]">{live[state].length}</span>
                </div>
                {live[state].length === 0 ? (
                  <p className="py-8 text-center text-[12px] text-[var(--text-4)]">No live native goals</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {live[state].slice(0, 4).map((goal) => <NativeGoalCard key={goal.id} goal={goal} />)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-4">
          <Panel className="p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Eyebrow>Operator tasks</Eyebrow>
                <h3 className="mt-1 text-[16px] font-semibold text-[var(--text)]">Current registry</h3>
              </div>
              <span className="num text-[18px] font-semibold text-[var(--text)]">{operatorTasks.length}</span>
            </div>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {operatorTasks.slice(0, 6).map((task) => (
                <div key={task.id} className="py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[12.5px] leading-snug text-[var(--text-2)]">{task.title}</p>
                    <Pill tone={task.status === "blocked" ? "down" : task.status === "in_progress" ? "accent" : task.status === "done" ? "up" : "neutral"} className="shrink-0 !py-0.5 !text-[10px]">
                      {task.status.replace("_", " ")}
                    </Pill>
                  </div>
                </div>
              ))}
              {operatorTasks.length === 0 && (
                <p className="py-8 text-center text-[12.5px] text-[var(--text-3)]">No operator tasks</p>
              )}
            </div>
          </Panel>

          <Panel className="p-5">
            <Eyebrow>Historical archive</Eyebrow>
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="num text-[22px] font-semibold text-[var(--up)]">{snapshot?.archive.counts.done ?? 0}</div>
                <div className="eyebrow mt-1">done</div>
              </div>
              <div>
                <div className="num text-[22px] font-semibold text-[var(--down)]">{snapshot?.archive.counts.failed ?? 0}</div>
                <div className="eyebrow mt-1">failed</div>
              </div>
              <div>
                <div className="num text-[22px] font-semibold text-[var(--text)]">{snapshot?.archive.counts.total ?? 0}</div>
                <div className="eyebrow mt-1">total</div>
              </div>
            </div>
            <p className="mt-3 text-center text-[11.5px] text-[var(--text-3)]">
              evidence artifacts <span className="num">{snapshot?.archive.artifact_counts.total ?? 0}</span>
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

// ── Cron / schedules ──────────────────────────────────────
type CronJob = {
  id: string; status: string; name: string; schedule: string;
  nextRun: string | null; lastRun: string | null; lastResult: string | null;
  deliver: string | null; skills: string | null; mode: string | null;
};
function CronPanel({ jobs, syncedAt }: { jobs: CronJob[]; syncedAt: string | null }) {
  return (
    <>
      <SectionHeader
        label="Cron · schedules"
        title="Recurring jobs"
        action={
          <span className="num text-[11px] text-[var(--text-3)]">
            synced {timeAgo(syncedAt)}
          </span>
        }
      />
      <div className="grid grid-cols-1 gap-4">
        <Panel className="p-5">
          <div className="flex items-center justify-between mb-3">
            <Eyebrow>schedules</Eyebrow>
            <span className="num text-[10.5px] text-[var(--text-3)]">
              {jobs.length} job{jobs.length === 1 ? "" : "s"}
            </span>
          </div>
          {jobs.length === 0 ? (
            <p className="text-[13px] text-[var(--text-3)] py-6 text-center">
              No schedules yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2 max-h-[440px] overflow-auto -mx-1 px-1">
              {jobs.map((j) => {
                const active = j.status === "active";
                return (
                  <div key={j.id} className="rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)] p-3">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: active ? "var(--up)" : "var(--text-3)" }} title={j.status} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text)] truncate">{j.name || j.id}</p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 num text-[11px] text-[var(--text-3)]">
                          <span className="text-[var(--text-2)]">{j.schedule}</span>
                          {j.nextRun && <span>next {timeAgo(j.nextRun)}</span>}
                          {j.deliver && <span>→ {j.deliver.split(":")[0]}</span>}
                          {j.skills && <span>{j.skills}</span>}
                        </div>
                      </div>
                      <Pill tone={active ? "up" : "neutral"} className="shrink-0 !py-0.5 !text-[10px]">
                        {j.status}
                      </Pill>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

      </div>
    </>
  );
}

// ── Activity feed ─────────────────────────────────────────
function ActivityFeed({ events }: { events: Ev[] }) {
  return (
    <>
      <SectionHeader label="Activity" title="Recent events" />
      {events.length === 0 ? (
        <Panel className="p-2">
          <EmptyState
            icon={<ActivityIcon className="w-6 h-6" />}
            title="No recent activity"
            hint="Events from Hermes and its agents will stream in here."
          />
        </Panel>
      ) : (
        <Panel className="p-2">
          <div className="divide-y divide-[var(--line)]">
            {events.map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-3.5 py-3">
                <span
                  className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: levelColor(e.level) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-medium text-[var(--text)] leading-snug truncate">
                      {e.title}
                    </p>
                    <span className="num text-[10.5px] text-[var(--text-3)] shrink-0 ml-auto">
                      {timeAgo(e.createdAt)}
                    </span>
                  </div>
                  {e.detail && (
                    <p className="mt-0.5 text-[12.5px] text-[var(--text-2)] leading-snug line-clamp-2">
                      {e.detail}
                    </p>
                  )}
                  {e.agent && (
                    <span className="num text-[10.5px] text-[var(--text-3)] mt-1 inline-block">
                      {e.agent}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

// ── Main ──────────────────────────────────────────────────
export default function HermesPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [inbox, setInbox] = useState<Req[]>([]);
  const [pending, setPending] = useState(0);
  const [events, setEvents] = useState<Ev[]>([]);
  const [nativeSnapshot, setNativeSnapshot] = useState<NativeSnapshot | null>(null);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [cronSync, setCronSync] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [h, reqs, act, native, cr] = await Promise.all([
      getJSON<Health>("/api/hermes/health"),
      getJSON<{ requests: Req[]; pending: number }>(
        "/api/hermes/requests?status=awaiting_approval&take=50"
      ),
      getJSON<{ events: Ev[] }>("/api/hermes/activity?take=40"),
      getJSON<NativeSnapshot>("/api/hermes/native"),
      getJSON<{ jobs: CronJob[]; syncedAt: string }>("/api/hermes/crons"),
    ]);
    if (h) setHealth(h);
    if (reqs) {
      setInbox(reqs.requests ?? []);
      setPending(reqs.pending ?? reqs.requests?.length ?? 0);
    }
    if (act) setEvents(act.events ?? []);
    if (native) setNativeSnapshot(native);
    if (cr) {
      setJobs(cr.jobs ?? []);
      setCronSync(cr.syncedAt ?? null);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    const firstLoad = setTimeout(() => {
      void load();
    }, 0);
    const iv = setInterval(load, 8000);
    return () => {
      clearTimeout(firstLoad);
      clearInterval(iv);
    };
  }, [load]);

  const manualRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <>
      <div className="relative z-10 w-full mx-auto pb-16">
        {/* Header */}
        <div className="hq-rise pt-4 pb-8 flex items-end justify-between gap-4">
          <div>
            <Eyebrow>Agent runtime</Eyebrow>
            <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
              Hermes
            </h1>
          </div>
          <div className="flex items-center gap-2.5">
            <HealthChip health={health} />
            <button
              type="button"
              onClick={manualRefresh}
              aria-label="Refresh"
              className="btn-ghost inline-flex items-center justify-center w-9 h-9"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Dispatches — what you've sent Hermes + live status/results */}
        <section className="mt-12">
          <HermesDispatches />
        </section>

        {/* Approval inbox */}
        <section className="mt-12">
          <SectionHeader
            label="Approval inbox"
            title="Awaiting approval"
            action={
              pending > 0 ? (
                <Pill tone="warn">{pending} pending</Pill>
              ) : (
                <span className="num text-[11px] text-[var(--text-3)]">clear</span>
              )
            }
          />
          {!loaded ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </div>
          ) : (
            <Panel className="p-2">
              <EmptyState
                icon={<Inbox className="w-6 h-6" />}
                title={inbox.length === 0 ? "Nothing awaiting approval." : "Approvals are read-only."}
                hint="Browser approvals and dispatch mutations are disabled on this Mission Control surface."
              />
            </Panel>
          )}
        </section>

        {/* Native work state */}
        <section className="mt-12">
          {!loaded ? (
            <>
              <SectionHeader label="Native work state" title="Goals, operator tasks, archive" />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <Skeleton className="h-48" />
                <Skeleton className="h-48" />
                <Skeleton className="h-48" />
              </div>
            </>
          ) : (
            <NativeWorkPanel snapshot={nativeSnapshot} />
          )}
        </section>

        {/* Cron / schedules */}
        <section className="mt-12">
          {!loaded ? (
            <>
              <SectionHeader label="Cron · schedules" title="Recurring jobs" />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Skeleton className="h-56" />
                <Skeleton className="h-56" />
              </div>
            </>
          ) : (
            <CronPanel jobs={jobs} syncedAt={cronSync} />
          )}
        </section>

        {/* Activity feed */}
        <section className="mt-12">
          {!loaded ? (
            <>
              <SectionHeader label="Activity" title="Recent events" />
              <Skeleton className="h-64" />
            </>
          ) : (
            <ActivityFeed events={events} />
          )}
        </section>

        {/* Observability — runs & usage */}
        <section className="mt-12">
          <HermesRuns />
        </section>
      </div>
    </>
  );
}
