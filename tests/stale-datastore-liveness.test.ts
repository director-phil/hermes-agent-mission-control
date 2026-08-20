import assert from "node:assert/strict";
import test from "node:test";
import {
  refreshFreshAuthoritativeConveyorSnapshot,
  CONVEYOR_SNAPSHOT_RETENTION_MS,
  type ConveyorState,
} from "../src/lib/conveyor-state.ts";
import {
  extractLiveGoalsFromConveyorPayload,
} from "../src/lib/runs-liveness.ts";

/**
 * Regression tests for the stale-DataStore-marks-dead-traces-live bug.
 *
 * Root cause: /api/runs reads hermes-conveyor from DataStore and trusts
 * its `active[].live` field unconditionally — even when the snapshot's
 * syncedAt is minutes/hours stale (bridge dead). This causes dead goals
 * to appear as "running" with live indicators on the dashboard.
 *
 * The fix extracts liveGoal resolution into a shared helper that applies
 * the same CONVEYOR_SNAPSHOT_RETENTION_MS staleness check used by
 * /api/conveyor.
 */

const BASE_SYNCED_AT = "2026-08-20T00:00:00.000Z";
const BASE_NOW_MS = Date.parse(BASE_SYNCED_AT);

function makeConveyorPayload(syncedAt: string, liveGoals: string[]) {
  return {
    conveyorOn: true,
    controllerPids: [101],
    liveGoals,
    active: liveGoals.map((g) => ({
      goalId: g,
      live: true,
      status: "running",
      rung: 2,
      attempts: 1,
      pr: null,
    })),
    upNext: [],
    planRequired: [],
    blocked: [],
    counts: { active: liveGoals.length, blocked: 0, up_next: 0 },
    focusPrefixes: [],
    message: "synced",
    boxes: [],
    statusAgeSec: 1,
    statusMissing: false,
    syncedAt,
  } satisfies ConveyorState;
}

// ─── Core regression: stale DataStore must NOT yield live goals ───

test("REGRESSION: stale DataStore conveyor payload must return zero live goals", () => {
  // Payload synced 5 minutes ago — well past 120s retention
  const stalePayload = makeConveyorPayload(
    new Date(BASE_NOW_MS - 5 * 60 * 1000).toISOString(),
    ["goal-alpha", "goal-beta"],
  );
  const nowMs = BASE_NOW_MS;

  // Confirm the snapshot IS stale according to the conveyor staleness logic
  assert.equal(
    refreshFreshAuthoritativeConveyorSnapshot(stalePayload, nowMs),
    null,
    "Payload should be rejected as stale by conveyor logic",
  );

  // The runs-liveness helper must also reject it
  const liveGoals = extractLiveGoalsFromConveyorPayload(stalePayload, nowMs);
  assert.equal(liveGoals.size, 0, "Stale DataStore must yield zero live goals");
});

test("REGRESSION: stale DataStore must not mark dead traces as running", () => {
  // Simulates: bridge died 10 minutes ago, DataStore still has old snapshot
  const stalePayload = makeConveyorPayload(
    new Date(BASE_NOW_MS - 10 * 60 * 1000).toISOString(),
    ["dead-goal-1", "dead-goal-2"],
  );

  const liveGoals = extractLiveGoalsFromConveyorPayload(stalePayload, BASE_NOW_MS);
  assert.equal(liveGoals.size, 0, "Dead goals from stale snapshot must not appear live");

  // Simulate what enrichedRuns would do with these goals
  const mockRun = {
    goal: "dead-goal-1",
    status: "completed",
    lastActivity: new Date(BASE_NOW_MS - 15 * 60 * 1000).toISOString(),
    liveController: false,
    traceRunning: false,
  };

  const isLive = liveGoals.has(mockRun.goal);
  assert.equal(isLive, false, "Completed goal must not be marked live from stale data");
});

// ─── Fresh DataStore must still work ───

test("fresh DataStore conveyor payload returns correct live goals", () => {
  // Payload synced 30s ago — within 120s retention
  const freshPayload = makeConveyorPayload(
    new Date(BASE_NOW_MS - 30_000).toISOString(),
    ["goal-alpha"],
  );

  const liveGoals = extractLiveGoalsFromConveyorPayload(freshPayload, BASE_NOW_MS);
  assert.equal(liveGoals.size, 1, "Fresh payload should yield live goals");
  assert(liveGoals.has("goal-alpha"), "goal-alpha should be live");
});

test("DataStore at exact retention boundary (120s) is accepted", () => {
  const boundaryPayload = makeConveyorPayload(
    new Date(BASE_NOW_MS - CONVEYOR_SNAPSHOT_RETENTION_MS).toISOString(),
    ["goal-boundary"],
  );

  const liveGoals = extractLiveGoalsFromConveyorPayload(boundaryPayload, BASE_NOW_MS);
  assert.equal(liveGoals.size, 1, "At exact boundary should be accepted");
});

test("DataStore 1ms past retention boundary (120001ms) is rejected", () => {
  const pastPayload = makeConveyorPayload(
    new Date(BASE_NOW_MS - CONVEYOR_SNAPSHOT_RETENTION_MS - 1).toISOString(),
    ["goal-past"],
  );

  const liveGoals = extractLiveGoalsFromConveyorPayload(pastPayload, BASE_NOW_MS);
  assert.equal(liveGoals.size, 0, "1ms past boundary should be rejected");
});

// ─── Edge cases ───

test("null/undefined payload returns empty set", () => {
  assert.equal(extractLiveGoalsFromConveyorPayload(null, BASE_NOW_MS).size, 0);
  assert.equal(extractLiveGoalsFromConveyorPayload(undefined, BASE_NOW_MS).size, 0);
});

test("payload without syncedAt returns empty set", () => {
  const noSync = { active: [{ goalId: "g1", live: true }] };
  assert.equal(extractLiveGoalsFromConveyorPayload(noSync, BASE_NOW_MS).size, 0);
});

test("payload with active items where live=false are excluded", () => {
  const payload = makeConveyorPayload(
    new Date(BASE_NOW_MS - 30_000).toISOString(),
    [],
  );
  // Add a non-live active item manually
  (payload as any).active = [{ goalId: "not-live", live: false, status: "completed", rung: null, attempts: 1, pr: null }];

  const liveGoals = extractLiveGoalsFromConveyorPayload(payload, BASE_NOW_MS);
  assert.equal(liveGoals.size, 0, "Non-live active items should not appear");
});

test("payload without statusMissing field still works via syncedAt check", () => {
  const payload = makeConveyorPayload(
    new Date(BASE_NOW_MS - 30_000).toISOString(),
    ["goal-x"],
  );
  // Remove statusMissing — the function should still work based on syncedAt
  delete (payload as any).statusMissing;

  const liveGoals = extractLiveGoalsFromConveyorPayload(payload, BASE_NOW_MS);
  // Should still work because we check syncedAt freshness
  assert.equal(liveGoals.size, 1);
});
