import { NextResponse } from "next/server";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type AdmissionPayload = {
  source?: string;
  available?: boolean;
  draining?: boolean;
  groups?: unknown[];
  stats?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  syncedAt?: string;
};

export async function GET() {
  const payload = await readDataStore<AdmissionPayload>("hermes-admission").catch(() => null);
  return NextResponse.json(
    {
      source: payload?.source ?? "hermes-admission",
      available: payload !== null && payload.available !== false,
      draining: payload?.draining === true,
      groups: Array.isArray(payload?.groups) ? payload.groups : [],
      stats: payload?.stats ?? {},
      readiness: payload?.readiness ?? { state: "unknown", ready: false },
      syncedAt: payload?.syncedAt ?? null,
    },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
  );
}
