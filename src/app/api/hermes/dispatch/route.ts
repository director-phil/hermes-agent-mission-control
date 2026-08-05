import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Hermes browser dispatch is disabled; Mission Control is read-only." },
    { status: 405 },
  );
}
