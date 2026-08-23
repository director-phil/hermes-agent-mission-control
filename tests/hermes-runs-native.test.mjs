import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  discoverHermesStateDatabases,
  listHermesSessionRuns,
  readHermesSessionGraph,
} from "../hermes-bridge/lib/parse-hermes-runs.mjs";

const NOW_MS = Date.parse("2026-08-23T00:30:00.000Z");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-native-runs-"));
  const profileRoot = path.join(root, ".hermes", "profiles", "fresh-coder");
  await fs.mkdir(profileRoot, { recursive: true });
  const primary = path.join(root, ".hermes", "state.db");
  const coder = path.join(profileRoot, "state.db");

  for (const dbPath of [primary, coder]) {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, profile_name TEXT, title TEXT,
        model TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
        last_activity_at REAL, message_count INTEGER DEFAULT 0,
        tool_call_count INTEGER DEFAULT 0, api_call_count INTEGER DEFAULT 0,
        cwd TEXT, git_branch TEXT, git_repo_root TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1
      );
      CREATE TABLE session_turn_leases (
        conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL
      );
    `);
    db.close();
  }

  const db = new Database(coder);
  db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "20260823_001", "cli", "fresh-coder", "Implement native runs", "local-coder",
    NOW_MS / 1000 - 120, null, null, NOW_MS / 1000 - 5, 4, 1, 2,
    "/repo/private", "feat/native", "/repo/private",
  );
  db.prepare(`INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)`).run(
    "20260823_001", "pid=123:private-holder", NOW_MS / 1000 - 60, NOW_MS / 1000 + 60,
  );
  db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "20260823_002", "cli", "fresh-coder", "Expired lease session", "local-coder",
    NOW_MS / 1000 - 600, null, null, NOW_MS / 1000 - 300, 1, 0, 1,
    "/repo/private", "feat/native", "/repo/private",
  );
  db.prepare(`INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)`).run(
    "20260823_002", "pid=124:private-holder", NOW_MS / 1000 - 600, NOW_MS / 1000 - 120,
  );
  db.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "20260823_001", "assistant", "SECRET_PROMPT_BODY", null, null, NOW_MS / 1000 - 10,
  );
  db.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "20260823_001", "tool", "SECRET_TOOL_RESULT", "{\"args\":\"SECRET_ARGS\"}", "read_file", NOW_MS / 1000 - 5,
  );
  db.close();

  return { root, hermesRoot: path.join(root, ".hermes") };
}

test("discovers primary and profile Hermes state databases", async () => {
  const { root, hermesRoot } = await fixture();
  try {
    const databases = await discoverHermesStateDatabases(hermesRoot);
    assert.deepEqual(databases.map((item) => item.profile), ["default", "fresh-coder"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("lists only metadata and treats only unexpired leases as live", async () => {
  const { root, hermesRoot } = await fixture();
  try {
    const databases = await discoverHermesStateDatabases(hermesRoot);
    const runs = listHermesSessionRuns(databases, { nowMs: NOW_MS, limit: 20 });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].goal, "20260823_001");
    assert.equal(runs[0].liveController, true);
    assert.equal(runs[0].status, "running");
    assert.equal(runs[0].specialist, "fresh-coder");
    assert.deepEqual(runs[0].nodeLabels, ["fresh-coder"]);
    assert.equal(runs[0].operationId, "op:20260823_001");
    assert.equal(runs[0].goalId, "session:20260823_001");
    assert.equal(runs[0].runId, "20260823_001");
    assert.equal(runs[0].stageId, "cli");
    assert.equal(runs[0].repo, "private");
    assert.equal(runs[0].branch, "feat/native");
    const expired = runs.find((run) => run.goal === "20260823_002");
    assert.equal(expired?.liveController, false);
    assert.equal(expired?.status, "idle");
    const exported = JSON.stringify(runs);
    for (const forbidden of ["SECRET_PROMPT_BODY", "SECRET_TOOL_RESULT", "SECRET_ARGS", "private-holder"]) {
      assert.equal(exported.includes(forbidden), false);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("builds a compatibility graph without exporting message content or private paths", async () => {
  const { root, hermesRoot } = await fixture();
  try {
    const databases = await discoverHermesStateDatabases(hermesRoot);
    const graph = readHermesSessionGraph(databases, "20260823_001", { nowMs: NOW_MS });
    assert.ok(graph);
    assert.equal(graph.goal, "20260823_001");
    assert.equal(graph.running, true);
    assert.equal(graph.currentAgent, "fresh-coder");
    assert.equal(graph.currentActivity?.tool, "read_file");
    assert.equal(graph.operationId, "op:20260823_001");
    assert.equal(graph.goalId, "session:20260823_001");
    assert.equal(graph.runId, "20260823_001");
    assert.equal(graph.stageId, "cli");
    assert.equal(graph.repo, "private");
    assert.equal(graph.branch, "feat/native");
    assert.deepEqual(graph.files, []);
    assert.deepEqual(graph.touches, []);
    assert.deepEqual(graph.learnings, []);
    assert.equal(graph.counts.modelCalls, 2);
    assert.equal(graph.counts.toolCalls, 1);
    const exported = JSON.stringify(graph);
    for (const forbidden of ["SECRET_PROMPT_BODY", "SECRET_TOOL_RESULT", "SECRET_ARGS", "/repo/private", "private-holder"]) {
      assert.equal(exported.includes(forbidden), false);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fails closed for malformed databases and invalid session identifiers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-native-runs-bad-"));
  try {
    const bad = path.join(root, "bad.db");
    await fs.writeFile(bad, "not sqlite");
    const databases = [{ path: bad, profile: "bad" }];
    assert.deepEqual(listHermesSessionRuns(databases, { nowMs: NOW_MS }), []);
    assert.equal(readHermesSessionGraph(databases, "../escape", { nowMs: NOW_MS }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
