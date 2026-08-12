#!/bin/bash
# Verification script for observability endpoint production fixes
# Run from browser console at: https://mission-control.reliabletradies.app

echo "📋 Observability Endpoint Production Verification"
echo "=================================================="
echo ""
echo "Commit: 57628a5ff46a8f6e2f0547b65077fb31d00c91ea"
echo "Branch: main"
echo "Date: 2026-08-12"
echo ""
echo "Run the following commands in your browser console (F12):"
echo "=================================================="
echo ""

cat << 'EOF'
// Test 1: /api/hermes/observability?window=24h (5x)
console.log("🔍 Testing /api/hermes/observability?window=24h");
for (let i = 1; i <= 5; i++) {
  (async () => {
    const r = await fetch('/api/hermes/observability?window=24h');
    const cors = r.headers.get('Access-Control-Allow-Origin');
    const status = r.status;
    const data = await r.json();
    console.log(`  Attempt ${i}: ${status} ${cors ? '✅ CORS' : '❌ NO CORS'}`);
  })();
}

// Test 2: /api/hermes/observability?window=7d (5x)
console.log("🔍 Testing /api/hermes/observability?window=7d");
for (let i = 1; i <= 5; i++) {
  (async () => {
    const r = await fetch('/api/hermes/observability?window=7d');
    const cors = r.headers.get('Access-Control-Allow-Origin');
    const status = r.status;
    const data = await r.json();
    console.log(`  Attempt ${i}: ${status} ${cors ? '✅ CORS' : '❌ NO CORS'}`);
  })();
}

// Test 3: /api/hermes/health (5x)
console.log("🔍 Testing /api/hermes/health");
for (let i = 1; i <= 5; i++) {
  (async () => {
    const r = await fetch('/api/hermes/health');
    const cors = r.headers.get('Access-Control-Allow-Origin');
    const status = r.status;
    console.log(`  Attempt ${i}: ${status} ${cors ? '✅ CORS' : '❌ NO CORS'}`);
  })();
}

// Test 4: /api/runs (5x) with field verification
console.log("🔍 Testing /api/runs with stale trace classification");
for (let i = 1; i <= 5; i++) {
  (async () => {
    const r = await fetch('/api/runs');
    const cors = r.headers.get('Access-Control-Allow-Origin');
    const data = await r.json();
    console.log(`  Attempt ${i}: ${r.status} ${cors ? '✅ CORS' : '❌ NO CORS'}`);
    console.log(`    Fields: total=${data.total}, liveController=${data.liveController}, ghost=${data.ghost}`);
    console.log(`    Summary: activeTraces=${data.summary?.activeTraces}, stalePeriodMs=${data.summary?.stalePeriodMs}`);
  })();
}

// Wait for all async operations
setTimeout(() => {
  console.log("\n✅ Browser verification complete! Check results above.");
  console.log("Expected: All 5 attempts for each endpoint should succeed (200 status) with CORS headers.");
}, 1000);
EOF

echo ""
echo "Expected Results:"
echo "================"
echo "✅ All 5 attempts for each endpoint: Status 200"
echo "✅ All responses have: Access-Control-Allow-Origin: *"
echo "✅ /api/runs includes fields: liveController, ghost, summary"
echo "✅ summary.stalePeriodMs = 1800000 (30 minutes)"
echo "✅ No 'TypeError: Failed to fetch' errors"
echo ""
echo "=================================================="
echo ""
echo "If all checks pass: ✅ Production fix is working"
echo "If any fail: ❌ Investigate error in browser console"
echo ""
