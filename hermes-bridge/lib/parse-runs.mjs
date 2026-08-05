import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { looksSecret, redactText } from "./redact.mjs";

const AGENT_CAP = 40;
const FILE_CAP = 200;
const TOUCH_CAP = 400;
const INDEX_CAP = 60;
const FLOW_CAP = AGENT_CAP * 2;
const LITE_FILE_CAP = 200;
const MAX_TRACE_BYTES = 25 * 1024 * 1024;
const MAX_SCRIBE_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 200 * 1024;
const MAX_EVENTS_PROCESSED = 50_000;
const SCRIBE_BULLET_CAP = 6;
const SCRIBE_FULL = process.env.CONVEYOR_MIRROR_SCRIBE_FULL === "1";
const DEFAULT_RUNS_ROOT = path.join(process.env.HOME || "", "ChatDev", "runs");
const DEFAULT_STATE_ROOT = path.join(process.env.HOME || "", "ChatDev", "goals", "state");

const OP_BY_TOOL = new Map([
  ["read_repo_file", "read"],
  ["list_allowed_directory", "read"],
  ["list_exports", "read"],
  ["apply_patch", "patch"],
  ["write_repo_file", "write"],
  ["delete_repo_file", "delete"],
]);

export async function parseRunTrace(goalDir, options = {}) {
  const goal = path.basename(goalDir);
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  const attempts = await attemptFiles(goalDir);
  const newest = attempts[0];
  const state = await readGoalState(goal, options.goalStateDir);
  const scribe = await parseScribe(path.join(goalDir, "scribe.md"), { secrets });

  if (!newest) {
    return emptyGraph(goal, state);
  }

  const agents = new Map();
  const files = new Map();
  const touches = new Map();
  const flow = [];
  const flowKeys = new Set();
  const activeAgents = new Set();
  let startedAt = null;
  let endedAt = null;
  let running = false;
  let workflowComplete = false;
  let eventCount = 0;
  let modelCalls = 0;
  let toolCalls = 0;

  for await (const line of readBoundedLines(newest.path, { maxBytes: MAX_TRACE_BYTES, maxLineBytes: MAX_LINE_BYTES })) {
    if (!line.trim()) continue;
    if (eventCount >= MAX_EVENTS_PROCESSED) break;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    eventCount += 1;
    const data = asRecord(event.data);
    const details = asRecord(data.details);
    const nodeId = safeLabel(data.node_id, secrets);
    const timestamp = safeIso(data.timestamp) || safeIso(data.created_at);
    if (timestamp) {
      startedAt = earlierIso(startedAt, timestamp);
      endedAt = laterIso(endedAt, timestamp);
    }

    const eventType = normalizeEventType(data.event_type || event.type);
    if (eventType === "WORKFLOW_START") {
      running = true;
      if (timestamp) startedAt = startedAt || timestamp;
    } else if (eventType === "WORKFLOW_COMPLETE") {
      workflowComplete = true;
      running = false;
      if (timestamp) endedAt = timestamp;
    } else if (eventType === "NODE_START" && nodeId) {
      running = true;
      if (agents.has(nodeId) || agents.size < AGENT_CAP) activeAgents.add(nodeId);
      const agent = ensureAgent(agents, nodeId);
      if (agent) agent.startedAt = earlierIso(agent.startedAt, timestamp);
    } else if (eventType === "NODE_END" && nodeId) {
      activeAgents.delete(nodeId);
      const agent = ensureAgent(agents, nodeId);
      if (agent) agent.endedAt = laterIso(agent.endedAt, timestamp);
    } else if (eventType === "MODEL_CALL" && nodeId) {
      modelCalls += 1;
      const agent = ensureAgent(agents, nodeId);
      if (agent) {
        agent.modelCalls += 1;
        const model = safeLabel(details.model_name || details.model || data.model_name, secrets);
        if (model) agent.model = model;
        agent.startedAt = agent.startedAt || timestamp;
      }
    } else if (eventType === "TOOL_CALL" && nodeId && details.stage !== "after") {
      toolCalls += 1;
      const agent = ensureAgent(agents, nodeId);
      const toolName = safeLabel(details.tool_name || data.tool_name, secrets) || "unknown";
      if (agent) {
        agent.toolCalls += 1;
        agent.tools[toolName] = (agent.tools[toolName] || 0) + 1;
        agent.startedAt = agent.startedAt || timestamp;
      }

      const op = OP_BY_TOOL.get(toolName) || inferOp(toolName);
      for (const filePath of extractPaths(details.tool_args || details.arguments, secrets)) {
        recordFile(files, filePath, op, nodeId);
        recordTouch(touches, nodeId, filePath, op);
      }
    }

    const edge = flowKeys.size < FLOW_CAP ? parseFlowEdge(data.message, secrets) : null;
    if (edge) {
      const key = `${edge.from}\u0000${edge.to}`;
      if (!flowKeys.has(key)) {
        flowKeys.add(key);
        flow.push(edge);
      }
    }
  }

  const graphAgents = [...agents.values()]
    .map((agent) => ({
      ...agent,
      running: activeAgents.has(agent.label),
    }));

  const graphFiles = [...files.values()]
    .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));

  const graphTouches = [...touches.values()]
    .sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path));

  running = running || activeAgents.size > 0 || state.status === "running";
  if (workflowComplete && activeAgents.size === 0 && state.status !== "running") running = false;

  return {
    goal,
    attempt: newest.attempt,
    status: safeStatus(state.status, secrets) || (workflowComplete ? "complete" : running ? "running" : "unknown"),
    startedAt,
    endedAt: workflowComplete || !running ? endedAt : null,
    running,
    agents: graphAgents.map(({ running: _running, ...agent }) => agent),
    files: graphFiles,
    flow,
    touches: graphTouches,
    learnings: scribe,
    counts: { events: eventCount, modelCalls, toolCalls },
  };
}

