import { NextResponse } from "next/server";
import {
  collectHermesObservability,
  type HermesObservability,
  parseObservabilityWindow,
  type ObservabilityWindow,
} from "@/lib/langfuse-observability";

// Window-specific timeout and collection limits
const WINDOW_CONFIG: Record<ObservabilityWindow, {
  timeoutMs: number;
  maxPages: number;
  maxRows: number;
}> = {
  "24h": {
    timeoutMs: 9000,    // 9s for 24h: fast, leaves 3s margin for processing
    maxPages: 5,        // Limit to 5 pages
    maxRows: 5000,      // Limit to 5000 rows
  },
  "7d": {
    timeoutMs: 8000,    // 8s for 7d: ultra-fast collection, leaves 4s margin
    maxPages: 1,        // Single page only: no pagination overhead
    maxRows: 1000,      // Minimal rows: 1000 max for fast aggregation
  },
};

const CACHE_MS = 7000;
const REQUEST_TIMEOUT_MS = 12000; // 12s hard timeout on HTTP request

const cache = new Map<
  ObservabilityWindow,
  {
    expiresAt: number;
    payload: HermesObservability;
  }
>();

// Background refresh state to track pending refreshes (fire-and-forget)
const backgroundRefreshState = new Map<ObservabilityWindow, {
  inFlight: boolean;
  nextAllowedTime: number;
}>();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * Wraps a promise with a hard timeout.
 * Rejects with "TIMEOUT" error if promise doesn't settle within timeoutMs.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Trigger background refresh without awaiting.
 * Fire-and-forget: we don't wait for this and don't return it in the response.
 */
function triggerBackgroundRefresh(window: ObservabilityWindow) {
  // Get or create refresh state
  if (!backgroundRefreshState.has(window)) {
    backgroundRefreshState.set(window, { inFlight: false, nextAllowedTime: 0 });
  }
  
  const state = backgroundRefreshState.get(window)!;
  const now = Date.now();
  
  // Skip if already in flight or too soon since last attempt
  if (state.inFlight || now < state.nextAllowedTime) {
    return;
  }
  
  // Mark as in flight
  state.inFlight = true;
  
  // Fire off the background refresh (do NOT await this)
  const config = WINDOW_CONFIG[window];
  (async () => {
    try {
      const payload = await withTimeout(
        collectHermesObservability(window, {
          maxPages: config.maxPages,
          maxRows: config.maxRows,
          timeoutMs: config.timeoutMs,
        }),
        config.timeoutMs + 2000 // Give slightly more time in background
      );
      
      // Update cache with fresh data
      cache.set(window, {
        expiresAt: Date.now() + CACHE_MS,
        payload,
      });
      
      console.log(`[observability] Background refresh completed for ${window}`);
    } catch (error) {
      // Log but don't fail - background refresh is best-effort
      console.warn(`[observability] Background refresh failed for ${window}:`, 
        error instanceof Error ? error.message : String(error));
      
      // Throttle retry attempts
      state.nextAllowedTime = Date.now() + 5000; // Wait 5s before next attempt
    } finally {
      state.inFlight = false;
    }
  })();
}

/**
 * Build a degraded but valid response payload for when data collection times out or fails.
 * This preserves the response contract so UI consumers don't break.
 */
