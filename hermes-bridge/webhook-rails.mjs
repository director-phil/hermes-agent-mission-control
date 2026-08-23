#!/usr/bin/env node
/**
 * webhook-rails.mjs — event-driven rails for the Hermes native bridge.
 *
 * Consumes public.webhook_events (written by the V2 app's webhook receivers)
 * and dispatches local agents:
 *
 *   vercel.deployment.ready  -> spawns the fresh-verifier agent to inspect
 *                               deploy logs + the deployed surface, then
 *                               finalizes pending-surface-verification goals
 *   github.pull_request.*    -> spawns the missioncontrol (Codex) reviewer
 *                               for gate:codex / review-requested PRs and
 *                               posts `codex-review: pass` when clean
 *   goal lifecycle changes   -> Langfuse error scout: for each newly failed
 *                               goal, queries Langfuse for ERROR observations
 *                               and authors an evidence-gated diagnosis goal
 *
 * No cron. The bridge's 5s daemon tick drives this; every handler is
 * fail-closed and leaves evidence in the events table / runtime dirs.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const HERMES_ROOT = path.join(process.env.HOME || "", ".hermes");
const NATIVE_ROOT = process.env.HERMES_NATIVE_ROOT || path.join(HERMES_ROOT, "mission-control", "runtime");
const MC_REPO = path.join(process.env.HOME || "", "Documents", "GitHub", "hermes-mission-control");
const FINALIZE_SCRIPT = path.join(MC_REPO, "scripts", "finalize-surface-verified.py");
const PR_STATE_FILE = path.join(NATIVE_ROOT, "pr-review-state.json");
const SCOUT_STATE_FILE = path.join(NATIVE_ROOT, "langfuse-scout-state.json");
const V2_REPO = "director-phil/rt-ops-v2";
const REVIEW_PASS_MARKER = "REVIEW_PASS";
const VERIFY_OK_MARKER = "VERIFIED";

export function railsConfig(env = process.env) {
  return {
    hermesBin: env.HERMES_BIN || "hermes",
    verifierProfile: env.RAILS_VERIFIER_PROFILE || "fresh-verifier",
    reviewerProfile: env.RAILS_REVIEWER_PROFILE || "missioncontrol",
    reviewTimeoutMs: 900000,
    verifyTimeoutMs: 900000,
    maxCommentChars: 12000,
  };
}

export function readStateFile(file) {
  return fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({}));
}

export async function writeStateFile(file, state) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

export function runBounded(command, args, stdinText, { timeoutMs, maxOutputChars = 20000, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      resolve({ exitCode: -1, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(0, maxOutputChars * 2); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(0, 20000); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: -2, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? -3, stdout, stderr });
    });
    child.stdin.end(stdinText, "utf8");
  });
}

function loadLangfuseEnv() {
  return fs.readFile(path.join(HERMES_ROOT, ".env"), "utf8")
    .then((text) => {
      const vals = { base: "http://127.0.0.1:3000", pk: "", sk: "" };
      for (const line of text.splitlines()) {
        const m = line.match(/^(HERMES_LANGFUSE_(?:BASE_URL|PUBLIC_KEY|SECRET_KEY))=(.*)$/);
        if (!m) continue;
        const value = m[2].trim().replace(/^["']|["']$/g, "");
        if (m[1] === "HERMES_LANGFUSE_BASE_URL") vals.base = value.replace(/\/$/, "");
        if (m[1] === "HERMES_LANGFUSE_PUBLIC_KEY") vals.pk = value;
        if (m[1] === "HERMES_LANGFUSE_SECRET_KEY") vals.sk = value;
      }
      return vals;
    })
    .catch(() => ({ base: "http://127.0.0.1:3000", pk: "", sk: "" }));
}

async function langfuseFetch(pathname, params = {}) {
  const lf = await loadLangfuseEnv();
  if (!lf.pk || !lf.sk) return { ok: false, error: "langfuse credentials missing" };
  const url = new URL(`${lf.base}/api/public${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${Buffer.from(`${lf.pk}:${lf.sk}`).toString("base64")}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Queue consumer
// ---------------------------------------------------------------------------

export async function processWebhookQueue({ q, log }) {
  const { rows } = await q(
    `SELECT id, event_type, source, payload
       FROM public.webhook_events
      WHERE processed_at IS NULL
      ORDER BY id
      LIMIT 5
      FOR UPDATE SKIP LOCKED`,
  );
  for (const row of rows) {
    try {
      const payload = row.payload || {};
      if (row.source === "vercel" && row.event_type === "deployment.ready") {
        await handleVercelDeploymentReady(payload, { q, log });
      } else if (row.source === "github" && /^pull_request\./.test(row.event_type)) {
        await handleGithubPullRequest(row.event_type, payload, { q, log });
      } else {
        log("webhook event ignored:", row.source, row.event_type);
      }
      await q(`UPDATE public.webhook_events SET processed_at = now(), processing_error = NULL WHERE id = $1`, [row.id]);
    } catch (error) {
      const msg = String(error?.message || error).slice(0, 600);
      log("webhook event failed:", row.id, msg);
      await q(`UPDATE public.webhook_events SET processed_at = now(), processing_error = $2 WHERE id = $1`, [row.id, msg]);
    }
  }
}

// ---------------------------------------------------------------------------
// Vercel deployment verification rail
// ---------------------------------------------------------------------------

export async function handleVercelDeploymentReady(payload, { q, log }) {
  const url = payload.url || "";
  const sha = payload.commitSha || "";
  const target = payload.target || "";
  if (!url) { log("vercel deploy event missing url — skipped"); return; }
  log("vercel deployment ready:", target, sha.slice(0, 12), url);

  // Only production deployments close goals; previews are mirrored for info.
  if (target !== "production") { log("vercel deploy target not production — skipped"); return; }

  const cfg = railsConfig();
  const packet = [
    "You are the Reliable Tradies V2 deployment verifier. Evidence first, no fabrication.",
    `Deployment URL: ${url}`,
    `Commit SHA: ${sha}`,
    "Verify, in order:",
    "1. Run `vercel ls reliable-tradies-ops-v2` (or `vercel logs reliable-tradies-ops-v2` if available) and confirm the production deployment for this commit finished with a successful build; record any ERROR/500 lines.",
    "2. Run `curl -sI -m 20 <url>` and confirm HTTP 200.",
    "3. If the deployment has no page surface (infra/docs only), say so explicitly.",
    `End stdout with "${VERIFY_OK_MARKER} <one-line evidence summary>" ONLY if all checks pass. Otherwise state exactly what failed, with the evidence you observed.`,
  ].join("\n");

  const result = await runBounded(
    cfg.hermesBin,
    ["--profile", cfg.verifierProfile, "chat", "--quiet", "--reasoning", "none", "--toolsets", "terminal,file", "--query-file", "-", "--source", "mission-control-deploy-verify"],
    packet,
    { timeoutMs: cfg.verifyTimeoutMs },
  );

  const ok = result.exitCode === 0 && result.stdout.includes(VERIFY_OK_MARKER);
  log("deploy verification:", ok ? "PASS" : "FAIL", `exit=${result.exitCode}`);

  const evidence = {
    deploymentUrl: url,
    commitSha: sha,
    verifiedAt: new Date().toISOString(),
    verifierOutput: result.stdout.slice(0, 4000),
    verifierStderr: result.stderr.slice(0, 1000),
  };

  if (ok && sha) {
    // Finalize any goal parked in changed_pending_surface_verification for this commit.
    const finalized = await finalizeGoalsForCommit(sha, evidence, log);
    log("surface-finalized goals:", finalized.length, finalized.join(","));
  }
  return { ok, evidence };
}

async function finalizeGoalsForCommit(commitSha, evidence, log) {
  const pendingDir = path.join(NATIVE_ROOT, "goals", "changed_pending_surface_verification");
  const finalized = [];
  let entries = [];
  try { entries = await fs.readdir(pendingDir); } catch { return finalized; }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const goalId = entry.replace(/\.md$/, "");
    const resultPath = path.join(NATIVE_ROOT, "runs", goalId, "result.json");
    let result = null;
    try { result = JSON.parse(await fs.readFile(resultPath, "utf8")); } catch { /* no result yet */ }
    const mergeSha = result?.stages?.merge?.merge_sha || "";
    const headSha = result?.stages?.pull_request?.head_sha || "";
    if (mergeSha === commitSha || headSha === commitSha) {
      const evidenceFile = path.join(NATIVE_ROOT, "runs", goalId, `surface-evidence-${Date.now()}.json`);
      await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", "utf8");
      const res = await runBounded(
        "/usr/bin/python3",
        [FINALIZE_SCRIPT, "--native-root", NATIVE_ROOT, "--goal-id", goalId, "--evidence-json", evidenceFile],
        "",
        { timeoutMs: 30000 },
      );
      if (res.exitCode === 0) finalized.push(goalId);
      else log("finalize failed:", goalId, res.stdout.slice(0, 500), res.stderr.slice(0, 500));
    }
  }
  return finalized;
}

