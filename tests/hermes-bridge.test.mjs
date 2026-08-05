import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNativeSnapshotRequest,
  buildMirrorEnvelope,
  fetchNativeSnapshot,
  hermesChat,
  requestKindsForPolicy,
  unsupportedRequestFailures,
  validateBridgeConfig,
  validateSnapshot,
} from "../hermes-bridge/bridge.mjs";

function sampleSnapshot() {
  const now = new Date().toISOString();
  return {
    source: {
      mode: "local-native",
      status: "ok",
      message: "Native Hermes truth loaded",
      roots: { missionControl: "/fixed", profiles: "/profiles", runtime: "/fixed/runtime", archive: "/fixed/archive/goals" },
      warnings: [],
      errors: [],
      checkedAt: now,
      lastSeen: now,
      stale: false,
    },
    policy: {
      primaryCloudOrchestrator: "default",
      alwaysOnWorkers: false,
      modelLoadsPermittedByRoster: false,
      langfuseMode: "metadata-only",
      runtimeNote: "Only roster-declared running profiles are shown as running.",
    },
    agents: [],
    operatorTasks: { updatedAt: null, tasks: [], counts: {} },
    goals: { live: { ready: [], running: [], done: [], failed: [] }, counts: { ready: 0, running: 0, done: 0, failed: 0 }, current: null, recentFailed: [] },
    archive: { root: "/fixed/archive/goals", counts: { done: 0, failed: 0, total: 0 }, artifact_counts: { done: 0, failed: 0, total: 0 }, manifestSha256: null, recent: [], recentArtifacts: [] },
  };
}

test("chat dispatch sends prompt on stdin, not argv or env", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-bridge-"));
  try {
    const capture = path.join(root, "capture.json");
    const bin = path.join(root, "fake-hermes.mjs");
    await fs.writeFile(bin, [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      `process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin })); console.log('ok'); });`,
      "",
    ].join("\n"), { mode: 0o700 });

    const prompt = "super sensitive mission prompt";
    const result = await hermesChat(prompt, {
      hermesBin: bin,
      runTimeoutMs: 5000,
      maxResultChars: 1000,
    });
    const captured = JSON.parse(await fs.readFile(capture, "utf8"));

    assert.equal(result, "ok");
    assert.equal(captured.stdin, prompt);
    assert.equal(captured.argv.includes(prompt), false);
    assert.equal(JSON.stringify(captured.env).includes(prompt), false);
    assert.deepEqual(captured.argv, ["--profile", "default", "chat", "--query-file", "-", "--source", "mission-control-bridge"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("chat dispatch errors do not include echoed prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-bridge-"));
  try {
    const bin = path.join(root, "fake-hermes-fail.mjs");
    await fs.writeFile(bin, [
      "#!/usr/bin/env node",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => { console.error(stdin); process.exit(12); });",
      "",
    ].join("\n"), { mode: 0o700 });

    const prompt = "prompt must not appear in error";
    await assert.rejects(
      () => hermesChat(prompt, { hermesBin: bin, runTimeoutMs: 5000, maxResultChars: 1000 }),
      (error) => error instanceof Error && !error.message.includes(prompt) && /Hermes exited 12/.test(error.message),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mirror envelope schema is strict and sanitized", () => {
  const snapshot = validateSnapshot(sampleSnapshot());
  const envelope = buildMirrorEnvelope(snapshot, { db: true, hermesCli: true, nativeSnapshot: true, detail: "ready" });

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.source, "bridge-mirror");
  assert.equal(envelope.heartbeat.db, true);
  assert.equal(envelope.heartbeat.hermesCli, true);
  assert.equal(envelope.heartbeat.nativeSnapshot, true);
  assert.equal(envelope.snapshot.source.status, "ok");
});

test("native snapshot fetch sends internal secret only to configured localhost URL", async () => {
  const secret = "bridge-secret-0123456789";
  let captured = null;
  const server = http.createServer((req, res) => {
    captured = { url: req.url, headers: req.headers };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sampleSnapshot()));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const snapshot = await fetchNativeSnapshot({
      nativeSnapshotUrl: `http://127.0.0.1:${port}/api/hermes/native`,
      nativeInternalSecret: secret,
      fetchTimeoutMs: 5000,
    });

    assert.equal(snapshot.source.status, "ok");
    assert.equal(captured.url, "/api/hermes/native");
    assert.equal(captured.headers["x-internal-secret"], secret);
    assert.equal(captured.headers.authorization, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("native snapshot secret is absent from errors and exported mirror snapshot", async () => {
  const secret = "bridge-secret-redacted-0123456789";
  const server = http.createServer((req, res) => {
    const snapshot = sampleSnapshot();
    snapshot.source.status = "warning";
    snapshot.source.message = `loaded ${req.headers["x-internal-secret"]}`;
    snapshot.source.warnings = [`warning ${req.headers["x-internal-secret"]}`];
    snapshot.source.errors = [`error ${req.headers["x-internal-secret"]}`];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const snapshot = await fetchNativeSnapshot({
      nativeSnapshotUrl: `http://127.0.0.1:${port}/api/hermes/native`,
      nativeInternalSecret: secret,
      fetchTimeoutMs: 5000,
    });
    const envelope = buildMirrorEnvelope(snapshot, { db: true, hermesCli: true, nativeSnapshot: true, detail: `detail ${secret}` });
    const exported = JSON.stringify(envelope);

    assert.equal(exported.includes(secret), false);
    assert.equal(exported.includes("x-internal-secret"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("native snapshot config fails closed without a bounded secret or localhost URL", () => {
  assert.throws(
    () => validateBridgeConfig({ nativeSnapshotUrl: "http://127.0.0.1:3020/api/hermes/native", nativeInternalSecret: "" }),
    /HERMES_NATIVE_INTERNAL_SECRET is required/,
  );
  assert.throws(
    () => buildNativeSnapshotRequest({ nativeSnapshotUrl: "https://example.com/api/hermes/native", nativeInternalSecret: "bridge-secret-0123456789" }),
    /HERMES_NATIVE_SNAPSHOT_URL must be http localhost/,
  );
});

test("bridge process fails startup when native internal secret is missing", async () => {
  const child = spawn(process.execPath, ["hermes-bridge/bridge.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/hermes",
      HERMES_NATIVE_SNAPSHOT_URL: "http://127.0.0.1:3020/api/hermes/native",
      HERMES_NATIVE_INTERNAL_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.notEqual(code, 0);
  assert.match(stderr, /HERMES_NATIVE_INTERNAL_SECRET is required/);
  assert.equal(stderr.includes("x-internal-secret"), false);
});

test("invalid mirror snapshot shape is rejected", () => {
  assert.throws(() => validateSnapshot({ source: { status: "ok" } }), /schema invalid/);
});

test("unsupported request kinds are failed instead of left queued", () => {
  const failures = unsupportedRequestFailures();

  assert.deepEqual(failures, [
    { kind: "briefing.generate", error: "Daily briefing generation is not supported in this Mission Control release." },
    { kind: "memory.write", error: "Wiki memory writes are not supported in this Mission Control release." },
  ]);
  assert.equal(requestKindsForPolicy().includes("briefing.generate"), false);
  assert.equal(requestKindsForPolicy().includes("memory.write"), false);
});

test("unsupported requests have no environment opt-in path", () => {
  const kinds = requestKindsForPolicy({ unsupportedRequests: true });

  assert.equal(unsupportedRequestFailures({ unsupportedRequests: true }).length, 2);
  assert.equal(kinds.includes("briefing.generate"), false);
  assert.equal(kinds.includes("memory.write"), false);
});
