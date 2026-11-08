import { NextRequest } from "next/server";
import { buildSnapshot, type MonitoringSnapshot } from "@/lib/monitoring";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const POLL_MS = 2000;
const KEEPALIVE_MS = 15_000;

function sseEncode(event: string, data: string): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(`event: ${event}\ndata: ${data}\n\n`);
}

async function loadSnapshot(): Promise<MonitoringSnapshot | null> {
  try {
    return buildSnapshot();
  } catch {
    const mirrored = await readDataStore<{ snapshot?: MonitoringSnapshot }>("hermes-monitoring").catch(() => null);
    return mirrored?.snapshot ?? null;
  }
}

export async function GET(request: NextRequest) {
  let lastHash = "";
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const tick = async () => {
        if (closed) return;
        try {
          const snap = await loadSnapshot();
          if (snap) {
            const payload = JSON.stringify(snap);
            const hash = payload.length + ":" + payload.slice(0, 64);
            if (hash !== lastHash) {
              lastHash = hash;
              controller.enqueue(sseEncode("services", payload));
            }
          }
        } catch {
          // transient — retry next tick
        }
      };

      await tick();
      const poll = setInterval(tick, POLL_MS);
      const keepalive = setInterval(() => {
        if (!closed) controller.enqueue(sseEncode("ping", "{}"));
      }, KEEPALIVE_MS);

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
