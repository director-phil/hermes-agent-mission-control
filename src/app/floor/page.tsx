"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type ReactFlowInstance,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Bot, Check, ExternalLink, FileCode2, GitBranch, Info, Radio, RefreshCw, X } from "lucide-react";
import { EmptyState, Eyebrow, Panel, Pill, SectionHeader, Skeleton, rise } from "@/components/ui/kit";


type RunStatusTone = "neutral" | "up" | "down" | "warn" | "accent";
type FileOp = "read" | "patch" | "write" | "delete";

interface RunIndex {
  goal: string;
  title?: string | null;
  source?: string | null;
  profile?: string | null;
  model?: string | null;
  operationId?: string | null;
  goalId?: string | null;
  runId?: string | null;
  stageId?: string | null;
  repo?: string | null;
  branch?: string | null;
  status: string;
  attempts: number;
  liveController?: boolean;
  traceRunning?: boolean;
  rung?: number | null;
  specialist?: string | null;
  shipped_pr?: string | null;
  preview_url?: string | null;
  lastActivity: string | null;
  nodeLabels: string[];
  filesTouched: number;
}

interface AdmissionGroup {
  id: string;
  physicalId: string | null;
  activeTokens: number;
  maxActive: number;
  queuedDepth: number;
  maxWaiting: number;
  active: Array<{ id: string; model: string | null; priority: string | null; activeAgeSeconds: number }>;
}

interface AdmissionPayload {
  available: boolean;
  draining: boolean;
  groups: AdmissionGroup[];
  readiness: { state?: string; ready?: boolean };
  syncedAt: string | null;
}

interface ProcessPayload {
  available: boolean;
  processes: Array<{ id: string; kind: string; live: boolean }>;
  syncedAt: string | null;
}

interface CronPayload {
  jobs: Array<{ status?: string }>;
  syncedAt: string | null;
}

interface NativeGoal {
  id: string;
  title: string;
  state: "ready" | "running" | "done" | "failed";
  source: "live-native" | "archive";
  status: string | null;
  updatedAt: string | null;
  evidence: string[];
  bytes: number;
}

interface NativeGoalsPayload {
  goals: {
    live: Record<"ready" | "running" | "done" | "failed", NativeGoal[]>;
    counts: Record<"ready" | "running" | "done" | "failed", number>;
    current: NativeGoal | null;
    recentFailed: NativeGoal[];
  };
}

interface ConveyorGoalSummary {
  goal: string;
  attempts: number;
  updatedAt: string | null;
}

interface ConveyorAttemptGraph {
  attempt: number;
  status: string;
  rung: number | null;
  startedAt: string | null;
  endedAt: string | null;
  running: boolean;
  agents: AgentTrace[];
  files: FileTrace[];
  flow: Array<{ from: string; to: string }>;
  touches: TouchTrace[];
  timeline: TimelineEntry[];
  currentAgent: string | null;
  currentActivity: CurrentActivity | null;
  counts: { events: number; modelCalls: number; toolCalls: number };
}

interface ConveyorRunGraph {
  goal: string;
  source: "conveyor-run";
  attempts: ConveyorAttemptGraph[];
  learnings: Array<{ attempt: number; learned: string[]; inferred: string[] }>;
  syncedAt: string;
}

function goalIdOf(goal: NativeGoal): string | null {
  const match = goal.id.match(/g_[A-Za-z0-9_.-]+/);
  return match ? match[0] : null;
}

function conveyorAttemptToRunGraph(goal: string, attempt: ConveyorAttemptGraph, learnings: ConveyorRunGraph["learnings"]): RunGraph {
  return {
    goal,
    attempt: attempt.attempt,
    status: attempt.status,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    running: attempt.running,
    agents: attempt.agents,
    files: attempt.files,
    flow: attempt.flow,
    touches: attempt.touches,
    learnings: learnings
      .filter((item) => item.attempt === attempt.attempt)
      .map((item) => ({ attempt: item.attempt, learned: item.learned, inferred: item.inferred })),
    currentAgent: attempt.currentAgent,
    currentActivity: attempt.currentActivity,
    timeline: attempt.timeline,
    counts: attempt.counts,
  };
}

// Synthesise a pipeline-stage view for a conveyor goal so the Local → Directed
// repair → Gate → Preview → Production strip renders for local runs too (not
// just chat sessions). Repair depth is inferred from the attempt number.
function conveyorGoalToRunIndex(goal: NativeGoal | null, attempt: ConveyorAttemptGraph | null): RunIndex | null {
  if (!goal) return null;
  const gid = goalIdOf(goal) ?? goal.id;
  const state = goal.state;
  const status = goal.status ?? state;
  return {
    goal: gid,
    title: goal.title,
    source: goal.source,
    profile: null,
    model: null,
    operationId: gid,
    goalId: gid,
    runId: null,
    stageId: null,
    repo: "ChatDev conveyor",
    branch: null,
    status,
    attempts: attempt ? attempt.attempt : 1,
    liveController: state === "running",
    traceRunning: false,
    rung: attempt ? Math.max(0, attempt.attempt - 1) : null,
    specialist: null,
    shipped_pr: null,
    preview_url: null,
    lastActivity: goal.updatedAt,
    nodeLabels: attempt ? attempt.agents.map((agent) => agent.label) : [],
    filesTouched: attempt ? attempt.files.length : 0,
  };
}

interface AgentTrace {
  id: string;
  label: string;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  modelCalls: number;
  toolCalls: number;
  tools: Record<string, number>;
}

