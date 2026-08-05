import assert from "node:assert/strict";
import test from "node:test";
import {
  collectHermesObservability,
  LANGFUSE_OBSERVATION_FIELDS,
  parseObservabilityWindow,
} from "../src/lib/langfuse-observability";

const NOW = new Date("2026-08-05T12:00:00.000Z");

function setLangfuseEnv() {
  process.env.HERMES_LANGFUSE_BASE_URL = "https://langfuse.local";
  process.env.HERMES_LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.HERMES_LANGFUSE_SECRET_KEY = "sk-test";
}

test("collects paginated Langfuse observations into safe aggregates", async () => {
  setLangfuseEnv();
  const seenUrls: URL[] = [];
  const seenAuth: string[] = [];
  const quietSpanRows = Array.from({ length: 998 }, (_, index) => ({
    id: `quiet-span-${index}`,
    startTime: "2026-08-05T11:49:00.000Z",
    endTime: "2026-08-05T11:49:01.000Z",
    type: "SPAN",
    name: "workflow step",
    level: "DEFAULT",
    usageDetails: {},
    metadata: {
      tool_call_count: 0,
    },
  }));
  const pages = [
    {
      data: [
        {
          id: "obs-gen-1",
          traceId: "trace-1",
          sessionId: "session-1",
          startTime: "2026-08-05T11:50:00.000Z",
          endTime: "2026-08-05T11:50:02.000Z",
          type: "GENERATION",
          name: "generation",
          level: "DEFAULT",
          providedModelName: "gpt-5",
          usageDetails: {
            input: "1000",
            output: 200,
            total: "1200",
            cache_read_input_tokens: "50",
            cache_creation_input_tokens: null,
          },
          totalCost: "0.12",
          metadata: {
            provider: "openai",
            platform: "codex",
            tool_call_count: "2",
            tool_name: "should-not-count",
            prompt: "must not be returned",
          },
        },
        {
          id: "obs-tool-1",
          parentObservationId: "obs-gen-1",
          traceId: "trace-1",
          sessionId: "session-1",
          startTime: "2026-08-05T11:50:03.000Z",
          endTime: "2026-08-05T11:50:04.000Z",
          type: "TOOL",
          name: "web.run",
          level: "DEFAULT",
          usageDetails: {},
          metadata: {
            tool_name: "web.run",
            args: "must not be returned",
          },
        },
        ...quietSpanRows,
      ],
      meta: { cursor: "page-2" },
    },
    {
      data: [
        {
          id: "obs-gen-2",
          traceId: "trace-2",
          startTime: "2026-08-05T11:55:00.000Z",
          endTime: "2026-08-05T11:55:01.000Z",
          type: "GENERATION",
          name: "generation",
          level: "ERROR",
          statusMessage: "model failed",
          model: "claude-sonnet-4.5",
          usageDetails: {
            input: null,
            output: "0",
          },
          costDetails: {
            total: "0.03",
          },
          metadata: {
            provider: "anthropic",
            platform: "server",
          },
        },
        {
          id: "obs-tool-2",
          traceId: "trace-1",
          sessionId: "session-1",
          startTime: "2026-08-05T11:50:05.000Z",
          endTime: "2026-08-05T11:50:06.000Z",
          type: "TOOL",
          name: "web.run",
          level: "DEFAULT",
          metadata: {
            tool_name: "web.run",
          },
        },
        {
          id: "obs-span-tool-1",
          traceId: "trace-1",
          sessionId: "session-1",
          startTime: "2026-08-05T11:50:07.000Z",
          endTime: "2026-08-05T11:50:08.000Z",
          type: "SPAN",
          name: "agent step",
          level: "DEFAULT",
          metadata: {
            tool_name: "browser.search",
            tool_call_id: "call-safe",
            args: "must not be returned",
          },
        },
        {
          id: "obs-event-tool-1",
          traceId: "trace-1",
          sessionId: "session-1",
          startTime: "2026-08-05T11:50:09.000Z",
          endTime: "2026-08-05T11:50:10.000Z",
          type: "EVENT",
          name: "tool:memory.lookup",
          level: "DEFAULT",
          metadata: {
            tool_call_count: "2",
            args: "must not be returned",
          },
        },
      ],
    },
  ];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seenUrls.push(url);
    const headers = init?.headers;
    if (headers instanceof Headers) {
      seenAuth.push(String(headers.get("authorization") ?? ""));
    } else if (headers && !Array.isArray(headers)) {
      seenAuth.push(String((headers as Record<string, string>).Authorization ?? ""));
    } else {
      seenAuth.push("");
    }
    const page = pages[seenUrls.length - 1];
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await collectHermesObservability("24h", {
    now: NOW,
    fetchImpl,
  });

  assert.equal(seenUrls.length, 2);
  assert.equal(pages[0].data.length, 1000);
  assert.equal(seenUrls[0].pathname, "/api/public/v2/observations");
  assert.equal(seenUrls[0].searchParams.get("limit"), "1000");
  assert.equal(seenUrls[0].searchParams.get("fields"), LANGFUSE_OBSERVATION_FIELDS);
  assert.equal(seenUrls[0].searchParams.get("fields")?.includes("io"), false);
  assert.equal(seenUrls[0].searchParams.has("fromStartTime"), true);
  assert.equal(seenUrls[0].searchParams.has("toStartTime"), true);
  assert.equal(seenUrls[1].searchParams.get("cursor"), "page-2");
  assert.equal(seenAuth.every((header) => header.startsWith("Basic ")), true);

  assert.equal(result.source.status, "ok");
  assert.equal(result.source.pages, 2);
  assert.equal(result.source.rows, 1004);
  assert.equal(result.totals?.inputTokens, 1000);
  assert.equal(result.totals?.outputTokens, 200);
  assert.equal(result.totals?.totalTokens, 1200);
  assert.equal(result.totals?.cacheReadTokens, 50);
  assert.equal(result.totals?.cacheWriteTokens, 0);
  assert.equal(result.totals?.totalCost, 0.15);
  assert.equal(result.totals?.generationCalls, 2);
  assert.equal(result.totals?.toolCalls, 5);
  assert.equal(result.totals?.uniqueTraces, 2);
  assert.equal(result.totals?.uniqueSessions, 1);
  assert.equal(result.totals?.errors, 1);
  assert.equal(result.workflow?.message, "LangGraph traces not detected");
  assert.equal(result.workflow?.modelGenerations, 2);
  assert.equal(result.workflow?.toolCalls, 5);
  assert.equal(result.workflow?.parentEdges, 1);
  assert.equal(result.workflow?.observationTypes.GENERATION, 2);
  assert.equal(result.amplification?.inputOutputRatio, 5);
  assert.equal(result.amplification?.deterministicFlags.includes("input_output_ratio_high"), true);
  assert.equal(result.byProvider[0].provider, "openai");
  assert.equal(result.byProvider[0].modelClass, "cloud");

  assert.deepEqual(
    result.byModel.map((model) => [model.model, model.totalTokens, model.cost, model.provider]),
    [
      ["gpt-5", 1200, 0.12, "openai"],
      ["claude-sonnet-4.5", 0, 0.03, "anthropic"],
    ],
  );

  const session = result.sessions.find((row) => row.sessionId === "session-1");
  assert.equal(session?.traceId, "trace-1");
  assert.equal(session?.totalTokens, 1200);
  assert.equal(session?.toolCallCount, 5);
  assert.equal(session?.provider, "openai");
  assert.equal(session?.platform, "codex");
  assert.deepEqual(
    result.tools.recent.map((tool) => [tool.name, tool.count]),
    [
      ["memory.lookup", 2],
      ["browser.search", 1],
      ["web.run", 2],
    ],
  );
  assert.deepEqual(
    result.tools.repeated.map((tool) => [tool.name, tool.count]),
    [
      ["memory.lookup", 2],
      ["web.run", 2],
    ],
  );
  assert.equal(result.tools.recent.some((tool) => tool.name === "should-not-count"), false);
  assert.equal(result.wasteFlags.some((flag) => flag.kind === "largest_token_session"), true);
  assert.equal(result.wasteFlags.some((flag) => flag.kind === "high_input_output_ratio"), true);
  assert.equal(result.topLargeTraces[0].totalTokens, 1200);
  assert.equal(result.topExpensiveTraces[0].cost, 0.12);
  assert.equal(result.recommendations.some((item) => item.includes("LangGraph")), true);
  assert.equal(JSON.stringify(result).includes("must not be returned"), false);
});

