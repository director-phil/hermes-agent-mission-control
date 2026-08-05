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
import { Bot, FileCode2, GitBranch, Info, Radio, RefreshCw } from "lucide-react";
import { EmptyState, Eyebrow, Panel, Pill, SectionHeader, Skeleton, rise } from "@/components/ui/kit";

type RunStatusTone = "neutral" | "up" | "down" | "warn" | "accent";
type FileOp = "read" | "patch" | "write" | "delete";

interface RunIndex {
  goal: string;
  status: string;
  attempts: number;
  rung: number | null;
  lastActivity: string | null;
  nodeLabels: string[];
  filesTouched: number;
  running: boolean;
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
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function statusTone(status: string, running: boolean): RunStatusTone {
  const normalized = status.toLowerCase();
  if (running || normalized === "running") return "accent";
  if (["passed", "done", "complete", "completed", "success"].includes(normalized)) return "up";
  if (["failed", "failure", "crash", "error"].includes(normalized)) return "down";
  if (normalized.includes("fail") || normalized.includes("blocked")) return "warn";
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
          {data.running ? "live" : "seen"}
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
  return (
    <Panel className="h-full min-h-[620px] overflow-hidden p-3">
      <SectionHeader
        label="Runs"
        title="Live queue"
        action={<Pill tone={runs.some((run) => run.running) ? "accent" : "neutral"}>{runs.length}</Pill>}
      />
      {!loaded ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-24" />)}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState icon={<GitBranch className="h-6 w-6" />} title="No mirrored runs" hint="The local bridge has not published run traces yet." />
      ) : (
        <div className="max-h-[calc(100vh-230px)] space-y-2 overflow-y-auto pr-1">
          {runs.map((run) => (
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
                  <p className="truncate text-[12.5px] font-semibold text-[var(--text)]">{run.goal}</p>
                  <p className="num mt-1 text-[10.5px] text-[var(--text-4)]">
                    {fmtRelative(run.lastActivity)} · attempt {run.attempts}
                  </p>
                </div>
                <Pill tone={statusTone(run.status, run.running)} className="!py-0.5 !text-[10px]">
                  {run.running ? "running" : run.status}
                </Pill>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {run.nodeLabels.slice(0, 4).map((node) => (
                  <span key={node} className="rounded-full border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--text-3)]">
                    {node}
                  </span>
                ))}
                <span className="rounded-full border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--text-4)]">
                  {run.filesTouched} files
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

function LearningPanel({ graph }: { graph: RunGraph | null }) {
  const latest = graph?.learnings.at(-1);
  return (
    <Panel className="h-full min-h-[620px] overflow-hidden p-5">
      <SectionHeader
        label="Scribe"
        title="Learned / inferred"
        action={graph ? <Pill tone="neutral">attempt {graph.attempt}</Pill> : null}
      />
      {!graph ? (
        <EmptyState icon={<Info className="h-6 w-6" />} title="Select a run" hint="Scribe notes appear beside the execution graph." />
      ) : !latest ? (
        <EmptyState icon={<Info className="h-6 w-6" />} title="No scribe notes" hint="This run has no learned or inferred entries mirrored yet." />
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

function FlowCanvas({ graph, loaded }: { graph: RunGraph | null; loaded: boolean }) {
  const built = useMemo(() => graph ? buildGraph(graph) : { nodes: [], edges: [] }, [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FloorNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const flowRef = useRef<ReactFlowInstance<FloorNode, Edge> | null>(null);
  const fittedGoalRef = useRef<string | null>(null);
  const timeline = graph?.timeline?.slice(-15).reverse() ?? [];

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
            {graph?.goal || "No run selected"}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {graph && <Pill tone={statusTone(graph.status, graph.running)}>{graph.running ? "running" : graph.status}</Pill>}
          {graph && <Pill tone="neutral">{graph.counts.toolCalls} tools</Pill>}
          {graph && <Pill tone="neutral">{graph.files.length} files</Pill>}
        </div>
      </div>

      {graph && (
        <div className="floor-now-strip mx-5 mt-4 flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-3 py-2 text-[12px] text-[var(--text-2)]">
          <span className="floor-now-dot" aria-hidden="true" />
          <span className="truncate"><span className="font-semibold text-[var(--text)]">NOW</span> · {activityText(graph)}</span>
        </div>
      )}

      <div className="floor-flow h-[500px]">
        {!loaded ? (
          <div className="p-5">
            <Skeleton className="h-[460px]" />
          </div>
        ) : !graph ? (
          <EmptyState icon={<GitBranch className="h-6 w-6" />} title="No graph loaded" hint="Select a mirrored run from the rail." className="h-full" />
        ) : nodes.length === 0 ? (
          <EmptyState icon={<Bot className="h-6 w-6" />} title="Trace is empty" hint="The mirrored run has no agent or file events." className="h-full" />
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

export default function FloorPage() {
  const [runs, setRuns] = useState<RunIndex[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [graph, setGraph] = useState<RunGraph | null>(null);
  const [graphLoaded, setGraphLoaded] = useState(false);
  const runsRef = useRef<RunIndex[]>([]);
  const graphRunningRef = useRef(false);

  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  useEffect(() => {
    graphRunningRef.current = graph?.running ?? false;
  }, [graph?.running]);

  const loadRuns = useCallback(async () => {
    const data = await getJSON<RunIndex[]>("/api/runs");
    if (data) {
      setRuns(data);
      setSelectedGoal((current) => current && data.some((run) => run.goal === current) ? current : data[0]?.goal ?? null);
    }
    setRunsLoaded(true);
  }, []);

  const loadGraph = useCallback(async (goal: string) => {
    const data = await getJSON<RunGraph>(`/api/runs/${encodeURIComponent(goal)}`);
    setGraph(data);
    setGraphLoaded(true);
  }, []);

  useEffect(() => {
    void loadRuns();
    const interval = setInterval(loadRuns, 4_000);
    return () => clearInterval(interval);
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedGoal) {
      setGraph(null);
      setGraphLoaded(runsLoaded);
      return;
    }
    setGraphLoaded(false);
    void loadGraph(selectedGoal);
    const interval = setInterval(() => {
      const selectedRun = runsRef.current.find((run) => run.goal === selectedGoal);
      if (selectedRun?.running || graphRunningRef.current) void loadGraph(selectedGoal);
    }, 4_000);
    return () => clearInterval(interval);
  }, [loadGraph, runsLoaded, selectedGoal]);

  const activeRuns = runs.filter((run) => run.running).length;

  return (
    <div className="relative z-10 w-full mx-auto p-8 pb-16 text-[var(--text)]">
      <div className="hq-rise flex flex-wrap items-end justify-between gap-6" style={rise(0)}>
        <div>
          <Eyebrow>Operating floor</Eyebrow>
          <h1 className="mt-2.5 text-[40px] font-semibold tracking-[-0.025em] leading-none text-[var(--text)]">
            Live Process View
          </h1>
          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-[var(--text-3)]">
            Agent handoffs, tool calls, touched files, and scribe autopsies mirrored from the local ChatDev trace bridge.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={activeRuns ? "accent" : "neutral"}>
            <Radio className="h-3 w-3" />
            {activeRuns} running
          </Pill>
          <Pill tone="neutral">
            <RefreshCw className="h-3 w-3" />
            4s poll
          </Pill>
        </div>
      </div>

      <section className="mt-10 grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)_340px]">
        <RunRail runs={runs} selected={selectedGoal} loaded={runsLoaded} onSelect={setSelectedGoal} />
        <FlowCanvas graph={graph} loaded={graphLoaded} />
        <LearningPanel graph={graph} />
      </section>
    </div>
  );
}
