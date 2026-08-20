import { CONVEYOR_SNAPSHOT_RETENTION_MS } from "./conveyor-state.ts";

/**
 * Extracts live goal IDs from a DataStore conveyor payload,
 * but ONLY if the payload's syncedAt is within CONVEYOR_SNAPSHOT_RETENTION_MS.
 *
 * This prevents stale DataStore snapshots (e.g. bridge dead for minutes/hours)
 * from marking dead goals as live in /api/runs.
 *
 * On Vercel or environments without local filesystem, this is the only check
 * available — the same retention window used by /api/conveyor applies.
 */
export function extractLiveGoalsFromConveyorPayload(
  payload: unknown,
  nowMs: number = Date.now(),
): Set<string> {
  if (!payload || typeof payload !== "object") return new Set();

  const record = payload as Record<string, unknown>;

  // Check freshness via syncedAt
  const syncedAt = record.syncedAt;
  if (typeof syncedAt !== "string") return new Set();

  const syncedAtMs = Date.parse(syncedAt);
  if (!Number.isFinite(syncedAtMs)) return new Set();

  const ageMs = nowMs - syncedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return new Set();
  if (ageMs > CONVEYOR_SNAPSHOT_RETENTION_MS) return new Set();

  // Payload is fresh — extract live goals
  const active = record.active;
  if (!Array.isArray(active)) return new Set();

  const liveGoals = new Set<string>();
  for (const item of active) {
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).live === true &&
      typeof (item as Record<string, unknown>).goalId === "string"
    ) {
      liveGoals.add((item as Record<string, unknown>).goalId as string);
    }
  }

  return liveGoals;
}
