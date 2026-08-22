import { NextResponse } from "next/server";
import { readDataStore } from "@/lib/hermes-native-mirror";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

export async function GET() {
  try {
    const runsPayload = await readDataStore<{ index?: unknown[] }>("hermes-runs").catch(() => null);
    const runs = Array.isArray(runsPayload?.index) ? runsPayload.index : [];
    return NextResponse.json(runs, { headers: CORS_HEADERS });
  } catch (error) {
    console.error("[runs] Error reading runs:", error);
    return NextResponse.json([], { headers: CORS_HEADERS });
  }
}
