import { NextResponse } from "next/server";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type EvaluationPayload = {
  decisions?: unknown[];
  syncedAt?: string;
};

export async function GET() {
  const payload = await readDataStore<EvaluationPayload>("hermes-evaluations").catch(() => null);
  return NextResponse.json(
    {
      decisions: Array.isArray(payload?.decisions) ? payload.decisions : [],
      syncedAt: payload?.syncedAt ?? null,
      available: payload !== null,
    },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
  );
}
