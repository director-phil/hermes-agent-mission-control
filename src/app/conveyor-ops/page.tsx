"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Bot,
  Database,
  FileCode2,
  GitBranch,
  Info,
  ListTree,
  Package,
  Radio,
  RefreshCw,
  Shuffle,
  Wrench,
} from "lucide-react";
import { EmptyState, Eyebrow, Panel, Pill, SectionHeader, Skeleton, rise } from "@/components/ui/kit";

/* ── data shapes ── */

type RunStatusTone = "neutral" | "up" | "down" | "warn" | "accent";

interface RunIndex {
  goal: string;
  status: string;
  attempts: number;
  liveController?: boolean;
  rung?: number | null;
  lastActivity: string | null;
  nodeLabels: string[];
  filesTouched: number;
}

interface ConveyorActive {
  goalId: string;
  live: boolean;
  status: string | null;
  rung: number | null;
  attempts: number | null;
  pr: string | null;
}
interface ConveyorUpNext {
  goalId: string;
  title: string;
  specialist: string | null;
  dependencyReady?: boolean;
  planRequired?: boolean;
  waitingOn?: string[];
}
interface ConveyorBlocked {
  goalId: string;
  queueState: string;
  blockedBy: string[];
  failedDependencies: string[];
}
interface ConveyorState {
  conveyorOn: boolean;
  active: ConveyorActive[];
  upNext: ConveyorUpNext[];
  blocked: ConveyorBlocked[];
  counts: Record<string, number>;
  message: string;
}

interface ActivityEvent {
  id: string;
  kind: string;
  title: string;
  detail?: string | null;
  agent?: string | null;
  level: string;
  createdAt: string;
}

type ToolCall = { name: string; path?: string };
type NodeSummary = { modelCalls: number; toolCalls: number; topTools: Record<string, number> };
type SessionData = {
  sessionId: string;
  toolCalls: ToolCall[];
  nodes: Record<string, NodeSummary>;
  totalTools: number;
  filesRead: string[];
  filesWritten: string[];
} | null;

interface LiveGoal {
  goalId: string;
  state: Record<string, unknown>;
  log: string[];
  session: SessionData;
  packets: unknown[];
}

interface LivePayload {
  active: boolean;
  goals: LiveGoal[];
  counts?: { done: number; failed: number };
}

/* ── fetch + format helpers ── */

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function normalizeStatus(status: string | null | undefined) {
  return String(status || "").toLowerCase();
}

function isFailedStatus(status: string | null | undefined) {
  const normalized = normalizeStatus(status);
  return ["failed", "failure", "crash", "error"].includes(normalized) || normalized.includes("fail");
}

function isTerminalSuccessStatus(status: string | null | undefined) {
  return ["done", "complete", "completed", "passed", "success", "shipped", "merged"].includes(normalizeStatus(status));
}

function statusTone(status: string | null | undefined, running = false): RunStatusTone {
  if (running) return "accent";
  if (isTerminalSuccessStatus(status)) return "up";
  if (isFailedStatus(status)) return "down";
  return "neutral";
}

function fmtRelative(value: string | null | undefined) {
  if (!value) return "no activity";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "no activity";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(time).toLocaleDateString();
}

function shortPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `${parts.at(-3)}/${parts.at(-2)}/${parts.at(-1)}`;
}

function safeId(prefix: string, value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return `${prefix}:${hash.toString(16)}`;
}

const STAGE_ORDER = ["Planner", "Local Implementer", "Gate Script", "Gate Runner", "Loop Gate"];

const RUNG_TABS = ["Local", "Cloud", "Codex", "Gate", "Preview", "Production"];

