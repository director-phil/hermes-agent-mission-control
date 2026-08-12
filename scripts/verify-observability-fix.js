#!/usr/bin/env node

/**
 * Production verification script for observability endpoint fixes.
 * Simulates repeated browser origin fetches to verify robustness.
 */

const API_ORIGIN = "https://mission-control.reliabletradies.app";
const ENDPOINTS = [
  "/api/hermes/observability?window=24h",
  "/api/hermes/observability?window=7d",
  "/api/hermes/health",
  "/api/runs",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface TestResult {
  endpoint: string;
  attempt: number;
  status: number | string;
  corsHeaders: boolean;
  error: string | null;
  duration_ms: number;
}

async function fetchEndpoint(endpoint: string): Promise<TestResult> {
  const url = `${API_ORIGIN}${endpoint}`;
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const corsOrigin = response.headers.get("Access-Control-Allow-Origin");
    const hasCors = corsOrigin !== null;

    return {
      endpoint,
      attempt: 1,
      status: response.status,
      corsHeaders: hasCors,
      error: null,
      duration_ms: Date.now() - start,
    };
  } catch (error) {
    return {
      endpoint,
      attempt: 1,
      status: "ERROR",
      corsHeaders: false,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - start,
    };
  }
}

async function runTests() {
  console.log("🚀 Production Verification: Observability Endpoints");
  console.log(`📍 Origin: ${API_ORIGIN}`);
  console.log(`⏱️  Testing 5/5 success rate per endpoint\n`);

  const results: TestResult[] = [];

  for (const endpoint of ENDPOINTS) {
    console.log(`\n🔍 Testing ${endpoint}`);
    const endpointResults: TestResult[] = [];

    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await fetchEndpoint(endpoint);
      result.attempt = attempt;
      endpointResults.push(result);
      results.push(result);

      const statusIcon =
        result.status === 200 ? "✅" : result.status === 500 ? "⚠️" : "❌";
      console.log(
        `  ${statusIcon} Attempt ${attempt}: ${result.status} (${result.duration_ms}ms)`
      );

      if (!result.corsHeaders) {
        console.log(`     ⚠️  Missing CORS headers`);
      }
    }

    // Check success rate
    const successCount = endpointResults.filter(
      (r) => r.status === 200
    ).length;
    const corsCount = endpointResults.filter((r) => r.corsHeaders).length;

    console.log(
      `\n  📊 Summary: ${successCount}/5 successful, ${corsCount}/5 with CORS headers`
    );

    if (successCount < 5) {
      console.log(
        `  ❌ FAILED: Expected 5/5 success, got ${successCount}/5`
      );
    } else if (corsCount < 5) {
      console.log(
        `  ⚠️  WARNING: CORS headers missing on ${5 - corsCount} attempts`
      );
    } else {
      console.log(`  ✅ PASSED: 5/5 successful with CORS headers`);
    }
  }

  // Overall summary
  console.log("\n\n📈 Overall Results:");
  const totalAttempts = results.length;
  const successCount = results.filter((r) => r.status === 200).length;
  const corsCount = results.filter((r) => r.corsHeaders).length;
  const errorCount = results.filter((r) => r.status === "ERROR").length;

  console.log(`  Total attempts: ${totalAttempts}`);
  console.log(`  ✅ Success: ${successCount}/${totalAttempts}`);
  console.log(`  🔒 CORS headers: ${corsCount}/${totalAttempts}`);
  console.log(`  ❌ Errors: ${errorCount}/${totalAttempts}`);

  const successRate = (successCount / totalAttempts) * 100;
  console.log(`\n  Success rate: ${successRate.toFixed(1)}%`);

  if (successCount === totalAttempts && corsCount === totalAttempts) {
    console.log("\n✅ All checks passed! Endpoints are production-ready.");
    return 0;
  } else {
    console.log(
      "\n❌ Some checks failed. See details above."
    );
    return 1;
  }
}

// Run verification
runTests().then((code) => process.exit(code));
