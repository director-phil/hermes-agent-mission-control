import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseApiConveyorSnapshot,
  conveyorFallbackFromQueueStatus,
  conveyorFallbackFromRuns,
  chooseConveyorSnapshot,
  EMPTY_CONVEYOR_SNAPSHOT,
  isAuthoritativeConveyorSnapshot,
  refreshFreshAuthoritativeConveyorSnapshot,
  isUsableConveyorSnapshot,
  type ConveyorState,
  type QueueRunnerStatus,
  type RunConveyorSource,
} from "../src/lib/conveyor-state.ts";

/**
 * Tests for stale trace classification and self-heal logic.
 * Ensures that stale traces are not treated as active in reliability/self-heal logic.
 */

interface TraceRun {
  id: string;
  startTime: number;
  status: "running" | "completed" | "failed";
  liveController?: boolean;
}

function classifyTraceAsStale(run: TraceRun, now: number): boolean {
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  const ageMs = now - run.startTime;
  return ageMs > STALE_THRESHOLD_MS;
}

function isTraceRunning(run: TraceRun, isStale: boolean): boolean {
  if (isStale) return false;
  return run.status === "running";
}

test("Stale traces are correctly identified based on age", () => {
  const now = Date.now();
  const recentRun: TraceRun = {
    id: "recent",
    startTime: now - 5 * 60 * 1000, // 5 minutes ago
    status: "running",
  };
  const oldRun: TraceRun = {
    id: "old",
    startTime: now - 45 * 60 * 1000, // 45 minutes ago
    status: "running",
  };

  assert(!classifyTraceAsStale(recentRun, now), "Recent run should not be stale");
  assert(classifyTraceAsStale(oldRun, now), "Old run should be stale");
});

test("Stale traces are not counted as running for self-heal logic", () => {
  const now = Date.now();
  const staleRun: TraceRun = {
    id: "stale-but-marked-running",
    startTime: now - 45 * 60 * 1000, // 45 minutes ago
    status: "running",
  };

  const isStale = classifyTraceAsStale(staleRun, now);
  const running = isTraceRunning(staleRun, isStale);

  assert(isStale, "Trace should be classified as stale");
  assert(!running, "Stale trace should not be counted as running for self-heal");
});

test("Recent running traces are counted as active", () => {
  const now = Date.now();
  const activeRun: TraceRun = {
    id: "active",
    startTime: now - 10 * 60 * 1000, // 10 minutes ago
    status: "running",
  };

  const isStale = classifyTraceAsStale(activeRun, now);
  const running = isTraceRunning(activeRun, isStale);

  assert(!isStale, "Recent trace should not be stale");
  assert(running, "Recent running trace should be active");
});

test("Completed traces are not counted as running regardless of age", () => {
  const now = Date.now();
  const completedRecent: TraceRun = {
    id: "completed-recent",
    startTime: now - 5 * 60 * 1000, // 5 minutes ago
    status: "completed",
  };
  const completedOld: TraceRun = {
    id: "completed-old",
    startTime: now - 45 * 60 * 1000, // 45 minutes ago
    status: "completed",
  };

  const running1 = isTraceRunning(completedRecent, false);
  const running2 = isTraceRunning(completedOld, true);

  assert(!running1, "Completed recent trace should not be running");
  assert(!running2, "Completed old trace should not be running");
});

test("Failed traces are not counted as running", () => {
  const now = Date.now();
  const failedRun: TraceRun = {
    id: "failed",
    startTime: now - 10 * 60 * 1000,
    status: "failed",
  };

  const isStale = classifyTraceAsStale(failedRun, now);
  const running = isTraceRunning(failedRun, isStale);

  assert(!running, "Failed trace should not be running");
});

test("Live controller count excludes stale instances", () => {
  const now = Date.now();
  const runs: Array<TraceRun & { liveController?: boolean }> = [
    {
      id: "live-1",
      startTime: now - 5 * 60 * 1000, // 5 minutes ago - ACTIVE
      status: "running",
      liveController: true,
    },
    {
      id: "live-2",
      startTime: now - 10 * 60 * 1000, // 10 minutes ago - ACTIVE
      status: "running",
      liveController: true,
    },
    {
      id: "ghost-live",
      startTime: now - 50 * 60 * 1000, // 50 minutes ago - STALE
      status: "running",
      liveController: true,
    },
  ];

  const liveCount = runs.filter(
    (r) => r.liveController === true && !classifyTraceAsStale(r, now)
  ).length;

  assert.equal(liveCount, 2, "Should count 2 live controllers (excluding stale)");
});

