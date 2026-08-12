import { NextResponse } from "next/server";
import {
  collectHermesObservability,
  type HermesObservability,
  parseObservabilityWindow,
  type ObservabilityWindow,
} from "@/lib/langfuse-observability";

const CACHE_MS = 7000;

const cache = new Map<
  ObservabilityWindow,
  {
    expiresAt: number;
    payload: HermesObservability;
    cachedAt: number;
  }
>();

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Failed to collect Hermes observability.";
}

function cacheHeaders(cachedAt: number | null, extra?: HeadersInit) {
  return {
    ...(extra ?? {}),
    "X-Cache-Age": cachedAt == null ? "0" : String(Math.max(0, Date.now() - cachedAt)),
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const window = parseObservabilityWindow(url.searchParams.get("window") ?? "24h");

  if (!window) {
    return NextResponse.json(
      { error: "Invalid window. Use 24h or 7d." },
      { status: 400 },
    );
  }

  const now = Date.now();
  const cached = cache.get(window);
  if (cached && cached.expiresAt > now) {
    return NextResponse.json(cached.payload, {
      headers: cacheHeaders(cached.cachedAt),
    });
  }

  try {
    const payload = await collectHermesObservability(window);
    const cachedAt = Date.now();
    cache.set(window, {
      expiresAt: cachedAt + CACHE_MS,
      payload,
      cachedAt,
    });

    return NextResponse.json(payload, {
      headers: cacheHeaders(cachedAt),
    });
  } catch (error) {
    const message = errorMessage(error);
    if (cached) {
      return NextResponse.json(cached.payload, {
        headers: cacheHeaders(cached.cachedAt, {
          "X-Cache-Stale": "1",
          "X-Cache-Error": message,
        }),
      });
    }

    return NextResponse.json(
      {
        error: message,
        lastGoodSnapshot: null,
      },
      {
        status: 502,
        headers: cacheHeaders(null),
      },
    );
  }
}
