#!/usr/bin/env node
import pg from "pg";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listRuns, parseRunTrace } from "./lib/parse-runs.mjs";
import { redactText } from "./lib/redact.mjs";

export const CONFIG = {
  hermesBin: process.env.HERMES_BIN || "hermes",
  nativeSnapshotUrl: process.env.HERMES_NATIVE_SNAPSHOT_URL || "http://127.0.0.1:3020/api/hermes/native",
  nativeInternalSecret: process.env.HERMES_NATIVE_INTERNAL_SECRET || "",
  pollMs: safeNumber(process.env.BRIDGE_POLL_MS, 5000, 1000, 300000),
  mirrorMs: safeNumber(process.env.BRIDGE_MIRROR_MS, 30000, 10000, 300000),
  runTimeoutMs: safeNumber(process.env.BRIDGE_RUN_TIMEOUT_MS, 240000, 10000, 900000),
  fetchTimeoutMs: safeNumber(process.env.BRIDGE_FETCH_TIMEOUT_MS, 12000, 1000, 60000),
  maxPromptChars: safeNumber(process.env.BRIDGE_MAX_PROMPT_CHARS, 12000, 1, 50000),
  maxResultChars: safeNumber(process.env.BRIDGE_MAX_RESULT_CHARS, 8000, 1, 50000),
  maxEventDetailChars: 400,
  chatdevRunsDir: process.env.CHATDEV_RUNS_DIR || path.join(process.env.HOME || "", "ChatDev", "runs"),
  chatdevGoalStateDir: process.env.CHATDEV_GOAL_STATE_DIR || path.join(process.env.HOME || "", "ChatDev", "goals", "state"),
};

const CORE_REQUEST_KINDS = ["oneshot", "chat", "cron.create", "cron.run", "cron.pause", "cron.resume", "cron.remove", "cron.edit"];
const UNSUPPORTED_REQUEST_FAILURES = [
  {
    kind: "briefing.generate",
    error: "Daily briefing generation is not supported in this Mission Control release.",
  },
  {
    kind: "memory.write",
    error: "Wiki memory writes are not supported in this Mission Control release.",
  },
];
const UNSUPPORTED_REQUEST_KINDS = UNSUPPORTED_REQUEST_FAILURES.map((item) => item.kind);

const DB_URL = process.env.DATABASE_URL || "";
if (!DB_URL && import.meta.url === `file://${process.argv[1]}`) {
  console.error("DATABASE_URL is required; use a direct postgres:// production connection string.");
  process.exit(1);
}
if ((DB_URL.startsWith("prisma://") || DB_URL.startsWith("prisma+")) && import.meta.url === `file://${process.argv[1]}`) {
  console.error("DATABASE_URL must be a direct postgres:// connection string for the bridge.");
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1)/.test(DB_URL);
const pool = DB_URL
  ? new pg.Pool({ connectionString: DB_URL, max: 4, ssl: isLocal ? undefined : { rejectUnauthorized: false } })
  : null;

const log = (...args) => console.log(new Date().toISOString(), ...args.map(redact));
const q = (text, params) => pool.query(text, params);

export function hermesChat(prompt, config = CONFIG) {
  return runBoundedProcess(
    config.hermesBin,
    ["--profile", "default", "chat", "--query-file", "-", "--source", "mission-control-bridge"],
    prompt,
    { timeoutMs: config.runTimeoutMs, maxOutputChars: config.maxResultChars },
  );
}

export async function runBoundedProcess(command, args, stdinText, options) {
  const timeoutMs = options.timeoutMs;
  const maxOutputChars = options.maxOutputChars;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizedEnv(process.env),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessGroup(child.pid);
      reject(new Error("Hermes command timed out"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, maxOutputChars); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, maxOutputChars); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(redact(error.message)));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(redact(`Hermes exited ${code ?? signal ?? "unknown"}`)));
      }
    });

    child.stdin.end(stdinText, "utf8");
  });
}

