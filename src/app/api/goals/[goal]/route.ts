import { NextResponse } from "next/server";
import { readConveyorRun } from "@/lib/conveyor-run";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  context: { params: Promise<{ goal: string }> },
) {
  const { goal } = await context.params;
  let decoded: string;
  try {
    decoded = decodeURIComponent(goal);
  } catch (error) {
    if (error instanceof URIError) {
      return NextResponse.json({ error: "invalid goal" }, { status: 400 });
    }
    throw error;
  }

  const local = await readConveyorRun(decoded).catch(() => null);
  if (local) {
    return NextResponse.json(local, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  }

  // Deployed / serverless fallback: read the bridge-mirrored graph.
  const mirror = await readDataStore<{ graphs?: Record<string, unknown> }>("hermes-conveyor-runs").catch(() => null);
  const graph = mirror?.graphs?.[decoded];
  if (graph) {
    return NextResponse.json(graph, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  }

  return NextResponse.json(
    { error: "conveyor run not found" },
    { status: 404, headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
  );
}
