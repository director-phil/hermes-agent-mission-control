import { NextResponse } from "next/server";
import { readConveyorRun } from "@/lib/conveyor-run";

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

  const graph = await readConveyorRun(decoded);
  if (!graph) {
    return NextResponse.json(
      { error: "conveyor run not found" },
      { status: 404, headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );
  }

  return NextResponse.json(graph, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
