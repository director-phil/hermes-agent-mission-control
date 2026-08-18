#!/usr/bin/env node

/**
 * Production Verification Script for 7d Hard Non-Blocking Observability Endpoint
 * 
 * Verifies that /api/hermes/observability?window=7d always responds within 2s
 * (with 12s safety margin) without awaiting Langfuse, and returns valid contract payloads.
 * 
 * Usage:
 *   node scripts/verify-7d-hard-nonblocking.js [base_url]
 * 
 * Examples:
 *   node scripts/verify-7d-hard-nonblocking.js http://localhost:3000
 *   node scripts/verify-7d-hard-nonblocking.js https://hermes-mission-control.vercel.app
 */

const BASE_URL = process.argv[2] || "http://localhost:3000";
const TIMEOUT_MS = 12000; // 12s timeout as per task spec
const TARGET_MS = 2000;   // Target response time (7d must be <2s)
const ATTEMPTS = 5;

console.log(`\n${"=".repeat(80)}`);
console.log(`7D OBSERVABILITY ENDPOINT VERIFICATION`);
console.log(`${"=".repeat(80)}`);
console.log(`Base URL: ${BASE_URL}`);
console.log(`Timeout: ${TIMEOUT_MS}ms`);
console.log(`Target Response Time: <${TARGET_MS}ms`);
console.log(`Attempts: ${ATTEMPTS} calls per window`);
console.log(`${"=".repeat(80)}\n`);

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

/**
 * Verify single endpoint call
 */
