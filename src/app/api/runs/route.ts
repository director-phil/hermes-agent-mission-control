import { NextResponse } from "next/server";
import { readDataStore } from "@/lib/hermes-native-mirror";
import { extractLiveGoalsFromConveyorPayload } from "@/lib/runs-liveness";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

/**
 * Classifies whether a trace should be considered "stale" based on its age.
 * A trace older than 30 minutes is considered stale for observability/analytics purposes.
 * This does NOT affect liveness judgment - conveyor/live-controller truth is authoritative.
 */
function classifyTraceAsStale(run: Record<string, unknown>): boolean {
  const now = Date.now();
  const timestamp = (() => {
    const lastActivity = run.lastActivity;
    if (typeof lastActivity === "string") return new Date(lastActivity).getTime();

    const startTime = run.startTime;
    if (typeof startTime === "number") return startTime;
    if (typeof startTime === "string") return new Date(startTime).getTime();

    const createdAt = run.createdAt;
    if (typeof createdAt === "number") return createdAt;
    if (typeof createdAt === "string") return new Date(createdAt).getTime();

    return null;
  })();

  if (timestamp === null) return false;
  const ageMs = now - timestamp;
  const STALE_THRESHOLD_MS = 30 * 60 * 1000;
  return ageMs > STALE_THRESHOLD_MS;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

export async function GET() {
  try {
    const [runsPayload, conveyorPayload] = await Promise.all([
      readDataStore<{ index?: unknown[] }>("hermes-runs").catch(() => null),
      readDataStore<unknown>("hermes-conveyor").catch(() => null),
    ]);

    const baseRuns = Array.isArray(runsPayload?.index) ? runsPayload.index : [];

    // Use staleness-aware extraction: if the DataStore conveyor snapshot
    // is older than CONVEYOR_SNAPSHOT_RETENTION_MS (120s), we get an empty
    // set — preventing stale payloads from marking dead goals as live.
    const liveGoals = extractLiveGoalsFromConveyorPayload(conveyorPayload);

    const nowIso = new Date().toISOString();
    const seen = new Set<string>();

    const enrichedRuns = baseRuns.map((run) => {
      const runObj = run as Record<string, unknown>;
      const goal = typeof runObj.goal === "string" ? runObj.goal : null;
      if (goal) seen.add(goal);
      const isLive = goal ? liveGoals.has(goal) : false;

      return {
        ...runObj,
        status: isLive ? "running" : runObj.status,
        liveController: isLive ? true : runObj.liveController,
        traceRunning: isLive ? true : runObj.traceRunning,
        lastActivity: isLive ? nowIso : runObj.lastActivity,
        isStale: isLive ? false : classifyTraceAsStale(runObj),
      } as Record<string, unknown>;
    });

    // If conveyor reports a live goal not present in runs index yet, add a synthetic row.
    for (const goalId of liveGoals) {
      if (seen.has(goalId)) continue;
      enrichedRuns.unshift({
        goal: goalId,
        status: "running",
        attempts: 0,
        rung: null,
        specialist: null,
        shipped_pr: null,
        preview_url: null,
        lastActivity: nowIso,
        nodeLabels: [],
        filesTouched: 0,
        traceRunning: true,
        liveController: true,
        isSynthetic: true,
        isStale: false,
      });
    }

    return NextResponse.json(enrichedRuns, { headers: CORS_HEADERS });
  } catch (error) {
    console.error("[runs] Error reading runs:", error);
    return NextResponse.json([], { headers: CORS_HEADERS });
  }
}
