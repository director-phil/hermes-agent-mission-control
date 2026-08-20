export interface ConveyorActive {
  goalId: string;
  live: boolean;
  status: string | null;
  rung: number | null;
  attempts: number | null;
  pr: string | null;
}

export interface ConveyorUpNext {
  goalId: string;
  title: string;
  specialist: string | null;
  dependencyReady?: boolean;
  planRequired?: boolean;
  waitingOn?: string[];
}

export interface ConveyorBlocked {
  goalId: string;
  queueState: string;
  blockedBy: string[];
  failedDependencies: string[];
}

export interface ConveyorBox {
  label: string;
  host: string;
  reachable: boolean;
  models: string[];
}

export interface ConveyorState {
  conveyorOn: boolean;
  controllerPids: number[];
  liveGoals: string[];
  active: ConveyorActive[];
  upNext: ConveyorUpNext[];
  planRequired: { goalId: string; title: string }[];
  blocked: ConveyorBlocked[];
  counts: Record<string, number>;
  focusPrefixes: string[];
  message: string;
  boxes: ConveyorBox[];
  statusAgeSec: number | null;
  statusMissing: boolean;
  syncedAt: string | null;
}

export interface RunConveyorSource {
  goal: string;
  status: string;
  attempts: number;
  liveController?: boolean;
  rung?: number | null;
  shipped_pr?: string | null;
}

export interface QueueRunnerStatus {
  updated_at?: number;
  conveyor_on?: boolean;
  controller_pids?: unknown[];
  active?: string[];
  active_detail?: Array<{
    goal_id?: string;
    status?: string | null;
    rung?: number | null;
    attempts?: number | null;
    pr?: string | null;
  }>;
  up_next?: Array<{
    goal_id?: string;
    title?: string;
    specialist?: string | null;
    dependency_ready?: boolean;
    plan_required?: boolean;
    waiting_on?: string[];
  }>;
  plan_required?: Array<{ goal_id?: string; title?: string }>;
  blocked?: Array<{
    goal_id?: string;
    queue_state?: string;
    blocked_by?: string[];
    failed_dependencies?: string[];
  }>;
  counts?: Record<string, number>;
  focus_prefixes?: string[];
  message?: string;
}

export const EMPTY_CONVEYOR_SNAPSHOT: ConveyorState = {
  conveyorOn: false,
  controllerPids: [],
  liveGoals: [],
  active: [],
  upNext: [],
  planRequired: [],
  blocked: [],
  counts: {},
  focusPrefixes: [],
  message: "",
  boxes: [],
  statusAgeSec: null,
  statusMissing: true,
  syncedAt: null,
};

export const CONVEYOR_SNAPSHOT_RETENTION_MS = 120_000;

const LIVE_QUEUE_STATUSES = new Set(["running", "recovering", "external_recovery"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function hasParseableDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseSyncedAtMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function toStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : [];
}

function toNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => isFiniteNonnegativeNumber(entry[1])));
}

function isConveyorActive(value: unknown): value is ConveyorActive {
  return (
    isRecord(value) &&
    typeof value.goalId === "string" &&
    typeof value.live === "boolean" &&
    isStringOrNull(value.status) &&
    isNumberOrNull(value.rung) &&
    isNumberOrNull(value.attempts) &&
    isStringOrNull(value.pr)
  );
}

function isConveyorUpNext(value: unknown): value is ConveyorUpNext {
  return (
    isRecord(value) &&
    typeof value.goalId === "string" &&
    typeof value.title === "string" &&
    isStringOrNull(value.specialist) &&
    (value.dependencyReady === undefined || typeof value.dependencyReady === "boolean") &&
    (value.planRequired === undefined || typeof value.planRequired === "boolean") &&
    (value.waitingOn === undefined || isStringArray(value.waitingOn))
  );
}

function isPlanRequired(value: unknown): value is { goalId: string; title: string } {
  return isRecord(value) && typeof value.goalId === "string" && typeof value.title === "string";
}

function isConveyorBlocked(value: unknown): value is ConveyorBlocked {
  return (
    isRecord(value) &&
    typeof value.goalId === "string" &&
    typeof value.queueState === "string" &&
    isStringArray(value.blockedBy) &&
    isStringArray(value.failedDependencies)
  );
}

function isConveyorBox(value: unknown): value is ConveyorBox {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.host === "string" &&
    typeof value.reachable === "boolean" &&
    isStringArray(value.models)
  );
}

