import { NextResponse } from "next/server";
import { readDataStore } from "@/lib/hermes-native-mirror";

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
 * A trace older than 30 minutes is considered stale and not active in self-heal logic.
 */
function classifyTraceAsStale(run: Record<string, unknown>): boolean {
  const now = Date.now();
  const timestamp = (() => {
    const startTime = run.startTime;
    const createdAt = run.createdAt;

    if (typeof startTime === "number") return startTime;
    if (typeof startTime === "string") return new Date(startTime).getTime();
    if (typeof createdAt === "number") return createdAt;
    if (typeof createdAt === "string") return new Date(createdAt).getTime();
    return null;
  })();

  if (timestamp === null) return false; // Unknown timestamp: not stale
  const ageMs = now - timestamp;
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  return ageMs > STALE_THRESHOLD_MS;
}

/**
 * Determines if a trace is actively running based on status and recency.
 */
function isTraceRunning(run: Record<string, unknown>, isStale: boolean): boolean {
  // Stale traces are never running (for self-heal purposes)
  if (isStale) return false;

  // Check status field if present
  const status = typeof run.status === "string" ? run.status.toLowerCase() : null;
  if (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return false;
  }

  // Default: active if not stale and no terminal status
  return true;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

export async function GET() {
  try {
    const payload = await readDataStore<{ index?: unknown[] }>(
      "hermes-runs"
    ).catch(() => null);

    if (!Array.isArray(payload?.index)) {
      return NextResponse.json([], { headers: CORS_HEADERS });
    }

    // Enrich runs with stale classification and trace status
    const enrichedRuns = payload.index.map((run) => {
      const runObj = run as Record<string, unknown>;
      const isStale = classifyTraceAsStale(runObj);
      const traceRunning = isTraceRunning(runObj, isStale);

      return {
        ...runObj,
        isStale,
        traceRunning,
      } as Record<string, unknown>;
    });

    // Count live controller instances (non-stale, explicitly marked)
    const liveControllerCount = enrichedRuns.filter(
      (r) => r["liveController"] === true && !r["isStale"]
    ).length;

    // Count ghost traces (stale runs that should not be in active metrics)
    const ghostTraceCount = enrichedRuns.filter((r) => r["isStale"]).length;

    // Count actively running traces (non-stale and in running state)
    const traceRunningCount = enrichedRuns.filter(
      (r) => r["traceRunning"] === true
    ).length;

    // Create response with summary metadata
    const response = {
      runs: enrichedRuns,
      total: enrichedRuns.length,
      liveController: liveControllerCount,
      liveControllerTrue: liveControllerCount, // Backward compat alias
      ghost: ghostTraceCount,
      traceRunning: traceRunningCount,
      summary: {
        totalRuns: enrichedRuns.length,
        liveControllerInstances: liveControllerCount,
        ghostTraces: ghostTraceCount,
        activeTraces: traceRunningCount,
        stalePeriodMs: 30 * 60 * 1000,
      },
    };

    return NextResponse.json(response, { headers: CORS_HEADERS });
  } catch (error) {
    console.error("[runs] Error reading runs:", error);
    return NextResponse.json(
      {
        runs: [],
        total: 0,
        liveController: 0,
        liveControllerTrue: 0,
        ghost: 0,
        traceRunning: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