test("Ghost trace count tracks only stale runs", () => {
  const now = Date.now();
  const runs: TraceRun[] = [
    {
      id: "recent-1",
      startTime: now - 5 * 60 * 1000,
      status: "running",
    },
    {
      id: "old-1",
      startTime: now - 45 * 60 * 1000,
      status: "running",
    },
    {
      id: "old-2",
      startTime: now - 60 * 60 * 1000,
      status: "running",
    },
    {
      id: "recent-2",
      startTime: now - 15 * 60 * 1000,
      status: "running",
    },
  ];

  const ghostCount = runs.filter((r) => classifyTraceAsStale(r, now)).length;
  assert.equal(ghostCount, 2, "Should identify 2 ghost (stale) traces");
});

test("Stale threshold is consistently applied", () => {
  const now = Date.now();
  const STALE_THRESHOLD_MS = 30 * 60 * 1000;

  // Exactly at threshold boundary
  const atThreshold: TraceRun = {
    id: "at-boundary",
    startTime: now - STALE_THRESHOLD_MS,
    status: "running",
  };

  // Just before threshold
  const beforeThreshold: TraceRun = {
    id: "before-boundary",
    startTime: now - STALE_THRESHOLD_MS + 1000,
    status: "running",
  };

  // Just after threshold
  const afterThreshold: TraceRun = {
    id: "after-boundary",
    startTime: now - STALE_THRESHOLD_MS - 1000,
    status: "running",
  };

  // At the boundary, > comparison should be false (not stale)
  assert(!classifyTraceAsStale(atThreshold, now), "At threshold should not be stale (boundary case)");
  assert(!classifyTraceAsStale(beforeThreshold, now), "Just before threshold should not be stale");
  assert(classifyTraceAsStale(afterThreshold, now), "Just after threshold should be stale");
});

test("Summary metrics are calculated correctly", () => {
  const now = Date.now();
  const runs: Array<TraceRun & { liveController?: boolean }> = [
    {
      id: "run-1",
      startTime: now - 5 * 60 * 1000,
      status: "running",
      liveController: true,
    },
    {
      id: "run-2",
      startTime: now - 45 * 60 * 1000,
      status: "running",
      liveController: true,
    },
    {
      id: "run-3",
      startTime: now - 10 * 60 * 1000,
      status: "completed",
      liveController: false,
    },
  ];

  const enriched = runs.map((r) => ({
    ...r,
    isStale: classifyTraceAsStale(r, now),
    traceRunning: isTraceRunning(r, classifyTraceAsStale(r, now)),
  }));

  const total = enriched.length;
  const liveController = enriched.filter((r) => r.liveController === true && !r.isStale).length;
  const ghost = enriched.filter((r) => r.isStale).length;
  const traceRunning = enriched.filter((r) => r.traceRunning).length;

  assert.equal(total, 3, "Total should be 3");
  assert.equal(liveController, 1, "Live controller should be 1 (run-1 is recent and marked)");
  assert.equal(ghost, 1, "Ghost should be 1 (run-2 is stale)");
  assert.equal(traceRunning, 1, "Trace running should be 1 (only run-1)");
});

const BASE_SYNCED_AT = "2026-08-20T00:00:00.000Z";
const BASE_NOW_MS = Date.parse(BASE_SYNCED_AT);

function syncedSnapshot(overrides: Partial<ConveyorState> = {}): ConveyorState {
  return {
    conveyorOn: true,
    controllerPids: [101],
    liveGoals: ["goal-live"],
    active: [
      {
        goalId: "goal-live",
        live: true,
        status: "running",
        rung: 2,
        attempts: 1,
        pr: null,
      },
    ],
    upNext: [],
    planRequired: [],
    blocked: [],
    counts: { active: 1, blocked: 0, up_next: 0 },
    focusPrefixes: [],
    message: "synced",
    boxes: [],
    statusAgeSec: 1,
    statusMissing: false,
    syncedAt: BASE_SYNCED_AT,
    ...overrides,
  };
}

const transientEmpty: ConveyorState = {
  conveyorOn: false,
  controllerPids: [],
  liveGoals: [],
  active: [],
  upNext: [],
  planRequired: [],
  blocked: [],
  counts: {},
  focusPrefixes: [],
  message: "",
  boxes: [],
  statusAgeSec: null,
  statusMissing: true,
  syncedAt: null,
};

