import { NextResponse } from "next/server";
import { buildSnapshot, setMaintenance } from "@/lib/monitoring";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const snapshot = buildSnapshot();
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (err) {
    // The engine writes to the SQLite DB in WAL mode; a rare checkpoint can
    // momentarily lock the file. Retry once before surfacing a 500.
    try {
      const snapshot = buildSnapshot();
      return NextResponse.json(snapshot, {
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      });
    } catch {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { probe_id?: string; active?: boolean; note?: string };
    if (typeof body.probe_id !== "string" || typeof body.active !== "boolean") {
      return NextResponse.json(
        { error: "probe_id (string) and active (boolean) are required" },
        { status: 400 },
      );
    }
    setMaintenance(body.probe_id, body.active, body.note ?? null);
    return NextResponse.json({ ok: true, probe_id: body.probe_id, maintenance: body.active });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
