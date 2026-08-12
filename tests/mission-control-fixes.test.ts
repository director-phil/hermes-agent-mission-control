import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { computeTabCounts, getRunLiveBadge, type RunIndex } from "../src/app/floor/page.tsx";
import { getJSON } from "../src/app/observability/page.tsx";

function run(overrides: Partial<RunIndex>): RunIndex {
  return {
    goal: overrides.goal ?? `goal-${overrides.status ?? "queued"}`,
    status: overrides.status ?? "queued",
    attempts: overrides.attempts ?? 1,
    liveController: overrides.liveController,
    traceRunning: overrides.traceRunning,
    rung: overrides.rung ?? null,
    specialist: overrides.specialist ?? null,
    shipped_pr: overrides.shipped_pr ?? null,
    preview_url: overrides.preview_url ?? null,
    lastActivity: overrides.lastActivity ?? "2026-08-12T00:00:00.000Z",
    nodeLabels: overrides.nodeLabels ?? [],
    filesTouched: overrides.filesTouched ?? 0,
  };
}

describe("Floor tab count logic", () => {
  test("computeTabCounts sums to total runs", () => {
    const runs = [
      run({ goal: "q1", status: "queued" }),
      run({ goal: "q2", status: "pending" }),
      run({ goal: "r1", status: "running" }),
      run({ goal: "d1", status: "done" }),
      run({ goal: "d2", status: "complete" }),
      run({ goal: "f1", status: "failed" }),
    ];

    const counts = computeTabCounts(runs);

    assert.equal(counts.queued + counts.running + counts.done + counts.failed, runs.length);
  });

  test("computeTabCounts filters canonical statuses correctly", () => {
    const runs = [
      run({ goal: "queued", status: "queued" }),
      run({ goal: "running", status: "running" }),
      run({ goal: "done", status: "done" }),
      run({ goal: "failed", status: "failed" }),
      run({ goal: "failed-error", status: "error" }),
    ];

    assert.deepEqual(computeTabCounts(runs), {
      queued: 1,
      running: 1,
      done: 1,
      failed: 2,
    });
  });
});

describe("Running badge semantics", () => {
  test("liveController=true shows live badge", () => {
    assert.deepEqual(getRunLiveBadge(run({ liveController: true })), {
      tone: "accent",
      label: "live",
    });
  });

  test("liveController=false shows seen badge even if traceRunning=true", () => {
    assert.deepEqual(getRunLiveBadge(run({ liveController: false, traceRunning: true })), {
      tone: "neutral",
      label: "seen",
    });
  });

  test("traceRunning=true alone does not show live badge", () => {
    assert.notEqual(getRunLiveBadge(run({ traceRunning: true })).label, "live");
  });
});

describe("Observability fetch resilience", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("stale data is returned on API error", async () => {
    const staleSnapshot = { totals: { totalTokens: 123 } };
    globalThis.fetch = async () => new Response(JSON.stringify(staleSnapshot), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-cache-age": "660000",
        "x-cache-stale": "1",
        "x-cache-error": "Langfuse timeout",
      },
    });

    const [data, error, dataAge, stale] = await getJSON<typeof staleSnapshot>("/api/hermes/observability?window=24h");

    assert.deepEqual(data, staleSnapshot);
    assert.equal(error, "Langfuse timeout");
    assert.equal(dataAge, 660000);
    assert.equal(stale, true);
  });

  test("error response can carry a last-good snapshot", async () => {
    const lastGoodSnapshot = { totals: { totalTokens: 456 } };
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "collector failed", lastGoodSnapshot }), {
      status: 502,
      headers: {
        "content-type": "application/json",
        "x-cache-age": "120000",
      },
    });

    const [data, error, dataAge, stale] = await getJSON<typeof lastGoodSnapshot>("/api/hermes/observability?window=7d");

    assert.deepEqual(data, lastGoodSnapshot);
    assert.equal(error, "collector failed");
    assert.equal(dataAge, 120000);
    assert.equal(stale, true);
  });

  test("fresh data shows no warning tuple", async () => {
    const freshSnapshot = { totals: { totalTokens: 789 } };
    globalThis.fetch = async () => new Response(JSON.stringify(freshSnapshot), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-cache-age": "3000",
      },
    });

    const [data, error, dataAge, stale] = await getJSON<typeof freshSnapshot>("/api/hermes/observability?window=24h");

    assert.deepEqual(data, freshSnapshot);
    assert.equal(error, null);
    assert.equal(dataAge, 3000);
    assert.equal(stale, false);
  });
});