export function isUsableConveyorSnapshot(value: unknown): value is ConveyorState {
  if (!isRecord(value)) return false;
  if (typeof value.conveyorOn !== "boolean") return false;
  if (!Array.isArray(value.controllerPids) || !value.controllerPids.every(Number.isInteger)) return false;
  if (!isStringArray(value.liveGoals)) return false;
  if (!Array.isArray(value.active) || !value.active.every(isConveyorActive)) return false;
  if (!Array.isArray(value.upNext) || !value.upNext.every(isConveyorUpNext)) return false;
  if (!Array.isArray(value.planRequired) || !value.planRequired.every(isPlanRequired)) return false;
  if (!Array.isArray(value.blocked) || !value.blocked.every(isConveyorBlocked)) return false;
  if (!isStringRecord(value.counts) || !Object.values(value.counts).every(isFiniteNonnegativeNumber)) return false;
  if (!isStringArray(value.focusPrefixes)) return false;
  if (typeof value.message !== "string") return false;
  if (!Array.isArray(value.boxes) || !value.boxes.every(isConveyorBox)) return false;
  if (!isFiniteNonnegativeNumber(value.statusAgeSec)) return false;
  if (typeof value.statusMissing !== "boolean") return false;
  if (!hasParseableDate(value.syncedAt)) return false;

  return true;
}

export function isAuthoritativeConveyorSnapshot(value: unknown): value is ConveyorState {
  return isUsableConveyorSnapshot(value) && value.statusMissing === false;
}

export function refreshConveyorSnapshotAge(snapshot: ConveyorState, nowMs = Date.now()): ConveyorState | null {
  if (!isUsableConveyorSnapshot(snapshot)) return null;
  if (typeof snapshot.syncedAt !== "string") return null;
  const syncedAtMs = parseSyncedAtMs(snapshot.syncedAt);
  if (syncedAtMs === null) return null;
  const ageMs = nowMs - syncedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return {
    ...snapshot,
    statusAgeSec: Math.floor(ageMs / 1000),
  };
}

export function refreshFreshAuthoritativeConveyorSnapshot(value: unknown, nowMs = Date.now()): ConveyorState | null {
  if (!isAuthoritativeConveyorSnapshot(value)) return null;
  const refreshed = refreshConveyorSnapshotAge(value, nowMs);
  if (!refreshed || typeof value.syncedAt !== "string") return null;
  const syncedAtMs = parseSyncedAtMs(value.syncedAt);
  if (syncedAtMs === null) return null;
  return nowMs - syncedAtMs <= CONVEYOR_SNAPSHOT_RETENTION_MS ? refreshed : null;
}

function retainedSnapshot(snapshot: unknown, nowMs: number): ConveyorState | null {
  if (!isUsableConveyorSnapshot(snapshot)) return null;
  if (typeof snapshot.syncedAt !== "string") return null;
  const syncedAtMs = parseSyncedAtMs(snapshot.syncedAt);
  if (syncedAtMs === null) return null;
  if (nowMs - syncedAtMs > CONVEYOR_SNAPSHOT_RETENTION_MS) return null;
  return refreshConveyorSnapshotAge(snapshot, nowMs);
}

export function conveyorFallbackFromRuns(runs: RunConveyorSource[], nowMs = Date.now()): ConveyorState | null {
  const liveRuns = runs.filter((run) => run.liveController === true);
  if (liveRuns.length === 0) return null;

  return {
    ...EMPTY_CONVEYOR_SNAPSHOT,
    conveyorOn: true,
    liveGoals: liveRuns.map((run) => run.goal),
    active: liveRuns.map((run) => ({
      goalId: run.goal,
      live: true,
      status: "running",
      rung: typeof run.rung === "number" ? run.rung : null,
      attempts: typeof run.attempts === "number" ? run.attempts : null,
      pr: typeof run.shipped_pr === "string" ? run.shipped_pr : null,
    })),
    counts: {
      active: liveRuns.length,
      blocked: 0,
      up_next: 0,
    },
    message: "fallback: inferred from /api/runs liveController",
    statusAgeSec: 0,
    syncedAt: new Date(nowMs).toISOString(),
  };
}

export function chooseConveyorSnapshot({
  current,
  next,
  runs,
  nowMs = Date.now(),
}: {
  current: ConveyorState | null;
  next: unknown;
  runs: RunConveyorSource[];
  nowMs?: number;
}): ConveyorState | null {
  const refreshedNext = refreshFreshAuthoritativeConveyorSnapshot(next, nowMs);
  if (refreshedNext) return refreshedNext;
  const retained = retainedSnapshot(current, nowMs);
  if (retained) return retained;
  return conveyorFallbackFromRuns(runs, nowMs);
}

export function chooseApiConveyorSnapshot({
  payload,
  queueFallback,
  nowMs = Date.now(),
}: {
  payload: unknown;
  queueFallback: ConveyorState | null;
  nowMs?: number;
}): ConveyorState {
  const refreshedPayload = refreshFreshAuthoritativeConveyorSnapshot(payload, nowMs);
  const freshQueueFallback = queueFallback && refreshFreshAuthoritativeConveyorSnapshot(queueFallback, nowMs) ? queueFallback : null;
  return refreshedPayload ?? freshQueueFallback ?? EMPTY_CONVEYOR_SNAPSHOT;
}