// ---------------------------------------------------------------------------
// GitHub PR review rail (Codex)
// ---------------------------------------------------------------------------

export async function handleGithubPullRequest(eventType, payload, { q, log }) {
  const repo = payload.repo || "";
  const number = payload.number;
  const headSha = payload.headSha || "";
  const labels = Array.isArray(payload.labels) ? payload.labels : [];
  const reviewRequested = payload.reviewRequested === true;
  if (repo !== V2_REPO || !number || !headSha) { log("github event outside rails scope — skipped"); return; }

  const isGate = labels.includes("gate:codex");
  const triggers = new Set(["pull_request.opened", "pull_request.synchronize", "pull_request.ready_for_review", "pull_request.review_requested", "pull_request.labeled", "pull_request.reopened", "pull_request.edited"]);
  if (!triggers.has(eventType)) { return; }
  if (!isGate && !reviewRequested) { return; }

  const state = await readStateFile(PR_STATE_FILE);
  const key = `${repo}#${number}#${headSha}`;
  if (state[key] && Date.now() - state[key] < 30 * 60 * 1000) { log("PR review already dispatched for", key); return; }
  state[key] = Date.now();
  await writeStateFile(PR_STATE_FILE, state);

  const cfg = railsConfig();
  const packet = [
    `You are the Codex reviewer for the Reliable Tradies V2 repo (${repo}).`,
    `PR: #${number}  Head SHA: ${headSha}`,
    "Review the PR as it stands on GitHub:",
    "1. Run `gh pr diff " + number + " --repo " + repo + "` and `gh pr view " + number + " --repo " + repo + " --json title,body,labels,state`.",
    "2. Check: correctness; V2 architecture doctrine (no Railway reads, no mart_/fact_/dim_ reads, no business math in page components); security (secrets, auth, IDOR); scope vs the PR title/body.",
    "3. If there are blocking findings, list them concisely (file:line, what, why).",
    `End stdout with "${REVIEW_PASS_MARKER}" exactly as the final non-empty line ONLY if the PR is clean. Otherwise do NOT emit the marker.`,
  ].join("\n");

  const result = await runBounded(
    cfg.hermesBin,
    ["--profile", cfg.reviewerProfile, "chat", "--quiet", "--reasoning", "none", "--toolsets", "terminal,file", "--query-file", "-", "--source", "mission-control-pr-review"],
    packet,
    { timeoutMs: cfg.reviewTimeoutMs },
  );

  const clean = result.exitCode === 0 && result.stdout.includes(REVIEW_PASS_MARKER);
  log("codex review:", `#${number}`, clean ? "PASS" : "FAIL", `exit=${result.exitCode}`);

  let body;
  if (clean) {
    body = "codex-review: pass";
  } else {
    const findings = (result.stdout || result.stderr || "review produced no output").trim();
    body = `Codex review findings for head ${headSha.slice(0, 12)}:\n\n${findings.slice(0, cfg.maxCommentChars)}`;
  }
  await runBounded("gh", ["pr", "comment", String(number), "--repo", repo, "--body", body], "", { timeoutMs: 60000, maxOutputChars: 2000 });
}

