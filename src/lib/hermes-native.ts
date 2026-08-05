import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

type GoalState = "ready" | "running" | "done" | "failed";
type HealthStatus = "ok" | "warning" | "error";
type NativeSourceMode = "local-native" | "remote-native-source";

const DEFAULT_MISSION_ROOT = "/home/phillip_downs/.hermes/mission-control";
const DEFAULT_PROFILES_ROOT = "/home/phillip_downs/.hermes/profiles";
const GOAL_STATES: GoalState[] = ["ready", "running", "done", "failed"];
const MAX_JSON_BYTES = 256 * 1024;
const MAX_GOAL_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_ARCHIVE_ROWS = 40;
const MAX_GOAL_ROWS_PER_STATE = 25;
const MAX_CRON_BYTES = 256 * 1024;
const MAX_CRON_ROWS = 200;
const MAX_REMOTE_AGENTS = 80;
const MAX_REMOTE_TASKS = 100;
const MAX_REMOTE_WARNINGS = 20;
const MAX_REMOTE_STRING = 180;
const MAX_REMOTE_BYTES = 2 * 1024 * 1024;
const REMOTE_CACHE_MS = 7000;
const REMOTE_TIMEOUT_MS = 8000;
const SECRET_PATTERN =
  /(api[_-]?key|secret|token|password|authorization|bearer\s+|sk-[a-z0-9]|pk-[a-z0-9]|AKIA[0-9A-Z]{16})/i;
const execFileAsync = promisify(execFile);

export interface HermesNativeAgent {
  id: string;
  profile: string;
  name: string;
  role: string;
  modelClass: "local" | "cloud";
  model: string;
  provider: string;
  status: "running" | "on-demand" | "stopped";
  capabilities: string[];
  forbiddenActions: string[];
  cloudOrchestratorCallWhen: string | null;
  langfuseCoverage: string;
  compressionPolicy: string;
  contextLength: number | null;
  statusNote: string;
}

export interface HermesOperatorTask {
  id: string;
  title: string;
  status: "in_progress" | "pending" | "done" | "blocked";
  priority: "high" | "medium" | "low";
  updatedAt: string | null;
}

export interface HermesGoalSummary {
  id: string;
  title: string;
  state: GoalState;
  source: "live-native" | "archive";
  status: string | null;
  updatedAt: string | null;
  evidence: string[];
  bytes: number;
  sha256?: string;
}

export interface HermesArchiveArtifactSummary {
  id: string;
  status: "done" | "failed";
  name: string;
  path: string;
  goal: string | null;
  bytes: number;
  sha256: string;
}

export interface HermesNativeSourceHealth {
  mode: NativeSourceMode;
  status: HealthStatus;
  message: string;
  roots: {
    missionControl: string;
    profiles: string;
    runtime: string;
    archive: string;
  };
  warnings: string[];
  errors: string[];
  checkedAt: string;
  lastSeen: string | null;
  stale: boolean;
}

export interface HermesNativeSnapshot {
  source: HermesNativeSourceHealth;
  policy: {
    primaryCloudOrchestrator: string;
    alwaysOnWorkers: boolean;
    modelLoadsPermittedByRoster: boolean;
    langfuseMode: string;
    runtimeNote: string;
  };
  agents: HermesNativeAgent[];
  operatorTasks: {
    updatedAt: string | null;
    tasks: HermesOperatorTask[];
    counts: Record<string, number>;
  };
  goals: {
    live: Record<GoalState, HermesGoalSummary[]>;
    counts: Record<GoalState, number>;
    current: HermesGoalSummary | null;
    recentFailed: HermesGoalSummary[];
  };
  archive: {
    root: string;
    counts: { done: number; failed: number; total: number };
    artifact_counts: { done: number; failed: number; total: number };
    manifestSha256: string | null;
    recent: HermesGoalSummary[];
    recentArtifacts: HermesArchiveArtifactSummary[];
  };
}

export type HermesCronJob = {
  id: string;
  status: string;
  name: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  deliver: string | null;
  skills: string | null;
  mode: string | null;
};

export interface HermesCronSnapshot {
  source: "local-hermes-cli" | "unavailable";
  status: HealthStatus;
  message: string;
  jobs: HermesCronJob[];
  syncedAt: string | null;
  warnings: string[];
}

export interface HermesNativeSourceEnvelope {
  schemaVersion: 1;
  source: "hermes-native-source";
  generatedAt: string;
  snapshot: HermesNativeSnapshot;
  crons: HermesCronSnapshot;
}

interface NativeRoots {
  missionControlRoot?: string;
  profilesRoot?: string;
}

interface SafeContext {
  warnings: string[];
  errors: string[];
}

interface ArchiveManifestRow {
  status: "done" | "failed";
  kind: "goal" | "artifact";
  name: string;
  path: string;
  goal: string | null;
  bytes: number;
  sha256: string;
}

let remoteCache:
  | {
      expiresAt: number;
      envelope: HermesNativeSourceEnvelope;
    }
  | null = null;

export async function readHermesNativeSnapshot(
  roots: NativeRoots = {},
): Promise<HermesNativeSnapshot> {
  const missionControlRoot = roots.missionControlRoot ?? DEFAULT_MISSION_ROOT;
  const profilesRoot = roots.profilesRoot ?? DEFAULT_PROFILES_ROOT;
  const ctx: SafeContext = { warnings: [], errors: [] };
  const checkedAt = new Date().toISOString();

  const [roster, operatorTasks, goals, archive] = await Promise.all([
    readRoster(missionControlRoot, profilesRoot, ctx),
    readOperatorTasks(missionControlRoot, ctx),
    readLiveGoals(missionControlRoot, ctx),
    readArchive(missionControlRoot, ctx),
  ]);

  const status: HealthStatus = ctx.errors.length ? "error" : ctx.warnings.length ? "warning" : "ok";
  const current = goals.running[0] ?? goals.ready[0] ?? null;

  return {
    source: {
      mode: "local-native",
      status,
      message:
        status === "ok"
          ? "Native Hermes truth loaded"
          : status === "error"
            ? "Native Hermes truth unavailable or failed validation"
            : "Native Hermes truth loaded with bounded-reader warnings",
      roots: {
        missionControl: missionControlRoot,
        profiles: profilesRoot,
        runtime: path.join(missionControlRoot, "runtime"),
        archive: path.join(missionControlRoot, "archive/goals"),
      },
      warnings: ctx.warnings.slice(0, 20),
      errors: ctx.errors.slice(0, 20),
      checkedAt,
      lastSeen: checkedAt,
      stale: false,
    },
    policy: roster.policy,
    agents: roster.agents,
    operatorTasks,
    goals: {
      live: goals,
      counts: countGoalStates(goals),
      current,
      recentFailed: goals.failed.slice(0, 5),
    },
    archive,
  };
}