test("separates reported, estimated, and effective costs without guessing unknown pricing", async () => {
  setLangfuseEnv();
  const page = {
    data: [
      {
        id: "opus-real",
        traceId: "trace-opus",
        sessionId: "session-opus",
        startTime: "2026-08-05T11:50:00.000Z",
        endTime: "2026-08-05T11:50:01.000Z",
        type: "GENERATION",
        providedModelName: "claude-opus-4-6",
        usageDetails: {
          input: 1_000_000,
          output: 100_000,
          total: 1_100_000,
          cache_read_input_tokens: 2_000_000,
          cache_creation_input_tokens: 3_000_000,
        },
        totalCost: "0.02",
        metadata: {
          provider: "anthropic",
          prompt: "raw content must not leak",
        },
      },
      {
        id: "local-qwen",
        traceId: "trace-local",
        startTime: "2026-08-05T11:51:00.000Z",
        type: "GENERATION",
        providedModelName: "qwen3-coder",
        usageDetails: {
          input: 10_000,
          output: 1_000,
          total: 11_000,
        },
        totalCost: "9",
        metadata: {
          provider: "custom",
          environment: "development",
        },
      },
      {
        id: "unknown-cloud",
        traceId: "trace-unknown",
        startTime: "2026-08-05T11:52:00.000Z",
        type: "GENERATION",
        providedModelName: "claude-future",
        usageDetails: {
          input: 1000,
          output: 100,
          total: 1100,
        },
        totalCost: "0.5",
        metadata: {
          provider: "anthropic",
        },
      },
      {
        id: "synthetic-env",
        traceId: "trace-test",
        startTime: "2026-08-05T11:53:00.000Z",
        type: "GENERATION",
        providedModelName: "claude-opus-4-6",
        usageDetails: {
          input: 9_000_000,
          output: 9_000_000,
          cache_creation_input_tokens: 9_000_000,
        },
        totalCost: "999",
        metadata: {
          provider: "anthropic",
          environment: "test",
        },
      },
      {
        id: "synthetic-provider",
        traceId: "trace-synthetic",
        startTime: "2026-08-05T11:54:00.000Z",
        type: "GENERATION",
        providedModelName: "fake-model",
        usageDetails: {
          input: 1_000_000,
          output: 1_000_000,
        },
        totalCost: "999",
        metadata: {
          provider: "synthetic",
        },
      },
    ],
  };
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const result = await collectHermesObservability("24h", {
    now: NOW,
    fetchImpl,
  });

  assert.equal(result.source.rows, 5);
  assert.equal(result.source.filteredRows, 2);
  assert.equal(result.source.includedRows, 3);
  assert.equal(result.totals?.reportedCost, 9.52);
  assert.equal(result.totals?.estimatedCost, 27.25);
  assert.equal(result.totals?.effectiveCost, 27.75);
  assert.equal(result.totals?.totalCost, 27.75);
  assert.equal(result.totals?.costBasis, "mixed");
  assert.equal(result.totals?.estimatedCostRange?.low, 27.25);
  assert.equal(result.totals?.estimatedCostRange?.high, 38.5);

  const opus = result.byModel.find((model) => model.model === "claude-opus-4-6");
  assert.equal(opus?.reportedCost, 0.02);
  assert.equal(opus?.estimatedCost, 27.25);
  assert.equal(opus?.effectiveCost, 27.25);
  assert.equal(opus?.costBasis, "anthropic_claude_opus_4_6_estimate_cache_write_5m_assumed");
  assert.equal(opus?.estimatedCostRange?.high, 38.5);
  assert.equal(opus?.cacheReadTokens, 2_000_000);
  assert.equal(opus?.cacheWriteTokens, 3_000_000);

  const local = result.byModel.find((model) => model.model === "qwen3-coder");
  assert.equal(local?.reportedCost, 9);
  assert.equal(local?.estimatedCost, 0);
  assert.equal(local?.effectiveCost, 0);
  assert.equal(local?.costBasis, "local_zero");

  const unknown = result.byModel.find((model) => model.model === "claude-future");
  assert.equal(unknown?.reportedCost, 0.5);
  assert.equal(unknown?.estimatedCost, null);
  assert.equal(unknown?.effectiveCost, 0.5);
  assert.equal(unknown?.costBasis, "reported_only_unknown_cloud");

  assert.equal(result.topExpensiveTraces[0].traceId, "trace-opus");
  assert.equal(result.topExpensiveTraces[0].reportedCost, 0.02);
  assert.equal(result.topExpensiveTraces[0].effectiveCost, 27.25);
  assert.equal(result.byProvider.find((provider) => provider.provider === "custom")?.effectiveCost, 0);
  assert.equal(JSON.stringify(result).includes("raw content must not leak"), false);
  assert.equal(JSON.stringify(result).includes("trace-test"), false);
  assert.equal(JSON.stringify(result).includes("trace-synthetic"), false);
});

test("returns failure health without fake totals when Langfuse fails", async () => {
  setLangfuseEnv();
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "nope" }), { status: 500 });

  const result = await collectHermesObservability("7d", {
    now: NOW,
    fetchImpl,
  });

  assert.equal(result.source.status, "error");
  assert.equal(result.source.message, "Langfuse unavailable");
  assert.equal(result.totals, null);
  assert.deepEqual(result.byModel, []);
  assert.deepEqual(result.byProvider, []);
  assert.equal(result.workflow, null);
  assert.equal(result.amplification, null);
  assert.deepEqual(result.recommendations, []);
  assert.equal(JSON.stringify(result).includes("sk-test"), false);
  assert.equal(JSON.stringify(result).includes("pk-test"), false);
});

test("validates supported observability windows", () => {
  assert.equal(parseObservabilityWindow("24h"), "24h");
  assert.equal(parseObservabilityWindow("7d"), "7d");
  assert.equal(parseObservabilityWindow("30d"), null);
  assert.equal(parseObservabilityWindow(null), null);
});
