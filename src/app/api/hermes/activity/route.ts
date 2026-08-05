import { NextResponse } from "next/server";
import { collectHermesObservability } from "@/lib/langfuse-observability";

export async function GET(req: Request) {
  const take = Math.min(Number(new URL(req.url).searchParams.get("take") || 40), 100);
  const observability = await collectHermesObservability("24h", {
    maxPages: 2,
    maxRows: Math.max(take, 40),
  });

  if (observability.source.status === "error") {
    return NextResponse.json({
      events: [],
      source: "langfuse",
      unavailable: true,
      message: observability.source.warning ?? observability.source.message,
    });
  }

  const operationEvents = observability.operations.map((operation) => ({
    id: `operation-${operation.operationId}`,
    kind: "operation",
    title: operation.operationId,
    detail: operation.models.length ? operation.models.join(", ") : null,
    agent: operation.platforms[0] ?? null,
    level: operation.status === "error" ? "down" : "info",
    createdAt: operation.latestTimestamp ?? operation.endTime ?? operation.startTime ?? observability.source.lastSync,
  }));

  const sessionEvents = observability.sessions.map((session) => ({
    id: `session-${session.id}`,
    kind: "session",
    title: session.sessionId ?? session.traceId ?? session.id,
    detail: session.models.length ? session.models.join(", ") : null,
    agent: session.platform,
    level: session.status === "error" ? "down" : "info",
    createdAt: session.latestTimestamp ?? session.endTime ?? session.startTime ?? observability.source.lastSync,
  }));

  const events = [...operationEvents, ...sessionEvents]
    .filter((event) => event.createdAt)
    .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
    .slice(0, take);

  return NextResponse.json({
    events,
    source: "langfuse",
    unavailable: false,
  });
}