export async function listRuns(runsRoot = DEFAULT_RUNS_ROOT, options = {}) {
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  let entries;
  try {
    entries = await fsp.readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const goalDir = path.join(runsRoot, entry.name);
    const attempts = await attemptFiles(goalDir);
    if (!attempts.length) continue;
    const state = await readGoalState(entry.name, options.goalStateDir);
    const newest = attempts[0];
    const lite = await parseTraceLite(newest.path, { secrets: options.secrets });
    rows.push({
      goal: entry.name,
      status: safeStatus(state.status, secrets) || "unknown",
      attempts: safeInteger(state.attempts) ?? newest.attempt,
      rung: safeInteger(state.rung),
      lastActivity: newest.mtimeIso,
      nodeLabels: lite.nodeLabels,
      filesTouched: lite.filesTouched,
      running: state.status === "running" || lite.running,
    });
  }

  return rows
    .sort((a, b) => Date.parse(b.lastActivity || "") - Date.parse(a.lastActivity || ""))
    .slice(0, INDEX_CAP);
}

async function parseTraceLite(filePath, options = {}) {
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  const nodeLabels = new Set();
  const files = new Set();
  let running = false;
  let completed = false;
  let eventCount = 0;
  for await (const line of readBoundedLines(filePath, { maxBytes: MAX_TRACE_BYTES, maxLineBytes: MAX_LINE_BYTES })) {
    if (!line.trim()) continue;
    if (eventCount >= MAX_EVENTS_PROCESSED) break;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = asRecord(event.data);
    const details = asRecord(data.details);
    const eventType = normalizeEventType(data.event_type || event.type);
    eventCount += 1;
    const nodeId = safeLabel(data.node_id, secrets);
    if (nodeId && nodeLabels.size < 12) nodeLabels.add(nodeId);
    if (eventType === "WORKFLOW_START" || eventType === "NODE_START") running = true;
    if (eventType === "WORKFLOW_COMPLETE") completed = true;
    if (eventType === "TOOL_CALL" && details.stage !== "after") {
      for (const filePath of extractPaths(details.tool_args || details.arguments, secrets)) {
        if (files.has(filePath) || files.size < LITE_FILE_CAP) files.add(filePath);
      }
    }
  }
  return {
    nodeLabels: [...nodeLabels],
    filesTouched: files.size,
    running: running && !completed,
  };
}

async function attemptFiles(goalDir) {
  let entries;
  try {
    entries = await fsp.readdir(goalDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^attempt-(\d+)-events\.jsonl$/);
    if (!match) continue;
    const filePath = path.join(goalDir, entry.name);
    try {
      const stat = await fsp.stat(filePath);
      files.push({
        path: filePath,
        attempt: Number(match[1]),
        mtimeMs: stat.mtimeMs,
        mtimeIso: stat.mtime.toISOString(),
      });
    } catch {}
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.attempt - a.attempt);
}

