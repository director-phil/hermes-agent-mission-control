/**
 * Read the monitoring probe-engine SQLite snapshot for the Hermy HQ dashboard.
 *
 * The probe engine (a systemd service in the `hermes-mission-control` repo)
 * continuously probes internal + external services and writes results to
 * `~/.hermes/mission-control/monitoring.db`. This module opens that file
 * read-only (node:sqlite, WAL-safe) and returns a render-ready snapshot.
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
  url?: string;
  cadenceSeconds: number;
  group: ProbeGroup;
}

// Canonical registry. Keep in sync with:
//   hermes-mission-control/apps/web/lib/monitoring/config.ts
const PROBES: ProbeDef[] = [
  // internal
  { id: "gb10-seat-1", name: "GB10 #1 model seat", kind: "loopback-http", target: "http://gb10-box-1:1234/v1/models", cadenceSeconds: 30, group: "internal" },
  { id: "gb10-seat-2", name: "GB10 #2 model seat", kind: "loopback-http", target: "http://gb10-box-2:1234/v1/models", cadenceSeconds: 30, group: "internal" },
  { id: "hermes-admission", name: "Hermes admission gateway", kind: "loopback-http", target: "http://127.0.0.1:19875/healthz", cadenceSeconds: 30, group: "internal" },
  { id: "qdrant", name: "Qdrant vector DB", kind: "loopback-http", target: "http://127.0.0.1:6333/collections", cadenceSeconds: 30, group: "internal" },
  { id: "goal-conveyor", name: "Goal conveyor", kind: "local-file", target: "/home/phillip_downs/ChatDev/goals/state/queue-runner-status.json", cadenceSeconds: 30, group: "internal" },
  { id: "checkcle", name: "CheckCle monitor", kind: "loopback-http", target: "http://127.0.0.1:8091/", url: "https://gb10-coder.taile151d3.ts.net:8091", cadenceSeconds: 60, group: "internal" },
  { id: "hermes-host", name: "Hermes host", kind: "server", target: "local", cadenceSeconds: 60, group: "internal" },
  // external — RT plane
  { id: "rt-dashboard", name: "RT dashboard", kind: "http", target: "https://dashboards.reliabletradies.app/", cadenceSeconds: 60, group: "external" },
  { id: "rt-login", name: "RT login", kind: "http", target: "https://login.reliabletradies.app/", cadenceSeconds: 60, group: "external" },
  { id: "rt-api-health", name: "RT API health", kind: "http", target: "https://dashboards.reliabletradies.app/api/health", cadenceSeconds: 60, group: "external" },
  { id: "rt-page-sweep", name: "RT pages (all routes)", kind: "page-sweep", target: "https://dashboards.reliabletradies.app", cadenceSeconds: 300, group: "external" },
  { id: "supabase-rest", name: "Supabase REST", kind: "http", target: "https://erakxiolnoigptfemedv.supabase.co/rest/v1/", cadenceSeconds: 60, group: "external" },
  { id: "supabase-auth", name: "Supabase auth", kind: "http", target: "https://erakxiolnoigptfemedv.supabase.co/auth/v1/health", cadenceSeconds: 60, group: "external" },
  { id: "servicetitan-api", name: "ServiceTitan API", kind: "http", target: "https://api.servicetitan.io/", cadenceSeconds: 300, group: "external" },
  { id: "xero-api", name: "Xero API", kind: "http", target: "https://api.xero.com/", cadenceSeconds: 300, group: "external" },
  // external — Vercel
  { id: "vercel-platform", name: "Vercel platform", kind: "http", target: "https://www.vercel-status.com/api/v2/status.json", cadenceSeconds: 300, group: "external" },
  { id: "vercel-deploy", name: "Vercel latest deploy", kind: "vercel-deploy", target: "reliable-tradies-ops-v2", cadenceSeconds: 300, group: "external" },
  // external — SSL
  { id: "rt-dashboard-ssl", name: "RT dashboard SSL", kind: "ssl", target: "dashboards.reliabletradies.app", cadenceSeconds: 21600, group: "external" },
  { id: "rt-login-ssl", name: "RT login SSL", kind: "ssl", target: "login.reliabletradies.app", cadenceSeconds: 21600, group: "external" },
];

const DB_PATH = process.env.MONITORING_DB_PATH ?? join(homedir(), ".hermes", "mission-control", "monitoring.db");
const CHECKCLE_DB_PATH = process.env.CHECKCLE_DB_PATH ?? "/opt/checkcle_pb_data/data.db";

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
  resolved_ts: string | null;
  state: string;
  last_status: ProbeStatus;
  last_error: string | null;
}

export interface Maintenance {
  id: number;
  probe_id: string;
  note: string | null;
  created_ts: string;
  active: number;
}

export interface ServiceStatus {
  probe: ProbeDef;
  latest: LatestResult | null;
  uptimePct24h: number | null;
  uptimePct7d: number | null;
  uptimePct30d: number | null;
  incident: Incident | null;
  maintenance: Maintenance | null;
  /** For `page-sweep` probes: parsed per-route breakdown from the metric JSON. */
  pageSweep?: PageSweepResult | null;
}

export interface PageSweepRoute {
  path: string;
  http: number | null;
  ms: number;
  status: ProbeStatus;
}

export interface PageSweepResult {
  total: number;
  up: number;
  degraded: number;
  down: number;
  routes: PageSweepRoute[];
}

export interface MonitoringSnapshot {
  generated_ts: string;
  global_status: "healthy" | "warning" | "critical";
  services: ServiceStatus[];
  open_incidents: Incident[];
  recent_incidents: Incident[];
  total: number;
  up: number;
  degraded: number;
  down: number;
  /** CheckCle (independent external monitor) services + status page, read from its PocketBase SQLite. */
  checkcle?: CheckCleSnapshot | null;
}

