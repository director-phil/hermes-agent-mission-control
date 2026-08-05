import { NextResponse } from "next/server";
import { readHermesCronSnapshotForServer } from "@/lib/hermes-native";

export async function GET() {
  const crons = await readHermesCronSnapshotForServer();
  return NextResponse.json(crons);
}

export async function POST() {
  return NextResponse.json(
    { error: "Hermes cron mutations are disabled; Mission Control is read-only." },
    { status: 405 },
  );
}
