import fs from "node:fs/promises";
import path from "node:path";

/**
 * Conveyor-run reader — parses a goal's local run directory
 * (`~/ChatDev/runs/<gid>/attempt-N-events.jsonl` + `scribe.md`) into a
 * per-attempt execution graph the Floor's Process Graph and Session Evidence
 * panels can render. This is the *local process* truth, not the chat-session
 * graph the native bridge mirrors.
 *
 * Each attempt is a distinct process: its own agents (nodes), file touches,
 * node flow, tool calls, and the scribe's learned/inferred metadata.
 */

const CHATDEV_ROOT = process.env.CHATDEV_ROOT || "/home/phillip_downs/ChatDev";
const RUNS_ROOT = path.join(CHATDEV_ROOT, "runs");

const GOAL_ID = /^[A-Za-z0-9_.-]{1,180}$/;
const ATTEMPT_FILE = /^attempt-(\d+)-events\.jsonl$/;

type FileOp = "read" | "patch" | "write" | "delete";

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

interface TimelineEntry {
  seq: number;
  node: string;
  kind: "node_start" | "node_end" | "model" | "tool";
  tool: string | null;
  file: string | null;
  at: string | null;
}

interface CurrentActivity {
  node: string;
  kind: "model" | "tool" | "idle";
  tool: string | null;
  file: string | null;
  at: string | null;
}

export interface ConveyorAttemptGraph {
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

export interface ConveyorRunGraph {
  goal: string;
  source: "conveyor-run";
  attempts: ConveyorAttemptGraph[];
  learnings: Array<{ attempt: number; learned: string[]; inferred: string[] }>;
  syncedAt: string;
}

const OP_OF_TOOL: Record<string, FileOp> = {
  read_repo_file: "read",
  apply_patch: "patch",
  write_repo_file: "write",
};

function safeIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.slice(0, 200) : null;
}

function relPathOf(args: unknown): string | null {
  if (args && typeof args === "object") {
    const rel = (args as Record<string, unknown>).rel_path;
    if (typeof rel === "string" && rel.trim()) return rel.trim().slice(0, 400);
  }
  return null;
}

interface RawEvent {
  type?: string;
  data?: {
    timestamp?: string;
    node_id?: string;
    event_type?: string;
    details?: {
      model_name?: string;
      tool_name?: string;
      output?: string;
      output_size?: number;
      arguments?: unknown;
    };
  };
}

function parseEvent(line: string): RawEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as RawEvent;
  } catch {
    return null;
  }
}