export async function readHermesNativeSourceEnvelope(
  roots: NativeRoots = {},
): Promise<HermesNativeSourceEnvelope> {
  const [snapshot, crons] = await Promise.all([
    readHermesNativeSnapshot(roots),
    readHermesCronSnapshot(),
  ]);

  return {
    schemaVersion: 1,
    source: "hermes-native-source",
    generatedAt: new Date().toISOString(),
    snapshot,
    crons,
  };
}

export async function readHermesNativeEnvelopeForServer(): Promise<HermesNativeSourceEnvelope> {
  const local = await readHermesNativeSourceEnvelope();
  if (local.snapshot.source.status !== "error") return local;

  const remote = await fetchHermesNativeSourceEnvelope().catch((error) => {
    return buildUnavailableEnvelope(`Remote native source unavailable: ${safeError(error)}`);
  });
  return remote;
}

export async function readHermesNativeSnapshotForServer(): Promise<HermesNativeSnapshot> {
  const local = await readHermesNativeSnapshot();
  if (local.source.status !== "error") return local;
  return (await fetchHermesNativeSourceEnvelope().catch((error) => {
    return buildUnavailableEnvelope(`Remote native source unavailable: ${safeError(error)}`);
  })).snapshot;
}

export async function readHermesCronSnapshotForServer(
  remoteOptions: Parameters<typeof fetchHermesNativeSourceEnvelope>[0] = {},
): Promise<HermesCronSnapshot> {
  const local = await readHermesCronSnapshot();
  if (local.source !== "unavailable" && local.status !== "error") return local;

  return (await fetchHermesNativeSourceEnvelope(remoteOptions).catch((error) => {
    return buildUnavailableEnvelope(`Remote native source unavailable: ${safeError(error)}`);
  })).crons;
}

export async function readHermesNativeHealthForServer() {
  const snapshot = await readHermesNativeSnapshotForServer();
  const nativeReady = snapshot.source.status !== "error";
  return {
    online: nativeReady,
    gateway: snapshot.source.mode,
    detail: snapshot.source.errors[0] ?? snapshot.source.warnings[0] ?? null,
    lastSeen: snapshot.source.lastSeen ?? snapshot.source.checkedAt,
    stale: snapshot.source.stale === true,
    ageMs: ageMs(snapshot.source.lastSeen ?? snapshot.source.checkedAt),
    source: snapshot.source.mode,
    checks: {
      nativeSnapshot: nativeReady,
      remoteSource: snapshot.source.mode === "remote-native-source",
    },
  };
}

export function isHermesNativeSnapshotStale(iso: string, nowMs = Date.now(), maxAgeMs = 90_000) {
  const testedAge = nowMs - Date.parse(iso);
  return !Number.isFinite(testedAge) || testedAge > maxAgeMs;
}

export async function fetchHermesNativeSourceEnvelope(
  options: {
    snapshotUrl?: string;
    internalSecret?: string;
    fetchImpl?: typeof fetch;
    nowMs?: number;
  } = {},
): Promise<HermesNativeSourceEnvelope> {
  const now = options.nowMs ?? Date.now();
  if (!options.snapshotUrl && !options.internalSecret && remoteCache && remoteCache.expiresAt > now) {
    return remoteCache.envelope;
  }

  const snapshotUrl = options.snapshotUrl ?? process.env.HERMES_NATIVE_SNAPSHOT_URL ?? "";
  const internalSecret = options.internalSecret ?? process.env.HERMES_NATIVE_INTERNAL_SECRET ?? "";
  const request = buildHermesNativeSourceRequest(snapshotUrl, internalSecret);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);

  try {
    const res = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error("native source redirects are rejected");
    }
    if (!res.ok) {
      throw new Error(`native source returned HTTP ${res.status}`);
    }

    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_BYTES) {
      throw new Error("native source payload exceeds 2 MB cap");
    }

    const text = await readResponseTextCapped(res, MAX_REMOTE_BYTES);
    const parsed = JSON.parse(text) as unknown;
    const redacted = redactSecretValue(parsed, internalSecret);
    const envelope = validateHermesNativeSourceEnvelope(redacted);
    envelope.snapshot.source = {
      ...envelope.snapshot.source,
      mode: "remote-native-source",
      message: envelope.snapshot.source.status === "error"
        ? envelope.snapshot.source.message
        : "Native Hermes truth loaded from signed remote source",
      checkedAt: new Date().toISOString(),
      lastSeen: envelope.generatedAt,
      stale: false,
    };

    if (!options.snapshotUrl && !options.internalSecret) {
      remoteCache = { expiresAt: now + REMOTE_CACHE_MS, envelope };
    }

    return envelope;
  } catch (error) {
    throw new Error(redactSecretText(safeError(error), internalSecret));
  } finally {
    clearTimeout(timeout);
  }
}

export function buildHermesNativeSourceRequest(snapshotUrl: string, internalSecret: string) {
  if (!internalSecret.trim()) throw new Error("HERMES_NATIVE_INTERNAL_SECRET is required");
  const url = validateHermesNativeSourceUrl(snapshotUrl);
  return {
    url: url.toString(),
    headers: {
      Accept: "application/json",
      "x-internal-secret": internalSecret,
    },
  };
}

