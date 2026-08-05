import { NextResponse } from "next/server";
import { readHermesNativeHealthForServer } from "@/lib/hermes-native";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const health = await readHermesNativeHealthForServer();
  return NextResponse.json(health, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
