/**
 * Read the monitoring probe-engine SQLite snapshot for the Hermy HQ dashboard.
 *
 * The probe engine (a systemd service in the `hermes-mission-control` repo)
 * continuously probes internal + external services and writes results to
 * `~/.hermes/mission-control/monitoring.db`. This module opens that file
 * read-only (better-sqlite3, WAL-safe) and returns a render-ready snapshot.
 */

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProbeStatus = "up" | "degraded" | "down";
export type ProbeGroup = "internal" | "external";

export interface ProbeDef {
  id: string;
  name: string;
  kind: string;
  target: string;
  cadenceSeconds: number;
  group: ProbeGroup;
}

// Canonical registry. Keep in sync with:
//   hermes-mission-control/apps/web/lib/monitoring/config.ts
const PROBES: ProbeDef[] = [
  { id: "gb10-seat-1", name: "GB10 #1 model seat", kind: "loopback-http", target: "http://gb10-box-1:1234/v1/models", cadenceSeconds: 30, group: "internal" },
  { id: "gb10-seat-2", name: "GB10 #2 model seat", kind: "loopback-http", target: "http://gb10-box-2:1234/v1/models", cadenceSeconds: 30, group: "internal" },
  { id: "hermes-admission", name: "Hermes admission", kind: "loopback-http", target: "http://127.0.0.1:19875/healthz", cadenceSeconds: 30, group: "internal" },
  { id: "qdrant", name: "Qdrant vector DB", kind: "loopback-http", target: "http://127.0.0.1:6333/collections", cadenceSeconds: 30, group: "internal" },
  { id: "goal-conveyor", name: "Goal conveyor", kind: "local-file", target: "/home/phillip_downs/ChatDev/goals/state/queue-runner-status.json", cadenceSeconds: 30, group: "internal" },
  { id: "rt-dashboard", name: "RT dashboard", kind: "http", target: "https://dashboards.reliabletradies.app/", cadenceSeconds: 60, group: "external" },
  { id: "rt-login", name: "RT login", kind: "http", target: "https://login.reliabletradies.app/", cadenceSeconds: 60, group: "external" },
  { id: "supabase-rest", name: "Supabase REST", kind: "http", target: "https://erakxiolnoigptfemedv.supabase.co/rest/v1/", cadenceSeconds: 60, group: "external" },
  { id: "rt-dashboard-ssl", name: "RT dashboard SSL", kind: "ssl", target: "dashboards.reliabletradies.app", cadenceSeconds: 21600, group: "external" },
];

const DB_PATH = process.env.MONITORING_DB_PATH ?? join(homedir(), ".hermes", "mission-control", "monitoring.db");

export interface LatestResult {
  ts: string;
  status: ProbeStatus;
  latency_ms: number | null;
  http_status: number | null;
  metric: string | null;
  error: string | null;
}

export interface Incident {
  id: number;
  probe_id: string;
  probe_name: string;
  opened_ts: string;
  state: string;
  last_status: ProbeStatus;
  last_error: string | null;
}

export interface ServiceStatus {
  probe: ProbeDef;
  latest: LatestResult | null;
  uptimePct24h: number | null;
  incident: Incident | null;
}

export interface MonitoringSnapshot {
  generated_ts: string;
  global_status: "healthy" | "warning" | "critical";
  services: ServiceStatus[];
  open_incidents: Incident[];
  total: number;
  up: number;
  degraded: number;
  down: number;
}

export function buildSnapshot(dbPath: string = DB_PATH): MonitoringSnapshot {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const latestStmt = db.prepare(
      `SELECT ts, status, latency_ms, http_status, metric, error
       FROM probe_results WHERE probe_id = ? ORDER BY id DESC LIMIT 1`,
    );
    const uptimeStmt = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status != 'down' THEN 1 ELSE 0 END) AS ok
       FROM probe_results WHERE probe_id = ? AND ts >= ?`,
    );
    const incidentStmt = db.prepare(
      `SELECT id, probe_id, probe_name, opened_ts, state, last_status, last_error
       FROM incidents WHERE probe_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1`,
    );
    const openIncidentsStmt = db.prepare(
      `SELECT id, probe_id, probe_name, opened_ts, state, last_status, last_error
       FROM incidents WHERE state = 'open' ORDER BY id DESC`,
    );

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const services: ServiceStatus[] = PROBES.map((probe) => {
      const latest = (latestStmt.get(probe.id) as LatestResult | undefined) ?? null;
      const uptimeRow = uptimeStmt.get(probe.id, since) as { total: number; ok: number } | undefined;
      const incident = (incidentStmt.get(probe.id) as Incident | undefined) ?? null;
      const uptimePct24h = uptimeRow && uptimeRow.total > 0 ? Math.round((uptimeRow.ok / uptimeRow.total) * 1000) / 10 : null;
      return { probe, latest, uptimePct24h, incident };
    });

    const open_incidents = openIncidentsStmt.all() as Incident[];
    const up = services.filter((s) => s.latest?.status === "up").length;
    const degraded = services.filter((s) => s.latest?.status === "degraded").length;
    const down = services.filter((s) => s.latest?.status === "down").length;

    let global_status: MonitoringSnapshot["global_status"] = "healthy";
    if (down > 0) global_status = "critical";
    else if (degraded > 0 || services.some((s) => !s.latest)) global_status = "warning";

    return {
      generated_ts: new Date().toISOString(),
      global_status,
      services,
      open_incidents,
      total: services.length,
      up,
      degraded,
      down,
    };
  } finally {
    db.close();
  }
}