export async function fetchNativeSnapshot(config = CONFIG) {
  const request = buildNativeSnapshotRequest(config);
  const secret = request.headers["x-internal-secret"];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const response = await fetch(request.url, {
      signal: controller.signal,
      redirect: "error",
      headers: request.headers,
    });
    if (!response.ok) throw new Error(`native snapshot HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("native snapshot exceeds bridge cap");
    const snapshot = validateSnapshot(redactJsonSecrets(JSON.parse(text), [secret]));
    if (snapshot.source.mode !== "local-native") throw new Error("native snapshot source is not local");
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

export function buildMirrorEnvelope(snapshot, heartbeat) {
  return {
    schemaVersion: 1,
    source: "bridge-mirror",
    mirroredAt: new Date().toISOString(),
    heartbeat: {
      db: heartbeat.db === true,
      hermesCli: heartbeat.hermesCli === true,
      nativeSnapshot: heartbeat.nativeSnapshot === true,
      detail: safeText(redact(heartbeat.detail), 500),
    },
    snapshot,
  };
}

export function buildNativeSnapshotRequest(config = CONFIG) {
  const url = validateNativeSnapshotUrl(config.nativeSnapshotUrl);
  const secret = validateNativeInternalSecret(config.nativeInternalSecret);
  return {
    url: url.toString(),
    headers: {
      Accept: "application/json",
      "x-internal-secret": secret,
    },
  };
}

export function validateBridgeConfig(config = CONFIG) {
  buildNativeSnapshotRequest(config);
  return true;
}

export function validateSnapshot(value) {
  const source = asRecord(value?.source);
  const policy = asRecord(value?.policy);
  const operatorTasks = asRecord(value?.operatorTasks);
  const goals = asRecord(value?.goals);
  const archive = asRecord(value?.archive);
  if (!source.status || !source.message || !policy.runtimeNote || !Array.isArray(value?.agents)) {
    throw new Error("native snapshot schema invalid");
  }

  return {
    source: {
      mode: source.mode === "bridge-mirror" ? "bridge-mirror" : "local-native",
      status: source.status === "ok" ? "ok" : source.status === "error" ? "error" : "warning",
      message: safeText(source.message, 300) || "Native snapshot loaded",
      roots: asRecord(source.roots),
      warnings: safeTextArray(source.warnings, 20, 300),
      errors: safeTextArray(source.errors, 20, 300),
      checkedAt: safeIso(source.checkedAt) || new Date().toISOString(),
      lastSeen: safeIso(source.lastSeen) || safeIso(source.checkedAt),
      stale: source.stale === true,
    },
    policy: {
      primaryCloudOrchestrator: safeText(policy.primaryCloudOrchestrator, 100) || "default",
      alwaysOnWorkers: policy.alwaysOnWorkers === true,
      modelLoadsPermittedByRoster: policy.modelLoadsPermittedByRoster === true,
      langfuseMode: safeText(policy.langfuseMode, 200) || "metadata-only",
      runtimeNote: safeText(policy.runtimeNote, 500) || "Native policy unavailable.",
    },
    agents: value.agents.slice(0, 50).map(sanitizeAgent).filter(Boolean),
    operatorTasks: {
      updatedAt: safeIso(operatorTasks.updatedAt),
      tasks: (Array.isArray(operatorTasks.tasks) ? operatorTasks.tasks : []).slice(0, 200).map(sanitizeTask).filter(Boolean),
      counts: numericRecord(operatorTasks.counts),
    },
    goals: {
      live: sanitizeLiveGoals(goals.live),
      counts: numericRecord(goals.counts),
      current: goals.current ? sanitizeGoal(goals.current) : null,
      recentFailed: (Array.isArray(goals.recentFailed) ? goals.recentFailed : []).slice(0, 20).map(sanitizeGoal).filter(Boolean),
    },
    archive: {
      root: safeText(archive.root, 500) || "",
      counts: numericRecord(archive.counts),
      artifact_counts: numericRecord(archive.artifact_counts),
      manifestSha256: safeHash(archive.manifestSha256),
      recent: (Array.isArray(archive.recent) ? archive.recent : []).slice(0, 100).map(sanitizeGoal).filter(Boolean),
      recentArtifacts: (Array.isArray(archive.recentArtifacts) ? archive.recentArtifacts : []).slice(0, 100).map(sanitizeArtifact).filter(Boolean),
    },
  };
}

async function setStore(key, data) {
  await q(
    `INSERT INTO "DataStore" (key, data, "updatedAt") VALUES ($1,$2, now())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, "updatedAt" = now()`,
    [key, JSON.stringify(data)],
  );
}

async function emit(kind, title, { detail = null, agent = "hermes", level = "info", meta = null } = {}) {
  await q(
    `INSERT INTO "AgentEvent" (id, kind, title, detail, agent, level, meta, "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [
      randomUUID(),
      safeText(kind, 60) || "activity",
      safeText(title, 200) || "Hermes event",
      detail ? safeText(redact(detail), CONFIG.maxEventDetailChars) : null,
      safeText(agent, 80) || "hermes",
      safeText(level, 20) || "info",
      meta ? JSON.stringify(meta) : null,
    ],
  );
}