async function readGoalState(goal, stateRoot = DEFAULT_STATE_ROOT) {
  try {
    const raw = await fsp.readFile(path.join(stateRoot || DEFAULT_STATE_ROOT, `${goal}.json`), "utf8");
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function parseScribe(scribePath, options = {}) {
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  let text;
  try {
    text = await readBoundedText(scribePath, MAX_SCRIBE_BYTES);
  } catch {
    return [];
  }
  const byAttempt = new Map();
  let currentAttempt = null;
  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const attempt = rawLine.match(/^##\s+Attempt\s+(\d+)/i);
    if (attempt) {
      currentAttempt = Number(attempt[1]);
      section = null;
      ensureScribeAttempt(byAttempt, currentAttempt);
      continue;
    }
    const heading = rawLine.match(/^###\s+(Learned|Inferred)\s*$/i);
    if (heading) {
      section = heading[1].toLowerCase() === "learned" ? "learned" : "inferred";
      if (currentAttempt == null) currentAttempt = 0;
      ensureScribeAttempt(byAttempt, currentAttempt);
      continue;
    }
    if (/^#{1,3}\s+/.test(rawLine)) {
      section = null;
      continue;
    }
    if (!section || currentAttempt == null) continue;
    const bullet = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (!bullet) continue;
    const item = scribeText(bullet[1], SCRIBE_FULL ? 300 : 160, secrets);
    if (!item) continue;
    const entry = byAttempt.get(currentAttempt);
    entry[`${section}Count`] += 1;
    const bucket = entry[section];
    const cap = SCRIBE_FULL ? 24 : SCRIBE_BULLET_CAP;
    const totalPreviewed = entry.learned.length + entry.inferred.length;
    if (!SCRIBE_FULL && totalPreviewed >= SCRIBE_BULLET_CAP) continue;
    if (!bucket.includes(item) && bucket.length < cap) bucket.push(item);
  }
  return [...byAttempt.values()].filter((item) => item.learned.length || item.inferred.length).slice(-10);
}

function ensureScribeAttempt(byAttempt, attempt) {
  if (!byAttempt.has(attempt)) {
    byAttempt.set(attempt, { attempt, learned: [], inferred: [], learnedCount: 0, inferredCount: 0 });
  }
}

function scribeText(value, max, secrets = []) {
  const text = scrubTextPaths(redactText(value, secrets)).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text ? text.slice(0, max) : null;
}

function ensureAgent(agents, label) {
  if (!agents.has(label) && agents.size >= AGENT_CAP) return null;
  if (!agents.has(label)) {
    agents.set(label, {
      id: stableId(label),
      label,
      model: null,
      startedAt: null,
      endedAt: null,
      modelCalls: 0,
      toolCalls: 0,
      tools: {},
    });
  }
  return agents.get(label);
}

function recordFile(files, filePath, op, nodeId) {
  if (!files.has(filePath) && files.size >= FILE_CAP) return;
  if (!files.has(filePath)) {
    files.set(filePath, {
      path: filePath,
      ops: { read: 0, patch: 0, write: 0, delete: 0 },
      total: 0,
      lastOp: null,
      lastNode: null,
    });
  }
  const file = files.get(filePath);
  file.ops[op] += 1;
  file.total += 1;
  file.lastOp = op;
  file.lastNode = nodeId;
}

function recordTouch(touches, agent, filePath, op) {
  const key = `${agent}\u0000${filePath}\u0000${op}`;
  if (!touches.has(key) && touches.size >= TOUCH_CAP) return;
  if (!touches.has(key)) touches.set(key, { agent, path: filePath, op, count: 0 });
  touches.get(key).count += 1;
}

function extractPaths(value, secrets = []) {
  const out = new Set();
  walkPaths(value, out, 0, secrets);
  return [...out].slice(0, 20);
}

function walkPaths(value, out, depth, secrets) {
  if (depth > 4 || out.size >= 20) return;
  if (Array.isArray(value)) {
    for (const item of value) walkPaths(item, out, depth + 1, secrets);
    return;
  }
  const record = asRecord(value);
  for (const [key, raw] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (typeof raw === "string" && ["path", "rel_path", "file_path", "filepath", "target", "filename", "directory"].includes(lower)) {
      const filePath = safePath(raw, secrets);
      if (filePath) out.add(filePath);
      continue;
    }
    if (raw && typeof raw === "object") walkPaths(raw, out, depth + 1, secrets);
  }
}

function parseFlowEdge(message, secrets = []) {
  const text = safeText(message, 240, secrets);
  if (!text) return null;
  const match = text.match(/Edge condition met for\s+(.+?)\s*->\s*(.+)$/i);
  if (!match) return null;
  const from = safeLabel(match[1], secrets);
  const to = safeLabel(match[2], secrets);
  return from && to ? { from, to } : null;
}

function normalizeEventType(value) {
  const text = String(value || "").toUpperCase();
  if (text === "WORKFLOW_STARTED") return "WORKFLOW_START";
  if (text === "WORKFLOW_COMPLETED") return "WORKFLOW_COMPLETE";
  return text;
}

function inferOp(toolName) {
  const text = String(toolName || "").toLowerCase();
  if (text.includes("delete")) return "delete";
  if (text.includes("patch")) return "patch";
  if (text.includes("write")) return "write";
  return "read";
}

function emptyGraph(goal, state) {
  return {
    goal,
    attempt: 0,
    status: safeStatus(state.status, []) || "unknown",
    startedAt: null,
    endedAt: null,
    running: state.status === "running",
    agents: [],
    files: [],
    flow: [],
    touches: [],
    learnings: [],
    counts: { events: 0, modelCalls: 0, toolCalls: 0 },
  };
}

function stableId(label) {
  return safeLabel(label, []).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "agent";
}

function safePath(value, secrets = []) {
  if (typeof value !== "string") return null;
  if (looksSecret(value)) return null;
  const text = redactText(value, secrets)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^file:\/\//, "");
  if (!text || text.length > 500) return null;
  if (/[\r\n]/.test(text)) return null;
  return toDisplayPath(text.replace(/^~(?=\/)/, "$HOME"));
}

function safeText(value, max, secrets = []) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (looksSecret(value)) return null;
  const text = redactText(value, secrets).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text ? text.slice(0, max) : null;
}

function safeLabel(value, secrets = []) {
  return safeText(value, 120, secrets);
}

function safeStatus(value, secrets = []) {
  const text = safeText(value, 40, secrets);
  return text && /^[a-z0-9_.-]+$/i.test(text) ? text : null;
}

function safeIso(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function earlierIso(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function laterIso(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function safeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function readBoundedText(filePath, maxBytes) {
  const stat = await fsp.stat(filePath);
  const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
  const handle = await fsp.open(filePath, "r");
  try {
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function* readBoundedLines(filePath, { maxBytes, maxLineBytes }) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return;
  }

  const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
  const stream = fs.createReadStream(filePath, { encoding: "utf8", start });
  let line = "";
  let skippingLongLine = false;

  try {
    for await (const chunk of stream) {
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf("\n", cursor);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.slice(cursor, end);

        if (!skippingLongLine) {
          if (line.length + part.length > maxLineBytes) {
            line = "";
            skippingLongLine = true;
          } else {
            line += part;
          }
        }

        if (newline === -1) break;
        if (!skippingLongLine) yield line.replace(/\r$/, "");
        line = "";
        skippingLongLine = false;
        cursor = newline + 1;
      }
    }
    if (line && !skippingLongLine) yield line.replace(/\r$/, "");
  } finally {
    stream.destroy();
  }
}

export function toDisplayPath(value) {
  if (typeof value !== "string") return "";
  const home = process.env.HOME || "";
  const normalized = value.replace(/\\/g, "/");
  const prefixes = [];
  if (home) {
    prefixes.push(`${home.replace(/\\/g, "/")}/Documents/GitHub/`);
    prefixes.push(`${home.replace(/\\/g, "/")}/ChatDev/`);
  }
  for (const prefix of prefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const stripped = normalized.slice(prefix.length);
    if (prefix.endsWith("/Documents/GitHub/")) {
      const slash = stripped.indexOf("/");
      return slash >= 0 ? stripped.slice(slash + 1) : "";
    }
    return stripped;
  }
  // Never emit an absolute filesystem path (leaks host directory structure).
  // Unmatched absolute/UNC/drive paths collapse to their basename.
  if (/^(\/|[A-Za-z]:\/|\/\/)/.test(normalized)) {
    const parts = normalized.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }
  return value;
}

// Scrub absolute path tokens embedded in free-text prose (scribe bullets),
// replacing each with its repo-relative / basename display form.
export function scrubTextPaths(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(/(?:[A-Za-z]:)?(?:\/[^\s"'`)*\]]+)+/g, (match) => {
    if (!/^(?:\/|[A-Za-z]:\/)/.test(match)) return match;
    return toDisplayPath(match) || match.split("/").filter(Boolean).pop() || match;
  });
}
