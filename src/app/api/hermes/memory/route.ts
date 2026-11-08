import { NextResponse } from "next/server";
import { requireInternalApiSecret } from "@/lib/internal-api-auth";
import { prisma } from "@/lib/prisma";

// GET ?q=&type=&status= → list/search wiki entries (mirrored by the bridge)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status") || "active";
  const where: Record<string, unknown> = {};
  if (status !== "all") where.status = status;
  if (type && type !== "all") where.type = type;
  if (q) where.OR = [
    { title: { contains: q, mode: "insensitive" } },
    { body: { contains: q, mode: "insensitive" } },
    { tags: { has: q.toLowerCase() } },
  ];
  const entries = await prisma.hermesMemory.findMany({ where, orderBy: { updatedAt: "desc" }, take: 300 });
  const all = await prisma.hermesMemory.findMany({ select: { type: true }, where: status === "all" ? {} : { status } });
  const typeCounts: Record<string, number> = {};
  for (const e of all) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  const lastSync = entries[0]?.syncedAt ?? null;
  return NextResponse.json({ entries, typeCounts, total: all.length, lastSync });
}

export async function POST(req: Request) {
  const unauthorized = requireInternalApiSecret(req);
  if (unauthorized) return unauthorized;

  const b = await req.json().catch(() => ({}));
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

  const row = await prisma.agentRequest.create({
    data: {
      origin: "web",
      kind: "memory.write",
      title: `Memory: ${title.slice(0, 180)}`,
      prompt: JSON.stringify(b),
      sideEffecting: false,
      status: "queued",
    },
  });
  return NextResponse.json({ request: row });
}
