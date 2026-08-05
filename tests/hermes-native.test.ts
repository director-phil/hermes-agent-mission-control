import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHermesNativeSourceRequest,
  fetchHermesNativeSourceEnvelope,
  parseHermesCronList,
  readHermesCronSnapshotForServer,
  readHermesNativeSnapshot,
  validateHermesNativeSourceEnvelope,
  type HermesNativeSnapshot,
} from "../src/lib/hermes-native";
import { isHermesBridgeMirrorStale } from "../src/lib/hermes-native-mirror";

async function makeRoots() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-native-"));
  const mission = path.join(root, "mission-control");
  const profiles = path.join(root, "profiles");
  await fs.mkdir(path.join(mission, "runtime/goals/ready"), { recursive: true });
  await fs.mkdir(path.join(mission, "runtime/goals/running"), { recursive: true });
  await fs.mkdir(path.join(mission, "runtime/goals/done"), { recursive: true });
  await fs.mkdir(path.join(mission, "runtime/goals/failed"), { recursive: true });
  await fs.mkdir(path.join(mission, "archive/goals"), { recursive: true });
  await fs.mkdir(profiles, { recursive: true });
  return { root, mission, profiles };
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

async function seedRoster(mission: string, profiles: string) {
  await writeJson(path.join(mission, "agent-roster.json"), {
    policy: {
      primary_cloud_orchestrator: "default",
      always_on_workers: false,
      model_loads_permitted_by_roster: false,
      langfuse_mode: "metadata-only; content disabled",
    },
    profiles: [
      {
        profile: "explorer",
        role: "Read-only repository explorer.",
        model_class: "local",
        model: "qwen3-coder-next",
        provider: "coder",
        capabilities: ["repository search"],
        forbidden_actions: ["file edits", "secret disclosure"],
        cloud_orchestrator_call_when: "Use for orientation.",
        status_note: "on-demand specialist",
      },
    ],
  });
  await fs.mkdir(path.join(profiles, "explorer"), { recursive: true });
  await fs.writeFile(
    path.join(profiles, "explorer/config.yaml"),
    [
      "model:",
      "  default: qwen3-coder-next",
      "  provider: coder",
      "  api_key: SECRET_SHOULD_NOT_RETURN",
      "  context_length: 262144",
      "compression:",
      "  enabled: true",
      "  threshold: 0.5",
      "  target_ratio: 0.25",
      "",
    ].join("\n"),
  );
}

