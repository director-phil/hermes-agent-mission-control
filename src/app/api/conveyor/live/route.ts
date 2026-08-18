import { NextResponse } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const GOALS = path.join(process.env.HOME || "", "ChatDev", "goals");
const STATE = path.join(GOALS, "state");
const SESSIONS = path.join(process.env.HOME || "", "ChatDev", "runs", "sessions");

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

type GoalResult = {
  goalId: string;
  state: Record<string, unknown>;
  log: string[];
  session: SessionData;
  packets: unknown[];
};

async function listMarkdown(dir: string) {
  const files = await readdir(dir).catch(() => [] as string[]);
  return (files as string[]).filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", ""));
}

function extractToolCalls(implResults: unknown[]): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  for (const item of implResults) {
    const message = item as { type?: string; payload?: { tool_calls?: unknown[] } };
    if (message.type !== "message") continue;
    for (const raw of message.payload?.tool_calls || []) {
      const tc = raw as { function?: { name?: string; arguments?: unknown }; name?: string };
      const fn = tc.function?.name || tc.name || "?";
      let relPath = "";
      try {
        const args = tc.function?.arguments;
        const parsed = typeof args === "string" ? JSON.parse(args) : args;
        relPath = (parsed as { rel_path?: string })?.rel_path || "";
      } catch {
        relPath = "";
      }
      toolCalls.push({ name: fn, path: relPath });
    }
  }
  return toolCalls;
}

function summarizeNodes(results: Record<string, unknown>): Record<string, NodeSummary> {
  const nodes: Record<string, NodeSummary> = {};
  for (const [key, val] of Object.entries(results)) {
    if (key === "graph_summary") continue;
    const nodeResults = ((val as { results?: unknown[] })?.results || []) as Array<{
      type?: string;
      payload?: { role?: string; tool_calls?: Array<{ function?: { name?: string }; name?: string }> };
    }>;
    const toolCounts: Record<string, number> = {};
    let modelCalls = 0;
    for (const item of nodeResults) {
      if (item.type === "message" && item.payload?.role === "assistant") modelCalls++;
      for (const call of item.payload?.tool_calls || []) {
        const fn = call.function?.name || call.name || "?";
        toolCounts[fn] = (toolCounts[fn] || 0) + 1;
      }
    }
    const nodeName = key.replace("node_", "");
    nodes[nodeName] = {
      modelCalls,
      toolCalls: Object.values(toolCounts).reduce((a, b) => a + b, 0),
      topTools: toolCounts,
    };
  }
  return nodes;
}

async function findSessionForGoal(gid: string): Promise<SessionData> {
  const allSessions = await readdir(SESSIONS).catch(() => [] as string[]);
  const goalSessions = (allSessions as string[]).filter((f) => f.endsWith(".json")).sort().reverse();

  for (const sf of goalSessions.slice(0, 5)) {
    try {
      const raw = JSON.parse(await readFile(path.join(SESSIONS, sf), "utf8")) as {
        task_prompt?: string;
        results?: Record<string, unknown>;
      };
      if (!raw.task_prompt?.includes(gid)) continue;

      const results = raw.results || {};
      const implResults = ((results["node_Local Implementer"] as { results?: unknown[] })?.results || []) as unknown[];
      const toolCalls = extractToolCalls(implResults);
      const nodes = summarizeNodes(results);

      return {
        sessionId: sf.replace(".json", ""),
        toolCalls,
        nodes,
        totalTools: toolCalls.length,
        filesRead: [...new Set(toolCalls.filter((t) => t.name === "read_repo_file").map((t) => t.path || ""))],
        filesWritten: [
          ...new Set(toolCalls.filter((t) => ["write_repo_file", "apply_patch"].includes(t.name)).map((t) => t.path || "")),
        ],
      };
    } catch {
      // skip unreadable/unrelated session file
    }
  }
  return null;
}

export async function GET() {
  const activeGoals = await listMarkdown(path.join(GOALS, "active"));

  if (!activeGoals.length) {
    return NextResponse.json({ active: false, goals: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const results: GoalResult[] = [];
  for (const gid of activeGoals) {
    const stateFile = path.join(STATE, `${gid}.json`);
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
    } catch {
      state = {};
    }

    const logFile = path.join(STATE, `${gid}.log`);
    let logLines: string[] = [];
    try {
      logLines = (await readFile(logFile, "utf8")).split("\n").filter(Boolean).slice(-30);
    } catch {
      logLines = [];
    }

    const sessionData = await findSessionForGoal(gid);

    results.push({
      goalId: gid,
      state,
      log: logLines,
      session: sessionData,
      packets: Array.isArray(state.packets) ? (state.packets as unknown[]) : [],
    });
  }

  const done = await readdir(path.join(GOALS, "done")).catch(() => [] as string[]);
  const failed = await readdir(path.join(GOALS, "failed")).catch(() => [] as string[]);

  return NextResponse.json(
    {
      active: true,
      goals: results,
      counts: {
        done: (done as string[]).filter((f) => f.endsWith(".md")).length,
        failed: (failed as string[]).length,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