test("authoritative next exactly 120s old is accepted", () => {
  const next = syncedSnapshot({ message: "boundary payload" });
  const chosen = chooseConveyorSnapshot({ current: null, next, runs: [], nowMs: BASE_NOW_MS + 120_000 });

  assert(chosen);
  assert.equal(refreshFreshAuthoritativeConveyorSnapshot(next, BASE_NOW_MS + 120_000)?.message, "boundary payload");
  assert.equal(chosen.message, "boundary payload");
  assert.equal(chosen.statusAgeSec, 120);
});

test("authoritative next 121s old is rejected", () => {
  const next = syncedSnapshot({ message: "stale authoritative payload" });

  assert.equal(refreshFreshAuthoritativeConveyorSnapshot(next, BASE_NOW_MS + 121_000), null);
  assert.equal(chooseConveyorSnapshot({ current: null, next, runs: [], nowMs: BASE_NOW_MS + 121_000 }), null);
});

test("stale authoritative next + fresh current retains current", () => {
  const current = syncedSnapshot({
    message: "fresh current",
    syncedAt: new Date(BASE_NOW_MS + 100_000).toISOString(),
  });
  const staleNext = syncedSnapshot({ message: "stale next" });

  const chosen = chooseConveyorSnapshot({ current, next: staleNext, runs: [], nowMs: BASE_NOW_MS + 121_000 });

  assert(chosen);
  assert.notEqual(chosen, current);
  assert.equal(chosen.message, "fresh current");
  assert.equal(chosen.statusAgeSec, 21);
});

test("stale authoritative next + expired current + live runs uses runs fallback", () => {
  const current = syncedSnapshot({ message: "expired current" });
  const staleNext = syncedSnapshot({ message: "stale next" });

  const chosen = chooseConveyorSnapshot({
    current,
    next: staleNext,
    runs: [
      {
        goal: "live-run",
        status: "running",
        attempts: 2,
        liveController: true,
      },
    ],
    nowMs: BASE_NOW_MS + 121_000,
  });

  assert(chosen);
  assert.equal(chosen.message, "fallback: inferred from /api/runs liveController");
  assert.equal(chosen.statusMissing, true);
  assert.deepEqual(chosen.liveGoals, ["live-run"]);
});

test("API selection falls back to queue when DataStore snapshot is stale", () => {
  const stalePayload = syncedSnapshot({ message: "stale DataStore" });
  const queueFallback = conveyorFallbackFromQueueStatus(
    {
      updated_at: 1787184091,
      conveyor_on: true,
      controller_pids: [222],
      active: ["queue-live"],
      active_detail: [{ goal_id: "queue-live", status: "running", rung: 1, attempts: 1 }],
      message: "queue status fallback",
    },
    1787184121,
  );

  assert(queueFallback);
  const chosen = chooseApiConveyorSnapshot({ payload: stalePayload, queueFallback, nowMs: BASE_NOW_MS + 121_000 });

  assert.equal(chosen, queueFallback);
  assert.equal(chosen.message, "queue status fallback");
  assert.deepEqual(chosen.liveGoals, ["queue-live"]);
});

test("API selection returns empty syncing payload when DataStore snapshot is stale and queue is missing", () => {
  const stalePayload = syncedSnapshot({ message: "stale DataStore" });

  const chosen = chooseApiConveyorSnapshot({ payload: stalePayload, queueFallback: null, nowMs: BASE_NOW_MS + 121_000 });

  assert.equal(chosen, EMPTY_CONVEYOR_SNAPSHOT);
  assert.equal(chosen.statusMissing, true);
  assert.equal(chosen.syncedAt, null);
  assert.deepEqual(chosen.active, []);
});

test("API selection returns empty syncing payload when DataStore and queue fallback are stale", () => {
  const stalePayload = syncedSnapshot({ message: "stale DataStore" });
  const staleQueueFallback = conveyorFallbackFromQueueStatus(
    {
      updated_at: 1787184000,
      conveyor_on: true,
      controller_pids: [222],
      active: ["old-queue-live"],
      active_detail: [{ goal_id: "old-queue-live", status: "running", rung: 1, attempts: 1 }],
      message: "stale queue status fallback",
    },
    1787184121,
  );

  assert.equal(staleQueueFallback, null);
  const chosen = chooseApiConveyorSnapshot({ payload: stalePayload, queueFallback: staleQueueFallback, nowMs: BASE_NOW_MS + 121_000 });

  assert.equal(chosen, EMPTY_CONVEYOR_SNAPSHOT);
  assert.equal(chosen.statusMissing, true);
  assert.equal(chosen.syncedAt, null);
  assert.deepEqual(chosen.active, []);
});