function queueStatusIsLive(status: string | null | undefined) {
  return LIVE_QUEUE_STATUSES.has(String(status || "").toLowerCase());
}

export function conveyorFallbackFromQueueStatus(
  status: QueueRunnerStatus,
  nowSeconds = Date.now() / 1000,
): ConveyorState | null {
  if (!isRecord(status)) return null;

  const updatedAt = isFiniteNonnegativeNumber(status.updated_at) && status.updated_at > 0 ? status.updated_at : null;
  if (updatedAt === null) return null;
  if (typeof status.conveyor_on !== "boolean") return null;
  if (!Array.isArray(status.controller_pids) || !status.controller_pids.every((pid) => Number.isInteger(pid) && pid >= 0)) return null;
  if (!Array.isArray(status.active) || !status.active.every((gid) => typeof gid === "string")) return null;
  if (!Array.isArray(status.active_detail)) return null;
  if (
    !status.active_detail.every(
      (item) =>
        isRecord(item) &&
        typeof item.goal_id === "string" &&
        (item.status === undefined || isStringOrNull(item.status)) &&
        (item.rung === undefined || isNumberOrNull(item.rung)) &&
        (item.attempts === undefined || isNumberOrNull(item.attempts)) &&
        (item.pr === undefined || isStringOrNull(item.pr)),
    )
  ) {
    return null;
  }

  if (status.counts !== undefined && (!isRecord(status.counts) || !Object.values(status.counts).every(isFiniteNonnegativeNumber))) {
    return null;
  }

  const controllerPids = status.controller_pids.slice(0, 50);
  const active = status.active.slice(0, 25);
  const activeDetail = status.active_detail;
  const detailByGoal = new Map(activeDetail.filter((item) => typeof item.goal_id === "string").map((item) => [item.goal_id as string, item]));
  if (!active.every((gid) => detailByGoal.has(gid))) return null;

  const activeEntries = active.map((gid) => {
    const detail = detailByGoal.get(gid) || {};
    const statusValue = typeof detail.status === "string" ? detail.status : null;
    return {
      goalId: gid,
      live: queueStatusIsLive(statusValue),
      status: statusValue,
      rung: typeof detail.rung === "number" ? detail.rung : null,
      attempts: typeof detail.attempts === "number" ? detail.attempts : null,
      pr: typeof detail.pr === "string" ? detail.pr : null,
    };
  });

  const liveGoals = activeEntries.filter((item) => item.live).map((item) => item.goalId);
  const ageSec = nowSeconds - updatedAt;
  if (!isFiniteNonnegativeNumber(ageSec)) return null;
  if (ageSec * 1000 > CONVEYOR_SNAPSHOT_RETENTION_MS) return null;
  const syncedAt = new Date(updatedAt * 1000).toISOString();

  return {
    conveyorOn: Boolean(status.conveyor_on) || controllerPids.length > 0,
    controllerPids,
    liveGoals,
    active: activeEntries,
    upNext: Array.isArray(status.up_next)
      ? status.up_next.slice(0, 25).map((g) => ({
          goalId: typeof g.goal_id === "string" ? g.goal_id : "",
          title: typeof g.title === "string" ? g.title : typeof g.goal_id === "string" ? g.goal_id : "",
          specialist: typeof g.specialist === "string" ? g.specialist : null,
          dependencyReady: typeof g.dependency_ready === "boolean" ? g.dependency_ready : true,
          planRequired: typeof g.plan_required === "boolean" ? g.plan_required : false,
          waitingOn: toStringArray(g.waiting_on, 12),
        })).filter((g) => g.goalId)
      : [],
    planRequired: Array.isArray(status.plan_required)
      ? status.plan_required
          .slice(0, 25)
          .map((g) => ({
            goalId: typeof g.goal_id === "string" ? g.goal_id : "",
            title: typeof g.title === "string" ? g.title : typeof g.goal_id === "string" ? g.goal_id : "",
          }))
          .filter((g) => g.goalId)
      : [],
    blocked: Array.isArray(status.blocked)
      ? status.blocked
          .slice(0, 50)
          .map((b) => ({
            goalId: typeof b.goal_id === "string" ? b.goal_id : "",
            queueState: typeof b.queue_state === "string" ? b.queue_state : "",
            blockedBy: toStringArray(b.blocked_by, 12),
            failedDependencies: toStringArray(b.failed_dependencies, 12),
          }))
          .filter((b) => b.goalId)
      : [],
    counts: toNumberRecord(status.counts),
    focusPrefixes: toStringArray(status.focus_prefixes, 12),
    message: typeof status.message === "string" ? status.message : "queue status fallback",
    boxes: [],
    statusAgeSec: Math.round(ageSec),
    statusMissing: false,
    syncedAt,
  };
}
