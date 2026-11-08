import { NextRequest } from "next/server";
import { readConveyorRun } from "@/lib/conveyor-run";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Vercel Pro: allow a long-lived streaming response (SSE). The client
// auto-reconnects when the function window elapses.
export const maxDuration = 60;

const POLL_MS = 1500;
const KEEPALIVE_MS = 15_000;

function sseEncode(event: string, data: string): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(`event: ${event}\ndata: ${data}\n\n`);
}

async function loadGraph(goal: string) {
  const local = await readConveyorRun(goal).catch(() => null);
  if (local) return local;
  const mirror = await readDataStore<{ graphs?: Record<string, unknown> }>("hermes-conveyor-runs").catch(() => null);
  return (mirror?.graphs?.[goal] as Record<string, unknown> | undefined) ?? null;
}

export async function GET(request: NextRequest) {
  const goal = decodeURIComponent(request.nextUrl.pathname.split("/").pop() ?? "");
  const encoder = new TextEncoder();
  let lastHash = "";
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const tick = async () => {
        if (closed) return;
        try {
          const graph = await loadGraph(goal);
          if (graph) {
            const payload = JSON.stringify(graph);
            const hash = payload.length + ":" + payload.slice(0, 64);
            if (hash !== lastHash) {
              lastHash = hash;
              controller.enqueue(sseEncode("graph", payload));
            }
          }
        } catch {
          // transient read failure — retry next tick, don't kill the stream
        }
      };

      await tick();
      const poll = setInterval(tick, POLL_MS);
      const keepalive = setInterval(() => {
        if (!closed) controller.enqueue(sseEncode("ping", "{}"));
      }, KEEPALIVE_MS);

      // Clean up when the client disconnects.
      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(poll);
        clearInterval(keepalive);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