async function mirrorNative() {
  let snapshot = null;
  let cliReady = false;
  let detail = null;

  try {
    snapshot = await fetchNativeSnapshot();
  } catch (error) {
    detail = redact(error.message);
  }

  try {
    await runBoundedProcess(CONFIG.hermesBin, ["--version"], "", { timeoutMs: 8000, maxOutputChars: 1000 });
    cliReady = true;
  } catch (error) {
    detail = detail || redact(error.message);
  }

  const envelope = buildMirrorEnvelope(snapshot || emptySnapshot(detail), {
    db: true,
    hermesCli: cliReady,
    nativeSnapshot: Boolean(snapshot) && snapshot.source.status !== "error",
    detail,
  });
  await setStore("hermes-native", envelope);
}

async function mirrorCrons() {
  try {
    const out = await runBoundedProcess(CONFIG.hermesBin, ["cron", "list", "--all"], "", {
      timeoutMs: 15000,
      maxOutputChars: 8000,
    });
    await setStore("hermes-crons", {
      jobs: out.split("\n").map((line) => line.trimEnd()).filter(Boolean),
      raw: out.slice(0, 8000),
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    log("cron list failed:", error.message);
  }
}

async function mirrorRuns() {
  const syncedAt = new Date().toISOString();
  const secrets = knownSecrets();
  try {
    await fs.access(CONFIG.chatdevRunsDir);
  } catch {
    await setStore("hermes-runs", { index: [], graphs: {}, syncedAt });
    return;
  }

  try {
    const index = await listRuns(CONFIG.chatdevRunsDir, { goalStateDir: CONFIG.chatdevGoalStateDir, secrets });
    const graphs = {};
    const maxPayloadBytes = 1_500_000;
    let payloadBytes = Buffer.byteLength(JSON.stringify({ index, graphs, syncedAt }));
    // Build graphs for every non-trivial run in the index (top 12 by recency).
    // Do NOT filter by an allow-list of statuses: the conveyor emits many
    // statuses (shipping, blocked, materializing, recovered, ...) and any run
    // present in the index should have a resolvable graph, else /api/runs/[goal] 404s.
    const candidates = index.slice(0, 12);

    for (const run of candidates) {
      try {
        const graph = await parseRunTrace(path.join(CONFIG.chatdevRunsDir, run.goal), {
          goalStateDir: CONFIG.chatdevGoalStateDir,
          secrets,
        });
        const graphJson = JSON.stringify(graph);
        const entryBytes = Buffer.byteLength(`${JSON.stringify(run.goal)}:${graphJson}`) + (Object.keys(graphs).length ? 1 : 0);
        if (payloadBytes + entryBytes > maxPayloadBytes) break;
        graphs[run.goal] = graph;
        payloadBytes += entryBytes;
      } catch (error) {
        log("run trace parse failed:", run.goal, error.message);
      }
    }

    const payload = { index, graphs, syncedAt };
    await setStore("hermes-runs", payload);
  } catch (error) {
    log("runs mirror failed:", error.message);
    await setStore("hermes-runs", { index: [], graphs: {}, syncedAt });
  }
}

async function failLegacyRequests() {
  await q(
    `UPDATE "AgentRequest"
     SET status='failed', error=$1, "finishedAt"=now(), "updatedAt"=now()
     WHERE status IN ('queued','approved') AND kind <> ALL($2::text[]) AND kind <> ALL($3::text[])`,
    ["Legacy request kind is no longer supported by native Mission Control.", requestKindsForPolicy(), UNSUPPORTED_REQUEST_KINDS],
  );
}

async function failUnsupportedRequests() {
  for (const failure of unsupportedRequestFailures()) {
    await q(
      `UPDATE "AgentRequest"
       SET status='failed', error=$2, "finishedAt"=now(), "updatedAt"=now()
       WHERE status IN ('queued','approved') AND kind=$1`,
      [failure.kind, failure.error],
    );
  }
}

async function runRequest(request) {
  await q(`UPDATE "AgentRequest" SET status='running', "startedAt"=now(), "updatedAt"=now() WHERE id=$1`, [request.id]);
  await emit("run", `Started: ${request.title}`, { level: "info", meta: { requestId: request.id, kind: request.kind } });
  try {
    const prompt = safePrompt(request.prompt || request.title);
    let result = "";
    if (request.kind === "oneshot" || request.kind === "chat") {
      result = await hermesChat(prompt);
    } else if (request.kind.startsWith("cron.")) {
      result = await runCronRequest(request.kind, request.prompt);
      await mirrorCrons();
    } else {
      throw new Error("Unsupported native request kind.");
    }
    await q(
      `UPDATE "AgentRequest" SET status='done', result=$2, "finishedAt"=now(), "updatedAt"=now() WHERE id=$1`,
      [request.id, safeText(result, CONFIG.maxResultChars)],
    );
    await emit("run", `Done: ${request.title}`, { level: "up", detail: "Hermes request completed.", meta: { requestId: request.id, kind: request.kind } });
  } catch (error) {
    const msg = safeText(redact(error.message), 600) || "Hermes request failed.";
    await q(`UPDATE "AgentRequest" SET status='failed', error=$2, "finishedAt"=now(), "updatedAt"=now() WHERE id=$1`, [request.id, msg]);
    await emit("run", `Failed: ${request.title}`, { level: "down", detail: msg, meta: { requestId: request.id, kind: request.kind } });
    log("request failed:", request.id, msg);
  }
}

async function runCronRequest(kind, prompt) {
  const payload = parseJsonObject(prompt);
  const op = kind.split(".")[1];
  const id = safeText(payload.id || payload.name, 200);
  const schedule = safeText(payload.schedule, 200);
  const cronPrompt = safeText(payload.prompt || payload.name, 2000);
  const argv =
    op === "create" ? ["cron", "create", schedule, cronPrompt].filter(Boolean)
    : op === "run" ? ["cron", "run", id]
    : op === "pause" ? ["cron", "pause", id]
    : op === "resume" ? ["cron", "resume", id]
    : op === "remove" ? ["cron", "remove", id]
    : op === "edit" ? ["cron", "edit", id]
    : null;
  if (!argv || argv.some((item) => !item)) throw new Error("Invalid cron request.");
  return await runBoundedProcess(CONFIG.hermesBin, argv, "", { timeoutMs: 20000, maxOutputChars: CONFIG.maxResultChars });
}

async function processQueue() {
  await failUnsupportedRequests();
  await failLegacyRequests();
  const { rows } = await q(
    `SELECT * FROM "AgentRequest"
     WHERE status IN ('queued','approved') AND kind = ANY($1::text[])
     ORDER BY "createdAt" ASC LIMIT 3`,
    [requestKindsForPolicy()],
  );
  for (const row of rows) await runRequest(row);
}

export function requestKindsForPolicy() {
  return [...CORE_REQUEST_KINDS];
}

export function unsupportedRequestFailures() {
  return UNSUPPORTED_REQUEST_FAILURES.map((item) => ({ kind: item.kind, error: item.error }));
}

async function mirrorTick() {
  try { await mirrorNative(); } catch (error) { log("native mirror failed:", error.message); }
  try { await mirrorCrons(); } catch (error) { log("cron mirror failed:", error.message); }
  try { await mirrorRuns(); } catch (error) { log("runs mirror failed:", error.message); }
}

async function main() {
  validateBridgeConfig();
  log(`hermes native bridge up; poll=${CONFIG.pollMs}ms mirror=${CONFIG.mirrorMs}ms`);
  await emit("status", "Native bridge connected", { level: "up", detail: "Bridge started with native mirror mode." });
  await mirrorTick();
  setInterval(() => mirrorTick().catch((error) => log("mirror loop", error.message)), CONFIG.mirrorMs);
  const tick = async () => {
    try { await processQueue(); } catch (error) { log("queue loop", error.message); }
    finally { setTimeout(tick, CONFIG.pollMs); }
  };
  tick();
}

function emptySnapshot(detail) {
  const now = new Date().toISOString();
  return {
    source: {
      mode: "local-native",
      status: "error",
      message: "Native snapshot unavailable to bridge",
      roots: { missionControl: "", profiles: "", runtime: "", archive: "" },
      warnings: [],
      errors: [safeText(detail, 300) || "native snapshot unavailable"],
      checkedAt: now,
      lastSeen: null,
      stale: true,
    },
    policy: {
      primaryCloudOrchestrator: "default",
      alwaysOnWorkers: false,
      modelLoadsPermittedByRoster: false,
      langfuseMode: "metadata-only",
      runtimeNote: "Native snapshot unavailable; no agents synthesized.",
    },
    agents: [],
    operatorTasks: { updatedAt: null, tasks: [], counts: {} },
    goals: { live: { ready: [], running: [], done: [], failed: [] }, counts: { ready: 0, running: 0, done: 0, failed: 0 }, current: null, recentFailed: [] },
    archive: { root: "", counts: { done: 0, failed: 0, total: 0 }, artifact_counts: { done: 0, failed: 0, total: 0 }, manifestSha256: null, recent: [], recentArtifacts: [] },
  };
}

function sanitizeAgent(value) {
  const row = asRecord(value);
  const id = safeSlug(row.id || row.profile);
  if (!id) return null;
  return {
    id,
    profile: safeSlug(row.profile) || id,
    name: safeText(row.name, 120) || id,
    role: safeText(row.role, 300) || "Hermes profile",
    modelClass: row.modelClass === "cloud" ? "cloud" : "local",
    model: safeText(row.model, 120) || "unknown",
    provider: safeText(row.provider, 120) || "unknown",
    status: row.status === "running" ? "running" : row.status === "stopped" ? "stopped" : "on-demand",
    capabilities: safeTextArray(row.capabilities, 8, 120),
    forbiddenActions: safeTextArray(row.forbiddenActions, 8, 120),
    cloudOrchestratorCallWhen: safeText(row.cloudOrchestratorCallWhen, 300),
    langfuseCoverage: safeText(row.langfuseCoverage, 200) || "metadata-only",
    compressionPolicy: safeText(row.compressionPolicy, 200) || "not declared",
    contextLength: safeInteger(row.contextLength),
    statusNote: safeText(row.statusNote, 200) || "not declared",
  };
}

function sanitizeTask(value) {
  const row = asRecord(value);
  const id = safeSlug(row.id);
  const title = safeText(row.title, 180);
  if (!id || !title) return null;
  return {
    id,
    title,
    status: ["in_progress", "pending", "done", "blocked"].includes(row.status) ? row.status : "pending",
    priority: ["high", "medium", "low"].includes(row.priority) ? row.priority : "medium",
    updatedAt: safeIso(row.updatedAt),
  };
}

function sanitizeLiveGoals(value) {
  const record = asRecord(value);
  return {
    ready: safeGoalArray(record.ready),
    running: safeGoalArray(record.running),
    done: safeGoalArray(record.done),
    failed: safeGoalArray(record.failed),
  };
}

function safeGoalArray(value) {
  return (Array.isArray(value) ? value : []).slice(0, 50).map(sanitizeGoal).filter(Boolean);
}

function sanitizeGoal(value) {
  const row = asRecord(value);
  const id = safeText(row.id, 240);
  const title = safeText(row.title, 180);
  if (!id || !title) return null;
  const state = ["ready", "running", "done", "failed"].includes(row.state) ? row.state : "ready";
  return {
    id,
    title,
    state,
    source: row.source === "archive" ? "archive" : "live-native",
    status: safeText(row.status, 80),
    updatedAt: safeIso(row.updatedAt),
    evidence: safeTextArray(row.evidence, 5, 180),
    bytes: safeInteger(row.bytes) ?? 0,
    sha256: safeHash(row.sha256) || undefined,
  };
}

function sanitizeArtifact(value) {
  const row = asRecord(value);
  const id = safeText(row.id, 240);
  const path = safeText(row.path, 360);
  if (!id || !path) return null;
  return {
    id,
    status: row.status === "failed" ? "failed" : "done",
    name: safeText(row.name, 180) || path,
    path,
    goal: safeText(row.goal, 180),
    bytes: safeInteger(row.bytes) ?? 0,
    sha256: safeHash(row.sha256) || "",
  };
}

function safePrompt(value) {
  const text = typeof value === "string" ? value : "";
  if (!text.trim()) throw new Error("Prompt is required.");
  if (text.length > CONFIG.maxPromptChars) throw new Error("Prompt exceeds bridge size cap.");
  return text;
}

function sanitizedEnv(env) {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    TERM: env.TERM,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
  };
}

function appendBounded(current, chunk, max) {
  const next = current + String(chunk);
  return next.length > max ? next.slice(0, max) : next;
}

function killProcessGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1500).unref();
}