async function verifyCall(window, attemptNum) {
  const url = `${BASE_URL}/api/hermes/observability?window=${window}`;
  const startTime = Date.now();
  
  try {
    const response = await fetchWithTimeout(url, TIMEOUT_MS);
    const elapsed = Date.now() - startTime;
    
    if (!response.ok) {
      return {
        success: false,
        elapsed,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }
    
    const data = await response.json();
    
    // Verify contract
    const hasSourceStatus = data.source && typeof data.source.status === "string";
    const hasRows = typeof data.source?.rows === "number";
    const isValidStatus = ["ok", "warning", "error", "partial"].includes(data.source?.status);
    
    return {
      success: response.ok && hasSourceStatus && hasRows && isValidStatus,
      elapsed,
      status: response.status,
      window,
      sourceStatus: data.source?.status,
      rows: data.source?.rows,
      message: data.source?.message,
      isPartial: data.isPartial || false,
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    return {
      success: false,
      elapsed,
      error: error.name === "AbortError" ? "TIMEOUT" : error.message,
    };
  }
}

/**
 * Format result row for table
 */
function formatResult(r) {
  if (!r.success) {
    return [
      "❌",
      r.elapsed,
      "FAILED",
      r.error || "Unknown",
    ];
  }
  
  const fastStatus = r.window === "7d" && r.elapsed <= TARGET_MS ? "✅ FAST" : r.elapsed > TARGET_MS ? "⚠️ SLOW" : "✅ OK";
  
  return [
    "✅",
    r.elapsed,
    r.status,
    `${r.sourceStatus}${r.isPartial ? " (partial)" : ""}`,
    r.rows,
    fastStatus,
  ];
}

/**
 * Run full verification suite
 */
async function runSuite() {
  const results = {
    "24h": [],
    "7d": [],
  };
  
  // Test 24h window
  console.log(`Testing 24h window (${ATTEMPTS} calls)...`);
  for (let i = 1; i <= ATTEMPTS; i++) {
    const result = await verifyCall("24h", i);
    results["24h"].push(result);
    
    const status = result.success ? "✅" : "❌";
    const elapsed = `${result.elapsed}ms`;
    const err = result.error ? ` - ${result.error}` : "";
    console.log(`  [${i}/${ATTEMPTS}] ${status} ${elapsed}${err}`);
  }
  
  console.log();
  
  // Test 7d window
  console.log(`Testing 7d window (${ATTEMPTS} calls)...`);
  for (let i = 1; i <= ATTEMPTS; i++) {
    const result = await verifyCall("7d", i);
    results["7d"].push(result);
    
    const status = result.success ? "✅" : "❌";
    const elapsed = `${result.elapsed}ms`;
    const err = result.error ? ` - ${result.error}` : "";
    const isFast = result.window === "7d" && result.elapsed <= TARGET_MS ? " [FAST]" : "";
    console.log(`  [${i}/${ATTEMPTS}] ${status} ${elapsed}${err}${isFast}`);
  }
  
  console.log();
  
  // Summary table
  console.log(`${"=".repeat(100)}`);
  console.log(`RESULTS SUMMARY`);
  console.log(`${"=".repeat(100)}`);
  
  const headers = ["Result", "Elapsed", "Status", "Source Status", "Rows", "Performance"];
  const rows = [];
  
  // 24h results
  rows.push(["--- 24h WINDOW ---", "", "", "", "", ""]);
  for (const r of results["24h"]) {
    rows.push(formatResult(r));
  }
  
  rows.push(["", "", "", "", "", ""]);
  
  // 7d results
  rows.push(["--- 7d WINDOW ---", "", "", "", "", ""]);
  for (const r of results["7d"]) {
    rows.push(formatResult(r));
  }
  
  // Print table with basic formatting
  const colWidths = [5, 10, 10, 20, 8, 15];
  console.log(headers.map((h, i) => h.padEnd(colWidths[i])).join(""));
  console.log("-".repeat(100));
  for (const row of rows) {
    if (!row[0]) {
      console.log("");
      continue;
    }
    const formatted = row.map((cell, i) => String(cell).padEnd(colWidths[i])).join("");
    console.log(formatted);
  }
  
  console.log(`${"=".repeat(100)}\n`);
  
  // Calculate stats
  const stats24h = {
    success: results["24h"].filter(r => r.success).length,
    avgTime: Math.round(results["24h"].reduce((s, r) => s + r.elapsed, 0) / ATTEMPTS),
    maxTime: Math.max(...results["24h"].map(r => r.elapsed)),
  };
  
  const stats7d = {
    success: results["7d"].filter(r => r.success).length,
    fastCount: results["7d"].filter(r => r.success && r.elapsed <= TARGET_MS).length,
    avgTime: Math.round(results["7d"].reduce((s, r) => s + r.elapsed, 0) / ATTEMPTS),
    maxTime: Math.max(...results["7d"].map(r => r.elapsed)),
  };
  
  // Print detailed results
  console.log("24h WINDOW STATS:");
  console.log(`  ✅ Success rate: ${stats24h.success}/${ATTEMPTS} (${Math.round(stats24h.success / ATTEMPTS * 100)}%)`);
  console.log(`  ⏱️  Average time: ${stats24h.avgTime}ms`);
  console.log(`  ⏱️  Max time: ${stats24h.maxTime}ms`);
  
  console.log("\n7d WINDOW STATS:");
  console.log(`  ✅ Success rate: ${stats7d.success}/${ATTEMPTS} (${Math.round(stats7d.success / ATTEMPTS * 100)}%)`);
  console.log(`  🚀 Fast responses (<${TARGET_MS}ms): ${stats7d.fastCount}/${ATTEMPTS} (${Math.round(stats7d.fastCount / ATTEMPTS * 100)}%)`);
  console.log(`  ⏱️  Average time: ${stats7d.avgTime}ms`);
  console.log(`  ⏱️  Max time: ${stats7d.maxTime}ms`);
  
  console.log(`\n${"=".repeat(80)}`);
  
  // Overall verdict
  const verdict24h = stats24h.success === ATTEMPTS;
  const verdict7d = stats7d.success === ATTEMPTS && stats7d.fastCount === ATTEMPTS;
  
  if (verdict24h && verdict7d) {
    console.log("✅ VERIFICATION PASSED: All requirements met");
    console.log(`   - 24h: ${stats24h.success}/${ATTEMPTS} success (avg ${stats24h.avgTime}ms)`);
    console.log(`   - 7d: ${stats7d.success}/${ATTEMPTS} success, ${stats7d.fastCount}/${ATTEMPTS} fast (avg ${stats7d.avgTime}ms)`);
    process.exit(0);
  } else {
    console.log("❌ VERIFICATION FAILED");
    if (!verdict24h) {
      console.log(`   - 24h: ${stats24h.success}/${ATTEMPTS} success (expected ${ATTEMPTS})`);
    }
    if (!verdict7d) {
      console.log(`   - 7d: ${stats7d.success}/${ATTEMPTS} success, ${stats7d.fastCount}/${ATTEMPTS} fast (expected ${ATTEMPTS} fast)`);
    }
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