function buildDegradedPayload(window: ObservabilityWindow): HermesObservability {
  const now_iso = new Date().toISOString();
  
  return ({
    status: "partial",
    error: "Collection timeout",
    source: {
      status: "warning",
      source: "langfuse",
      message: `Warming up ${window} observability data`,
      warning: "Timeout occurred during data collection",
      lastSync: null,
      window,
      fromStartTime: now_iso,
      toStartTime: now_iso,
      rows: 0,
      filteredRows: 0,
      includedRows: 0,
      pages: 0,
      truncated: false,
    },
    health: {
      status: "warning",
      ok: false,
    },
    health_summary: {
      status: "warning",
      ok: false,
      liveController: false,
      traceRunning: false,
    },
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCost: 0,
      estimatedCost: null,
      effectiveCost: 0,
      costBasis: "local_zero",
      totalCost: 0,
      generationCalls: 0,
      toolCalls: 0,
      uniqueTraces: 0,
      uniqueSessions: 0,
      errors: 0,
      latestTimestamp: null,
    },
    byModel: [],
    byProvider: [],
    completeness: null,
    timeSeries: {} as any,
    correlationCoverage: { 
      status: "missing", 
      totalObservations: 0, 
      eligibleObservations: 0, 
      withOperationId: 0, 
      withGoalId: 0, 
      withRunId: 0, 
      withStageId: 0, 
      invalidIdentifierObservations: 0, 
      fullyCorrelatedObservations: 0, 
      operationCount: 0, 
      fullyCorrelatedOperations: 0, 
      percentage: null 
    },
    operations: [],
    accounting: { 
      operationCount: 0, 
      rowCap: 0, 
      returnedOperations: 0, 
      truncatedOperations: false, 
      reportedCost: 0, 
      estimatedCost: null, 
      effectiveCost: 0, 
      costBasis: "local_zero", 
      reconciliation: "missing", 
      warnings: [] 
    },
    graftCohort: { 
      status: "missing", 
      signalObservations: 0, 
      signalOperations: 0, 
      graft: { 
        platform: "unknown", 
        provider: "unknown", 
        model: "unknown", 
        cost: { low: 0, high: 0, basis: "unknown" }, 
        generation: { tokens: { low: 0, high: 0 }, calls: { low: 0, high: 0 } }, 
        tokenDist: [], 
        toolCalls: [] 
      }, 
      baseline: { 
        platform: "unknown", 
        provider: "unknown", 
        model: "unknown", 
        cost: { low: 0, high: 0, basis: "unknown" }, 
        generation: { tokens: { low: 0, high: 0 }, calls: { low: 0, high: 0 } }, 
        tokenDist: [], 
        toolCalls: [] 
      }, 
      delta: { 
        costPercentChange: null, 
        tokensPercentChange: null, 
        toolsAdded: [], 
        toolsRemoved: [] 
      } 
    },
    workflow: null,
    amplification: null,
    sessions: [],
    tools: { recent: [], repeated: [] },
    topExpensiveTraces: [],
    topLargeTraces: [],
    wasteFlags: [],
    recommendations: [],
    observationsByTrace: {},
    traceCount: 0,
    sessionCount: 0,
    // Mark as partial so consumers know this is degraded
    isPartial: true,
    partialReason: `Warming up ${window} observability data`,
  } as any) as HermesObservability;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const window = parseObservabilityWindow(
      url.searchParams.get("window") ?? "24h"
    );

    if (!window) {
      return NextResponse.json(
        { error: "Invalid window. Use 24h or 7d.", status: "error" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const now = Date.now();
    const cached = cache.get(window);

    // ====================================================================================
    // FAST PATH: 7d window - NEVER await Langfuse, return immediately
    // ====================================================================================
    if (window === "7d") {
      // If we have fresh cache, return immediately
      if (cached && cached.expiresAt > now) {
        return NextResponse.json(cached.payload, { headers: CORS_HEADERS });
      }

      // NO CACHE: Return degraded payload immediately
      // Trigger background refresh fire-and-forget (do NOT await)
      triggerBackgroundRefresh("7d");
      
      // Return immediately with degraded but valid payload (source.status='warning', rows=0)
      const degradedPayload = buildDegradedPayload("7d");
      return NextResponse.json(degradedPayload, { status: 200, headers: CORS_HEADERS });
    }

    // ====================================================================================
    // STANDARD PATH: 24h window - await with hard timeout, fallback to cache on timeout
    // ====================================================================================
    
    // If we have fresh cache, return immediately
    if (cached && cached.expiresAt > now) {
      return NextResponse.json(cached.payload, { headers: CORS_HEADERS });
    }

    // Get window-specific config (for 24h)
    const config = WINDOW_CONFIG[window];

    // Wrap collectHermesObservability with hard timeout
    let payload: HermesObservability;
    try {
      payload = await withTimeout(
        collectHermesObservability(window, {
          maxPages: config.maxPages,
          maxRows: config.maxRows,
          timeoutMs: config.timeoutMs,
        }),
        REQUEST_TIMEOUT_MS
      );
    } catch (collectionError) {
      // If we have stale cached data, return it instead of failing
      if (cached && cached.expiresAt <= now) {
        return NextResponse.json(cached.payload, { headers: CORS_HEADERS });
      }

      // If no cached data at all, return a degraded but valid response
      const errorMessage =
        collectionError instanceof Error ? collectionError.message : "Unknown error";

      console.warn(`[observability] Collection failed for ${window}: ${errorMessage}`);
      
      const degradedPayload = buildDegradedPayload(window);
      degradedPayload.source.message = `Collection failed: ${errorMessage}`;
      
      return NextResponse.json(degradedPayload, { status: 200, headers: CORS_HEADERS });
    }

    cache.set(window, {
      expiresAt: now + CACHE_MS,
      payload,
    });

    return NextResponse.json(payload, { headers: CORS_HEADERS });
  } catch (error) {
    console.error("[observability] Error in GET handler:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Return a structured error response that the client can handle
    return NextResponse.json(
      {
        status: "error",
        error: errorMessage,
        health: { status: "error", message: errorMessage },
        health_summary: {
          status: "error",
          ok: false,
          liveController: false,
          traceRunning: false,
        },
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