export function validateHermesNativeSourceUrl(value: string) {
  if (!value.trim()) throw new Error("HERMES_NATIVE_SNAPSHOT_URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("HERMES_NATIVE_SNAPSHOT_URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("HERMES_NATIVE_SNAPSHOT_URL must not include credentials, query, or hash");
  }
  const allowedPath = url.pathname === "/hermes-native" || url.pathname === "/api/hermes/native-source";
  if (!allowedPath) throw new Error("HERMES_NATIVE_SNAPSHOT_URL path is not approved");
  const allowedPort = url.port === "" || url.port === "443" || url.port === "10000";
  if (!allowedPort) throw new Error("HERMES_NATIVE_SNAPSHOT_URL port is not approved");
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/i.test(url.hostname)) {
    throw new Error("HERMES_NATIVE_SNAPSHOT_URL host must be a Tailscale Funnel hostname");
  }
  return url;
}

export function validateHermesNativeSourceEnvelope(value: unknown): HermesNativeSourceEnvelope {
  const record = asRecord(value);
  if (
    record.schemaVersion !== 1 ||
    record.source !== "hermes-native-source" ||
    !safeIso(record.generatedAt)
  ) {
    throw new Error("native source schema invalid");
  }

  return {
    schemaVersion: 1,
    source: "hermes-native-source",
    generatedAt: safeIso(record.generatedAt) as string,
    snapshot: parseRemoteSnapshot(record.snapshot),
    crons: parseRemoteCronSnapshot(record.crons),
  };
}

export async function readHermesCronSnapshot(): Promise<HermesCronSnapshot> {
  const syncedAt = new Date().toISOString();
  try {
    const { stdout } = await execFileAsync("hermes", ["cron", "list", "--all"], {
      timeout: 4000,
      maxBuffer: MAX_CRON_BYTES,
      env: minimalHermesEnv(),
      encoding: "utf8",
    });
    const jobs = parseHermesCronList(stdout).slice(0, MAX_CRON_ROWS);
    return {
      source: "local-hermes-cli",
      status: "ok",
      message: "Hermes cron list loaded",
      jobs,
      syncedAt,
      warnings: [],
    };
  } catch (error) {
    return {
      source: "unavailable",
      status: "warning",
      message: "Hermes cron list unavailable",
      jobs: [],
      syncedAt: null,
      warnings: [safeError(error)],
    };
  }
}

export function parseHermesCronList(raw: string): HermesCronJob[] {
  const jobs: HermesCronJob[] = [];
  let cur: HermesCronJob | null = null;
  const push = () => {
    if (!cur) return;
    if (cur.id && (cur.name || cur.schedule)) jobs.push(cur);
  };

  for (const line of raw.slice(0, MAX_CRON_BYTES).split("\n")) {
    const head = line.match(/^\s{2}([0-9a-f]{6,})\s+\[([a-z_ -]{1,32})\]/i);
    if (head) {
      push();
      cur = {
        id: head[1],
        status: sanitizeCronText(head[2]) ?? "unknown",
        name: "",
        schedule: "",
        nextRun: null,
        lastRun: null,
        lastResult: null,
        deliver: null,
        skills: null,
        mode: null,
      };
      continue;
    }

    const kv = line.match(/^\s{4}([A-Za-z][A-Za-z ]{0,40}?):\s+(.*)$/);
    if (!kv || !cur) continue;
    const key = kv[1].trim().toLowerCase();
    const val = sanitizeCronText(kv[2]);
    if (!val) continue;

    if (key === "name") cur.name = val;
    else if (key === "schedule") cur.schedule = val;
    else if (key === "next run") cur.nextRun = val;
    else if (key === "deliver") cur.deliver = val.split(":")[0] ?? val;
    else if (key === "skills") cur.skills = val;
    else if (key === "mode") cur.mode = val;
    else if (key === "last run") {
      const m = val.match(/^(\S+)\s+(.*)$/);
      cur.lastRun = m ? m[1] : val;
      cur.lastResult = m ? sanitizeCronText(m[2]) : null;
    }
  }
  push();
  return jobs.slice(0, MAX_CRON_ROWS);
}

async function readRoster(root: string, profilesRoot: string, ctx: SafeContext) {
  const rosterRead = await readTextWithStatsAtRoot(root, "agent-roster.json", MAX_JSON_BYTES, ctx, true);
  if (!rosterRead) return emptyRosterPolicy("agent-roster.json unavailable");

  const payload = parseJsonStrict(rosterRead.text, ctx, "agent-roster.json");
  if (!payload) return emptyRosterPolicy("agent-roster.json invalid");

  const record = asRecord(payload);
  const policyRecord = asRecord(record.policy);
  const langfuseMode = safeString(policyRecord.langfuse_mode) ?? "metadata-only";
  const primary = safeString(policyRecord.primary_cloud_orchestrator) ?? "default";
  const profiles = arrayValue(record.profiles);
  if (!profiles || profiles.length === 0) {
    ctx.warnings.push("agent-roster.json: no configured profiles; no agents reported");
    return emptyRosterPolicy("agent-roster.json empty", primary, langfuseMode, policyRecord);
  }

  const agents: HermesNativeAgent[] = [];

  for (const item of profiles) {
    const row = asRecord(item);
    const profile = slugString(row.profile);
    if (!profile) continue;
    const config = await readProfileHints(profilesRoot, profile, ctx);
    const statusNote = safeString(row.status_note) ?? "on-demand specialist";
    const isDefault = profile === primary;
    agents.push({
      id: profile,
      profile,
      name: displayName(profile),
      role: safeString(row.role) ?? "Hermes specialist",
      modelClass: row.model_class === "cloud" ? "cloud" : "local",
      model: safeString(row.model) ?? config.model ?? "unknown",
      provider: safeString(row.provider) ?? config.provider ?? "unknown",
      status: isDefault ? "running" : statusNote.includes("retired") ? "stopped" : "on-demand",
      capabilities: stringArray(row.capabilities).slice(0, 8),
      forbiddenActions: stringArray(row.forbidden_actions).slice(0, 8),
      cloudOrchestratorCallWhen: safeString(row.cloud_orchestrator_call_when),
      langfuseCoverage: langfuseMode,
      compressionPolicy: config.compressionPolicy ?? "not declared",
      contextLength: config.contextLength,
      statusNote,
    });
  }

  agents.sort((a, b) => (a.profile === primary ? -1 : b.profile === primary ? 1 : a.profile.localeCompare(b.profile)));

  return {
    policy: {
      primaryCloudOrchestrator: primary,
      alwaysOnWorkers: Boolean(policyRecord.always_on_workers),
      modelLoadsPermittedByRoster: Boolean(policyRecord.model_loads_permitted_by_roster),
      langfuseMode,
      runtimeNote: agents.some((agent) => agent.profile === primary)
        ? "Only roster-declared running profiles are shown as running; specialists are on-demand to reduce cost."
        : "Primary cloud orchestrator is not present in the roster; no running default was synthesized.",
    },
    agents,
  };
}