function activeRungTabs(active: ConveyorActive | null): Set<string> {
  if (!active) return new Set();
  const status = normalizeStatus(active.status);
  const rung = active.rung ?? 0;
  const tabs = new Set<string>();
  if (rung <= 0) tabs.add("Local");
  if (rung >= 1) {
    tabs.add("Cloud");
    tabs.add("Codex");
  }
  if (status.includes("gate") || status === "running" || status === "recovering") tabs.add("Gate");
  if (status.includes("preview")) tabs.add("Preview");
  if (["shipping", "deploying", "shipped", "merged"].includes(status) || isTerminalSuccessStatus(status)) tabs.add("Production");
  return tabs;
}

/* ── packet-derived scribe helpers (loosely-typed filesystem JSON) ── */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringifyEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const rec = entry as Record<string, unknown>;
    const text = rec.message || rec.reason || rec.summary || rec.detail;
    if (typeof text === "string") return text;
  }
  return null;
}

function packetFailures(packet: unknown): string[] {
  const failures = asRecord(packet).failures;
  if (!Array.isArray(failures)) return [];
  return failures.map(stringifyEntry).filter((v): v is string => Boolean(v));
}

function packetInferred(packet: unknown): string[] {
  const rec = asRecord(packet);
  const candidates = [rec.diagnosis, rec.inferred, rec.findings, rec.diagnostician];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) out.push(...candidate.map(stringifyEntry).filter((v): v is string => Boolean(v)));
    else {
      const single = stringifyEntry(candidate);
      if (single) out.push(single);
    }
  }
  return out;
}

function packetLabel(packet: unknown, index: number): string {
  const rec = asRecord(packet);
  const attempt = rec.attempt ?? index + 1;
  const from = rec.from || rec.node || "agent";
  const to = rec.to || "";
  return to ? `#${attempt} · ${from} → ${to}` : `#${attempt} · ${from}`;
}

/* ── React Flow node types ── */

type StageNodeData = { label: string; summary: NodeSummary | null; isCurrent: boolean };
type FileNodeData = { path: string; op: "read" | "write" };
type OpsNode = Node<StageNodeData, "stage"> | Node<FileNodeData, "file">;

function StageFlowNode({ data }: NodeProps<Node<StageNodeData, "stage">>) {
  const topTools = data.summary ? Object.entries(data.summary.topTools).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
  const hasData = Boolean(data.summary);
  return (
    <div className={`ops-node ${data.isCurrent ? "is-current" : ""} ${!hasData ? "is-idle" : ""}`}>
      <Handle type="target" position={Position.Top} className="ops-handle" />
      <Handle type="source" position={Position.Bottom} className="ops-handle" />
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-[13px] font-semibold text-[var(--text)]">{data.label}</h3>
        {data.isCurrent && <Pill tone="accent" className="!py-0.5 !text-[10px]">now</Pill>}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <Eyebrow className="!text-[9px]">Model calls</Eyebrow>
          <p className="num mt-1 text-[16px] font-semibold text-[var(--text)]">{data.summary?.modelCalls ?? 0}</p>
        </div>
        <div>
          <Eyebrow className="!text-[9px]">Tool calls</Eyebrow>
          <p className="num mt-1 text-[16px] font-semibold text-[var(--accent)]">{data.summary?.toolCalls ?? 0}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {topTools.length ? (
          topTools.map(([tool, count]) => (
            <span key={tool} className="rounded-full border border-[var(--line)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-3)]">
              {tool} <span className="num">x{count}</span>
            </span>
          ))
        ) : (
          <span className="text-[10px] text-[var(--text-4)]">no data yet</span>
        )}
      </div>
    </div>
  );
}

function FileFlowNode({ data }: NodeProps<Node<FileNodeData, "file">>) {
  const color = data.op === "write" ? "var(--up)" : "var(--text-3)";
  return (
    <div className="ops-file-node">
      <Handle type="target" position={Position.Left} className="ops-handle" />
      <div className="flex items-start gap-2">
        <FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color }} />
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-[var(--text)]">{shortPath(data.path)}</p>
          <span className="text-[9.5px]" style={{ color }}>{data.op}</span>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = { stage: StageFlowNode, file: FileFlowNode };

