import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  chooseApiConveyorSnapshot,
  conveyorFallbackFromQueueStatus,
  refreshFreshAuthoritativeConveyorSnapshot,
  type ConveyorState,
  type QueueRunnerStatus,
} from "@/lib/conveyor-state";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const QUEUE_STATUS_PATH =
  process.env.CHATDEV_QUEUE_STATUS ||
  path.join(process.env.HOME || "", "ChatDev", "goals", "state", "queue-runner-status.json");

async function readQueueRunnerFallback(nowMs: number): Promise<ConveyorState | null> {
  try {
    const raw = await readFile(QUEUE_STATUS_PATH, "utf8");
    return conveyorFallbackFromQueueStatus(JSON.parse(raw) as QueueRunnerStatus, nowMs / 1000);
  } catch {
    return null;
  }
}

export async function GET() {
  const payload = await readDataStore<unknown>("hermes-conveyor").catch(() => null);
  const nowMs = Date.now();
  const refreshedPayload = refreshFreshAuthoritativeConveyorSnapshot(payload, nowMs);
  const queueFallback = refreshedPayload ? null : await readQueueRunnerFallback(nowMs);
  const snapshot = chooseApiConveyorSnapshot({ payload, queueFallback, nowMs });

  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
