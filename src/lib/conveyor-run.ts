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

export interface AttemptVerdict {
  relevance: number | null;
  toolQuality: number | null;
  contextBloat: number | null;
  hallucination: number | null;
  summary: string | null;
}

export interface AttemptLearnings {
  attempt: number;
  learned: string[];
  inferred: string[];
  /** Raw `- observed:` trace lines — the "what happened / why it failed" record. */
  observed: string[];
  /** LLM-as-judge evaluator verdict (DeepSeek) for this attempt, if present. */
  verdict: AttemptVerdict | null;
}

export interface ConveyorCompletion {
  status: string;
  shippedPr: string | null;
  prNumber: number | null;
  deploymentId: string | null;
  productionUrl: string | null;
  mergeSha: string | null;
  health: string | null;
  completedAt: string | null;
}

export interface ConveyorRunGraph {
  goal: string;
  source: "conveyor-run";
  attempts: ConveyorAttemptGraph[];
  learnings: AttemptLearnings[];
  completion: ConveyorCompletion | null;
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

function numOrNull(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseScribe(text: string): AttemptLearnings[] {
  type Bucket = { learned: string[]; inferred: string[]; observed: string[]; verdict: AttemptVerdict | null };
  const buckets = new Map<number, Bucket>();
  let currentAttempt = 0;
  let section: "learned" | "inferred" | "verdict" | null = null;

  const ensure = (attempt: number): Bucket => {
    let bucket = buckets.get(attempt);
    if (!bucket) {
      bucket = { learned: [], inferred: [], observed: [], verdict: null };
      buckets.set(attempt, bucket);
    }
    return bucket;
  };

  for (const line of text.split("\n")) {
    // `## Attempt N (...)` starts a new attempt bucket.
    const attemptMatch = line.match(/^##\s+Attempt\s+(\d+)/i);
    if (attemptMatch) {
      currentAttempt = Number(attemptMatch[1]);
      section = null;
      continue;
    }
    if (/^###\s+Learned/i.test(line)) { section = "learned"; continue; }
    if (/^###\s+Inferred/i.test(line)) { section = "inferred"; continue; }
    if (/^##\s+Evaluator\s+verdict/i.test(line)) { section = "verdict"; continue; }
    // any other h2/h3 heading (## / ###) resets the section
    if (/^#{2,3}\s/.test(line)) { section = null; continue; }

    if (currentAttempt <= 0) continue;
    const bucket = ensure(currentAttempt);

    // `- observed:` lines are always captured — they are the raw "what happened".
    const observed = line.match(/^-\s*observed:\s*(.+)$/i);
    if (observed) {
      const item = observed[1].trim().slice(0, 500);
      if (item) bucket.observed.push(item);
      continue;
    }

    if (section === "verdict") {
      const field = line.match(/^-\s*([a-z_]+):\s*(.+)$/i);
      if (field) {
        const key = field[1].toLowerCase();
        const value = field[2].trim();
        if (!bucket.verdict) {
          bucket.verdict = { relevance: null, toolQuality: null, contextBloat: null, hallucination: null, summary: null };
        }
        if (key === "goal_relevance" || key === "relevance") bucket.verdict.relevance = numOrNull(value);
        else if (key === "tool_call_quality" || key === "tool_quality") bucket.verdict.toolQuality = numOrNull(value);
        else if (key === "context_bloat") bucket.verdict.contextBloat = numOrNull(value);
        else if (key === "hallucination") bucket.verdict.hallucination = numOrNull(value);
        else if (key === "summary") bucket.verdict.summary = value.slice(0, 400);
      }
      continue;
    }

    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet) {
      const item = bullet[1].trim().slice(0, 400);
      if (item && section === "learned") bucket.learned.push(item);
      else if (item && section === "inferred") bucket.inferred.push(item);
    }
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.learned.length || bucket.inferred.length || bucket.observed.length || bucket.verdict)
    .map(([attempt, bucket]) => ({
      attempt,
      learned: bucket.learned.slice(0, 20),
      inferred: bucket.inferred.slice(0, 20),
      observed: bucket.observed.slice(0, 60),
      verdict: bucket.verdict,
    }))
    .sort((a, b) => a.attempt - b.attempt);
}

export interface ConveyorRunSummary {
  goal: string;
  attempts: number;
  updatedAt: string | null;
  completion: ConveyorCompletion | null;
}

const GOALS_STATE_ROOT = path.join(CHATDEV_ROOT, "goals", "state");

function safeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

function prNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Read a goal's state ledger (`~/ChatDev/goals/state/<goal>.json`) and extract
 * the completion record — PR URL/number, Vercel deployment id, production URL,
 * merge SHA, health, and completion time. This is the authoritative "shipped"
 * truth the event stream never carries.
 */
async function readGoalLedger(goal: string): Promise<ConveyorCompletion | null> {
  if (!GOAL_ID.test(goal)) return null;
  const file = path.join(GOALS_STATE_ROOT, `${goal}.json`);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const shipping = (record.shipping && typeof record.shipping === "object" ? record.shipping : {}) as Record<string, unknown>;
  const shippedPr = typeof record.shipped_pr === "string" ? record.shipped_pr : null;
  const pr = typeof shipping.pr === "string" ? (shipping.pr as string) : shippedPr;
  const completedAt =
    safeTimestamp(record.completed_at ?? record.completedAt ?? record.finishedAt) ??
    safeTimestamp(record.queue_runner_updated_at);
  return {
    status: typeof record.status === "string" ? record.status : "unknown",
    shippedPr: pr,
    prNumber: prNumberFromUrl(pr),
    deploymentId: shipping.deployment_id != null ? String(shipping.deployment_id) : null,
    productionUrl: typeof shipping.production_url === "string" ? (shipping.production_url as string) : null,
    mergeSha: typeof shipping.merge_sha === "string" ? (shipping.merge_sha as string) : null,
    health: typeof shipping.health === "string" ? (shipping.health as string) : null,
    completedAt,
  };
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
      completion: await readGoalLedger(goal),
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
    completion: await readGoalLedger(goal),
    syncedAt: new Date().toISOString(),
  };
}
