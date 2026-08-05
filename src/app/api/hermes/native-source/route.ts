import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { readHermesNativeSourceEnvelope } from "@/lib/hermes-native";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!hasValidInternalSecret(req.headers.get("x-internal-secret"))) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const envelope = await readHermesNativeSourceEnvelope();
  return NextResponse.json(envelope, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

function hasValidInternalSecret(provided: string | null) {
  const expected = process.env.HERMES_NATIVE_INTERNAL_SECRET;
  if (!expected || !provided) return false;

  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}