function buildGraph(liveGoal: LiveGoal | null, currentNode: string | null): { nodes: OpsNode[]; edges: Edge[] } {
  const nodes: OpsNode[] = [];
  const edges: Edge[] = [];
  const session = liveGoal?.session ?? null;

  STAGE_ORDER.forEach((label, index) => {
    nodes.push({
      id: safeId("stage", label),
      type: "stage",
      position: { x: 0, y: index * 148 },
      data: { label, summary: session?.nodes[label] ?? null, isCurrent: currentNode === label },
    });
    if (index > 0) {
      const source = safeId("stage", STAGE_ORDER[index - 1]);
      const target = safeId("stage", label);
      edges.push({
        id: `chain:${source}:${target}`,
        source,
        target,
        type: "smoothstep",
        animated: currentNode === label || currentNode === STAGE_ORDER[index - 1],
        style: { stroke: "var(--accent)", strokeWidth: 1.8 },
      });
    }
  });

  const implementerId = safeId("stage", "Local Implementer");
  const filesWritten = new Set(session?.filesWritten ?? []);
  const files = [...(session?.filesWritten ?? []), ...(session?.filesRead ?? [])].filter(
    (path, index, arr) => arr.indexOf(path) === index,
  );

  files.slice(0, 12).forEach((filePath, index) => {
    const fileId = safeId("file", filePath);
    nodes.push({
      id: fileId,
      type: "file",
      position: { x: 420, y: index * 76 },
      data: { path: filePath, op: filesWritten.has(filePath) ? "write" : "read" },
    });
    edges.push({
      id: `touch:${fileId}`,
      source: implementerId,
      target: fileId,
      type: "smoothstep",
      style: { stroke: filesWritten.has(filePath) ? "var(--up)" : "var(--text-3)", strokeWidth: 1.2 },
    });
  });

  return { nodes, edges };
}

/* ── left panel: live queue ── */

type QueueTone = "accent" | "neutral" | "up" | "down" | "warn";

interface QueueCard {
  goalId: string;
  statusLabel: string;
  tone: QueueTone;
  timeAgo: string;
  attempts: number;
  nodeLabels: string[];
  filesTouched: number;
}

function buildQueueCards(conveyor: ConveyorState | null, runs: RunIndex[]): QueueCard[] {
  const runByGoal = new Map(runs.map((run) => [run.goal, run]));
  const cards: QueueCard[] = [];
  const seen = new Set<string>();

  for (const active of conveyor?.active ?? []) {
    if (seen.has(active.goalId)) continue;
    seen.add(active.goalId);
    const run = runByGoal.get(active.goalId);
    cards.push({
      goalId: active.goalId,
      statusLabel: active.live ? "RUNNING" : (active.status || "recovering").toUpperCase(),
      tone: active.live ? "accent" : "warn",
      timeAgo: fmtRelative(run?.lastActivity ?? null),
      attempts: active.attempts ?? run?.attempts ?? 0,
      nodeLabels: run?.nodeLabels ?? [],
      filesTouched: run?.filesTouched ?? 0,
    });
  }

  for (const upNext of conveyor?.upNext ?? []) {
    if (seen.has(upNext.goalId)) continue;
    seen.add(upNext.goalId);
    const run = runByGoal.get(upNext.goalId);
    cards.push({
      goalId: upNext.goalId,
      statusLabel: "PENDING",
      tone: "neutral",
      timeAgo: fmtRelative(run?.lastActivity ?? null),
      attempts: run?.attempts ?? 0,
      nodeLabels: run?.nodeLabels ?? [],
      filesTouched: run?.filesTouched ?? 0,
    });
  }

  for (const blocked of conveyor?.blocked ?? []) {
    if (seen.has(blocked.goalId)) continue;
    seen.add(blocked.goalId);
    const run = runByGoal.get(blocked.goalId);
    cards.push({
      goalId: blocked.goalId,
      statusLabel: "BLOCKED",
      tone: "warn",
      timeAgo: fmtRelative(run?.lastActivity ?? null),
      attempts: run?.attempts ?? 0,
      nodeLabels: run?.nodeLabels ?? [],
      filesTouched: run?.filesTouched ?? 0,
    });
  }

  return cards;
}