function emptyRosterPolicy(
  reason: string,
  primary = "default",
  langfuseMode = "metadata-only",
  policyRecord: Record<string, unknown> = {},
) {
  return {
    policy: {
      primaryCloudOrchestrator: primary,
      alwaysOnWorkers: Boolean(policyRecord.always_on_workers),
      modelLoadsPermittedByRoster: Boolean(policyRecord.model_loads_permitted_by_roster),
      langfuseMode,
      runtimeNote: `No Hermes agents reported: ${reason}.`,
    },
    agents: [] as HermesNativeAgent[],
  };
}

async function readProfileHints(root: string, profile: string, ctx: SafeContext) {
  const rel = path.join(profile, "config.yaml");
  const text = await readTextAtRoot(root, rel, MAX_CONFIG_BYTES, ctx, false);
  if (!text) return { compressionPolicy: null, contextLength: null, model: null, provider: null };

  const withoutSecretLines = text
    .split(/\r?\n/)
    .filter((line) => !SECRET_PATTERN.test(line))
    .join("\n");
  const contextLength = firstNumber(withoutSecretLines.match(/context_length:\s*(\d+)/)?.[1]);
  const model = safeString(withoutSecretLines.match(/(?:^|\n)\s*default:\s*([^\n]+)/)?.[1]);
  const provider = safeString(withoutSecretLines.match(/(?:^|\n)\s*provider:\s*([^\n]+)/)?.[1]);
  const compressionEnabled = withoutSecretLines.match(/compression:[\s\S]*?enabled:\s*(true|false)/)?.[1];
  const threshold = withoutSecretLines.match(/compression:[\s\S]*?threshold:\s*([0-9.]+)/)?.[1];
  const target = withoutSecretLines.match(/compression:[\s\S]*?target_ratio:\s*([0-9.]+)/)?.[1];
  const compressionPolicy =
    compressionEnabled == null
      ? null
      : `enabled=${compressionEnabled}${threshold ? ` threshold=${threshold}` : ""}${target ? ` target=${target}` : ""}`;

  return {
    compressionPolicy,
    contextLength,
    model,
    provider,
  };
}

