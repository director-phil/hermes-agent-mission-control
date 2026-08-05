import { NextResponse } from "next/server";

export async function PATCH() {
  return NextResponse.json(
    { error: "Hermes request approvals are disabled; Mission Control is read-only." },
    { status: 405 },
  );
}