function QueuePanel({
  conveyor,
  runs,
  loaded,
  selected,
  onSelect,
  completedCount,
  failedCount,
}: {
  conveyor: ConveyorState | null;
  runs: RunIndex[];
  loaded: boolean;
  selected: string | null;
  onSelect: (goal: string) => void;
  completedCount: number;
  failedCount: number;
}) {
  const cards = useMemo(() => buildQueueCards(conveyor, runs), [conveyor, runs]);
  const runningCount = (conveyor?.active.length ?? 0) + (conveyor?.upNext.length ?? 0);

  return (
    <Panel className="flex h-full min-h-[640px] w-full flex-col overflow-hidden p-3 md:w-[280px] md:shrink-0">
      <SectionHeader label="Runs" title="Live queue" action={<Pill tone="accent">{cards.length}</Pill>} />
      <div className="mb-3 grid grid-cols-3 gap-1.5 text-center">
        <div className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5">
          <p className="num text-[15px] font-semibold text-[var(--accent)]">{runningCount}</p>
          <p className="text-[9px] text-[var(--text-4)]">up next</p>
        </div>
        <div className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5">
          <p className="num text-[15px] font-semibold text-[var(--up)]">{completedCount}</p>
          <p className="text-[9px] text-[var(--text-4)]">done</p>
        </div>
        <div className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5">
          <p className="num text-[15px] font-semibold text-[var(--down)]">{failedCount}</p>
          <p className="text-[9px] text-[var(--text-4)]">failed</p>
        </div>
      </div>
      {!loaded ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-20" />)}
        </div>
      ) : cards.length === 0 ? (
        <EmptyState icon={<GitBranch className="h-6 w-6" />} title="Queue is empty" hint="Nothing active, staged, or blocked right now." />
      ) : (
        <div className="max-h-[calc(100vh-320px)] space-y-2 overflow-y-auto pr-1">
          {cards.map((card) => (
            <button
              key={card.goalId}
              type="button"
              onClick={() => onSelect(card.goalId)}
              className={`w-full rounded-[var(--r-md)] border p-2.5 text-left transition ${
                selected === card.goalId
                  ? "border-[var(--line-strong)] bg-[var(--surface-2)]"
                  : "border-[var(--line)] bg-transparent hover:bg-[var(--surface-1)]"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-[11.5px] font-semibold text-[var(--text)]">{card.goalId}</p>
                <Pill tone={card.tone} className="!py-0.5 !text-[9px]">{card.statusLabel}</Pill>
              </div>
              <p className="num mt-1 text-[10px] text-[var(--text-4)]">{card.timeAgo} · attempt {card.attempts}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {card.nodeLabels.slice(0, 3).map((node) => (
                  <span key={node} className="rounded-full border border-[var(--line)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-3)]">
                    {node}
                  </span>
                ))}
                <span className="rounded-full border border-[var(--line)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-4)]">
                  {card.filesTouched} files
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ── center panel: process graph ── */

function CollaborationView({ packets }: { packets: unknown[] }) {
  const agents = ["P", "I", "D", "R"];
  const recent = packets.slice(-6);
  const ragCount = packets.filter((p) => asRecord(p).rag).length;
  const crosswalkCount = packets.filter((p) => asRecord(p).crosswalk).length;
  const correctionsCount = packets.filter((p) => packetFailures(p).length > 0).length;

  return (
    <div className="border-t border-[var(--line)] px-5 py-4">
      <Eyebrow>Agent collaboration view</Eyebrow>
      <div className="mt-3 flex items-center justify-between gap-3 px-4">
        {agents.map((agent) => (
          <div key={agent} className="flex flex-col items-center gap-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--line-strong)] bg-[var(--surface-2)] text-[12px] font-semibold text-[var(--text)]">
              {agent}
            </div>
          </div>
        ))}
      </div>
      {recent.length === 0 ? (
        <p className="mt-3 text-center text-[11px] text-[var(--text-4)]">No packet exchanges mirrored yet.</p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {recent.map((packet, index) => (
            <div key={index} className="truncate rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[10.5px] text-[var(--text-3)]">
              {packetLabel(packet, index)}
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-2 text-center">
          <Database className="mx-auto h-3.5 w-3.5 text-[var(--text-3)]" />
          <p className="num mt-1 text-[13px] font-semibold text-[var(--text)]">{ragCount}</p>
          <p className="text-[9px] text-[var(--text-4)]">RAG</p>
        </div>
        <div className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-2 text-center">
          <Package className="mx-auto h-3.5 w-3.5 text-[var(--text-3)]" />
          <p className="num mt-1 text-[13px] font-semibold text-[var(--text)]">{packets.length}</p>
          <p className="text-[9px] text-[var(--text-4)]">Pack data</p>
        </div>
        <div className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-2 text-center">
          <Shuffle className="mx-auto h-3.5 w-3.5 text-[var(--text-3)]" />
          <p className="num mt-1 text-[13px] font-semibold text-[var(--text)]">{crosswalkCount}</p>
          <p className="text-[9px] text-[var(--text-4)]">Crosswalk</p>
        </div>
        <div className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-2 text-center">
          <Wrench className="mx-auto h-3.5 w-3.5 text-[var(--text-3)]" />
          <p className="num mt-1 text-[13px] font-semibold text-[var(--text)]">{correctionsCount}</p>
          <p className="text-[9px] text-[var(--text-4)]">Corrections</p>
        </div>
      </div>
    </div>
  );
}

function ProcessGraphPanel({
  selectedGoal,
  liveGoal,
  loaded,
  activeEntry,
  run,
}: {
  selectedGoal: string | null;
  liveGoal: LiveGoal | null;
  loaded: boolean;
  activeEntry: ConveyorActive | null;
  run: RunIndex | null;
}) {
  const lastLog = liveGoal?.log.at(-1) ?? null;
  const currentNode = useMemo(() => {
    if (!lastLog) return null;
    const match = STAGE_ORDER.find((label) => lastLog.includes(label));
    return match ?? null;
  }, [lastLog]);

  const built = useMemo(() => buildGraph(liveGoal, currentNode), [liveGoal, currentNode]);
  const [nodes, setNodes, onNodesChange] = useNodesState<OpsNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const flowRef = useRef<ReactFlowInstance<OpsNode, Edge> | null>(null);
  const fittedRef = useRef<string | null>(null);
  const rungTabs = useMemo(() => activeRungTabs(activeEntry), [activeEntry]);
  const timeline = (liveGoal?.log ?? []).slice(-20).reverse();
  const running = Boolean(activeEntry?.live);
  const status = activeEntry?.status || run?.status || "unknown";

  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built.edges, built.nodes, setNodes, setEdges]);

  useEffect(() => {
    if (!selectedGoal || nodes.length === 0 || !flowRef.current) return;
    if (fittedRef.current === selectedGoal) return;
    fittedRef.current = selectedGoal;
    const frame = requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.2, duration: 300 }));
    return () => cancelAnimationFrame(frame);
  }, [selectedGoal, nodes.length]);

  return (
    <Panel className="min-h-[640px] flex-1 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <Eyebrow>Process graph</Eyebrow>
          <h2 className="mt-1 truncate text-[18px] font-semibold text-[var(--text)]">{selectedGoal || "No goal selected"}</h2>
        </div>
        {selectedGoal && (
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={statusTone(status, running)}>{running ? "running" : status}</Pill>
            <Pill tone="neutral">{liveGoal?.session?.totalTools ?? 0} tools</Pill>
            <Pill tone="neutral">{(liveGoal?.session?.filesRead.length ?? 0) + (liveGoal?.session?.filesWritten.length ?? 0)} files</Pill>
          </div>
        )}
      </div>

      {selectedGoal && (
        <div className="flex flex-wrap gap-1.5 border-b border-[var(--line)] px-5 py-2.5">
          {RUNG_TABS.map((tab) => (
            <span
              key={tab}
              className={`rounded-full border px-2.5 py-1 text-[10.5px] font-medium ${
                rungTabs.has(tab)
                  ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "border-[var(--line)] text-[var(--text-4)]"
              }`}
            >
              {tab}
            </span>
          ))}
        </div>
      )}

      {selectedGoal && (
        <div className="ops-now-strip mx-5 mt-3 flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[12px] text-[var(--text-2)]">
          <span className="ops-now-dot" aria-hidden="true" />
          <span className="truncate">
            <span className="font-semibold text-[var(--text)]">NOW</span> · {currentNode || "waiting"} · {status} · {fmtRelative(run?.lastActivity)}
          </span>
        </div>
      )}

      <div className="ops-flow h-[420px]">
        {!loaded ? (
          <div className="p-5"><Skeleton className="h-[380px]" /></div>
        ) : !selectedGoal ? (
          <EmptyState icon={<GitBranch className="h-6 w-6" />} title="Select a goal" hint="Pick a run from the live queue to inspect its process graph." className="h-full" />
        ) : !liveGoal?.session ? (
          <EmptyState icon={<Radio className="h-6 w-6 animate-pulse" />} title="No session data yet" hint="Waiting for the local session trace to mirror to disk." className="h-full" />
        ) : (
          <ReactFlow<OpsNode, Edge>
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onInit={(instance) => { flowRef.current = instance; }}
            nodeTypes={nodeTypes}
            minZoom={0.25}
            maxZoom={1.4}
            nodesDraggable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="rgba(255,255,255,0.08)" gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      {selectedGoal && timeline.length > 0 && (
        <div className="border-t border-[var(--line)] px-5 py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Eyebrow>Sequence</Eyebrow>
            <Pill tone="neutral" className="!py-0.5 !text-[10px]">last {timeline.length}</Pill>
          </div>
          <ol className="grid max-h-32 gap-1.5 overflow-y-auto pr-1 md:grid-cols-2">
            {timeline.map((line, index) => (
              <li key={index} className="min-w-0 truncate rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[11px] text-[var(--text-3)]">
                {line}
              </li>
            ))}
          </ol>
        </div>
      )}

      {selectedGoal && <CollaborationView packets={liveGoal?.packets ?? []} />}
    </Panel>
  );
}

/* ── right panel: scribe ── */

function ScribePanel({ liveGoal, loaded }: { liveGoal: LiveGoal | null; loaded: boolean }) {
  const packets = liveGoal?.packets ?? [];
  const learned = packets.flatMap(packetFailures);
  const inferred = packets.flatMap(packetInferred);

  return (
    <Panel className="flex h-full min-h-[640px] w-full flex-col overflow-hidden p-4 md:w-[300px] md:shrink-0">
      <SectionHeader
        label="Scribe"
        title="Learned / inferred"
        action={liveGoal ? <Pill tone="neutral">attempt {packets.length}</Pill> : null}
      />
      {!loaded ? (
        <div className="space-y-2">
          {[0, 1, 2].map((item) => <Skeleton key={item} className="h-16" />)}
        </div>
      ) : !liveGoal ? (
        <EmptyState icon={<Info className="h-6 w-6" />} title="Select a goal" hint="Scribe notes appear beside the active process graph." />
      ) : (
        <div className="max-h-[calc(100vh-260px)] overflow-y-auto pr-1">
          <div>
            <Eyebrow>Learned</Eyebrow>
            {learned.length === 0 ? (
              <p className="mt-2 text-[11px] text-[var(--text-4)]">No failures logged for this goal yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {learned.slice(0, 12).map((item, index) => (
                  <li key={index} className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--text-2)]">
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-6">
            <Eyebrow>Inferred</Eyebrow>
            {inferred.length === 0 ? (
              <p className="mt-2 text-[11px] text-[var(--text-4)]">No diagnostician findings mirrored yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {inferred.slice(0, 10).map((item, index) => (
                  <li key={index} className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--text-2)]">
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ── page ── */

export default function ConveyorOpsPage() {
  const [conveyor, setConveyor] = useState<ConveyorState | null>(null);
  const [runs, setRuns] = useState<RunIndex[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [live, setLive] = useState<LivePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [conveyorData, runsData, activityData, liveData] = await Promise.all([
      getJSON<ConveyorState>("/api/conveyor"),
      getJSON<RunIndex[]>("/api/runs"),
      getJSON<{ events: ActivityEvent[] }>("/api/hermes/activity"),
      getJSON<LivePayload>("/api/conveyor/live"),
    ]);
    if (conveyorData) setConveyor(conveyorData);
    if (runsData) setRuns(runsData);
    if (activityData?.events) setActivity(activityData.events);
    if (liveData) setLive(liveData);
    setLoaded(true);
    setSelectedGoal((current) => {
      if (current) return current;
      const firstActive = conveyorData?.active[0]?.goalId;
      const firstUpNext = conveyorData?.upNext[0]?.goalId;
      const firstLive = liveData?.goals[0]?.goalId;
      return firstActive ?? firstLive ?? firstUpNext ?? runsData?.[0]?.goal ?? null;
    });
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 5_000);
    return () => clearInterval(interval);
  }, [load]);

  const liveGoal = useMemo(
    () => (selectedGoal ? live?.goals.find((g) => g.goalId === selectedGoal) ?? null : null),
    [live, selectedGoal],
  );
  const activeEntry = useMemo(
    () => (selectedGoal ? conveyor?.active.find((a) => a.goalId === selectedGoal) ?? null : null),
    [conveyor, selectedGoal],
  );
  const selectedRun = useMemo(
    () => (selectedGoal ? runs.find((r) => r.goal === selectedGoal) ?? null : null),
    [runs, selectedGoal],
  );

  const completedCount = live?.counts?.done ?? runs.filter((r) => isTerminalSuccessStatus(r.status)).length;
  const failedCount = live?.counts?.failed ?? runs.filter((r) => isFailedStatus(r.status)).length;

  return (
    <div className="relative z-10 mx-auto w-full p-8 pb-16 text-[var(--text)]">
      <div className="hq-rise flex flex-wrap items-end justify-between gap-6" style={rise(0)}>
        <div>
          <Eyebrow>Conveyor</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold leading-none tracking-[-0.025em] text-[var(--text)]">Conveyor Ops</h1>
          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-[var(--text-3)]">
            Real-time visibility into the autonomous goal conveyor — live queue, process graph, and scribe notes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={conveyor?.conveyorOn ? "up" : "down"}>
            <Radio className="h-3 w-3" />
            {conveyor?.conveyorOn ? "Conveyor ON" : "Conveyor OFF"}
          </Pill>
          <Pill tone="neutral">
            <ListTree className="h-3 w-3" />
            {activity.length} activity events
          </Pill>
          <Pill tone="neutral">
            <RefreshCw className="h-3 w-3" />
            polling 5s
          </Pill>
        </div>
      </div>

      <section className="mt-6 flex flex-col gap-4 xl:flex-row">
        <QueuePanel
          conveyor={conveyor}
          runs={runs}
          loaded={loaded}
          selected={selectedGoal}
          onSelect={setSelectedGoal}
          completedCount={completedCount}
          failedCount={failedCount}
        />
        <ProcessGraphPanel
          selectedGoal={selectedGoal}
          liveGoal={liveGoal}
          loaded={loaded}
          activeEntry={activeEntry}
          run={selectedRun}
        />
        <ScribePanel liveGoal={liveGoal} loaded={loaded} />
      </section>
    </div>
  );
}
