import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const take = Math.min(Number(new URL(req.url).searchParams.get("take") || 40), 100);
  const events = await prisma.agentEvent.findMany({ orderBy: { createdAt: "desc" }, take });
  return NextResponse.json({ events });
}