export interface CheckCleService {
  name: string;
  status: string;
  service_type: string;
  response_time: number | null;
  url: string | null;
  last_checked: string | null;
}

export interface CheckCleSnapshot {
  services: CheckCleService[];
  page: { title: string; slug: string; is_public: string; status: string } | null;
}

function pct(db: DatabaseSync, probeId: string, windowMs: number): number | null {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status != 'down' THEN 1 ELSE 0 END) AS ok
       FROM probe_results WHERE probe_id = ? AND ts >= ?`,
    )
    .get(probeId, since) as { total: number; ok: number } | undefined;
  if (!row || !row.total) return null;
  return Math.round((row.ok / row.total) * 1000) / 10;
}

function parseSweep(metric: string | null): PageSweepResult | null {
  if (!metric) return null;
  try {
    const m = JSON.parse(metric) as PageSweepResult;
    return Array.isArray(m.routes) ? m : null;
  } catch {
    return null;
  }
}

/**
 * Read CheckCle's PocketBase SQLite directly (read-only) so its independent
 * per-service status can be surfaced alongside the native probes in one board.
 * Returns null when CheckCle isn't running or its DB is unreadable.
 */
function readCheckCle(): CheckCleSnapshot | null {
  try {
    const db = new DatabaseSync(CHECKCLE_DB_PATH, { readOnly: true, timeout: 3000 });
    try {
      const services = db
        .prepare(
          `SELECT name, status, service_type, response_time, url, last_checked
           FROM services ORDER BY name`,
        )
        .all() as CheckCleService[];
      const page = db
        .prepare(`SELECT title, slug, is_public, status FROM operational_page LIMIT 1`)
        .get() as CheckCleSnapshot["page"];
      return { services, page };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function buildSnapshot(dbPath: string = DB_PATH): MonitoringSnapshot {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    const latestStmt = db.prepare(
      `SELECT ts, status, latency_ms, http_status, metric, error
       FROM probe_results WHERE probe_id = ? ORDER BY id DESC LIMIT 1`,
    );
    const incidentStmt = db.prepare(
      `SELECT id, probe_id, probe_name, opened_ts, resolved_ts, state, last_status, last_error
       FROM incidents WHERE probe_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1`,
    );
    const maintenanceStmt = db.prepare(
      `SELECT id, probe_id, note, created_ts, active
       FROM maintenance WHERE probe_id = ? AND active = 1 ORDER BY id DESC LIMIT 1`,
    );
    const openIncidentsStmt = db.prepare(
      `SELECT id, probe_id, probe_name, opened_ts, resolved_ts, state, last_status, last_error
       FROM incidents WHERE state = 'open' ORDER BY id DESC`,
    );
    const recentIncidentsStmt = db.prepare(
      `SELECT id, probe_id, probe_name, opened_ts, resolved_ts, state, last_status, last_error
       FROM incidents WHERE state = 'resolved' ORDER BY id DESC LIMIT 20`,
    );

    const services: ServiceStatus[] = PROBES.map((probe) => {
      const latest = (latestStmt.get(probe.id) as LatestResult | undefined) ?? null;
      const incident = (incidentStmt.get(probe.id) as Incident | undefined) ?? null;
      const maintenance = (maintenanceStmt.get(probe.id) as Maintenance | undefined) ?? null;
      const pageSweep = probe.kind === "page-sweep" ? parseSweep(latest?.metric ?? null) : undefined;
      return {
        probe,
        latest,
        uptimePct24h: pct(db, probe.id, 24 * 60 * 60 * 1000),
        uptimePct7d: pct(db, probe.id, 7 * 24 * 60 * 60 * 1000),
        uptimePct30d: pct(db, probe.id, 30 * 24 * 60 * 60 * 1000),
        incident,
        maintenance,
        pageSweep,
      };
    });

    const open_incidents = openIncidentsStmt.all() as Incident[];
    const recent_incidents = recentIncidentsStmt.all() as Incident[];
    const active = services.filter((s) => !s.maintenance);
    const up = active.filter((s) => s.latest?.status === "up").length;
    const degraded = active.filter((s) => s.latest?.status === "degraded").length;
    const down = active.filter((s) => s.latest?.status === "down").length;

    let global_status: MonitoringSnapshot["global_status"] = "healthy";
    if (down > 0) global_status = "critical";
    else if (degraded > 0 || active.some((s) => !s.latest)) global_status = "warning";

    return {
      generated_ts: new Date().toISOString(),
      global_status,
      services,
      open_incidents,
      recent_incidents,
      total: services.length,
      up,
      degraded,
      down,
      checkcle: readCheckCle(),
    };
  } finally {
    db.close();
  }
}

/**
 * Pause (active=true) or resume (active=false) monitoring for a probe.
 * Opens the DB read-write; the engine skips paused probes so no false incidents
 * are raised during planned maintenance.
 */
export function setMaintenance(probeId: string, active: boolean, note: string | null): void {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS maintenance (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         probe_id TEXT NOT NULL,
         note TEXT,
         created_ts TEXT NOT NULL,
         active INTEGER NOT NULL DEFAULT 1
       );
       CREATE INDEX IF NOT EXISTS idx_maintenance_probe ON maintenance (probe_id, active);`,
    );
    const ts = new Date().toISOString();
    db.prepare(`UPDATE maintenance SET active = 0 WHERE probe_id = ? AND active = 1`).run(probeId);
    if (active) {
      db.prepare(`INSERT INTO maintenance (probe_id, note, created_ts, active) VALUES (?, ?, ?, 1)`).run(probeId, note, ts);
    }
  } finally {
    db.close();
  }
}