test("future-dated next + current valid -> retains and re-ages current", () => {
  const current = syncedSnapshot({ statusAgeSec: 0 });
  const futureNext = syncedSnapshot({
    message: "future payload",
    syncedAt: "2026-08-20T00:01:00.000Z",
  });

  assert.equal(isAuthoritativeConveyorSnapshot(futureNext), true);
  const chosen = chooseConveyorSnapshot({ current, next: futureNext, runs: [], nowMs: BASE_NOW_MS + 30_000 });

  assert(chosen);
  assert.notEqual(chosen, current);
  assert.equal(chosen.message, "synced");
  assert.equal(chosen.statusAgeSec, 30);
});

test("future-dated next + expired current + live runs -> runs fallback", () => {
  const current = syncedSnapshot({ statusAgeSec: 0 });
  const futureNext = syncedSnapshot({
    message: "future payload",
    syncedAt: "2026-08-20T00:03:00.000Z",
  });
  const chosen = chooseConveyorSnapshot({
    current,
    next: futureNext,
    runs: [
      {
        goal: "live-run",
        status: "running",
        attempts: 2,
        liveController: true,
      },
    ],
    nowMs: BASE_NOW_MS + 121_000,
  });

  assert(chosen);
  assert.equal(chosen.message, "fallback: inferred from /api/runs liveController");
  assert.equal(chosen.statusMissing, true);
  assert.deepEqual(chosen.liveGoals, ["live-run"]);
});

test("future-dated next + no other evidence -> null", () => {
  const futureNext = syncedSnapshot({
    message: "future payload",
    syncedAt: "2026-08-20T00:01:00.000Z",
  });

  assert.equal(chooseConveyorSnapshot({ current: null, next: futureNext, runs: [], nowMs: BASE_NOW_MS }), null);
});

test("API selection falls back to queue when DataStore snapshot is future-dated", () => {
  const futurePayload = syncedSnapshot({
    message: "future payload",
    syncedAt: "2026-08-20T00:01:00.000Z",
  });
  const queueFallback = conveyorFallbackFromQueueStatus(
    {
      updated_at: 1787184000,
      conveyor_on: true,
      controller_pids: [222],
      active: ["queue-live"],
      active_detail: [{ goal_id: "queue-live", status: "running", rung: 1, attempts: 1 }],
      message: "queue status fallback",
    },
    1787184030,
  );

  assert(queueFallback);
  const chosen = chooseApiConveyorSnapshot({ payload: futurePayload, queueFallback, nowMs: BASE_NOW_MS });

  assert.equal(chosen, queueFallback);
  assert.equal(chosen.message, "queue status fallback");
  assert.deepEqual(chosen.liveGoals, ["queue-live"]);
});

test("statusMissing true with syncedAt is usable but not authoritative and cannot replace current", () => {
  const current = syncedSnapshot();
  const missingStatus = syncedSnapshot({
    statusMissing: true,
    message: "fallback: inferred from /api/runs liveController",
  });

  assert.equal(isUsableConveyorSnapshot(missingStatus), true);
  assert.equal(isAuthoritativeConveyorSnapshot(missingStatus), false);
  const chosen = chooseConveyorSnapshot({ current, next: missingStatus, runs: [], nowMs: BASE_NOW_MS + 1_000 });
  assert(chosen);
  assert.equal(chosen.message, "synced");
  assert.equal(chosen.statusMissing, false);
});

test("invalid date string is rejected", () => {
  assert.equal(isUsableConveyorSnapshot(syncedSnapshot({ syncedAt: "not-a-date" })), false);
});

test("negative or NaN age and nonnumeric counts are rejected", () => {
  assert.equal(isUsableConveyorSnapshot(syncedSnapshot({ statusAgeSec: -1 })), false);
  assert.equal(isUsableConveyorSnapshot(syncedSnapshot({ statusAgeSec: Number.NaN })), false);
  assert.equal(isUsableConveyorSnapshot({ ...syncedSnapshot(), counts: { active: "1" } }), false);
  assert.equal(isUsableConveyorSnapshot(syncedSnapshot({ counts: { active: -1 } })), false);
  assert.equal(isUsableConveyorSnapshot(syncedSnapshot({ counts: { active: Number.NaN } })), false);
});

