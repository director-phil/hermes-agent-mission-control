import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;
const TIMELINE_LIMIT = 100;

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(1, Math.min(MAX_LIMIT, number)) : fallback;
}

function isoFromSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function labelFor(row, descriptor) {
  return String(row.profile_name || descriptor.profile || row.source || "hermes").slice(0, 128);
}

function stageFor(row) {
  const value = String(row.source || "session").toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
  return SESSION_ID.test(value) ? value : "session";
}

function repoFor(row) {
  const value = typeof row.git_repo_root === "string" && row.git_repo_root
    ? row.git_repo_root
    : typeof row.cwd === "string" ? row.cwd : "";
  const name = value ? path.basename(value) : "";
  return name && SESSION_ID.test(name) ? name : null;
}

function branchFor(row) {
  const value = typeof row.git_branch === "string" ? row.git_branch.trim() : "";
  return value && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function correlationFor(row) {
  return {
    operationId: `op:${row.id}`,
    goalId: `session:${row.id}`,
    runId: row.id,
    stageId: stageFor(row),
    repo: repoFor(row),
    branch: branchFor(row),
  };
}

function statusFor(row, live) {
  if (live) return "running";
  const reason = String(row.end_reason || "").toLowerCase();
  if (reason.includes("fail") || reason.includes("error") || reason.includes("crash")) return "failed";
  if (row.ended_at != null) return "done";
  return "idle";
}

function openReadOnly(descriptor) {
  return new Database(descriptor.path, { readonly: true, fileMustExist: true });
}

function hasRequiredTables(db) {
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions','messages','session_turn_leases')")
      .all()
      .map((row) => row.name),
  );
  return names.has("sessions") && names.has("messages") && names.has("session_turn_leases");
}

export async function discoverHermesStateDatabases(hermesRoot) {
  const found = [];
  const primary = path.join(hermesRoot, "state.db");
  try {
    await fs.access(primary);
    found.push({ path: primary, profile: "default" });
  } catch {}

  const profilesRoot = path.join(hermesRoot, "profiles");
  const entries = await fs.readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const statePath = path.join(profilesRoot, entry.name, "state.db");
    try {
      await fs.access(statePath);
      found.push({ path: statePath, profile: entry.name });
    } catch {}
  }
  return found;
}

export function listHermesSessionRuns(databases, options = {}) {
  const nowSeconds = Number(options.nowMs ?? Date.now()) / 1000;
  const limit = boundedLimit(options.limit);
  const rows = [];

  for (const descriptor of Array.isArray(databases) ? databases : []) {
    let db;
    try {
      db = openReadOnly(descriptor);
      if (!hasRequiredTables(db)) continue;
      const sessions = db.prepare(`
        SELECT s.id, s.source, s.profile_name, s.title, s.model, s.started_at, s.ended_at,
               s.end_reason, s.last_activity_at, s.message_count, s.tool_call_count,
               s.api_call_count, s.cwd, s.git_branch, s.git_repo_root,
               EXISTS(
                 SELECT 1 FROM session_turn_leases l
                 WHERE l.conversation_id = s.id AND l.expires_at > ?
               ) AS live
        FROM sessions s
        WHERE s.id IS NOT NULL
        ORDER BY COALESCE(s.last_activity_at, s.started_at) DESC
        LIMIT ?
      `).all(nowSeconds, limit);
      for (const row of sessions) {
        if (!SESSION_ID.test(String(row.id || ""))) continue;
        const label = labelFor(row, descriptor);
        const live = row.live === 1;
        const correlation = correlationFor(row);
        rows.push({
          goal: row.id,
          title: typeof row.title === "string" ? row.title.slice(0, 200) : null,
          source: typeof row.source === "string" ? row.source.slice(0, 64) : null,
          profile: label,
          model: typeof row.model === "string" ? row.model.slice(0, 128) : null,
          ...correlation,
          status: statusFor(row, live),
          attempts: 1,
          liveController: live,
          traceRunning: live,
          rung: null,
          specialist: label,
          shipped_pr: null,
          preview_url: null,
          lastActivity: isoFromSeconds(row.last_activity_at ?? row.started_at),
          startedAt: isoFromSeconds(row.started_at),
          endedAt: isoFromSeconds(row.ended_at),
          nodeLabels: [label],
          filesTouched: 0,
          counts: {
            events: Number(row.message_count) || 0,
            modelCalls: Number(row.api_call_count) || 0,
            toolCalls: Number(row.tool_call_count) || 0,
          },
        });
      }
    } catch {
      // A missing, locked or malformed profile database contributes no live truth.
    } finally {
      try { db?.close(); } catch {}
    }
  }

  return rows
    .sort((a, b) => Date.parse(b.lastActivity || "") - Date.parse(a.lastActivity || ""))
    .slice(0, limit);
}