interface FileTrace {
  path: string;
  ops: Record<FileOp, number>;
  total: number;
  lastOp: FileOp | null;
  lastNode: string | null;
}

interface TouchTrace {
  agent: string;
  path: string;
  op: FileOp;
  count: number;
}

interface LearningTrace {
  attempt: number;
  learned: string[];
  inferred: string[];
}

interface CurrentActivity {
  node: string;
  kind: "model" | "tool" | "idle";
  tool: string | null;
  file: string | null;
  at: string | null;
}

interface TimelineEntry {
  seq: number;
  node: string;
  kind: "node_start" | "node_end" | "model" | "tool";
  tool: string | null;
  file: string | null;
  at: string | null;
}

interface RunGraph {
  goal: string;
  attempt: number;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  running: boolean;
  agents: AgentTrace[];
  files: FileTrace[];
  flow: Array<{ from: string; to: string }>;
  touches: TouchTrace[];
  learnings: LearningTrace[];
  currentAgent?: string | null;
  currentActivity?: CurrentActivity | null;
  timeline?: TimelineEntry[];
  counts: { events: number; modelCalls: number; toolCalls: number };
}

type AgentNodeData = {
  agent: AgentTrace;
  running: boolean;
};

type FileNodeData = {
  file: FileTrace;
  active: boolean;
};

type AgentNode = Node<AgentNodeData, "agent">;
type FileNode = Node<FileNodeData, "file">;
type FloorNode = AgentNode | FileNode;

const OP_COLOR: Record<FileOp, string> = {
  read: "var(--text-3)",
  patch: "var(--accent)",
  write: "var(--up)",
  delete: "var(--down)",
};

const FLOW_COLOR = "color-mix(in srgb, var(--accent) 70%, var(--text) 30%)";

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

function isTrulyRunning(run: Pick<RunIndex, "liveController"> | null | undefined) {
  return run?.liveController === true;
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

function statusTone(status: string, running = false): RunStatusTone {
  const normalized = normalizeStatus(status);
  if (running) return "accent";
  if (isTerminalSuccessStatus(normalized)) return "up";
  if (isFailedStatus(normalized)) return "down";
  if (["shipping", "shipped", "deploying", "merged"].includes(normalized)) return "warn";
  if (normalized.includes("blocked")) return "warn";
  return "neutral";
}

function fmtRelative(value: string | null) {
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
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `${prefix}:${hash.toString(16)}`;
}

function AgentTraceNode({ data }: NodeProps<AgentNode>) {
  const toolEntries = Object.entries(data.agent.tools).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <div className={`floor-node floor-node-agent ${data.running ? "is-running" : ""}`}>
      <Handle type="target" position={Position.Left} className="floor-handle" />
      <Handle type="source" position={Position.Right} className="floor-handle" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="truncate text-[13px] font-semibold text-[var(--text)]">{data.agent.label}</h3>
          </div>
          <p className="mt-1 truncate text-[11.5px] text-[var(--text-3)]">{data.agent.model || "model pending"}</p>
        </div>
        <Pill tone={data.running ? "accent" : "neutral"} className="!py-0.5 !text-[10px]">
          {data.running ? "active turn" : "seen"}
        </Pill>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div>
          <Eyebrow>Model calls</Eyebrow>
          <p className="num mt-1 text-[18px] font-semibold text-[var(--text)]">{data.agent.modelCalls}</p>
        </div>
        <div>
          <Eyebrow>Tool calls</Eyebrow>
          <p className="num mt-1 text-[18px] font-semibold text-[var(--accent)]">{data.agent.toolCalls}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {toolEntries.length ? toolEntries.map(([tool, count]) => (
          <span key={tool} className="rounded-full border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--text-2)]">
            {tool} <span className="num text-[var(--text-3)]">x{count}</span>
          </span>
        )) : (
          <span className="text-[11px] text-[var(--text-4)]">No tool calls yet</span>
        )}
      </div>
    </div>
  );
}

function FileTraceNode({ data }: NodeProps<FileNode>) {
  const op = data.file.lastOp || "read";
  return (
    <div className={`floor-node floor-node-file ${data.active ? "is-active" : ""}`}>
      <Handle type="target" position={Position.Left} className="floor-handle" />
      <div className="flex items-start gap-2.5">
        <FileCode2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: OP_COLOR[op] }} />
        <div className="min-w-0">
          <h3 className="truncate text-[12.5px] font-semibold text-[var(--text)]">{shortPath(data.file.path)}</h3>
          <p className="mt-1 truncate text-[10.5px] text-[var(--text-4)]">{data.file.path}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(["read", "patch", "write", "delete"] as FileOp[]).map((item) => (
          data.file.ops[item] > 0 && (
            <span key={item} className="rounded-full border border-[var(--line)] px-2 py-1 text-[10px]" style={{ color: OP_COLOR[item] }}>
              {item} <span className="num">x{data.file.ops[item]}</span>
            </span>
          )
        ))}
      </div>
    </div>
  );
}

const nodeTypes = {
  agent: AgentTraceNode,
  file: FileTraceNode,
};