function sampleSnapshot(): HermesNativeSnapshot {
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

function sampleEnvelope(secret?: string) {
  const now = new Date().toISOString();
  const snapshot = sampleSnapshot();
  if (secret) {
    snapshot.source.message = `loaded ${secret}`;
    snapshot.source.warnings = [`warning ${secret}`];
    snapshot.source.errors = [`error ${secret}`];
  }
  return {
    schemaVersion: 1,
    source: "hermes-native-source",
    generatedAt: now,
    snapshot,
    crons: {
      source: "local-hermes-cli",
      status: "ok",
      message: "Hermes cron list loaded",
      jobs: [],
      syncedAt: now,
      warnings: secret ? [`cron ${secret}`] : [],
    },
  };
}

test("parses roster and profile hints without returning secrets", async () => {
  const { root, mission, profiles } = await makeRoots();
  try {
    await seedRoster(mission, profiles);
    await writeJson(path.join(mission, "operator-tasks.json"), { tasks: [] });
    await writeJson(path.join(mission, "archive/goals/import-manifest.json"), {
      counts: { done: 0, failed: 0, total: 0 },
      artifact_counts: { done: 0, failed: 0, total: 0 },
      files: [],
      artifacts: [],
    });

    const snapshot = await readHermesNativeSnapshot({ missionControlRoot: mission, profilesRoot: profiles });
    assert.equal(snapshot.agents.some((agent) => agent.profile === "default"), false);
    const explorer = snapshot.agents.find((agent) => agent.profile === "explorer");
    assert.equal(explorer?.status, "on-demand");
    assert.equal(explorer?.contextLength, 262144);
    assert.equal(explorer?.compressionPolicy, "enabled=true threshold=0.5 target=0.25");
    assert.deepEqual(snapshot.agents.map((agent) => agent.profile), ["explorer"]);
    assert.equal(JSON.stringify(snapshot).includes("SECRET_SHOULD_NOT_RETURN"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loads operator tasks, live goal metadata, and archive manifest counts", async () => {
  const { root, mission, profiles } = await makeRoots();
  try {
    await seedRoster(mission, profiles);
    await writeJson(path.join(mission, "operator-tasks.json"), {
      updated_at: "2026-08-05T00:00:00+10:00",
      tasks: [
        { id: "import-native", title: "import native goals/tasks", status: "in_progress", priority: "high" },
        { id: "deploy", title: "deploy mission-control.reliabletradies.app", status: "pending", priority: "medium" },
      ],
    });
    await fs.writeFile(
      path.join(mission, "runtime/goals/running/current.md"),
      [
        "---",
        "status: running",
        "updated_at: 2026-08-05T10:00:00+10:00",
        "evidence:",
        "  - tests queued",
        "---",
        "# Wire native Mission Control",
        "Body should not be needed by callers.",
      ].join("\n"),
    );
    await writeJson(path.join(mission, "archive/goals/import-manifest.json"), {
      counts: { done: 1, failed: 1, total: 2 },
      artifact_counts: { done: 1, failed: 0, total: 1 },
      files: [
        { kind: "goal", status: "done", name: "alpha.md", path: "done/alpha.md", bytes: 10, sha256: "a".repeat(64) },
        { kind: "goal", status: "failed", name: "beta.md", path: "failed/beta.md", bytes: 20, sha256: "b".repeat(64) },
      ],
      artifacts: [
        { kind: "artifact", status: "done", name: "autopsy.md", path: "done/alpha/autopsy.md", goal: "alpha", bytes: 30, sha256: "c".repeat(64) },
      ],
    });

    const snapshot = await readHermesNativeSnapshot({ missionControlRoot: mission, profilesRoot: profiles });
    assert.equal(snapshot.operatorTasks.tasks.length, 2);
    assert.equal(snapshot.operatorTasks.counts.in_progress, 1);
    assert.equal(snapshot.goals.current?.title, "Wire native Mission Control");
    assert.deepEqual(snapshot.goals.current?.evidence, ["tests queued"]);
    assert.deepEqual(snapshot.archive.counts, { done: 1, failed: 1, total: 2 });
    assert.deepEqual(snapshot.archive.artifact_counts, { done: 1, failed: 0, total: 1 });
    assert.equal(snapshot.archive.recent[0].sha256, "b".repeat(64));
    assert.equal(snapshot.archive.recentArtifacts[0].path, "done/alpha/autopsy.md");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not count nested archive artifacts as goals in legacy manifests", async () => {
  const { root, mission, profiles } = await makeRoots();
  try {
    await seedRoster(mission, profiles);
    await writeJson(path.join(mission, "operator-tasks.json"), { tasks: [] });
    await writeJson(path.join(mission, "archive/goals/import-manifest.json"), {
      counts: { done: 2, failed: 2, total: 4 },
      files: [
        { status: "done", name: "alpha.md", bytes: 10, sha256: "a".repeat(64) },
        { status: "done", name: "alpha/autopsy.md", bytes: 11, sha256: "b".repeat(64) },
        { status: "failed", name: "beta.md", bytes: 12, sha256: "c".repeat(64) },
        { status: "failed", name: "beta/evidence.md", bytes: 13, sha256: "d".repeat(64) },
      ],
    });

    const snapshot = await readHermesNativeSnapshot({ missionControlRoot: mission, profilesRoot: profiles });
    assert.deepEqual(snapshot.archive.counts, { done: 1, failed: 1, total: 2 });
    assert.deepEqual(snapshot.archive.artifact_counts, { done: 1, failed: 1, total: 2 });
    assert.equal(snapshot.archive.recent.length, 2);
    assert.equal(snapshot.archive.recent.some((goal) => goal.title.includes("autopsy")), false);
    assert.deepEqual(
      snapshot.archive.recentArtifacts.map((artifact) => artifact.path).sort(),
      ["done/alpha/autopsy.md", "failed/beta/evidence.md"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects symlink and oversized live goal files", async () => {
  const { root, mission, profiles } = await makeRoots();
  try {
    await seedRoster(mission, profiles);
    await writeJson(path.join(mission, "operator-tasks.json"), { tasks: [] });
    await writeJson(path.join(mission, "archive/goals/import-manifest.json"), {
      counts: { done: 0, failed: 0, total: 0 },
      artifact_counts: { done: 0, failed: 0, total: 0 },
      files: [],
      artifacts: [],
    });
    await fs.writeFile(path.join(root, "outside.md"), "# outside");
    await fs.symlink(path.join(root, "outside.md"), path.join(mission, "runtime/goals/ready/link.md"));
    await fs.writeFile(path.join(mission, "runtime/goals/ready/too-big.md"), "x".repeat(70 * 1024));

    const snapshot = await readHermesNativeSnapshot({ missionControlRoot: mission, profilesRoot: profiles });
    assert.equal(snapshot.goals.counts.ready, 0);
    assert.equal(snapshot.source.status, "warning");
    assert.equal(snapshot.source.warnings.some((warning) => warning.includes("symlink rejected")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("returns empty states when native files are valid but empty", async () => {
  const { root, mission, profiles } = await makeRoots();
  try {
    await writeJson(path.join(mission, "agent-roster.json"), {
      policy: { primary_cloud_orchestrator: "default" },
      profiles: [],
    });
    await writeJson(path.join(mission, "operator-tasks.json"), { tasks: [] });
    await writeJson(path.join(mission, "archive/goals/import-manifest.json"), {
      counts: { done: 0, failed: 0, total: 0 },
      artifact_counts: { done: 0, failed: 0, total: 0 },
      files: [],
      artifacts: [],
    });

    const snapshot = await readHermesNativeSnapshot({ missionControlRoot: mission, profilesRoot: profiles });
    assert.equal(snapshot.agents.length, 0);
    assert.equal(snapshot.source.status, "warning");
    assert.equal(snapshot.source.warnings.some((warning) => warning.includes("no configured profiles")), true);
    assert.equal(snapshot.operatorTasks.tasks.length, 0);
    assert.equal(snapshot.goals.current, null);
    assert.equal(snapshot.archive.counts.total, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("missing roster is an explicit source error with no fabricated agents", async () => {
  const { root, mission, profiles } = await makeRoots();
  try {
    await writeJson(path.join(mission, "operator-tasks.json"), { tasks: [] });
    await writeJson(path.join(mission, "archive/goals/import-manifest.json"), {
      counts: { done: 0, failed: 0, total: 0 },
      artifact_counts: { done: 0, failed: 0, total: 0 },
      files: [],
      artifacts: [],
    });

    const snapshot = await readHermesNativeSnapshot({ missionControlRoot: mission, profilesRoot: profiles });
    assert.equal(snapshot.source.status, "error");
    assert.equal(snapshot.source.errors.some((error) => error.includes("agent-roster.json")), true);
    assert.equal(snapshot.agents.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invalid roster is an explicit source error with no fabricated agents", async () => {
  const { root, mission, profiles } = await makeRoots();
  try {
    await fs.writeFile(path.join(mission, "agent-roster.json"), "{not-json");
    await writeJson(path.join(mission, "operator-tasks.json"), { tasks: [] });
    await writeJson(path.join(mission, "archive/goals/import-manifest.json"), {
      counts: { done: 0, failed: 0, total: 0 },
      artifact_counts: { done: 0, failed: 0, total: 0 },
      files: [],
      artifacts: [],
    });

    const snapshot = await readHermesNativeSnapshot({ missionControlRoot: mission, profilesRoot: profiles });
    assert.equal(snapshot.source.status, "error");
    assert.equal(snapshot.source.errors.some((error) => error.includes("invalid JSON")), true);
    assert.equal(snapshot.agents.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge mirror staleness is explicit", () => {
  const now = Date.parse("2026-08-05T00:02:00.000Z");
  assert.equal(isHermesBridgeMirrorStale("2026-08-05T00:01:00.000Z", now), false);
  assert.equal(isHermesBridgeMirrorStale("2026-08-05T00:00:00.000Z", now), true);
  assert.equal(isHermesBridgeMirrorStale("not-a-date", now), true);
});

test("parses cron list with bounded sanitized fields and no script body", () => {
  const raw = [
    "  abc123 [active]",
    "    Name: Weekly review",
    "    Schedule: 0 9 * * 1",
    "    Next run: 2026-08-10T09:00:00+10:00",
    "    Deliver: slack:#ops",
    "    Skills: review",
    "    Script: prompt with SECRET_SHOULD_NOT_RETURN",
    "    Last run: 2026-08-03T09:00:00+10:00 ok",
    "    Mode: local",
    "",
  ].join("\n");

  const jobs = parseHermesCronList(raw);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "abc123");
  assert.equal(jobs[0].deliver, "slack");
  assert.equal(Object.hasOwn(jobs[0], "script"), false);
  assert.equal(JSON.stringify(jobs).includes("SECRET_SHOULD_NOT_RETURN"), false);
});

test("native source URL validation requires HTTPS Tailscale Funnel shape and secret", () => {
  assert.throws(
    () => buildHermesNativeSourceRequest("http://gb10.tailnet.ts.net/hermes-native", "secret"),
    /must use HTTPS/,
  );
  assert.throws(
    () => buildHermesNativeSourceRequest("https://example.com/hermes-native", "secret"),
    /Tailscale Funnel hostname/,
  );
  assert.throws(
    () => buildHermesNativeSourceRequest("https://gb10.tailnet.ts.net/api/hermes/native", "secret"),
    /path is not approved/,
  );
  assert.throws(
    () => buildHermesNativeSourceRequest("https://gb10.tailnet.ts.net/hermes-native", ""),
    /HERMES_NATIVE_INTERNAL_SECRET is required/,
  );

  const request = buildHermesNativeSourceRequest(
    "https://gb10.tailnet.ts.net:10000/hermes-native",
    "secret",
  );
  assert.equal(request.url, "https://gb10.tailnet.ts.net:10000/hermes-native");
  assert.equal(request.headers["x-internal-secret"], "secret");
});

test("native source envelope schema is strict", () => {
  assert.equal(validateHermesNativeSourceEnvelope(sampleEnvelope()).schemaVersion, 1);
  assert.throws(
    () => validateHermesNativeSourceEnvelope({ ...sampleEnvelope(), crons: { jobs: [] } }),
    /schema invalid/,
  );
});

test("remote native source envelope is deeply sanitized and capped", () => {
  const raw = sampleEnvelope("secret-token-value") as Record<string, any>;
  raw.generatedAt = "2026-08-05T10:00:00+10:00";
  raw.extra = "strip me";
  raw.snapshot.source.checkedAt = "2026-08-05T10:01:00+10:00";
  raw.snapshot.source.lastSeen = "2026-08-05T10:02:00+10:00";
  raw.snapshot.source.apiKey = "SECRET_SHOULD_NOT_RETURN";
  raw.snapshot.source.warnings = ["safe warning", "Authorization: Bearer SECRET_SHOULD_NOT_RETURN"];
  raw.snapshot.policy.runtimeNote = "x".repeat(240);
  raw.snapshot.agents = Array.from({ length: 90 }, (_, i) => ({
    id: `agent-${i}`,
    profile: `agent-${i}`,
    name: `Agent ${i}`,
    role: "Reader",
    modelClass: "cloud",
    model: "claude",
    provider: "anthropic",
    status: "on-demand",
    capabilities: ["metadata", "token:SECRET_SHOULD_NOT_RETURN"],
    forbiddenActions: ["writes"],
    cloudOrchestratorCallWhen: null,
    langfuseCoverage: "metadata-only",
    compressionPolicy: "not declared",
    contextLength: 200000,
    statusNote: "safe",
    unknown: "strip me",
  }));
  raw.snapshot.operatorTasks.tasks = Array.from({ length: 120 }, (_, i) => ({
    id: `todo-${i}`,
    title: `Task ${i}`,
    status: "pending",
    priority: "medium",
    updatedAt: "2026-08-05T10:03:00+10:00",
    secret: "SECRET_SHOULD_NOT_RETURN",
  }));
  raw.crons.syncedAt = "2026-08-05T10:04:00+10:00";
  raw.crons.jobs = Array.from({ length: 205 }, (_, i) => ({
    id: `cron-${i}`,
    status: "active",
    name: `Cron ${i}`,
    schedule: "0 9 * * *",
    nextRun: "2026-08-06T09:00:00+10:00",
    lastRun: null,
    lastResult: i === 0 ? "token:SECRET_SHOULD_NOT_RETURN" : "ok",
    deliver: i === 0 ? "Authorization: Bearer SECRET_SHOULD_NOT_RETURN" : "slack",
    skills: "review",
    mode: "local",
    script: "SECRET_SHOULD_NOT_RETURN",
  }));

  const parsed = validateHermesNativeSourceEnvelope(raw);
  const exported = JSON.stringify(parsed);
  assert.equal(parsed.generatedAt, "2026-08-05T00:00:00.000Z");
  assert.equal(parsed.snapshot.source.checkedAt, "2026-08-05T00:01:00.000Z");
  assert.equal(parsed.snapshot.source.lastSeen, "2026-08-05T00:02:00.000Z");
  assert.equal(parsed.crons.syncedAt, "2026-08-05T00:04:00.000Z");
  assert.equal(parsed.snapshot.agents.length, 80);
  assert.equal(parsed.snapshot.operatorTasks.tasks.length, 100);
  assert.equal(parsed.crons.jobs.length, 200);
  assert.equal(parsed.snapshot.policy.runtimeNote.length, 180);
  assert.deepEqual(parsed.snapshot.source.warnings, ["safe warning"]);
  assert.deepEqual(parsed.snapshot.agents[0].capabilities, ["metadata"]);
  assert.equal(parsed.crons.jobs[0].deliver, null);
  assert.equal(parsed.crons.jobs[0].lastResult, null);
  assert.equal(Object.hasOwn(parsed, "extra"), false);
  assert.equal(Object.hasOwn(parsed.snapshot.source, "apiKey"), false);
  assert.equal(Object.hasOwn(parsed.snapshot.agents[0], "unknown"), false);
  assert.equal(Object.hasOwn(parsed.crons.jobs[0], "script"), false);
  assert.equal(exported.includes("SECRET_SHOULD_NOT_RETURN"), false);
});

test("remote native source rejects invalid nested enums", () => {
  const raw = sampleEnvelope() as Record<string, any>;
  raw.snapshot.agents = [{
    id: "agent",
    profile: "agent",
    name: "Agent",
    role: "Reader",
    modelClass: "quantum",
    model: "claude",
    provider: "anthropic",
    status: "on-demand",
    capabilities: [],
    forbiddenActions: [],
    cloudOrchestratorCallWhen: null,
    langfuseCoverage: "metadata-only",
    compressionPolicy: "not declared",
    contextLength: null,
    statusNote: "safe",
  }];

  assert.throws(() => validateHermesNativeSourceEnvelope(raw), /schema invalid/);
});

test("remote native source rejects redirects, oversized payloads, and invalid schemas", async () => {
  const url = "https://gb10.tailnet.ts.net/hermes-native";
  const secret = "native-source-secret";

  await assert.rejects(
    () => fetchHermesNativeSourceEnvelope({
      snapshotUrl: url,
      internalSecret: secret,
      fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }),
    }),
    /redirects are rejected/,
  );

  await assert.rejects(
    () => fetchHermesNativeSourceEnvelope({
      snapshotUrl: url,
      internalSecret: secret,
      fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    }),
    /exceeds 2 MB cap/,
  );

  await assert.rejects(
    () => fetchHermesNativeSourceEnvelope({
      snapshotUrl: url,
      internalSecret: secret,
      fetchImpl: async () => Response.json({ schemaVersion: 1, source: "wrong" }),
    }),
    /schema invalid/,
  );
});

test("remote native source redacts internal secret from returned JSON", async () => {
  const secret = "native-source-secret-redacted";
  const envelope = await fetchHermesNativeSourceEnvelope({
    snapshotUrl: "https://gb10.tailnet.ts.net/hermes-native",
    internalSecret: secret,
    fetchImpl: async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>)["x-internal-secret"], secret);
      return Response.json(sampleEnvelope(secret));
    },
  });

  const exported = JSON.stringify(envelope);
  assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes("x-internal-secret"), false);
  assert.equal(envelope.snapshot.source.mode, "remote-native-source");
});

test("cron server reader uses local cron metadata before remote source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cron-local-"));
  const bin = path.join(root, "bin");
  const previousPath = process.env.PATH;
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(bin, "hermes"),
    [
      "#!/bin/sh",
      "printf '%s\\n' '  abc123 [active]'",
      "printf '%s\\n' '    Name: Local cron'",
      "printf '%s\\n' '    Schedule: 0 9 * * *'",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    process.env.PATH = bin;
    const crons = await readHermesCronSnapshotForServer({
      snapshotUrl: "https://gb10.tailnet.ts.net/hermes-native",
      internalSecret: "secret",
      fetchImpl: async () => {
        throw new Error("remote fetch should not be called");
      },
    });
    assert.equal(crons.source, "local-hermes-cli");
    assert.equal(crons.jobs[0]?.name, "Local cron");
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cron server reader falls back to signed remote source when local cron metadata is unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cron-remote-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = root;
    const crons = await readHermesCronSnapshotForServer({
      snapshotUrl: "https://gb10.tailnet.ts.net/hermes-native",
      internalSecret: "native-source-secret",
      fetchImpl: async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>)["x-internal-secret"], "native-source-secret");
        const envelope = sampleEnvelope() as Record<string, any>;
        envelope.crons.jobs = [{
          id: "remote-cron",
          status: "active",
          name: "Remote cron",
          schedule: "0 10 * * *",
          nextRun: null,
          lastRun: null,
          lastResult: null,
          deliver: null,
          skills: null,
          mode: null,
        }];
        return Response.json(envelope);
      },
    });
    assert.equal(crons.source, "local-hermes-cli");
    assert.equal(crons.jobs[0]?.id, "remote-cron");
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("protected native-source route rejects missing and wrong internal secret headers", async () => {
  const previousSecret = process.env.HERMES_NATIVE_INTERNAL_SECRET;
  process.env.HERMES_NATIVE_INTERNAL_SECRET = "expected-secret";
  try {
    const route = await import("../src/app/api/hermes/native-source/route");
    const GET = route.GET;
    const missing = await GET(new Request("http://localhost/api/hermes/native-source"));
    const wrong = await GET(new Request("http://localhost/api/hermes/native-source", {
      headers: { "x-internal-secret": "wrong-secret" },
    }));
    assert.notEqual(missing.status, 200);
    assert.notEqual(wrong.status, 200);
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
  } finally {
    if (previousSecret == null) delete process.env.HERMES_NATIVE_INTERNAL_SECRET;
    else process.env.HERMES_NATIVE_INTERNAL_SECRET = previousSecret;
  }
});
