import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const hermesApiRoot = path.join(repo, "src/app/api/hermes");

const expectedRoutes = [
  "activity/route.ts",
  "briefing/route.ts",
  "cost/route.ts",
  "crons/route.ts",
  "dispatch/route.ts",
  "evaluation-control/route.ts",
  "health/route.ts",
  "memory/route.ts",
  "native-source/route.ts",
  "native/route.ts",
  "observability/route.ts",
  "requests/[id]/route.ts",
  "requests/route.ts",
  "tasks/route.ts",
].sort();

const approvedDisabledMutations = new Map([
  ["briefing/route.ts", new Set(["POST"])],
  ["crons/route.ts", new Set(["POST"])],
  ["dispatch/route.ts", new Set(["POST"])],
  ["memory/route.ts", new Set(["POST"])],
  ["requests/[id]/route.ts", new Set(["PATCH"])],
]);

async function listRoutes(dir = hermesApiRoot, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const routes = [];
  for (const entry of entries) {
    const rel = path.posix.join(prefix, entry.name);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...await listRoutes(abs, rel));
    } else if (entry.isFile() && entry.name === "route.ts") {
      routes.push(rel);
    }
  }
  return routes.sort();
}

test("Hermes API route inventory is explicit, DB-free, and read-only except approved disabled mutations", async () => {
  const routes = await listRoutes();
  assert.deepEqual(routes, expectedRoutes);

  for (const route of routes) {
    const source = await fs.readFile(path.join(hermesApiRoot, route), "utf8");
    assert.doesNotMatch(source, /@\/lib\/prisma|from\s+["'][^"']*prisma|prisma\./i, `${route} must not use Prisma`);
    assert.doesNotMatch(source, /@\/lib\/supabase|from\s+["'][^"']*supabase|supabase\./i, `${route} must not use Supabase`);
    assert.doesNotMatch(source, /hermes-native-mirror/, `${route} must use direct native transport`);

    const mutatingExports = [...source.matchAll(/export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)\s*\(/g)]
      .map((match) => match[1]);
    const approved = approvedDisabledMutations.get(route) ?? new Set();
    for (const method of mutatingExports) {
      assert.equal(approved.has(method), true, `${route} exports unapproved ${method}`);
      assert.match(source, /status:\s*(405|410)/, `${route} ${method} must be disabled with 405/410`);
      assert.doesNotMatch(source, /agentRequest\.create|agentRequest\.update|dataStore|hermesMemory/i, `${route} ${method} must not queue or write`);
    }
  }
});