function buildGraph(graph: RunGraph): { nodes: FloorNode[]; edges: Edge[] } {
  const agentByLabel = new Map(graph.agents.map((agent) => [agent.label, agent]));
  const fileIdByPath = new Map(graph.files.map((file) => [file.path, safeId("file", file.path)]));
  const nodes: FloorNode[] = [];
  const edges: Edge[] = [];

  graph.agents.forEach((agent, index) => {
    const running = graph.currentAgent ? agent.label === graph.currentAgent : graph.running && !agent.endedAt;
    nodes.push({
      id: safeId("agent", agent.label),
      type: "agent",
      position: { x: 0, y: index * 168 },
      data: { agent, running },
    });
  });

  graph.files.slice(0, 60).forEach((file, index) => {
    nodes.push({
      id: fileIdByPath.get(file.path) || safeId("file", file.path),
      type: "file",
      position: { x: 480 + (index % 2) * 280, y: Math.floor(index / 2) * 124 },
      data: { file, active: graph.currentActivity?.file === file.path },
    });
  });

  graph.flow.forEach((edge, index) => {
    const source = agentByLabel.has(edge.from) ? safeId("agent", edge.from) : null;
    const target = agentByLabel.has(edge.to) ? safeId("agent", edge.to) : null;
    if (!source || !target) return;
    edges.push({
      id: `flow:${source}:${target}:${index}`,
      source,
      target,
      type: "smoothstep",
      animated: true,
      style: { stroke: FLOW_COLOR, strokeWidth: 1.8 },
      markerEnd: { type: "arrowclosed", color: "var(--accent)" },
    });
  });

  graph.touches.forEach((touch, index) => {
    const source = agentByLabel.has(touch.agent) ? safeId("agent", touch.agent) : null;
    const target = fileIdByPath.get(touch.path);
    if (!source || !target) return;
    edges.push({
      id: `touch:${source}:${target}:${touch.op}:${index}`,
      source,
      target,
      type: "smoothstep",
      label: touch.count > 1 ? String(touch.count) : touch.op,
      style: { stroke: OP_COLOR[touch.op], strokeWidth: touch.op === "patch" || touch.op === "write" ? 2.2 : 1.4 },
      labelStyle: { fill: "var(--text-2)", fontSize: 10 },
      labelBgStyle: { fill: "var(--surface-1)", fillOpacity: 0.92 },
      markerEnd: { type: "arrowclosed", color: OP_COLOR[touch.op] },
    });
  });

  return { nodes, edges };
}

function nodeSignature(node: FloorNode) {
  return JSON.stringify({ type: node.type, data: node.data });
}

function edgeSignature(edge: Edge) {
  return JSON.stringify({ source: edge.source, target: edge.target, label: edge.label, animated: edge.animated, style: edge.style });
}

function mergeNodes(previous: FloorNode[], incoming: FloorNode[]): FloorNode[] {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  return incoming.map((node) => {
    const current = previousById.get(node.id);
    if (!current) return node;
    if (nodeSignature(current) === nodeSignature(node)) return current;
    return { ...current, type: node.type, data: node.data } as FloorNode;
  });
}

function mergeEdges(previous: Edge[], incoming: Edge[]): Edge[] {
  const previousById = new Map(previous.map((edge) => [edge.id, edge]));
  return incoming.map((edge) => {
    const current = previousById.get(edge.id);
    return current && edgeSignature(current) === edgeSignature(edge) ? current : edge;
  });
}

function activityText(graph: RunGraph) {
  const activity = graph.currentActivity;
  const agent = graph.currentAgent || activity?.node || "idle";
  if (!activity) return agent + " · waiting";
  const model = graph.agents.find((item) => item.label === activity.node)?.model;
  const pieces = [agent];
  if (model) pieces.push(model);
  pieces.push(activity.kind === "tool" ? activity.tool || "tool" : activity.kind === "model" ? activity.tool || "MODEL_CALL" : "idle");
  if (activity.file) pieces.push("→ " + shortPath(activity.file));
  pieces.push(fmtRelative(activity.at));
  return pieces.join(" · ");
}

function timelineText(item: TimelineEntry) {
  const action = item.kind === "node_start" ? "NODE_START" : item.kind === "node_end" ? "NODE_END" : item.tool || item.kind.toUpperCase();
  return item.file ? item.node + " → " + action + " " + shortPath(item.file) : item.node + " → " + action;
}

type RunBucket = "active" | "done" | "failed";

function runBucket(run: RunIndex): RunBucket {
  const s = normalizeStatus(run.status);
  if (isFailedStatus(s)) return "failed";
  if (
    isTrulyRunning(run) ||
    ["pending", "staged", "ready", "blocked", "queued"].includes(s)
  )
    return "active";
  if (isTerminalSuccessStatus(s) || s === "shipping") return "done";
  // superseded / unknown / any other terminal-ish status → Completed (not actionable, keep out of Up next)
  return "done";
}

function hasSubstantiveGraph(run: RunIndex) {
  return run.filesTouched > 0 || run.nodeLabels.length > 1;
}



function defaultSelectedGoal(runs: RunIndex[]) {
  // Live floor: an actively leased Hermes session wins, then the newest substantive graph, then newest overall.
  return runs.find(isTrulyRunning)?.goal ?? runs.find(hasSubstantiveGraph)?.goal ?? runs[0]?.goal ?? null;
}