// ---------------------------------------------------------------------------
// Langfuse error scout (event-triggered from the native snapshot)
// ---------------------------------------------------------------------------

export async function scoutFailedGoals(snapshot, { log }) {
  const recentFailed = Array.isArray(snapshot?.goals?.recentFailed) ? snapshot.goals.recentFailed : [];
  if (!recentFailed.length) return;
  const state = await readStateFile(SCOUT_STATE_FILE);
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  const firstRun = !state.updatedAt;
  let changed = false;
  for (const goal of recentFailed) {
    const goalId = goal.goal_id || goal.id;
    if (!goalId || seen.has(goalId)) continue;
    seen.add(goalId);
    changed = true;
    if (firstRun) continue; // baseline: existing failures are pre-rails history
    try {
      await scoutGoal(goalId, log);
    } catch (error) {
      log("scout failed for", goalId, String(error?.message || error).slice(0, 300));
    }
  }
  if (changed) await writeStateFile(SCOUT_STATE_FILE, { seen: [...seen], updatedAt: new Date().toISOString() });
}

async function scoutGoal(goalId, log) {
  const res = await langfuseFetch("/observations", {
    name: `goal:${goalId}`,
    limit: 50,
  });
  if (!res.ok) { log("langfuse query failed for", goalId, res.error); return; }
  const observations = Array.isArray(res.data?.data) ? res.data.data : [];
  const errors = observations.filter((o) => o.level === "ERROR" || (o.statusMessage && o.statusMessage !== "OK"));
  log("scout:", goalId, "observations", observations.length, "errors", errors.length);
  if (!errors.length) return;

  const evidence = errors.slice(0, 5).map((o) => ({
    id: o.id,
    name: o.name,
    level: o.level,
    statusMessage: String(o.statusMessage || "").slice(0, 500),
    startTime: o.startTime,
  }));

  const goalFile = path.join(NATIVE_ROOT, "goals", "staged", `g_${Date.now()}_langfuse-${goalId}.md`);
  const title = `fix: diagnose Langfuse errors from failed goal ${goalId}`;
  const content = [
    "---",
    `title: ${title}`,
    `repo/workdir: ${path.join(HERMES_ROOT, "mission-control-source", "rt-ops-v2")}`,
    "dependencies:",
    "hard_stop: false",
    "branch_kind: fix",
    "vercel_impact: false",
    "surface_verification: false",
    "---",
    "",
    "## Outcome",
    `Investigate and fix the errors that caused native goal \`${goalId}\` to fail, using the Langfuse evidence below.`,
    "",
    "## Context",
    `Langfuse observations with ERROR level found on trace goal:${goalId}:`,
    "",
    ...evidence.map((e) => `- observation \`${e.id}\` name=\`${e.name}\` level=\`${e.level}\` status=\`${e.statusMessage}\` at ${e.startTime}`),
    "",
    "Inspect the failing goal's run artifacts first (`runtime/runs/" + goalId + "/`), then fix the root cause. Do not chase symptoms.",
    "",
    "## Allowed files",
    "",
    "- `apps/web/**`",
    "- `supabase/migrations/**`",
    "",
    "## Acceptance",
    "",
    "```bash",
    `pnpm --dir apps/web exec tsc --noEmit`,
    `pnpm build:web`,
    `test -f "apps/web/lib/__checks__/diagnosis-${goalId}.md"`,
    `grep -q "root cause" "apps/web/lib/__checks__/diagnosis-${goalId}.md"`,
    "```",
    "",
  ].join("\n");
  await fs.writeFile(goalFile, content, "utf8");
  log("scout authored diagnosis goal:", goalFile);
}