export function readHermesSessionGraph(databases, sessionId, options = {}) {
  if (!SESSION_ID.test(String(sessionId || ""))) return null;
  const nowSeconds = Number(options.nowMs ?? Date.now()) / 1000;

  for (const descriptor of Array.isArray(databases) ? databases : []) {
    let db;
    try {
      db = openReadOnly(descriptor);
      if (!hasRequiredTables(db)) continue;
      const row = db.prepare(`
        SELECT s.id, s.source, s.profile_name, s.title, s.model, s.started_at, s.ended_at,
               s.end_reason, s.last_activity_at, s.message_count, s.tool_call_count,
               s.api_call_count, s.cwd, s.git_branch, s.git_repo_root,
               EXISTS(
                 SELECT 1 FROM session_turn_leases l
                 WHERE l.conversation_id = s.id AND l.expires_at > ?
               ) AS live
        FROM sessions s WHERE s.id = ? LIMIT 1
      `).get(nowSeconds, sessionId);
      if (!row) continue;

      const label = labelFor(row, descriptor);
      const live = row.live === 1;
      const correlation = correlationFor(row);
      const messageRows = db.prepare(`
        SELECT id, role, tool_name, timestamp
        FROM messages
        WHERE session_id = ? AND active = 1 AND role IN ('assistant', 'tool')
        ORDER BY id DESC
        LIMIT ?
      `).all(sessionId, TIMELINE_LIMIT).reverse();
      const timeline = messageRows.map((message, index) => ({
        seq: index + 1,
        node: label,
        kind: message.role === "tool" ? "tool" : "model",
        tool: message.role === "tool" && typeof message.tool_name === "string"
          ? message.tool_name.slice(0, 128)
          : null,
        file: null,
        at: isoFromSeconds(message.timestamp),
      }));
      const tools = {};
      for (const event of timeline) {
        if (event.kind === "tool" && event.tool) tools[event.tool] = (tools[event.tool] || 0) + 1;
      }
      const current = timeline.at(-1) || null;
      const startedAt = isoFromSeconds(row.started_at);
      const endedAt = isoFromSeconds(row.ended_at);

      return {
        goal: row.id,
        title: typeof row.title === "string" ? row.title.slice(0, 200) : null,
        source: typeof row.source === "string" ? row.source.slice(0, 64) : null,
        profile: label,
        ...correlation,
        attempt: 1,
        status: statusFor(row, live),
        startedAt,
        endedAt,
        running: live,
        agents: [{
          id: label,
          label,
          model: typeof row.model === "string" ? row.model.slice(0, 128) : null,
          startedAt,
          endedAt,
          modelCalls: Number(row.api_call_count) || 0,
          toolCalls: Number(row.tool_call_count) || 0,
          tools,
        }],
        files: [],
        flow: [],
        touches: [],
        learnings: [],
        currentAgent: live ? label : null,
        currentActivity: current ? {
          node: current.node,
          kind: current.kind,
          tool: current.tool,
          file: null,
          at: current.at,
        } : null,
        timeline,
        counts: {
          events: Number(row.message_count) || 0,
          modelCalls: Number(row.api_call_count) || 0,
          toolCalls: Number(row.tool_call_count) || 0,
        },
      };
    } catch {
      // Fail closed and continue to the next bounded profile database.
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return null;
}
