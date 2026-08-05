import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-briefing" } });
  return NextResponse.json(row?.data ?? { generatedAt: null, summary: null, sections: [] });
}

export async function POST() {
  return NextResponse.json(
    { error: "Daily briefing generation is not supported in this Mission Control release." },
    { status: 410 },
  );
}
