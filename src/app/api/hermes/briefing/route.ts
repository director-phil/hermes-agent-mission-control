import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    generatedAt: null,
    greeting: null,
    summary: null,
    sections: [],
    readonly: true,
    source: "unavailable",
  });
}

export async function POST() {
  return NextResponse.json(
    { error: "Daily briefing generation is disabled; Mission Control is read-only." },
    { status: 410 },
  );
}
