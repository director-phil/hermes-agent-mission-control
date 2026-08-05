"use client";

/* ───────────────────────────────────────────────────────────
   Hermy HQ · Approval inbox
   "Everything that needs your tap" queue.
   Self-contained: polls /api/hermes/requests as a read-only queue.
   ─────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from "react";
import { Check, Inbox } from "lucide-react";
import {
  Panel,
  Pill,
  EmptyState,
  Eyebrow,
} from "@/components/ui/kit";

// ── Types ─────────────────────────────────────────────────
interface Req {
  id: string;
  origin: string;
  kind: string;
  title: string;
  prompt: string | null;
  sideEffecting: boolean;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────
function timeAgo(d: string | null): string {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ── Card ──────────────────────────────────────────────────
function InboxCard({
  req,
  compact,
}: {
  req: Req;
  compact: boolean;
}) {
  const pad = compact ? "p-4" : "p-5";

  return (
    <Panel className={pad}>
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone="neutral">{req.kind}</Pill>
          {req.sideEffecting && <Pill tone="warn">side-effecting</Pill>}
        </div>
        <span className="num text-[10.5px] text-[var(--text-3)] shrink-0 mt-1">
          {timeAgo(req.createdAt)}
        </span>
      </div>

      <h3 className="text-[15px] font-medium text-[var(--text)] leading-snug">
        {req.title}
      </h3>
      {req.prompt && (
        <p className="mt-1.5 text-[13px] text-[var(--text-2)] leading-snug line-clamp-2">
          {req.prompt}
        </p>
      )}

      <p className="mt-4 text-[12px] text-[var(--text-3)]">
        Approval actions are disabled on this read-only Mission Control surface.
      </p>
    </Panel>
  );
}

// ── Main ──────────────────────────────────────────────────
export function ApprovalInbox({ compact = false }: { compact?: boolean }) {
  const [requests, setRequests] = useState<Req[]>([]);
  const [pending, setPending] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const data = await getJSON<{ requests: Req[]; pending: number }>(
      "/api/hermes/requests?status=awaiting_approval&take=50"
    );
    if (data) {
      setRequests(data.requests ?? []);
      setPending(data.pending ?? data.requests?.length ?? 0);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    const firstLoad = setTimeout(() => {
      void load();
    }, 0);
    const iv = setInterval(load, 6000);
    return () => {
      clearTimeout(firstLoad);
      clearInterval(iv);
    };
  }, [load]);

  const count = pending || requests.length;
  const visible = compact ? requests.slice(0, 3) : requests;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <Eyebrow>Approval inbox</Eyebrow>
        <Pill tone={count > 0 ? "accent" : "neutral"}>
          {count} pending
        </Pill>
      </div>

      {loaded && requests.length === 0 ? (
        <Panel className="p-2">
          <EmptyState
            icon={<Check className="w-6 h-6" style={{ color: "var(--up)" }} />}
            title="Nothing needs you right now — you're clear."
            hint="Side-effecting work waiting on your call will land here."
          />
        </Panel>
      ) : requests.length === 0 ? (
        // pre-load: keep it calm, mirror empty framing
        <Panel className="p-2">
          <EmptyState
            icon={<Inbox className="w-6 h-6" />}
            title="Checking the queue…"
          />
        </Panel>
      ) : (
        <div className={`flex flex-col ${compact ? "gap-2.5" : "gap-4"}`}>
          {visible.map((req) => (
            <InboxCard
              key={req.id}
              req={req}
              compact={compact}
            />
          ))}
          {compact && count > 3 && (
            <a
              href="/hermes"
              className="inline-flex items-center gap-1 self-start text-[12.5px] font-medium transition-colors"
              style={{ color: "var(--accent)" }}
            >
              View all in Hermes →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