test("current good retained at 30s and returned copy has age 30", () => {
  const good = syncedSnapshot({ statusAgeSec: 0 });
  const chosen = chooseConveyorSnapshot({ current: good, next: transientEmpty, runs: [], nowMs: BASE_NOW_MS + 30_000 });

  assert(chosen);
  assert.notEqual(chosen, good);
  assert.equal(chosen.conveyorOn, true);
  assert.equal(chosen.statusAgeSec, 30);
});

test("initial transient + live runs fallback -> ON", () => {
  const runs: RunConveyorSource[] = [
    {
      goal: "live-run",
      status: "running",
      attempts: 2,
      liveController: true,
      rung: 3,
      shipped_pr: "https://example.test/pr/1",
    },
  ];

  const chosen = chooseConveyorSnapshot({ current: null, next: transientEmpty, runs, nowMs: BASE_NOW_MS + 5_000 });

  assert(chosen);
  assert.equal(chosen.conveyorOn, true);
  assert.deepEqual(chosen.liveGoals, ["live-run"]);
  assert.equal(chosen.active[0]?.live, true);
  assert.equal(chosen.statusMissing, true);
  assert.equal(chosen.statusAgeSec, 0);
  assert.equal(chosen.syncedAt, "2026-08-20T00:00:05.000Z");
  assert.equal(isUsableConveyorSnapshot(chosen), true);
  assert.equal(isAuthoritativeConveyorSnapshot(chosen), false);
});

test("runs fallback -> later transient retains fallback", () => {
  const current = conveyorFallbackFromRuns(
    [
      {
        goal: "live-run",
        status: "running",
        attempts: 1,
        liveController: true,
      },
    ],
    BASE_NOW_MS,
  );

  assert(current);
  const chosen = chooseConveyorSnapshot({ current, next: transientEmpty, runs: [], nowMs: BASE_NOW_MS + 30_000 });
  assert(chosen);
  assert.notEqual(chosen, current);
  assert.equal(chosen.statusMissing, true);
  assert.equal(chosen.statusAgeSec, 30);
});

test("initial transient + no fallback -> null/loading", () => {
  assert.equal(chooseConveyorSnapshot({ current: null, next: transientEmpty, runs: [], nowMs: BASE_NOW_MS }), null);
});

test("current expires at 121s with no live runs -> null", () => {
  const current = syncedSnapshot({ statusAgeSec: 0 });

  assert.equal(chooseConveyorSnapshot({ current, next: transientEmpty, runs: [], nowMs: BASE_NOW_MS + 121_000 }), null);
});

test("expired current + live runs -> fresh inferred ON", () => {
  const current = syncedSnapshot({ statusAgeSec: 0 });
  const chosen = chooseConveyorSnapshot({
    current,
    next: transientEmpty,
    runs: [
      {
        goal: "live-run",
        status: "running",
        attempts: 2,
        liveController: true,
      },
    ],
    nowMs: BASE_NOW_MS + 121_000,
  });

  assert(chosen);
  assert.equal(chosen.conveyorOn, true);
  assert.equal(chosen.statusMissing, true);
  assert.equal(chosen.statusAgeSec, 0);
  assert.equal(chosen.syncedAt, "2026-08-20T00:02:01.000Z");
  assert.deepEqual(chosen.liveGoals, ["live-run"]);
});

test("genuine OFF next replaces prior ON immediately", () => {
  const current = syncedSnapshot({ statusAgeSec: 0 });
  const off = syncedSnapshot({
    conveyorOn: false,
    controllerPids: [],
    liveGoals: [],
    active: [],
    counts: { active: 0 },
    message: "conveyor off",
    syncedAt: "2026-08-20T00:00:30.000Z",
  });

  assert.equal(isUsableConveyorSnapshot(off), true);
  assert.equal(isAuthoritativeConveyorSnapshot(off), true);
  const chosen = chooseConveyorSnapshot({ current, next: off, runs: [], nowMs: BASE_NOW_MS + 30_000 });
  assert(chosen);
  assert.notEqual(chosen, current);
  assert.equal(chosen.conveyorOn, false);
  assert.equal(chosen.message, "conveyor off");
  assert.equal(chosen.statusAgeSec, 0);
});

test("run fallback expires similarly", () => {
  const current = conveyorFallbackFromRuns(
    [
      {
        goal: "live-run",
        status: "running",
        attempts: 1,
        liveController: true,
      },
    ],
    BASE_NOW_MS,
  );

  assert(current);
  assert.equal(chooseConveyorSnapshot({ current, next: transientEmpty, runs: [], nowMs: BASE_NOW_MS + 121_000 }), null);
});