async function readOperatorTasks(root: string, ctx: SafeContext) {
  const payload = await readJsonAtRoot(root, "operator-tasks.json", MAX_JSON_BYTES, ctx);
  const record = asRecord(payload);
  const rows = arrayValue(record.tasks) ?? [];
  const tasks: HermesOperatorTask[] = rows.flatMap((item) => {
    const row = asRecord(item);
    const id = slugString(row.id);
    const title = safeDisplayText(row.title);
    if (!id || !title) return [];
    const status = normalizeTaskStatus(row.status);
    return [{
      id,
      title,
      status,
      priority: normalizePriority(row.priority),
      updatedAt: safeIso(row.updated_at ?? row.updatedAt) ?? safeIso(record.updated_at ?? record.updatedAt),
    }];
  });

  return {
    updatedAt: safeIso(record.updated_at ?? record.updatedAt),
    tasks,
    counts: tasks.reduce<Record<string, number>>((acc, task) => {
      acc[task.status] = (acc[task.status] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

async function readLiveGoals(root: string, ctx: SafeContext): Promise<Record<GoalState, HermesGoalSummary[]>> {
  const result: Record<GoalState, HermesGoalSummary[]> = {
    ready: [],
    running: [],
    done: [],
    failed: [],
  };

  await Promise.all(GOAL_STATES.map(async (state) => {
    const relDir = path.join("runtime/goals", state);
    const entries = await listFilesAtRoot(root, relDir, ctx, MAX_GOAL_ROWS_PER_STATE);
    const rows: HermesGoalSummary[] = [];
    for (const entry of entries) {
      const rel = path.join(relDir, entry.name);
      const read = await readTextWithStatsAtRoot(root, rel, MAX_GOAL_BYTES, ctx, false);
      if (!read) continue;
      rows.push(parseGoalSummary(entry.name, state, "live-native", read.text, read.bytes));
    }
    result[state] = rows.sort(newestFirst);
  }));

  return result;
}

async function readArchive(root: string, ctx: SafeContext) {
  const manifestRead = await readTextWithStatsAtRoot(root, "archive/goals/import-manifest.json", MAX_JSON_BYTES, ctx, false);
  const manifest = manifestRead ? parseJson(manifestRead.text, ctx, "archive manifest") : {};
  const manifestRecord = asRecord(manifest);
  const countsRecord = asRecord(manifestRecord.counts);
  const artifactCountsRecord = asRecord(manifestRecord.artifact_counts);
  const manifestFiles = [...(arrayValue(manifestRecord.files) ?? []), ...(arrayValue(manifestRecord.artifacts) ?? [])];
  const goalFiles = manifestFiles.flatMap((item) => classifyArchiveManifestRow(item, "goal"));
  const artifactFiles = manifestFiles.flatMap((item) => classifyArchiveManifestRow(item, "artifact"));
  const counts = countArchiveRows(
    goalFiles,
    countsRecord,
    goalFiles.length === 0,
  );
  const artifact_counts = countArchiveRows(artifactFiles, artifactCountsRecord, true);

  const recent = goalFiles
    .slice(-MAX_ARCHIVE_ROWS)
    .reverse()
    .map((row) => {
      const status: GoalState = row.status;
      return {
        id: `archive-${status}-${row.path}`,
        title: titleFromFileName(row.name),
        state: status,
        source: "archive" as const,
        status,
        updatedAt: null,
        evidence: [],
        bytes: row.bytes,
        sha256: row.sha256,
      };
    });

  const recentArtifacts = artifactFiles
    .slice(-MAX_ARCHIVE_ROWS)
    .reverse()
    .map((row) => ({
      id: `archive-artifact-${row.status}-${row.path}`,
      status: row.status,
      name: row.name,
      path: row.path,
      goal: row.goal,
      bytes: row.bytes,
      sha256: row.sha256,
    }));

  return {
    root: path.join(root, "archive/goals"),
    counts,
    artifact_counts,
    manifestSha256: manifestRead ? sha256Hex(manifestRead.text) : null,
    recent,
    recentArtifacts,
  };
}

function classifyArchiveManifestRow(item: unknown, expectedKind: "goal" | "artifact"): ArchiveManifestRow[] {
  const row = asRecord(item);
  const status = row.status === "failed" ? "failed" : row.status === "done" ? "done" : null;
  const sha256 = safeHash(row.sha256);
  if (!status || !sha256) return [];

  const rawPath = safeArchiveRelPath(row.path) ?? safeArchiveRelPath(`${status}/${safeString(row.name) ?? ""}`);
  if (!rawPath) return [];
  const parts = rawPath.split("/");
  if (parts[0] !== status || parts.length < 2) return [];

  const name = safeFileName(parts[parts.length - 1]);
  if (!name) return [];

  const declaredKind = row.kind === "artifact" ? "artifact" : row.kind === "goal" ? "goal" : null;
  const inferredKind = parts.length === 2 && name.endsWith(".md") ? "goal" : "artifact";
  const kind = declaredKind ?? inferredKind;
  if (kind !== expectedKind) return [];

  return [{
    status,
    kind,
    name,
    path: rawPath,
    goal: kind === "artifact" ? safeDisplayText(row.goal) ?? safeDisplayText(parts[1]) : null,
    bytes: firstNumber(row.bytes) ?? 0,
    sha256,
  }];
}

function countArchiveRows(rows: ArchiveManifestRow[], manifestCounts: Record<string, unknown>, useManifestFallback: boolean) {
  if (rows.length || !useManifestFallback) {
    const done = rows.filter((row) => row.status === "done").length;
    const failed = rows.filter((row) => row.status === "failed").length;
    return { done, failed, total: done + failed };
  }

  const done = firstNumber(manifestCounts.done) ?? 0;
  const failed = firstNumber(manifestCounts.failed) ?? 0;
  return {
    done,
    failed,
    total: firstNumber(manifestCounts.total) ?? done + failed,
  };
}

function parseGoalSummary(
  name: string,
  state: GoalState,
  source: "live-native" | "archive",
  text: string,
  bytes: number,
): HermesGoalSummary {
  const trimmed = text.slice(0, MAX_GOAL_BYTES);
  const json = name.endsWith(".json") ? parseJson(trimmed, { warnings: [], errors: [] }, name) : null;
  const row = asRecord(json);
  const title =
    safeDisplayText(row.title) ??
    safeDisplayText(firstMarkdownHeading(trimmed)) ??
    titleFromFileName(name);
  const status = safeDisplayText(row.status) ?? safeDisplayText(frontmatterValue(trimmed, "status")) ?? state;
  const updatedAt =
    safeIso(row.updated_at ?? row.updatedAt ?? row.finishedAt ?? row.createdAt) ??
    safeIso(frontmatterValue(trimmed, "updated_at"));
  const evidence = [
    ...stringArray(row.evidence),
    ...frontmatterList(trimmed, "evidence"),
  ].filter((item) => !SECRET_PATTERN.test(item)).slice(0, 5);

  return {
    id: `${source}-${state}-${name}`,
    title,
    state,
    source,
    status,
    updatedAt,
    evidence,
    bytes,
  };
}

async function readJsonAtRoot(root: string, rel: string, maxBytes: number, ctx: SafeContext) {
  const read = await readTextAtRoot(root, rel, maxBytes, ctx, false);
  if (!read) return {};
  return parseJson(read, ctx, rel);
}

async function readTextAtRoot(
  root: string,
  rel: string,
  maxBytes: number,
  ctx: SafeContext,
  required: boolean,
) {
  const read = await readTextWithStatsAtRoot(root, rel, maxBytes, ctx, required);
  return read?.text ?? null;
}

async function readTextWithStatsAtRoot(
  root: string,
  rel: string,
  maxBytes: number,
  ctx: SafeContext,
  required: boolean,
) {
  try {
    const target = await resolveContainedPath(root, rel);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw new Error(`file exceeds ${maxBytes} byte cap`);
    const text = await fs.readFile(target, "utf8");
    return { text, bytes: stat.size };
  } catch (error) {
    if (required) ctx.errors.push(`${rel}: ${safeError(error)}`);
    return null;
  }
}

async function listFilesAtRoot(root: string, rel: string, ctx: SafeContext, limit: number) {
  try {
    const dir = await resolveContainedPath(root, rel);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (!entry.isFile()) {
        if (entry.isSymbolicLink()) ctx.warnings.push(`${path.join(rel, entry.name)}: symlink rejected`);
        continue;
      }
      if (!safeFileName(entry.name)) continue;
      files.push(entry);
    }
    return files;
  } catch (error) {
    ctx.warnings.push(`${rel}: ${safeError(error)}`);
    return [];
  }
}

async function resolveContainedPath(root: string, rel: string) {
  if (path.isAbsolute(rel) || rel.includes("\0")) throw new Error("invalid relative path");
  const normalizedRel = path.normalize(rel);
  if (normalizedRel.startsWith("..")) throw new Error("path escape rejected");
  const realRoot = await fs.realpath(root);
  const target = path.join(realRoot, normalizedRel);
  const lstat = await fs.lstat(target);
  if (lstat.isSymbolicLink()) throw new Error("symlink rejected");
  const realTarget = await fs.realpath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("path containment rejected");
  }
  return realTarget;
}

function countGoalStates(goals: Record<GoalState, HermesGoalSummary[]>) {
  return {
    ready: goals.ready.length,
    running: goals.running.length,
    done: goals.done.length,
    failed: goals.failed.length,
  };
}

function parseJson(text: string, ctx: SafeContext, label: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    ctx.warnings.push(`${label}: invalid JSON`);
    return {};
  }
}

function parseJsonStrict(text: string, ctx: SafeContext, label: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    ctx.errors.push(`${label}: invalid JSON`);
    return null;
  }
}

function normalizeTaskStatus(value: unknown): HermesOperatorTask["status"] {
  const text = safeString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (text === "in_progress" || text === "done" || text === "blocked") return text;
  return "pending";
}

function normalizePriority(value: unknown): HermesOperatorTask["priority"] {
  const text = safeString(value)?.toLowerCase();
  if (text === "low" || text === "medium") return text;
  return "high";
}

function safeDisplayText(value: unknown) {
  const text = safeString(value);
  if (!text || SECRET_PATTERN.test(text)) return null;
  return text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  const arr = arrayValue(value);
  if (!arr) return [];
  return arr.flatMap((item) => {
    const text = safeDisplayText(item);
    return text ? [text] : [];
  });
}

function slugString(value: unknown) {
  const text = safeString(value);
  return text && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(text) ? text : null;
}

function safeFileName(value: unknown) {
  const text = safeString(value);
  if (!text || text.includes("/") || text.includes("\\") || text.includes("..")) return null;
  return text.slice(0, 180);
}

function safeArchiveRelPath(value: unknown) {
  const text = safeString(value);
  if (!text || text.includes("\\") || text.includes("\0")) return null;
  const normalized = path.posix.normalize(text.replaceAll(path.sep, "/"));
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) return null;
  const parts = normalized.split("/");
  if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.every((part) => safeFileName(part)) ? normalized.slice(0, 360) : null;
}

