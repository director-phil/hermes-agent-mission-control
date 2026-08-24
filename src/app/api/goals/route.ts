import { NextResponse } from "next/server";
import { listConveyorRuns } from "@/lib/conveyor-run";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const goals = await listConveyorRuns();
  return NextResponse.json(
    { goals },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
  );
}