function parseAttemptGraph(
  goal: string,
  text: string,
  attempt: number,
  isLatest: boolean,
): ConveyorAttemptGraph | null {
  const agents = new Map<string, AgentTrace>();
  const files = new Map<string, FileTrace>();
  const touches = new Map<string, TouchTrace>();
  const timeline: TimelineEntry[] = [];
  const flow: Array<{ from: string; to: string }> = [];
  const seenEdges = new Set<string>();

  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let lastNode: string | null = null;
  let currentActivity: CurrentActivity | null = null;
  let events = 0;
  let modelCalls = 0;
  let toolCalls = 0;

  const agentFor = (nodeId: string | null | undefined): AgentTrace | null => {
    if (!nodeId) return null;
    let agent = agents.get(nodeId);
    if (!agent) {
      agent = {
        id: nodeId,
        label: nodeId,
        model: null,
        startedAt: null,
        endedAt: null,
        modelCalls: 0,
        toolCalls: 0,
        tools: {},
      };
      agents.set(nodeId, agent);
    }
    return agent;
  };

  for (const line of text.split("\n")) {
    const event = parseEvent(line);
    if (!event) continue;
    if (event.type && event.type !== "log") continue;
    const data = event.data;
    if (!data) continue;

    const kind = data.event_type;
    const nodeId = data.node_id ?? null;
    const at = safeIso(data.timestamp);
    events += 1;

    if (kind === "NODE_START") {
      const agent = agentFor(nodeId);
      if (agent && !agent.startedAt) agent.startedAt = at;
      if (nodeId) {
        if (lastNode && lastNode !== nodeId) {
          const edge = `${lastNode}->${nodeId}`;
          if (!seenEdges.has(edge)) {
            seenEdges.add(edge);
            flow.push({ from: lastNode, to: nodeId });
          }
        }
        lastNode = nodeId;
      }
      timeline.push({ seq: timeline.length + 1, node: nodeId ?? "?", kind: "node_start", tool: null, file: null, at });
      if (!startedAt) startedAt = at;
    } else if (kind === "NODE_END") {
      const agent = agentFor(nodeId);
      if (agent && !agent.endedAt) agent.endedAt = at;
      timeline.push({ seq: timeline.length + 1, node: nodeId ?? "?", kind: "node_end", tool: null, file: null, at });
      endedAt = at;
    } else if (kind === "MODEL_CALL") {
      const agent = agentFor(nodeId);
      if (agent) {
        agent.modelCalls += 1;
        const model = safeString(data.details?.model_name);
        if (model && !agent.model) agent.model = model;
      }
      modelCalls += 1;
      currentActivity = { node: nodeId ?? "?", kind: "model", tool: null, file: null, at };
      timeline.push({ seq: timeline.length + 1, node: nodeId ?? "?", kind: "model", tool: null, file: null, at });
    } else if (kind === "TOOL_CALL") {
      const toolName = safeString(data.details?.tool_name) ?? "tool";
      const filePath = relPathOf(data.details?.arguments);
      const agent = agentFor(nodeId);
      if (agent) {
        agent.toolCalls += 1;
        agent.tools[toolName] = (agent.tools[toolName] ?? 0) + 1;
      }
      toolCalls += 1;
      currentActivity = { node: nodeId ?? "?", kind: "tool", tool: toolName, file: filePath, at };
      timeline.push({ seq: timeline.length + 1, node: nodeId ?? "?", kind: "tool", tool: toolName, file: filePath, at });

      const op = OP_OF_TOOL[toolName] ?? "read";
      if (filePath) {
        let file = files.get(filePath);
        if (!file) {
          file = { path: filePath, ops: { read: 0, patch: 0, write: 0, delete: 0 }, total: 0, lastOp: null, lastNode: null };
          files.set(filePath, file);
        }
        file.ops[op] += 1;
        file.total += 1;
        file.lastOp = op;
        file.lastNode = nodeId;
        if (agent) {
          const key = `${nodeId}|${filePath}|${op}`;
          let touch = touches.get(key);
          if (!touch) {
            touch = { agent: nodeId ?? "?", path: filePath, op, count: 0 };
            touches.set(key, touch);
          }
          touch.count += 1;
        }
      }
    }
  }

  if (agents.size === 0 && files.size === 0) return null;

  const agentList = [...agents.values()].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const fileList = [...files.values()].sort((a, b) => b.total - a.total);
  const touchList = [...touches.values()];

  return {
    attempt,
    status: isLatest ? "running" : "failed",
    rung: null,
    startedAt,
    endedAt,
    running: isLatest,
    agents: agentList,
    files: fileList,
    flow,
    touches: touchList,
    timeline: timeline.slice(-100),
    currentAgent: lastNode,
    currentActivity: isLatest ? currentActivity : null,
    counts: { events, modelCalls, toolCalls },
  };
}