function safeHash(value: unknown) {
  const text = safeString(value);
  return text && /^[a-f0-9]{64}$/i.test(text) ? text.toLowerCase() : null;
}

function safeIso(value: unknown) {
  const text = safeString(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function firstNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function displayName(profile: string) {
  if (profile === "default") return "Default Cloud Orchestrator";
  if (profile === "codex") return "Codex Implementation Lane";
  return profile
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function titleFromFileName(name: string) {
  return name
    .replace(/\.(md|json|jsonl)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "Untitled goal";
}

function firstMarkdownHeading(text: string) {
  return text.match(/^#\s+(.+)$/m)?.[1] ?? null;
}

function frontmatterValue(text: string, key: string) {
  const fm = frontmatter(text);
  return fm.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"))?.[1]?.replace(/^["']|["']$/g, "") ?? null;
}

function frontmatterList(text: string, key: string) {
  const fm = frontmatter(text);
  const match = fm.match(new RegExp(`^${key}:\\s*\\n((?:\\s*-\\s+.+\\n?)+)`, "mi"));
  if (!match?.[1]) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+)$/)?.[1])
    .filter(Boolean)
    .flatMap((item) => {
      const text = safeDisplayText(item);
      return text ? [text] : [];
    });
}

function frontmatter(text: string) {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0 || end > 4096) return "";
  return text.slice(3, end);
}

function newestFirst(a: HermesGoalSummary, b: HermesGoalSummary) {
  return (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0);
}

