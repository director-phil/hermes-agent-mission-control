import { NextResponse } from "next/server";
import { listConveyorRuns } from "@/lib/conveyor-run";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const local = await listConveyorRuns().catch(() => []);
  if (local.length > 0) {
    return NextResponse.json(
      { goals: local },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );
  }

  // Deployed / serverless: local ChatDev run dirs are unavailable, so read the
  // bridge-mirrored conveyor runs from the shared data store.
  const mirror = await readDataStore<{ index?: unknown[] }>("hermes-conveyor-runs").catch(() => null);
  const goals = Array.isArray(mirror?.index) ? mirror.index : [];
  return NextResponse.json(
    { goals },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
  );
}