function parseScribe(text: string): Array<{ attempt: number; learned: string[]; inferred: string[] }> {
  const result: Array<{ attempt: number; learned: string[]; inferred: string[] }> = [];
  let currentAttempt = 0;
  let section: "learned" | "inferred" | null = null;
  const buckets: Record<number, { learned: string[]; inferred: string[] }> = {};

  const ensure = (attempt: number) => {
    if (!buckets[attempt]) buckets[attempt] = { learned: [], inferred: [] };
    return buckets[attempt];
  };

  for (const line of text.split("\n")) {
    const attemptMatch = line.match(/^## Attempt (\d+)/);
    if (attemptMatch) {
      currentAttempt = Number(attemptMatch[1]);
      section = null;
      continue;
    }
    const learned = line.match(/^### Learned/);
    const inferred = line.match(/^### Inferred/);
    if (learned) { section = "learned"; continue; }
    if (inferred) { section = "inferred"; continue; }
    if (/^## / .test(line)) { section = null; continue; }
    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet && section && currentAttempt > 0) {
      const bucket = ensure(currentAttempt);
      const item = bullet[1].trim().slice(0, 400);
      if (item) bucket[section].push(item);
    }
  }

  for (const [attemptStr, bucket] of Object.entries(buckets)) {
    result.push({ attempt: Number(attemptStr), learned: bucket.learned.slice(0, 20), inferred: bucket.inferred.slice(0, 20) });
  }
  return result.sort((a, b) => a.attempt - b.attempt);
}

export interface ConveyorRunSummary {
  goal: string;
  attempts: number;
  updatedAt: string | null;
}

/**
 * Enumerate goals that have a local conveyor run directory with parsed
 * attempt events. Returns the most recently active goal first, so callers can
 * default the process graph to the freshest local process.
 */
export async function listConveyorRuns(): Promise<ConveyorRunSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(RUNS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const summaries: ConveyorRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const goal = entry.name;
    if (!GOAL_ID.test(goal)) continue;
    const dir = path.join(RUNS_ROOT, goal);

    let files;
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const attemptFiles = files
      .filter((f) => f.isFile() && ATTEMPT_FILE.test(f.name))
      .map((f) => Number(f.name.match(ATTEMPT_FILE)?.[1]));
    if (attemptFiles.length === 0) continue;

    let latestMtimeMs = 0;
    for (const f of files) {
      if (!f.isFile()) continue;
      try {
        const st = await fs.stat(path.join(dir, f.name));
        if (st.mtimeMs > latestMtimeMs) latestMtimeMs = st.mtimeMs;
      } catch {
        // skip unreadable file
      }
    }

    summaries.push({
      goal,
      attempts: attemptFiles.length,
      updatedAt: latestMtimeMs ? new Date(latestMtimeMs).toISOString() : null,
    });
  }

  return summaries.sort(
    (a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0),
  );
}

export async function readConveyorRun(goal: string): Promise<ConveyorRunGraph | null> {
  if (!GOAL_ID.test(goal)) return null;
  const dir = path.join(RUNS_ROOT, goal);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const attemptFiles = entries
    .filter((e) => e.isFile() && ATTEMPT_FILE.test(e.name))
    .map((e) => ({ name: e.name, attempt: Number(e.name.match(ATTEMPT_FILE)?.[1]) }))
    .sort((a, b) => a.attempt - b.attempt);

  if (attemptFiles.length === 0) return null;

  const attempts: ConveyorAttemptGraph[] = [];
  for (let i = 0; i < attemptFiles.length; i += 1) {
    const { name, attempt } = attemptFiles[i];
    const isLatest = i === attemptFiles.length - 1;
    let text: string;
    try {
      const stat = await fs.stat(path.join(dir, name));
      if (stat.size > 12 * 1024 * 1024) continue; // skip oversized (stale) streams
      text = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const graph = parseAttemptGraph(goal, text, attempt, isLatest);
    if (graph) attempts.push(graph);
  }

  let learnings: ConveyorRunGraph["learnings"] = [];
  try {
    const scribe = await fs.readFile(path.join(dir, "scribe.md"), "utf8");
    learnings = parseScribe(scribe);
  } catch {
    // no scribe — empty learnings
  }

  return {
    goal,
    source: "conveyor-run",
    attempts,
    learnings,
    syncedAt: new Date().toISOString(),
  };
}
