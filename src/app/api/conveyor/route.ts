import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const QUEUE_STATUS_PATH =
  process.env.CHATDEV_QUEUE_STATUS ||
  path.join(process.env.HOME || "", "ChatDev", "goals", "state", "queue-runner-status.json");

const EMPTY = {
  conveyorOn: false,
  controllerPids: [] as number[],
  liveGoals: [] as string[],
  active: [] as unknown[],
  upNext: [] as unknown[],
  planRequired: [] as unknown[],
  blocked: [] as unknown[],
  counts: {} as Record<string, number>,
  focusPrefixes: [] as string[],
  message: "",
  boxes: [] as unknown[],
  statusAgeSec: null as number | null,
  statusMissing: true,
  syncedAt: null as string | null,
};

type QueueRunnerStatus = {
  updated_at?: number;
  conveyor_on?: boolean;
  controller_pids?: unknown[];
  active?: string[];
  active_detail?: Array<{
    goal_id?: string;
    status?: string;
    rung?: number;
    attempts?: number;
    pr?: string | null;
  }>;
  up_next?: Array<{
    goal_id?: string;
    title?: string;
    specialist?: string | null;
    dependency_ready?: boolean;
    plan_required?: boolean;
    waiting_on?: string[];
  }>;
  plan_required?: Array<{ goal_id?: string; title?: string }>;
  blocked?: Array<{
    goal_id?: string;
    queue_state?: string;
    blocked_by?: string[];
    failed_dependencies?: string[];
  }>;
  counts?: Record<string, number>;
  focus_prefixes?: string[];
  message?: string;
};

async function readQueueRunnerFallback(): Promise<typeof EMPTY | null> {
  try {
    const raw = await readFile(QUEUE_STATUS_PATH, "utf8");
    const status = JSON.parse(raw) as QueueRunnerStatus;
    const updatedAt = typeof status.updated_at === "number" ? status.updated_at : null;
    const statusAgeSec = updatedAt ? Math.max(0, Math.round(Date.now() / 1000 - updatedAt)) : null;
    const syncedAt = updatedAt ? new Date(updatedAt * 1000).toISOString() : new Date().toISOString();

    const active = Array.isArray(status.active) ? status.active : [];
    const activeDetail = Array.isArray(status.active_detail) ? status.active_detail : [];

    return {
      conveyorOn: Boolean(status.conveyor_on),
      controllerPids: (Array.isArray(status.controller_pids) ? status.controller_pids : [])
        .filter((n): n is number => Number.isInteger(n))
        .slice(0, 50),
      liveGoals: active.slice(0, 25),
      active: active.slice(0, 25).map((gid) => {
        const detail = activeDetail.find((d) => d.goal_id === gid) || {};
        return {
          goalId: gid,
          live: true,
          status: detail.status ?? null,
          rung: detail.rung ?? null,
          attempts: detail.attempts ?? null,
          pr: detail.pr ?? null,
        };
      }),
      upNext: Array.isArray(status.up_next)
        ? status.up_next.slice(0, 25).map((g) => ({
            goalId: g.goal_id,
            title: g.title || g.goal_id,
            specialist: g.specialist ?? null,
            dependencyReady: g.dependency_ready ?? true,
            planRequired: g.plan_required ?? false,
            waitingOn: (Array.isArray(g.waiting_on) ? g.waiting_on : []).slice(0, 12),
          }))
        : [],
      planRequired: Array.isArray(status.plan_required)
        ? status.plan_required.slice(0, 25).map((g) => ({ goalId: g.goal_id, title: g.title || g.goal_id }))
        : [],
      blocked: Array.isArray(status.blocked)
        ? status.blocked.slice(0, 50).map((b) => ({
            goalId: b.goal_id,
            queueState: b.queue_state,
            blockedBy: (Array.isArray(b.blocked_by) ? b.blocked_by : []).slice(0, 12),
            failedDependencies: (Array.isArray(b.failed_dependencies) ? b.failed_dependencies : []).slice(0, 12),
          }))
        : [],
      counts: typeof status.counts === "object" && status.counts ? status.counts : {},
      focusPrefixes: (Array.isArray(status.focus_prefixes) ? status.focus_prefixes : []).slice(0, 12),
      message: typeof status.message === "string" ? status.message : "queue status fallback",
      boxes: [],
      statusAgeSec,
      statusMissing: false,
      syncedAt,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const payload = await readDataStore<typeof EMPTY>("hermes-conveyor").catch(() => null);
  const fallback = payload ? null : await readQueueRunnerFallback();
  return NextResponse.json(payload ?? fallback ?? EMPTY, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
