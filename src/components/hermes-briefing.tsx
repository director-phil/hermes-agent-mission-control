"use client";

/* ───────────────────────────────────────────────────────────
   Hermy HQ · Chief-of-Staff brief
   Renders Hermes' daily brief (GET /api/hermes/briefing) and live
   read-only status.
   ─────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from "react";
import { Sunrise, RefreshCw, ArrowUpRight } from "lucide-react";
import { Panel, Eyebrow, Button } from "@/components/ui/kit";

interface Section { label: string; items: string[] }
interface Briefing {
  generatedAt: string | null;
  greeting?: string | null;
  summary: string | null;
  sections?: Section[];
}

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), dy = Math.floor(diff / 86400000);
  if (dy > 0) return `${dy}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

// tone a section by its intent
function sectionTone(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("decision") || l.includes("approv")) return "var(--warn)";
  if (l.includes("ship") || l.includes("done") || l.includes("win")) return "var(--up)";
  if (l.includes("next") || l.includes("priorit")) return "var(--accent)";
  return "var(--text-3)";
}

export function HermesBriefing() {
  const [data, setData] = useState<Briefing | null>(null);
  const [pending, setPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [b, r] = await Promise.all([
        fetch("/api/hermes/briefing").then((x) => (x.ok ? x.json() : null)),
        fetch("/api/hermes/requests?status=awaiting_approval&take=1").then((x) => (x.ok ? x.json() : null)),
      ]);
      if (b) {
        setData(b);
      }
      if (r) setPending(r.pending ?? 0);
    } catch { /* ignore */ }
    setLoaded(true);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    const firstLoad = setTimeout(() => {
      void load();
    }, 0);
    const iv = setInterval(load, 20000);
    return () => {
      clearTimeout(firstLoad);
      clearInterval(iv);
    };
  }, [load]);

  const empty = !data || !data.generatedAt || !data.summary;

  return (
    <Panel className="p-6">
      <div className="flex items-center justify-between gap-4 mb-3">
        <div className="flex items-center gap-2.5">
          <Sunrise className="w-4 h-4 text-[var(--accent)]" />
          <Eyebrow>Chief of Staff</Eyebrow>
          {!empty && (
            <span className="num text-[11px] text-[var(--text-3)]">· {timeAgo(data!.generatedAt as string)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {pending > 0 && (
            <a href="/hermes" className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium num"
              style={{ color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--warn) 24%, transparent)" }}>
              {pending} need{pending === 1 ? "s" : ""} you <ArrowUpRight className="w-3 h-3" />
            </a>
          )}
          <Button variant="ghost" size="sm" onClick={load} disabled={refreshing}>
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {empty ? (
        <div className="py-6 text-center">
          <p className="text-[14px] text-[var(--text-2)]">
            {loaded ? "No brief yet." : "Loading…"}
          </p>
          {loaded && (
            <p className="mt-1 text-[12.5px] text-[var(--text-3)]">
              Briefing generation is disabled on this read-only Mission Control surface.
            </p>
          )}
        </div>
      ) : (
        <>
          {data!.greeting && (
            <p className="text-[15px] font-medium text-[var(--text)] mb-1.5">{data!.greeting}</p>
          )}
          <p className="text-[14px] leading-relaxed text-[var(--text-2)] max-w-[75ch]">{data!.summary}</p>

          {(data!.sections ?? []).length > 0 && (
            <div className="mt-6 grid sm:grid-cols-2 gap-x-8 gap-y-6">
              {data!.sections!.map((s, i) => (
                <div key={i}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: sectionTone(s.label) }} />
                    <Eyebrow className="!text-[9.5px]">{s.label}</Eyebrow>
                  </div>
                  <div>
                    {s.items.map((item, j) => (
                      <div key={j} className="flex gap-2.5 py-1.5 border-b border-[var(--line)] last:border-0">
                        <span className="text-[var(--text-4)] shrink-0 pt-0.5 text-[12px]">·</span>
                        <p className="flex-1 text-[13px] leading-snug text-[var(--text-2)]">{item}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