function sha256Hex(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function readResponseTextCapped(res: Response, cap: number) {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error("native source payload exceeds 2 MB cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildUnavailableEnvelope(message: string): HermesNativeSourceEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    source: "hermes-native-source",
    generatedAt: now,
    snapshot: {
      source: {
        mode: "remote-native-source",
        status: "error",
        message: "Native Hermes truth unavailable",
        roots: {
          missionControl: "",
          profiles: "",
          runtime: "",
          archive: "",
        },
        warnings: [],
        errors: [message],
        checkedAt: now,
        lastSeen: null,
        stale: true,
      },
      policy: {
        primaryCloudOrchestrator: "unavailable",
        alwaysOnWorkers: false,
        modelLoadsPermittedByRoster: false,
        langfuseMode: "unavailable",
        runtimeNote: "Native runtime state is unavailable.",
      },
      agents: [],
      operatorTasks: { updatedAt: null, tasks: [], counts: {} },
      goals: {
        live: { ready: [], running: [], done: [], failed: [] },
        counts: { ready: 0, running: 0, done: 0, failed: 0 },
        current: null,
        recentFailed: [],
      },
      archive: {
        root: "",
        counts: { done: 0, failed: 0, total: 0 },
        artifact_counts: { done: 0, failed: 0, total: 0 },
        manifestSha256: null,
        recent: [],
        recentArtifacts: [],
      },
    },
    crons: {
      source: "unavailable",
      status: "warning",
      message: "Hermes cron list unavailable",
      jobs: [],
      syncedAt: null,
      warnings: [message],
    },
  };
}

function sanitizeCronText(value: unknown) {
  const text = safeString(value);
  if (!text || SECRET_PATTERN.test(text)) return null;
  return text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
}

function parseRemoteSnapshot(value: unknown): HermesNativeSnapshot {
  const record = asRecord(value);
  if (!Array.isArray(record.agents)) throw new Error("native source schema invalid");
  return {
    source: parseRemoteSourceHealth(record.source),
    policy: parseRemotePolicy(record.policy),
    agents: record.agents.slice(0, MAX_REMOTE_AGENTS).flatMap(parseRemoteAgent),
    operatorTasks: parseRemoteOperatorTasks(record.operatorTasks),
    goals: parseRemoteGoals(record.goals),
    archive: parseRemoteArchive(record.archive),
  };
}

function parseRemoteSourceHealth(value: unknown): HermesNativeSourceHealth {
  const record = asRecord(value);
  const status = parseHealthStatus(record.status);
  const checkedAt = requireIso(record.checkedAt, "native source schema invalid");
  const roots = asRecord(record.roots);
  return {
    mode: parseNativeSourceMode(record.mode),
    status,
    message: remoteText(record.message) ?? "Native Hermes truth loaded",
    roots: {
      missionControl: remoteText(roots.missionControl) ?? "",
      profiles: remoteText(roots.profiles) ?? "",
      runtime: remoteText(roots.runtime) ?? "",
      archive: remoteText(roots.archive) ?? "",
    },
    warnings: remoteTextArray(record.warnings, MAX_REMOTE_WARNINGS),
    errors: remoteTextArray(record.errors, MAX_REMOTE_WARNINGS),
    checkedAt,
    lastSeen: nullableIso(record.lastSeen),
    stale: record.stale === true,
  };
}

function parseRemotePolicy(value: unknown): HermesNativeSnapshot["policy"] {
  const record = asRecord(value);
  return {
    primaryCloudOrchestrator: remoteSlug(record.primaryCloudOrchestrator) ?? "unavailable",
    alwaysOnWorkers: record.alwaysOnWorkers === true,
    modelLoadsPermittedByRoster: record.modelLoadsPermittedByRoster === true,
    langfuseMode: remoteText(record.langfuseMode) ?? "metadata-only",
    runtimeNote: remoteText(record.runtimeNote) ?? "Native runtime state loaded from remote source.",
  };
}

function parseRemoteAgent(value: unknown): HermesNativeAgent[] {
  const record = asRecord(value);
  const profile = remoteSlug(record.profile);
  const id = remoteSlug(record.id) ?? profile;
  if (!profile || !id) return [];
  const status = parseAgentStatus(record.status);
  const modelClass = record.modelClass === "cloud" ? "cloud" : record.modelClass === "local" ? "local" : null;
  if (!status || !modelClass) throw new Error("native source schema invalid");
  return [{
    id,
    profile,
    name: remoteText(record.name) ?? displayName(profile),
    role: remoteText(record.role) ?? "Hermes specialist",
    modelClass,
    model: remoteText(record.model) ?? "unknown",
    provider: remoteText(record.provider) ?? "unknown",
    status,
    capabilities: remoteTextArray(record.capabilities, 8),
    forbiddenActions: remoteTextArray(record.forbiddenActions, 8),
    cloudOrchestratorCallWhen: remoteText(record.cloudOrchestratorCallWhen),
    langfuseCoverage: remoteText(record.langfuseCoverage) ?? "metadata-only",
    compressionPolicy: remoteText(record.compressionPolicy) ?? "not declared",
    contextLength: nullableFiniteNumber(record.contextLength),
    statusNote: remoteText(record.statusNote) ?? "",
  }];
}

function parseRemoteOperatorTasks(value: unknown): HermesNativeSnapshot["operatorTasks"] {
  const record = asRecord(value);
  const rows = arrayValue(record.tasks);
  if (!rows) throw new Error("native source schema invalid");
  const tasks = rows.slice(0, MAX_REMOTE_TASKS).flatMap((item) => {
    const row = asRecord(item);
    const id = remoteSlug(row.id);
    const title = remoteText(row.title);
    if (!id || !title) return [];
    return [{
      id,
      title,
      status: parseTaskStatus(row.status),
      priority: parsePriority(row.priority),
      updatedAt: nullableIso(row.updatedAt),
    }];
  });
  return {
    updatedAt: nullableIso(record.updatedAt),
    tasks,
    counts: parseCounts(record.counts),
  };
}

function parseRemoteGoals(value: unknown): HermesNativeSnapshot["goals"] {
  const record = asRecord(value);
  const live = asRecord(record.live);
  return {
    live: {
      ready: parseRemoteGoalList(live.ready, "ready", MAX_GOAL_ROWS_PER_STATE),
      running: parseRemoteGoalList(live.running, "running", MAX_GOAL_ROWS_PER_STATE),
      done: parseRemoteGoalList(live.done, "done", MAX_GOAL_ROWS_PER_STATE),
      failed: parseRemoteGoalList(live.failed, "failed", MAX_GOAL_ROWS_PER_STATE),
    },
    counts: parseGoalCounts(record.counts),
    current: parseRemoteGoalNullable(record.current, null),
    recentFailed: parseRemoteGoalList(record.recentFailed, "failed", 5),
  };
}

function parseRemoteArchive(value: unknown): HermesNativeSnapshot["archive"] {
  const record = asRecord(value);
  return {
    root: remoteText(record.root) ?? "",
    counts: parseArchiveCounts(record.counts),
    artifact_counts: parseArchiveCounts(record.artifact_counts),
    manifestSha256: safeHash(record.manifestSha256),
    recent: parseRemoteGoalList(record.recent, null, MAX_ARCHIVE_ROWS),
    recentArtifacts: parseRemoteArchiveArtifacts(record.recentArtifacts),
  };
}

function parseRemoteCronSnapshot(value: unknown): HermesCronSnapshot {
  const record = asRecord(value);
  const source = record.source === "local-hermes-cli" || record.source === "unavailable" ? record.source : null;
  if (!source) throw new Error("native source schema invalid");
  const rows = arrayValue(record.jobs);
  if (!rows) throw new Error("native source schema invalid");
  return {
    source,
    status: parseHealthStatus(record.status),
    message: remoteText(record.message) ?? "Hermes cron list loaded",
    jobs: rows.slice(0, MAX_CRON_ROWS).flatMap(parseRemoteCronJob),
    syncedAt: nullableIso(record.syncedAt),
    warnings: remoteTextArray(record.warnings, MAX_REMOTE_WARNINGS),
  };
}

function parseRemoteCronJob(value: unknown): HermesCronJob[] {
  const record = asRecord(value);
  const id = remoteSlug(record.id);
  const status = remoteText(record.status);
  const name = remoteText(record.name);
  const schedule = remoteText(record.schedule);
  if (!id || !status || !name || !schedule) return [];
  return [{
    id,
    status,
    name,
    schedule,
    nextRun: remoteText(record.nextRun),
    lastRun: remoteText(record.lastRun),
    lastResult: remoteText(record.lastResult),
    deliver: remoteText(record.deliver),
    skills: remoteText(record.skills),
    mode: remoteText(record.mode),
  }];
}

function parseRemoteGoalList(value: unknown, expectedState: GoalState | null, limit: number): HermesGoalSummary[] {
  const rows = arrayValue(value);
  if (!rows) throw new Error("native source schema invalid");
  return rows.slice(0, limit).flatMap((item) => parseRemoteGoalNullable(item, expectedState) ?? []);
}

function parseRemoteGoalNullable(value: unknown, expectedState: GoalState | null): HermesGoalSummary | null {
  if (value == null) return null;
  const record = asRecord(value);
  const id = remoteText(record.id);
  const title = remoteText(record.title);
  const state = parseGoalState(record.state);
  const source = record.source === "live-native" || record.source === "archive" ? record.source : null;
  if (!id || !title || !state || !source) return null;
  if (expectedState && state !== expectedState) throw new Error("native source schema invalid");
  return {
    id,
    title,
    state,
    source,
    status: remoteText(record.status),
    updatedAt: nullableIso(record.updatedAt),
    evidence: remoteTextArray(record.evidence, 5),
    bytes: nonNegativeNumber(record.bytes),
    sha256: safeHash(record.sha256) ?? undefined,
  };
}

function parseRemoteArchiveArtifacts(value: unknown): HermesArchiveArtifactSummary[] {
  const rows = arrayValue(value);
  if (!rows) throw new Error("native source schema invalid");
  return rows.slice(0, MAX_ARCHIVE_ROWS).flatMap((item) => {
    const record = asRecord(item);
    const id = remoteText(record.id);
    const status = record.status === "done" || record.status === "failed" ? record.status : null;
    const name = safeFileName(record.name);
    const archivePath = safeArchiveRelPath(record.path);
    const sha256 = safeHash(record.sha256);
    if (!id || !status || !name || !archivePath || !sha256) return [];
    return [{
      id,
      status,
      name,
      path: archivePath,
      goal: remoteText(record.goal),
      bytes: nonNegativeNumber(record.bytes),
      sha256,
    }];
  });
}

function parseHealthStatus(value: unknown): HealthStatus {
  if (value === "ok" || value === "warning" || value === "error") return value;
  throw new Error("native source schema invalid");
}

function parseNativeSourceMode(value: unknown): NativeSourceMode {
  if (value === "local-native" || value === "remote-native-source") return value;
  throw new Error("native source schema invalid");
}

function parseAgentStatus(value: unknown): HermesNativeAgent["status"] | null {
  return value === "running" || value === "on-demand" || value === "stopped" ? value : null;
}

function parseTaskStatus(value: unknown): HermesOperatorTask["status"] {
  if (value === "in_progress" || value === "pending" || value === "done" || value === "blocked") return value;
  throw new Error("native source schema invalid");
}

function parsePriority(value: unknown): HermesOperatorTask["priority"] {
  if (value === "high" || value === "medium" || value === "low") return value;
  throw new Error("native source schema invalid");
}

function parseGoalState(value: unknown): GoalState | null {
  return value === "ready" || value === "running" || value === "done" || value === "failed" ? value : null;
}

function parseCounts(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record).slice(0, 20)) {
    const safeKey = remoteSlug(key);
    if (!safeKey) continue;
    out[safeKey] = nonNegativeNumber(raw);
  }
  return out;
}

