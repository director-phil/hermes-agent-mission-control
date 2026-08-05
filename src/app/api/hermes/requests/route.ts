import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    requests: [],
    pending: 0,
    readonly: true,
    source: "unavailable",
  });
}
