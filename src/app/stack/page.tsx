"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  Brain,
  Cpu,
  Database,
  GitBranch,
  Layers,
  Network,
  Plug,
  Puzzle,
  RefreshCw,
} from "lucide-react";
import { Pill, SectionHeader, rise } from "@/components/ui/kit";

type Tone = "up" | "warn" | "down" | "accent" | "neutral";

interface Component {
  name: string;
  detail: string;
}

interface Layer {
  name: string;
  icon: typeof Plug;
  hint: string;
  live?: boolean;
  components: Component[];
}

const LAYERS: Layer[] = [
  {
    name: "Desktop plugins",
    icon: Plug,
    hint: "Hermes app surfaces",
    components: [
      { name: "hermes-achievements", detail: "gamification pane" },
      { name: "rt-extensions", detail: "Reliable Tradies surface" },
      { name: "ai-document-extraction", detail: "OCR / document pipeline" },
    ],
  },
  {
    name: "Orchestration",
    icon: Network,
    hint: "goal conveyor",
    live: true,
    components: [
      { name: "goal-conveyor", detail: "keeper → escalate.py" },
      { name: "native-goal-runner", detail: "hermes-native-goal-runner.service" },
      { name: "structured-json", detail: "constrained JSON decoding" },
    ],
  },
  {
    name: "Agents",
    icon: Bot,
    hint: "3 model seats",
    components: [
      { name: "planner", detail: "local-planner · qwen3.8-27b" },
      { name: "coder", detail: "local-coder · qwen3-coder-next" },
      { name: "reviewer", detail: "local-reviewer · qwen3.8-27b" },
    ],
  },
  {
    name: "Tools — graft etc.",
    icon: GitBranch,
    hint: "specialist bridge",
    live: true,
    components: [
      { name: "graft_repo_map", detail: "build the 2,601-file repo graph" },
      { name: "graft_find_code", detail: "search the graph" },
      { name: "read_pack", detail: "read the task packet" },
      { name: "read_repo_file", detail: "read a file" },
      { name: "write_repo_file", detail: "write a file" },
      { name: "apply_patch", detail: "apply a diff" },
      { name: "move_repo_file", detail: "rename a file" },
      { name: "list_allowed_directory", detail: "list scoped dir" },
      { name: "latest_migration", detail: "next migration number" },
    ],
  },
  {
    name: "MCP servers",
    icon: Puzzle,
    hint: "loaded on demand",
    components: [
      { name: "playwright", detail: "browser · 24 tools" },
      { name: "posthog", detail: "analytics · 5" },
      { name: "langfuse-docs", detail: "docs · 4" },
      { name: "smart-connections", detail: "Obsidian RAG · 3" },
      { name: "wordpress", detail: "CMS · 7" },
      { name: "x_search · rss · video", detail: "search, feeds, media" },
    ],
  },
  {
    name: "Gateway + models",
    icon: Cpu,
    hint: "admission :19875",
    components: [
      { name: "admission-gateway", detail: "127.0.0.1:19875" },
      { name: "qwen3-coder-next", detail: "coder" },
      { name: "qwen3.8-27b", detail: "planner + reviewer" },
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
    name: "Data + observability",
    icon: Database,
    hint: "telemetry + memory",
    components: [
      { name: "Langfuse", detail: "traces + evals" },
      { name: "Qdrant", detail: "vector store" },
      { name: "Supabase", detail: "raw source tables" },
    ],
  },
  {
    name: "Knowledge graph",
    icon: Brain,
    hint: "DevChat-style static index → dynamic query",
    components: [
      { name: "rt-vault-knowledge", detail: "static+dynamic · ops knowledge" },
      { name: "rt-bugs", detail: "static+dynamic · confirmed bugs" },
      { name: "rt-patterns", detail: "static+dynamic · proven solutions" },
      { name: "rt-decisions", detail: "static+dynamic · ADRs" },
      { name: "skills", detail: "static · 60+ SKILL.md" },
      { name: "vault records", detail: "static · change records" },
      { name: "user profile", detail: "static · durable facts" },
    ],
  },
];

const DEFERRED = [
  { name: "Graphiti / Zep", detail: "temporal knowledge graph", reason: "superseded by local knowledge pattern (DevChat-style)" },
  { name: "llguidance", detail: "structured generation", reason: "covered by LM Studio json_schema" },
  { name: "OnlyCLI", detail: "CLI automation", reason: "works, no immediate fit" },
  { name: "Deer-flow", detail: "workflow engine", reason: "deferred" },
  { name: "BossConsole / JAT", detail: "agent orchestration UI", reason: "deferred" },
];

function toneFor(state: string): Tone {
  switch (state) {
    case "running": return "accent";
    case "ready": return "up";
    case "failed": return "down";
    case "blocked": return "warn";
    case "done": return "up";
    default: return "neutral";
  }
}

export default function StackPage() {
  const [goals, setGoals] = useState<any[] | null>(null);
  const [refreshed, setRefreshed] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await fetch("/api/goals", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (alive) {
          setGoals(Array.isArray(data.goals) ? data.goals : []);
          setRefreshed(new Date());
        }
      } catch {
        /* keep last state */
      }
    }
    poll();
    const t = setInterval(poll, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { running: 0, ready: 0, failed: 0, blocked: 0, done: 0 };
    for (const g of goals ?? []) {
      const s = (g.state ?? g.status ?? "").toString();
      if (s in c) c[s]++;
    }
    return c;
  }, [goals]);

  const conveyorState = counts.running > 0
    ? "running"
    : counts.failed > 0
      ? "failed"
      : counts.blocked > 0
        ? "blocked"
        : counts.ready > 0
          ? "ready"
          : goals === null
            ? "unknown"
            : "idle";

  const busy = counts.running > 0;

  return (
    <main className="px-5 py-6 md:px-8">
      <SectionHeader
        label="System"
        title="System stack"
        action={
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-3)]">
            <RefreshCw className="h-3.5 w-3.5" />
            {refreshed ? `refreshed ${refreshed.toLocaleTimeString()}` : "polling /api/goals…"}
          </span>
        }
      />

      {/* summary strip */}
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "running", value: counts.running },
          { label: "ready", value: counts.ready },
          { label: "failed", value: counts.failed },
          { label: "blocked", value: counts.blocked },
          { label: "done", value: counts.done },
          { label: "conveyor", value: conveyorState },
        ].map((s, i) => (
          <div key={s.label} className="rounded-lg border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2.5" style={rise(i)}>
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-4)]">{s.label}</div>
            <div className="text-[15px] font-semibold text-[var(--text)]">{s.value}</div>
          </div>
        ))}
      </div>

      {/* layers */}
      <div className="grid grid-cols-1 gap-4">
        {LAYERS.map((layer, i) => (
          <section key={layer.name} className="rounded-xl border border-[var(--line)] bg-[var(--surface-1)] p-4" style={rise(i)}>
            <div className="mb-3 flex items-center gap-2.5">
              <layer.icon className="h-4 w-4 text-[var(--accent)]" />
              <h3 className="text-[14px] font-semibold text-[var(--text)]">{layer.name}</h3>
              <span className="text-[11.5px] text-[var(--text-4)]">{layer.hint}</span>
              {layer.live && (
                <Pill tone={busy ? "accent" : "neutral"} className="ml-auto !py-0.5 !text-[10px]">
                  {busy ? "in use" : "idle"}
                </Pill>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {layer.components.map((c) => (
                <div key={c.name} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[12.5px] text-[var(--text)]">{c.name}</div>
                    <div className="truncate text-[11px] text-[var(--text-3)]">{c.detail}</div>
                  </div>
                  <Pill tone={layer.live && busy ? "accent" : "neutral"} className="!py-0.5 !text-[10px]">
                    {layer.live ? (busy ? "busy" : "idle") : "on"}
                  </Pill>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* deferred recommendations */}
      <section className="mt-4 rounded-xl border border-dashed border-[var(--line-strong)] p-4" style={rise(8)}>
        <div className="mb-3 flex items-center gap-2.5">
          <Layers className="h-4 w-4 text-[var(--text-3)]" />
          <h3 className="text-[14px] font-semibold text-[var(--text)]">Recommended — deferred</h3>
          <span className="text-[11.5px] text-[var(--text-4)]">evaluated, not yet in the stack</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {DEFERRED.map((d) => (
            <div key={d.name} className="rounded-lg border border-[var(--line)] px-3 py-2.5 opacity-80">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[12.5px] text-[var(--text)]">{d.name}</span>
                <Pill tone="neutral" className="!py-0.5 !text-[10px]">deferred</Pill>
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--text-3)]">{d.detail}</div>
              <div className="mt-1 text-[11px] text-[var(--text-4)]">why: {d.reason}</div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
