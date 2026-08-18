import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const WEBHOOK_SECRET = process.env.CONVEYOR_WEBHOOK_SECRET || process.env.INTERNAL_API_SECRET || "";

type WebhookPayload = {
  goal_id: string;
  goal_title?: string;
  event: "started" | "gate_pass" | "gate_fail" | "repair" | "done" | "failed" | "restaged";
  rung?: number;
  attempt?: number;
  kind?: string;
  detail?: string;
  model?: string;
  wall_sec?: number;
  recoverable?: boolean;
  pr_url?: string;
  failures?: Array<{ cmd?: string; out?: string }>;
};

export async function POST(req: Request) {
  // Auth check
  const secret = req.headers.get("x-webhook-secret") || req.headers.get("x-internal-secret");
  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload.goal_id || !payload.event) {
    return NextResponse.json({ error: "goal_id and event are required" }, { status: 400 });
  }

  // Classify recoverability
  const recoverable = payload.recoverable ?? classifyRecoverable(payload);

  // Write the event
  const event = await prisma.conveyorEvent.create({
    data: {
      goalId: payload.goal_id,
      goalTitle: payload.goal_title,
      event: payload.event,
      rung: payload.rung,
      attempt: payload.attempt,
      kind: payload.kind,
      detail: truncate(payload.detail, 4000),
      model: payload.model,
      wallSec: payload.wall_sec,
      recoverable,
      prUrl: payload.pr_url,
    },
  });

  // Also mirror to AgentEvent for the dashboard activity feed
  await prisma.agentEvent.create({
    data: {
      kind: "run",
      title: `${payload.event}: ${payload.goal_id}`,
      detail: payload.kind
        ? `${payload.kind} at rung ${payload.rung ?? "?"} (${payload.model ?? "unknown"})`
        : undefined,
      agent: "conveyor",
      level: payload.event === "done" ? "up" : payload.event === "failed" ? "down" : "info",
      meta: {
        goalId: payload.goal_id,
        event: payload.event,
        rung: payload.rung,
        kind: payload.kind,
        recoverable,
        wallSec: payload.wall_sec,
      },
    },
  });

  return NextResponse.json({ ok: true, event_id: event.id, recoverable });
}

function classifyRecoverable(p: WebhookPayload): boolean {
  if (p.event !== "failed") return false;
  // Non-recoverable: needs_reconciliation (PR already shipped), hard_stop
  if (p.kind === "needs_reconciliation") return false;
  if (p.kind === "hard_stop") return false;
  // Recoverable: context_gap, scope_violation (fixable), no_diff, timeout, tsc errors
  return true;
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) : s;
}
