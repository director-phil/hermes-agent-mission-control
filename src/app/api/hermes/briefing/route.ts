import { NextResponse } from "next/server";
import { requireInternalApiSecret } from "@/lib/internal-api-auth";
import { prisma } from "@/lib/prisma";
import { readHermesBridgeHealth } from "@/lib/hermes-native-mirror";

export async function GET() {
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-briefing" } });
  return NextResponse.json(row?.data ?? { generatedAt: null, summary: null, sections: [] });
}

export async function POST(req: Request) {
  const unauthorized = requireInternalApiSecret(req);
  if (unauthorized) return unauthorized;

  const health = await readHermesBridgeHealth();
  if (!health.online) {
    return NextResponse.json({ error: "Hermes bridge is not online; brief generation is unavailable.", health }, { status: 503 });
  }

  const row = await prisma.agentRequest.create({
    data: {
      origin: "web",
      kind: "briefing.generate",
      title: "Daily brief",
      prompt: "Generate the Chief-of-Staff daily brief.",
      sideEffecting: false,
      status: "queued",
    },
  });
  return NextResponse.json({ request: row });
}
