import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    entries: [],
    typeCounts: {},
    total: 0,
    lastSync: null,
    readonly: true,
    source: "unavailable",
  });
}

export async function POST() {
  return NextResponse.json(
    { error: "Wiki memory writes are disabled; Mission Control is read-only." },
    { status: 410 },
  );
}
