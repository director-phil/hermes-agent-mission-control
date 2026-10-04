import { NextResponse } from "next/server";
import { appendFileSync } from "node:fs";
import { buildSnapshot, setMaintenance, type MonitoringSnapshot } from "@/lib/monitoring";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ERR_LOG = "/home/phillip_downs/.hermes/mission-control/reader-errors.log";

function logError(msg: string) {
  try {
    appendFileSync(ERR_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* never let logging break the response */
  }
}

// Last successful snapshot — served as a stale fallback when the probe engine is
// mid-write (SQLite WAL checkpoint contention) so the board never 500s, it just
// renders data a few seconds old.
let lastGood: MonitoringSnapshot | null = null;

async function buildWithRetry(retries = 3): Promise<MonitoringSnapshot> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const snap = buildSnapshot();
      lastGood = snap;
      return snap;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 120 * (i + 1)));
      }
    }
  }
  if (lastGood) {
    logError(`GET /api/services returning stale snapshot after ${retries} failed builds: ${String(lastErr)}`);
    return lastGood;
  }
  throw lastErr;
}

export async function GET() {
  try {
    const snapshot = await buildWithRetry();
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logError(`GET /api/services failed after 3 retries: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
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