test("empty or partial queue status returns null", () => {
  assert.equal(conveyorFallbackFromQueueStatus({}), null);
  assert.equal(conveyorFallbackFromQueueStatus({ updated_at: 1787184000 }), null);
  assert.equal(
    conveyorFallbackFromQueueStatus({
      updated_at: 1787184000,
      conveyor_on: true,
      controller_pids: [],
      active: ["missing-detail"],
    }),
    null,
  );
  assert.equal(
    conveyorFallbackFromQueueStatus({
      updated_at: 1787184000,
      conveyor_on: true,
      controller_pids: [],
      active: ["missing-detail"],
      active_detail: [],
    }),
    null,
  );
});

test("invalid queue status timestamps return null", () => {
  assert.equal(
    conveyorFallbackFromQueueStatus({
      updated_at: 0,
      conveyor_on: false,
      controller_pids: [],
      active: [],
      active_detail: [],
    }),
    null,
  );
  assert.equal(
    conveyorFallbackFromQueueStatus({
      updated_at: Number.NaN,
      conveyor_on: false,
      controller_pids: [],
      active: [],
      active_detail: [],
    }),
    null,
  );
  assert.equal(
    conveyorFallbackFromQueueStatus(
      {
        updated_at: 1787184000,
        conveyor_on: false,
        controller_pids: [],
        active: [],
        active_detail: [],
      },
      1787183999,
    ),
    null,
  );
});

test("queue fallback exactly 120s old is accepted", () => {
  const fallback = conveyorFallbackFromQueueStatus(
    {
      updated_at: 1787184000,
      conveyor_on: true,
      controller_pids: [222],
      active: ["queue-live"],
      active_detail: [{ goal_id: "queue-live", status: "running", rung: 1, attempts: 1 }],
    },
    1787184120,
  );

  assert(fallback);
  assert.equal(fallback.statusAgeSec, 120);
  assert.equal(fallback.statusMissing, false);
  assert.deepEqual(fallback.liveGoals, ["queue-live"]);
});

test("queue fallback 121s old is rejected", () => {
  assert.equal(
    conveyorFallbackFromQueueStatus(
      {
        updated_at: 1787184000,
        conveyor_on: true,
        controller_pids: [222],
        active: ["queue-live"],
        active_detail: [{ goal_id: "queue-live", status: "running", rung: 1, attempts: 1 }],
      },
      1787184121,
    ),
    null,
  );
});

test("only running detail live in queue fallback", () => {
  const queueStatus: QueueRunnerStatus = {
    updated_at: 1787184000,
    conveyor_on: true,
    controller_pids: [222],
    active: ["live", "recover", "external", "null-status", "done"],
    active_detail: [
      { goal_id: "live", status: "running", rung: 1, attempts: 1 },
      { goal_id: "recover", status: "recovering", rung: 2, attempts: 3 },
      { goal_id: "external", status: "external_recovery", rung: 4, attempts: 2 },
      { goal_id: "null-status", status: null },
      { goal_id: "done", status: "completed" },
    ],
  };

  const fallback = conveyorFallbackFromQueueStatus(queueStatus, 1787184030);

  assert(fallback);
  assert.equal(fallback.conveyorOn, true);
  assert.equal(fallback.syncedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(fallback.statusAgeSec, 30);
  assert.equal(isAuthoritativeConveyorSnapshot(fallback), true);
  assert.deepEqual(fallback.liveGoals, ["live", "recover", "external"]);
  assert.deepEqual(
    fallback.active.map((item) => [item.goalId, item.live]),
    [
      ["live", true],
      ["recover", true],
      ["external", true],
      ["null-status", false],
      ["done", false],
    ],
  );
});

test("conveyorOn true when controller PID list is nonempty", () => {
  const fallback = conveyorFallbackFromQueueStatus(
    {
      updated_at: 1787184000,
      conveyor_on: false,
      controller_pids: [333],
      active: [],
      active_detail: [],
    },
    1787184030,
  );

  assert(fallback);
  assert.equal(fallback.conveyorOn, true);
});

test("malformed snapshots are rejected", () => {
  assert.equal(isUsableConveyorSnapshot({ conveyorOn: false, active: [] }), false);
  assert.equal(isUsableConveyorSnapshot({ ...transientEmpty, active: "bad" }), false);
});

test("runs fallback returns null when no live controller exists", () => {
  assert.equal(
    conveyorFallbackFromRuns([
      {
        goal: "not-live",
        status: "running",
        attempts: 1,
        liveController: false,
      },
    ]),
    null,
  );
});
