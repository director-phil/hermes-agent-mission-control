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
 * Uses lastActivity (preferred for bridge-mirrored runs) or falls back to startTime/createdAt.
 */
function classifyTraceAsStale(run: Record<string, unknown>): boolean {
  const now = Date.now();
  const timestamp = (() => {
    // Prefer lastActivity (used by bridge-mirrored runs)
    const lastActivity = run.lastActivity;
    if (typeof lastActivity === "string") return new Date(lastActivity).getTime();
    
    // Fallback to startTime (used by some test data)
    const startTime = run.startTime;
    if (typeof startTime === "number") return startTime;
    if (typeof startTime === "string") return new Date(startTime).getTime();
    
    // Fallback to createdAt
    const createdAt = run.createdAt;
    if (typeof createdAt === "number") return createdAt;
    if (typeof createdAt === "string") return new Date(createdAt).getTime();
    
    return null;
  })();

  if (timestamp === null) return false; // Unknown timestamp: not stale
  const ageMs = now - timestamp;
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  return ageMs > STALE_THRESHOLD_MS;
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

    // Enrich runs with stale classification
    // Only clear liveness for stale traces that were NOT marked live by the bridge
    const enrichedRuns = payload.index.map((run) => {
      const runObj = run as Record<string, unknown>;
      const isStale = classifyTraceAsStale(runObj);

      // For stale traces, clear liveness only if the bridge didn't mark them live
      if (isStale) {
        const isLiveByBridge = runObj.liveController === true;
        
        // If bridge marked it live, trust that and preserve it (long-running work)
        // If bridge didn't mark it live, clear liveness to exclude from active view
        if (!isLiveByBridge) {
          return {
            ...runObj,
            isStale: true,
            traceRunning: false, // Only clear if trace wasn't marked running by bridge
          } as Record<string, unknown>;
        }
        
        // Bridge marked it live: preserve all liveness fields
        return {
          ...runObj,
          isStale: true,
        } as Record<string, unknown>;
      }

      // For recent traces, preserve all fields as-is and just mark them not-stale
      return {
        ...runObj,
        isStale: false,
      } as Record<string, unknown>;
    });

    // Return the enriched array directly (preserves backward compatibility)
    return NextResponse.json(enrichedRuns, { headers: CORS_HEADERS });
  } catch (error) {
    console.error("[runs] Error reading runs:", error);
    return NextResponse.json([], { headers: CORS_HEADERS });
  }
}
