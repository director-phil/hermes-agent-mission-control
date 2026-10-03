import { buildSnapshot } from "@/lib/monitoring";
import type { ProbeStatus } from "@/lib/monitoring";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DOT: Record<ProbeStatus, string> = {
  up: "#22c55e",
  degraded: "#f59e0b",
  down: "#ef4444",
};

export default function StatusPage() {
  const snap = buildSnapshot();
  const tone = snap.global_status === "critical" ? "#ef4444" : snap.global_status === "warning" ? "#f59e0b" : "#22c55e";
  const updated = new Date(snap.generated_ts).toLocaleTimeString("en-AU", { timeZone: "Australia/Brisbane" });

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2.5rem 1.5rem", fontFamily: "system-ui, -apple-system, sans-serif", color: "#0f172a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 14, height: 14, borderRadius: "50%", background: tone, display: "inline-block", flexShrink: 0 }} />
        <h1 style={{ fontSize: 22, fontWeight: 650, margin: 0, letterSpacing: "-0.01em" }}>Reliable Tradies — Service Status</h1>
      </div>
      <p style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
        {snap.up} of {snap.total} services operational · updated {updated} AEST
      </p>

      <div style={{ marginTop: 20, border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
        {snap.services.map((s, i) => {
          const paused = !!s.maintenance;
          const status = paused ? "paused" : (s.latest?.status ?? "down");
          const color = paused ? "#94a3b8" : (DOT[s.latest?.status ?? "down"] ?? "#94a3b8");
          const label = paused ? "paused" : status;
          return (
            <div
              key={s.probe.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                background: i % 2 ? "#f8fafc" : "#fff",
                borderTop: i ? "1px solid #f1f5f9" : "none",
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 550, fontSize: 14 }}>{s.probe.name}</div>
                <div style={{ color: "#94a3b8", fontSize: 11.5, fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.probe.target}
                </div>
              </div>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                <span style={{ color: "#64748b", fontSize: 12.5 }}>
                  {paused ? "—" : s.uptimePct24h != null ? `${s.uptimePct24h}% 24h` : "—"}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    padding: "2px 8px",
                    borderRadius: 999,
                    color: paused ? "#475569" : color,
                    background: `${color}1a`,
                  }}
                >
                  {label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 24 }}>
        Powered by Hermy HQ monitoring · probe engine snapshot
      </p>
    </main>
  );
}