const RUN_TABS: Array<{ key: RunBucket; label: string }> = [
  { key: "active", label: "Active" },
  { key: "done", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function RunRail({
  runs,
  selected,
  loaded,
  onSelect,
}: {
  runs: RunIndex[];
  selected: string | null;
  loaded: boolean;
  onSelect: (goal: string) => void;
}) {
  const [tab, setTab] = useState<RunBucket>("active");

  const buckets = useMemo(() => {
    const groups: Record<RunBucket, RunIndex[]> = { active: [], done: [], failed: [] };
    for (const run of runs) groups[runBucket(run)].push(run);
    // active tab: running first, then most-recent
    groups.active.sort((a, b) => Number(isTrulyRunning(b)) - Number(isTrulyRunning(a)) || Date.parse(b.lastActivity || "") - Date.parse(a.lastActivity || ""));
    return groups;
  }, [runs]);

  const visible = buckets[tab];

  return (
    <Panel className="h-full min-h-[620px] overflow-hidden p-3">
      <SectionHeader
        label="Runs"
        title="Hermes sessions"
        action={<Pill tone={runs.some(isTrulyRunning) ? "accent" : "neutral"}>{runs.length}</Pill>}
      />
      <div className="mb-3 grid grid-cols-3 gap-1 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-1">
        {RUN_TABS.map((entry) => {
          const count = buckets[entry.key].length;
          const isActive = tab === entry.key;
          const tone = entry.key === "failed" && count > 0 ? "var(--down)" : entry.key === "active" ? "var(--accent)" : "var(--up)";
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={`flex flex-col items-center gap-0.5 rounded-[var(--r-sm)] px-2 py-1.5 text-[11px] font-medium transition ${
                isActive ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]"
              }`}
            >
              <span className="flex items-center gap-1.5">
                {entry.label}
                <span className="num rounded-full px-1.5 text-[10px]" style={{ color: count > 0 ? tone : "var(--text-4)" }}>
                  {count}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {!loaded ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-24" />)}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState icon={<GitBranch className="h-6 w-6" />} title="No Hermes sessions" hint="The native bridge has not published session metadata yet." />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<GitBranch className="h-6 w-6" />}
          title={tab === "failed" ? "No failures" : tab === "done" ? "Nothing completed yet" : "No active sessions"}
          hint={tab === "failed" ? "Failed Hermes sessions will surface here." : "Sessions appear when Hermes records current runtime activity."}
        />
      ) : (
        <div className="max-h-[calc(100vh-280px)] space-y-2 overflow-y-auto pr-1">
          {visible.map((run) => {
            const running = isTrulyRunning(run);
            return (
              <button
                key={run.goal}
                type="button"
                onClick={() => onSelect(run.goal)}
                className={`w-full rounded-[var(--r-md)] border p-3 text-left transition ${
                  selected === run.goal
                    ? "border-[var(--line-strong)] bg-[var(--surface-2)]"
                    : "border-[var(--line)] bg-transparent hover:bg-[var(--surface-1)]"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-semibold text-[var(--text)]">{run.title || run.goal}</p>
                    <p className="num mt-1 text-[10.5px] text-[var(--text-4)]">
                      {run.operationId || run.goal} · {fmtRelative(run.lastActivity)}
                    </p>
                    {(run.repo || run.branch) && (
                      <p className="mt-1 truncate text-[10.5px] text-[var(--text-3)]">
                        {[run.repo, run.branch].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <Pill tone={statusTone(run.status, running)} className="!py-0.5 !text-[10px]">
                    {running ? "active turn" : run.status}
                  </Pill>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {[run.profile, run.model, run.stageId].filter((value): value is string => Boolean(value)).slice(0, 4).map((node) => (
                    <span key={node} className="rounded-full border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--text-3)]">
                      {node}
                    </span>
                  ))}
                  {run.repo === "ChatDev" && (
                    <span className="rounded-full border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--text-4)]">
                      retired archive
                    </span>
                  )}
                  {run.filesTouched > 0 && (
                    <span className="rounded-full border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--text-4)]">
                      {run.filesTouched} files
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

    </Panel>
  );
}

function LearningPanel({ graph, conveyor, attempt }: { graph: RunGraph | null; conveyor: ConveyorRunGraph | null; attempt: number }) {
  const learning = conveyor?.learnings.find((item) => item.attempt === attempt) ?? null;
  const latest = graph?.learnings.at(-1);
  const hasLearning = Boolean(learning && (learning.learned.length > 0 || learning.inferred.length > 0));

  return (
    <Panel className="h-full min-h-[620px] overflow-hidden p-5">
      <SectionHeader
        label="Session evidence"
        title="Learned / inferred metadata"
        action={
          conveyor ? (
            <Pill tone="neutral">attempt {attempt}</Pill>
          ) : graph ? (
            <Pill tone="neutral">attempt {graph.attempt}</Pill>
          ) : null
        }
      />
      {conveyor ? (
        !hasLearning ? (
          <EmptyState
            icon={<Info className="h-6 w-6" />}
            title="No learning metadata"
            hint="This attempt has no learned or inferred metadata recorded yet."
          />
        ) : (
          <div className="max-h-[calc(100vh-250px)] overflow-y-auto pr-1">
            <div>
              <Eyebrow>Learned</Eyebrow>
              <ul className="mt-3 space-y-2">
                {learning!.learned.slice(0, 10).map((item) => (
                  <li key={item} className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-2)]">
                    {item}
                  </li>
                ))}
                {learning!.learned.length === 0 && (
                  <li className="text-[11px] text-[var(--text-4)]">Nothing learned this attempt.</li>
                )}
              </ul>
            </div>
            <div className="mt-6">
              <Eyebrow>Inferred</Eyebrow>
              <ul className="mt-3 space-y-2">
                {learning!.inferred.slice(0, 8).map((item) => (
                  <li key={item} className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-2)]">
                    {item}
                  </li>
                ))}
                {learning!.inferred.length === 0 && (
                  <li className="text-[11px] text-[var(--text-4)]">No inferences this attempt.</li>
                )}
              </ul>
            </div>
          </div>
        )
      ) : !graph ? (
        <EmptyState icon={<Info className="h-6 w-6" />} title="Select a goal" hint="Bounded attempt evidence appears beside the execution graph." />
      ) : !latest ? (
        <EmptyState icon={<Info className="h-6 w-6" />} title="No learning metadata" hint="Hermes has not recorded learned or inferred metadata for this session." />
      ) : (
        <div className="max-h-[calc(100vh-250px)] overflow-y-auto pr-1">
          <div>
            <Eyebrow>Learned</Eyebrow>
            <ul className="mt-3 space-y-2">
              {latest.learned.slice(0, 10).map((item) => (
                <li key={item} className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-2)]">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-6">
            <Eyebrow>Inferred</Eyebrow>
            <ul className="mt-3 space-y-2">
              {latest.inferred.slice(0, 8).map((item) => (
                <li key={item} className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-2)]">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
}

type PipelineStageState = "idle" | "active" | "ok" | "fail" | "building";

function stageTone(state: PipelineStageState): RunStatusTone {
  if (state === "ok") return "up";
  if (state === "fail") return "down";
  if (state === "active" || state === "building") return "accent";
  return "neutral";
}

function stageIcon(state: PipelineStageState) {
  if (state === "ok") return <Check className="h-3 w-3" />;
  if (state === "fail") return <X className="h-3 w-3" />;
  return null;
}

function PipelineStage({
  label,
  state,
  href,
}: {
  label: string;
  state: PipelineStageState;
  href?: string | null;
}) {
  const className = `pipeline-stage ${state === "active" || state === "building" ? "pipeline-glow" : ""}`;
  const pill = (
    <Pill tone={stageTone(state)} className={className}>
      {stageIcon(state)}
      <span>{label}</span>
      {href && <ExternalLink className="h-3 w-3" />}
    </Pill>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex">
      {pill}
    </a>
  ) : pill;
}

function PipelineStrip({ run }: { run: RunIndex | null }) {
  if (!run) return null;
  const status = normalizeStatus(run.status);
  const rung = run.rung ?? 0;
  const running = isTrulyRunning(run);
  const failed = isFailedStatus(status);
  const terminalSuccess = isTerminalSuccessStatus(status);
  const shipping = ["shipping", "deploying"].includes(status);
  const productionBuilding = shipping;
  const hasPr = Boolean(run.shipped_pr);
  const hasPreview = Boolean(run.preview_url);
  const productionOk = terminalSuccess && hasPr;

  const localState: PipelineStageState =
    failed && rung === 0 ? "fail"
    : running && rung === 0 ? "active"
    : rung > 0 || terminalSuccess || shipping ? "ok"
    : "idle";
  const repairState: PipelineStageState =
    failed && rung >= 1 ? "fail"
    : running && rung >= 1 ? "active"
    : rung >= 1 && (terminalSuccess || shipping) ? "ok"
    : "idle";
  const gateState: PipelineStageState =
    failed ? "fail"
    : terminalSuccess ? "ok"
    : running ? "active"
    : "idle";
  const previewState: PipelineStageState =
    hasPreview || (terminalSuccess && hasPr) ? "ok"
    : hasPr && !productionOk ? "building"
    : "idle";
  const productionState: PipelineStageState =
    productionOk ? "ok"
    : productionBuilding ? "building"
    : "idle";

  return (
    <div className="pipeline-strip mx-5 mt-3 flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2">
      <PipelineStage label="Local" state={localState} />
      <PipelineStage label="Directed repair" state={repairState} />
      <PipelineStage label="Gate" state={gateState} />
      <PipelineStage label={previewState === "building" ? "Preview building" : "Preview"} state={previewState} href={run.preview_url} />
      <PipelineStage label={productionState === "building" ? "Production building" : "Production"} state={productionState} />
    </div>
  );
}

function FlowCanvas({ graph, loaded, selectedRun }: { graph: RunGraph | null; loaded: boolean; selectedRun: RunIndex | null }) {
  const built = useMemo(() => graph ? buildGraph(graph) : { nodes: [], edges: [] }, [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FloorNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const flowRef = useRef<ReactFlowInstance<FloorNode, Edge> | null>(null);
  const fittedGoalRef = useRef<string | null>(null);
  const timeline = graph?.timeline?.slice(-15).reverse() ?? [];
  const headerStatus = selectedRun?.status || graph?.status || "unknown";
  const headerRunning = isTrulyRunning(selectedRun);

  useEffect(() => {
    if (!graph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes((current) => mergeNodes(current as FloorNode[], built.nodes));
    setEdges((current) => mergeEdges(current, built.edges));
  }, [built.edges, built.nodes, graph, setEdges, setNodes]);

  useEffect(() => {
    if (!graph || nodes.length === 0 || !flowRef.current) return;
    if (fittedGoalRef.current === graph.goal) return;
    fittedGoalRef.current = graph.goal;
    const frame = requestAnimationFrame(() => {
      flowRef.current?.fitView({ padding: 0.16, duration: 360 });
    });
    return () => cancelAnimationFrame(frame);
  }, [graph, nodes.length]);

  return (
    <Panel className="min-h-[620px] overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <Eyebrow>Process graph</Eyebrow>
          <h2 className="mt-1 truncate text-[18px] font-semibold text-[var(--text)]">
            {selectedRun?.title || graph?.goal || "No session selected"}
          </h2>
          {selectedRun?.operationId && (
            <p className="num mt-1 truncate text-[10.5px] text-[var(--text-4)]">
              {selectedRun.operationId} · {[selectedRun.repo, selectedRun.branch].filter(Boolean).join(" · ") || "workspace unavailable"}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {graph && <Pill tone={statusTone(headerStatus, headerRunning)}>{headerRunning ? "active turn" : headerStatus}</Pill>}
          {graph && <Pill tone="neutral">{graph.counts.toolCalls} tools</Pill>}
          {graph && <Pill tone="neutral">{graph.files.length} files</Pill>}
        </div>
      </div>

      {graph && <PipelineStrip run={selectedRun} />}

      {graph && (
        <div className="floor-now-strip mx-5 mt-4 flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[12px] text-[var(--text-2)]">
          <span className="floor-now-dot" aria-hidden="true" />
          <span className="truncate"><span className="font-semibold text-[var(--text)]">LAST EVENT</span> · {activityText(graph)}</span>
        </div>
      )}

      <div className="floor-flow h-[500px]">
        {!loaded ? (
          <div className="p-5">
            <Skeleton className="h-[460px]" />
          </div>
        ) : !graph ? (
          <EmptyState icon={<GitBranch className="h-6 w-6" />} title="No graph loaded" hint="Select a Hermes session from the rail." className="h-full" />
        ) : headerRunning && graph.files.length === 0 && graph.counts.toolCalls === 0 && nodes.length <= 1 && edges.length === 0 ? (
          <EmptyState
            icon={<Radio className="h-6 w-6 animate-pulse" />}
            title="Session starting — no tool events yet"
            hint="The session is active. Metadata-only model and tool events will appear here as Hermes records them."
            className="h-full"
          />
        ) : nodes.length === 0 ? (
          <EmptyState icon={<Bot className="h-6 w-6" />} title="Trace is empty" hint="This Hermes session has no model or tool events yet." className="h-full" />
        ) : (
          <ReactFlow<FloorNode, Edge>
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
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => node.type === "agent" ? "var(--accent)" : "var(--text-3)"}
              maskColor="rgba(10,11,13,0.68)"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      {graph && timeline.length > 0 && (
        <div className="border-t border-[var(--line)] px-5 py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Eyebrow>Sequence</Eyebrow>
            <Pill tone="neutral" className="!py-0.5 !text-[10px]">last {timeline.length}</Pill>
          </div>
          <ol className="grid max-h-32 gap-1.5 overflow-y-auto pr-1 md:grid-cols-2">
            {timeline.map((item) => (
              <li key={item.seq} className="min-w-0 truncate rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[11px] text-[var(--text-3)]">
                <span className="text-[var(--text-2)]">{timelineText(item)}</span>
                <span className="num ml-2 text-[var(--text-4)]">{fmtRelative(item.at)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}

function GoalTile({
  goal,
  tone,
  onSelect,
}: {
  goal: NativeGoal;
  tone: "accent" | "neutral" | "down" | "up";
  onSelect: (goal: NativeGoal) => void;
}) {
  const stateLabel = tone === "accent" ? "working" : tone === "down" ? "failed" : tone === "up" ? "done" : "ready";
  return (
    <button
      type="button"
      onClick={() => onSelect(goal)}
      className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-2)]"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium leading-snug text-[var(--text)]">{goal.title}</p>
        <Pill tone={tone} className="!py-0.5 !text-[10px]">{stateLabel}</Pill>
      </div>
      <p className="num mt-1.5 text-[10.5px] text-[var(--text-4)]">
        {goal.status ?? goal.state}{goal.updatedAt ? ` · ${fmtRelative(goal.updatedAt)}` : ""}
      </p>
    </button>
  );
}

function NativeGoalsPanel({
  goals,
  selectedGoal,
  onSelect,
}: {
  goals: NativeGoalsPayload | null;
  selectedGoal: string | null;
  onSelect: (goal: NativeGoal) => void;
}) {
  const live = goals?.goals.live ?? { ready: [], running: [], done: [], failed: [] };
  const counts = goals?.goals.counts ?? { ready: 0, running: 0, done: 0, failed: 0 };
  const running = live.running;
  const ready = live.ready;
  const done = live.done;
  const recentFailed = goals?.goals.recentFailed ?? [];

  const selectedIdOf = (goal: NativeGoal) => goalIdOf(goal) ?? goal.id;

  return (
    <Panel className="h-full min-h-[620px] overflow-hidden p-5">
      <SectionHeader
        label="Goals"
        title="What locals are working on"
        action={<Pill tone={running.length ? "accent" : "neutral"}>{counts.running} working</Pill>}
      />
      <div className="mt-4 max-h-[calc(100vh-300px)] space-y-5 overflow-y-auto pr-1">
        <div>
          <Eyebrow>Working now</Eyebrow>
          {running.length === 0 ? (
            <p className="mt-2 text-[12px] text-[var(--text-4)]">No goal is currently running through the conveyor.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {running.map((goal) => (
                <li key={goal.id} className={selectedGoal === selectedIdOf(goal) ? "ring-2 ring-[var(--accent)] rounded-[var(--r-md)]" : ""}>
                  <GoalTile goal={goal} tone="accent" onSelect={onSelect} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <Eyebrow>Up next</Eyebrow>
          {ready.length === 0 ? (
            <p className="mt-2 text-[12px] text-[var(--text-4)]">No ready goals queued.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {ready.slice(0, 8).map((goal) => (
                <li key={goal.id} className={selectedGoal === selectedIdOf(goal) ? "ring-2 ring-[var(--accent)] rounded-[var(--r-md)]" : ""}>
                  <GoalTile goal={goal} tone="neutral" onSelect={onSelect} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {done.length > 0 && (
          <div>
            <Eyebrow>Completed</Eyebrow>
            <ul className="mt-3 space-y-2">
              {done.slice(0, 8).map((goal) => (
                <li key={goal.id} className={selectedGoal === selectedIdOf(goal) ? "ring-2 ring-[var(--accent)] rounded-[var(--r-md)]" : ""}>
                  <GoalTile goal={goal} tone="up" onSelect={onSelect} />
                </li>
              ))}
            </ul>
            {done.length > 8 && (
              <p className="num mt-2 text-[10.5px] text-[var(--text-4)]">+{done.length - 8} more completed</p>
            )}
          </div>
        )}

        {recentFailed.length > 0 && (
          <div>
            <Eyebrow>Failed</Eyebrow>
            <ul className="mt-3 space-y-2">
              {recentFailed.slice(0, 5).map((goal) => (
                <li key={goal.id} className={selectedGoal === selectedIdOf(goal) ? "ring-2 ring-[var(--accent)] rounded-[var(--r-md)]" : ""}>
                  <GoalTile goal={goal} tone="down" onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function FloorPage() {
  const [runs, setRuns] = useState<RunIndex[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [graph, setGraph] = useState<RunGraph | null>(null);
  const [graphLoaded, setGraphLoaded] = useState(false);
  const [admission, setAdmission] = useState<AdmissionPayload | null>(null);
  const [processes, setProcesses] = useState<ProcessPayload | null>(null);
  const [crons, setCrons] = useState<CronPayload | null>(null);
  const [goals, setGoals] = useState<NativeGoalsPayload | null>(null);
  const [conveyor, setConveyor] = useState<ConveyorRunGraph | null>(null);
  const [conveyorGoals, setConveyorGoals] = useState<ConveyorGoalSummary[]>([]);
  const [attemptIndex, setAttemptIndex] = useState(0);
  const [conveyorSource, setConveyorSource] = useState<string | null>(null);

  const runsRef = useRef<RunIndex[]>([]);
  const graphRunningRef = useRef(false);
  const loadRunsRequestRef = useRef(0);
  const conveyorGoalRef = useRef<string | null>(null);
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  useEffect(() => {
    graphRunningRef.current = graph?.running ?? false;
  }, [graph?.running]);

  const loadRuns = useCallback(async () => {
    const requestId = loadRunsRequestRef.current + 1;
    loadRunsRequestRef.current = requestId;
    const [data, admissionData, processData, cronData, goalsData, conveyorGoalsData] = await Promise.all([
      getJSON<RunIndex[]>("/api/runs"),
      getJSON<AdmissionPayload>("/api/hermes/admission"),
      getJSON<ProcessPayload>("/api/hermes/processes"),
      getJSON<CronPayload>("/api/hermes/crons"),
      getJSON<NativeGoalsPayload>("/api/hermes/native"),
      getJSON<{ goals: ConveyorGoalSummary[] }>("/api/goals"),
    ]);
    if (requestId !== loadRunsRequestRef.current) return;

    if (data) {
      setRuns(data);
      setSelectedGoal((current) => {
        if (current && conveyorGoalRef.current) return current; // conveyor selection wins
        if (current && data.some((run) => run.goal === current)) return current;
        return defaultSelectedGoal(data);
      });
    }
    if (admissionData) setAdmission(admissionData);
    if (processData) setProcesses(processData);
    if (cronData) setCrons(cronData);
    if (goalsData) setGoals(goalsData);
    if (conveyorGoalsData?.goals) setConveyorGoals(conveyorGoalsData.goals);
    setRunsLoaded(true);
  }, []);

  const loadGraph = useCallback(async (goal: string) => {
    const data = await getJSON<RunGraph>(`/api/runs/${encodeURIComponent(goal)}`);
    setGraph(data);
    setGraphLoaded(true);
  }, []);

  const loadConveyor = useCallback(async (goal: string) => {
    const data = await getJSON<ConveyorRunGraph>(`/api/goals/${encodeURIComponent(goal)}`);
    setConveyor(data);
    if (data?.attempts?.length) {
      setAttemptIndex(data.attempts.length - 1);
    }
    setGraphLoaded(true);
  }, []);

  const selectGoalById = useCallback((gid: string) => {
    conveyorGoalRef.current = gid;
    setConveyorSource(gid);
    setSelectedGoal(gid);
    setGraphLoaded(false);
    void loadConveyor(gid);
  }, [loadConveyor]);

  const selectGoal = useCallback((goal: NativeGoal) => {
    selectGoalById(goalIdOf(goal) ?? goal.id);
  }, [selectGoalById]);

  // Default the process graph to the freshest local conveyor run so the local
  // process (planner → implementer → gate agents + file touches) renders, rather
  // than an empty chat-session graph.
  useEffect(() => {
    if (autoSelectedRef.current || conveyorSource) return;
    if (conveyorGoals.length === 0) return;
    autoSelectedRef.current = true;
    selectGoalById(conveyorGoals[0].goal);
  }, [conveyorGoals, conveyorSource, selectGoalById]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRuns();
    const interval = setInterval(loadRuns, 4_000);
    return () => clearInterval(interval);
  }, [loadRuns]);

  // Poll the selected conveyor run while it is live (running attempt).
  useEffect(() => {
    if (!conveyorSource) return;
    const poll = () => void loadConveyor(conveyorSource);
    const latest = conveyor?.attempts[conveyor.attempts.length - 1];
    const interval = setInterval(poll, latest?.running ? 4_000 : 10_000);
    return () => clearInterval(interval);
  }, [conveyorSource, conveyor?.attempts, loadConveyor]);

  useEffect(() => {
    if (!selectedGoal) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGraph(null);
      setGraphLoaded(runsLoaded);
      return;
    }
    if (conveyorSource === selectedGoal) return; // conveyor owns this selection
    setGraphLoaded(false);
    void loadGraph(selectedGoal);
    const interval = setInterval(() => {
      const selectedRun = runsRef.current.find((run) => run.goal === selectedGoal);
      if (selectedRun ? isTrulyRunning(selectedRun) : graphRunningRef.current) void loadGraph(selectedGoal);
    }, 4_000);
    return () => clearInterval(interval);
  }, [loadGraph, runsLoaded, selectedGoal, conveyorSource]);

  const conveyorAttempt = conveyor?.attempts[attemptIndex] ?? null;
  const derivedGraph: RunGraph | null = conveyor && conveyorAttempt
    ? conveyorAttemptToRunGraph(conveyor.goal, conveyorAttempt, conveyor.learnings)
    : graph;
  const isConveyorView = conveyorSource === selectedGoal && conveyor !== null;

  const selectedConveyorGoal = useMemo(() => {
    if (!conveyorSource) return null;
    const live = goals?.goals.live ?? { ready: [], running: [], done: [], failed: [] };
    for (const state of ["running", "ready", "done", "failed"] as const) {
      const match = live[state].find((goal) => goalIdOf(goal) === conveyorSource);
      if (match) return match;
    }
    return null;
  }, [goals, conveyorSource]);

  const selectedRun = selectedGoal
    ? runs.find((run) => run.goal === selectedGoal) ??
      (isConveyorView ? conveyorGoalToRunIndex(selectedConveyorGoal, conveyorAttempt) : null)
    : null;

  const onSelectAttempt = (index: number) => {
    if (conveyor && index >= 0 && index < conveyor.attempts.length) setAttemptIndex(index);
  };

  const attemptSelector = conveyor && conveyor.attempts.length > 1 ? (
    <div className="flex flex-wrap items-center gap-1.5">
      {conveyor.attempts.map((attempt, index) => (
        <button
          key={attempt.attempt}
          type="button"
          onClick={() => onSelectAttempt(index)}
          className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
            index === attemptIndex
              ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
              : "border-[var(--line)] text-[var(--text-3)] hover:border-[var(--text-2)]"
          }`}
        >
          attempt {attempt.attempt}
        </button>
      ))}
    </div>
  ) : null;

  const activeSessions = runs.filter((run) => isTrulyRunning(run)).length;
  const latestActivity = runs[0]?.lastActivity ?? null;
  const activeSeats = admission?.groups.reduce((sum, group) => sum + group.activeTokens, 0) ?? 0;
  const queuedSeats = admission?.groups.reduce((sum, group) => sum + group.queuedDepth, 0) ?? 0;
  const liveProcesses = processes?.processes.filter((item) => item.live).length ?? 0;
  const scheduledJobs = crons?.jobs.filter((job) => job.status === "active").length ?? 0;

  return (
    <div className="relative z-10 w-full mx-auto p-8 pb-16 text-[var(--text)]">
      <div className="hq-rise flex flex-wrap items-end justify-between gap-6" style={rise(0)}>
        <div>
          <Eyebrow>Operating floor</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
            Live Process View
          </h1>
          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-[var(--text-3)]">
            Hermes sessions, admission capacity, tracked background processes and scheduled work joined to metadata-only runtime evidence.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="accent">
            <Radio className="h-3 w-3" />
            Hermes native
          </Pill>
          <Pill tone={activeSessions ? "up" : "neutral"}>
            {activeSessions} active turns
          </Pill>
          <Pill tone={admission?.readiness.ready ? "up" : "warn"}>
            {activeSeats} model seats · {queuedSeats} queued
          </Pill>
          <Pill tone={liveProcesses ? "accent" : "neutral"}>
            {liveProcesses} background
          </Pill>
          <Pill tone={scheduledJobs ? "neutral" : "warn"}>
            {scheduledJobs} scheduled
          </Pill>
          <Pill tone="neutral">
            {runs.length} recent sessions
          </Pill>
          <Pill tone="neutral">
            <RefreshCw className="h-3 w-3" />
            {fmtRelative(latestActivity)}
          </Pill>
        </div>
      </div>

      <section className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)_340px]">
        <NativeGoalsPanel goals={goals} selectedGoal={conveyorSource ?? selectedGoal} onSelect={selectGoal} />
        <div className="flex min-w-0 flex-col gap-2">
          {attemptSelector}
          <FlowCanvas graph={derivedGraph} loaded={graphLoaded} selectedRun={selectedRun} />
        </div>
        <LearningPanel graph={isConveyorView ? null : graph} conveyor={isConveyorView ? conveyor : null} attempt={conveyorAttempt?.attempt ?? 0} />
      </section>
    </div>
  );
}