export function redact(value) {
  return redactText(value, knownSecrets());
}

function validateNativeInternalSecret(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("HERMES_NATIVE_INTERNAL_SECRET is required.");
  }
  const secret = value.trim();
  if (secret.length < 16 || secret.length > 512) {
    throw new Error("HERMES_NATIVE_INTERNAL_SECRET length is invalid.");
  }
  if (/[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error("HERMES_NATIVE_INTERNAL_SECRET contains invalid characters.");
  }
  return secret;
}

function validateNativeSnapshotUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HERMES_NATIVE_SNAPSHOT_URL must be a localhost URL.");
  }
  const hostname = url.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "http:" || !isLoopback || url.pathname !== "/api/hermes/native" || url.search || url.hash || url.username || url.password) {
    throw new Error("HERMES_NATIVE_SNAPSHOT_URL must be http localhost /api/hermes/native.");
  }
  return url;
}

function knownSecrets() {
  return [CONFIG.nativeInternalSecret].filter((secret) => typeof secret === "string" && secret.length >= 8);
}

function redactJsonSecrets(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonSecrets(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJsonSecrets(item, secrets)]));
  }
  return value;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "{}");
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function safeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function safeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function numericRecord(value) {
  const record = asRecord(value);
  const out = {};
  for (const [key, raw] of Object.entries(record)) {
    const parsed = safeInteger(raw);
    if (parsed != null && /^[a-z_]+$/i.test(key)) out[key] = parsed;
  }
  return out;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/(api[_-]?key|secret|token|password|authorization|bearer\s+|sk-[a-z0-9])/i.test(text)) return null;
  return text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function safeTextArray(value, maxRows, maxText) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const text = safeText(item, maxText);
    return text ? [text] : [];
  }).slice(0, maxRows);
}

function safeSlug(value) {
  const text = safeText(value, 100);
  return text && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(text) ? text : null;
}

function safeIso(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("fatal", redact(error.stack || error.message));
    process.exit(1);
  });
}