function parseGoalCounts(value: unknown): Record<GoalState, number> {
  const record = asRecord(value);
  return {
    ready: nonNegativeNumber(record.ready),
    running: nonNegativeNumber(record.running),
    done: nonNegativeNumber(record.done),
    failed: nonNegativeNumber(record.failed),
  };
}

function parseArchiveCounts(value: unknown) {
  const record = asRecord(value);
  const done = nonNegativeNumber(record.done);
  const failed = nonNegativeNumber(record.failed);
  return {
    done,
    failed,
    total: nonNegativeNumber(record.total) || done + failed,
  };
}

function nullableIso(value: unknown): string | null {
  if (value == null) return null;
  const iso = safeIso(value);
  if (!iso) throw new Error("native source schema invalid");
  return iso;
}

function requireIso(value: unknown, message: string): string {
  const iso = safeIso(value);
  if (!iso) throw new Error(message);
  return iso;
}

function remoteText(value: unknown): string | null {
  const text = safeString(value);
  if (!text || SECRET_PATTERN.test(text)) return null;
  return text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_REMOTE_STRING);
}

function remoteTextArray(value: unknown, limit: number): string[] {
  const arr = arrayValue(value);
  if (!arr) throw new Error("native source schema invalid");
  return arr.slice(0, limit).flatMap((item) => {
    const text = remoteText(item);
    return text ? [text] : [];
  });
}

function remoteSlug(value: unknown): string | null {
  const text = remoteText(value);
  return text && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(text) ? text : null;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = firstNumber(value);
  if (parsed == null) throw new Error("native source schema invalid");
  return parsed;
}

function nonNegativeNumber(value: unknown): number {
  const parsed = firstNumber(value);
  return parsed != null && parsed >= 0 ? parsed : 0;
}

function minimalHermesEnv() {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "USER", "SHELL", "TERM"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function ageMs(iso: string | null) {
  if (!iso) return null;
  const age = Date.now() - Date.parse(iso);
  return Number.isFinite(age) ? age : null;
}

function redactSecretValue(value: unknown, secret: string): unknown {
  if (!secret) return value;
  if (typeof value === "string") return redactSecretText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactSecretValue(item, secret));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactSecretValue(item, secret);
  }
  return out;
}

function redactSecretText(value: string, secret: string) {
  return secret ? value.split(secret).join("[redacted]") : value;
}

function safeError(error: unknown) {
  return error instanceof Error
    ? error.message.replaceAll(String(DEFAULT_MISSION_ROOT), "mission-root")
    : "read failed";
}
