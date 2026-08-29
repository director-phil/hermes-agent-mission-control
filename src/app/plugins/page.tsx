"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Boxes,
  Cpu,
  Network,
  Plug,
  RefreshCw,
} from "lucide-react";
import { Pill, SectionHeader, rise } from "@/components/ui/kit";

export const dynamic = "force-dynamic";

type GoalState = "running" | "ready" | "failed" | "blocked" | "done";

interface Component {
  name: string;
  detail: string;
  live?: "goals";
}

interface Layer {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
  components: Component[];
}

const LAYERS: Layer[] = [
  {
    name: "Desktop plugins",
    icon: Plug,
    hint: "Hermes app surfaces",
    components: [
      { name: "hermes-achievements", detail: "gamification pane" },
      { name: "rt-extensions", detail: "Reliable Tradies extensions" },
      { name: "ai-document-extraction", detail: "OCR / doc pipeline" },
    ],
  },
  {
    name: "Orchestration",
    icon: Network,
    hint: "goal conveyor",
    components: [
      { name: "goal-conveyor", detail: "rt-goal-queue → escalate.py", live: "goals" },
      { name: "native-goal-runner", detail: "hermes-native-goal-runner.service", live: "goals" },
    ],
  },
  {
    name: "Model gateway",
    icon: Cpu,
    hint: "admission :19875",
    components: [
      { name: "admission-gateway", detail: "127.0.0.1:19875" },
      { name: "local-planner", detail: "qwen3.8-27b" },
      { name: "local-coder", detail: "qwen3-coder-next" },
      { name: "local-reviewer", detail: "qwen3.8-27b" },
      { name: "text-embedding-bge-m3", detail: "embeddings" },
    ],
  },
  {
    name: "Physical boxes",
    icon: Boxes,
    hint: "GB10 hardware",
    components: [
      { name: "gb10-coder", detail: "LM Studio :1234" },
      { name: "gb10-reviewer", detail: "GB10 Box 2" },
    ],
  },
  {
    name: "Observability",
    icon: Activity,
    hint: "telemetry",
    components: [
      { name: "langfuse", detail: "self-hosted" },
      { name: "mission-control api", detail: "/api/goals · /api/runs" },
    ],
  },
];

function normalizeState(s: string | null | undefined): GoalState | null {
  if (!s) return null;
  const v = s.toLowerCase();
  if (v.includes("run")) return "running";
  if (v.includes("ready")) return "ready";
  if (v.includes("fail")) return "failed";
  if (v.includes("block")) return "blocked";
  if (v.includes("done") || v.includes("complete") || v.includes("success")) return "done";
  return null;
}

function toneFor(state: string | null): "up" | "warn" | "down" | "accent" | "neutral" {
  switch (state) {
    case "running":
      return "accent";
    case "ready":
    case "done":
      return "up";
    case "failed":
      return "down";
    case "blocked":
      return "warn";
    case "online":
      return "up";
    default:
      return "neutral";
  }
}

export default function PluginsPage() {
  const [goals, setGoals] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await fetch("/api/goals", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (alive) {
          setGoals(Array.isArray(data.goals) ? data.goals : []);
          setRefreshed(new Date());
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const counts = useMemo(() => {
    const c: Record<GoalState, number> = { running: 0, ready: 0, failed: 0, blocked: 0, done: 0 };
    for (const g of goals ?? []) {
      const s = normalizeState(
        (g as { state?: string; status?: string }).state ??
          (g as { status?: string }).status,
      );
      if (s && s in c) c[s] += 1;
    }
    return c;
  }, [goals]);

  function conveyorStatus(): string | null {
    if (!goals) return null;
    if (counts.running > 0) return "running";
    if (counts.failed > 0) return "failed";
    if (counts.blocked > 0) return "blocked";
    if (counts.ready > 0) return "ready";
    if (counts.done > 0) return "done";
    return "idle";
  }

  const live = conveyorStatus();

  return (
    <main className="px-5 py-6 md:px-8">
      <SectionHeader
        label="System"
        title="Plugin stack"
        action={
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-3)]">
            <RefreshCw className="h-3.5 w-3.5" />
            {error
              ? `error: ${error}`
              : refreshed
                ? `refreshed ${refreshed.toLocaleTimeString()}`
                : "polling /api/goals…"}
          </span>
        }
      />

      {/* Live summary strip */}
      {goals !== null && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-3)]">
          <Pill tone="neutral">{goals.length} goals</Pill>
          <Pill tone="accent">{counts.running} running</Pill>
          <Pill tone="up">{counts.ready} ready</Pill>
          <Pill tone="warn">{counts.blocked} blocked</Pill>
          <Pill tone="down">{counts.failed} failed</Pill>
          <Pill tone="up">{counts.done} done</Pill>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {LAYERS.map((layer, i) => {
          const Icon = layer.icon;
          return (
            <section
              key={layer.name}
              className="panel"
              style={rise(i)}
            >
              <div className="flex items-center gap-2.5 px-4 pt-4">
                <Icon className="h-4 w-4 text-[var(--accent)]" />
                <h3 className="text-[14px] font-semibold text-[var(--text)]">{layer.name}</h3>
                <span className="eyebrow !text-[10px] !text-[var(--text-4)]">{layer.hint}</span>
              </div>
              <div className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {layer.components.map((c) => {
                  const status = c.live === "goals" ? live : "online";
                  return (
                    <div
                      key={c.name}
                      className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-[var(--text)]">
                          {c.name}
                        </div>
                        <div className="truncate text-[11px] text-[var(--text-3)]">{c.detail}</div>
                      </div>
                      <Pill tone={toneFor(status)} className="!py-0.5 !text-[10px]">
                        {status}
                      </Pill>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {error && goals === null && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-[var(--text-3)]">
          <Bot className="h-4 w-4" />
          <span>Waiting for live conveyor data… ({error})</span>
        </div>
      )}
    </main>
  );
}
