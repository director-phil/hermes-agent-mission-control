import { NextResponse } from "next/server";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ProcessPayload = {
  source?: string;
  processes?: unknown[];
  syncedAt?: string;
};

export async function GET() {
  const payload = await readDataStore<ProcessPayload>("hermes-processes").catch(() => null);
  return NextResponse.json(
    {
      source: payload?.source ?? "hermes-process-registry",
      available: payload !== null,
      processes: Array.isArray(payload?.processes) ? payload.processes : [],
      syncedAt: payload?.syncedAt ?? null,
    },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
  );
}
