import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const execFileAsync = promisify(execFile);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

type EndpointCheck = {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
};

async function checkEndpoint(url: string, timeoutMs = 2000): Promise<EndpointCheck> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("bash", ["-lc", `command -v ${command}`], { timeout: 1200 });
    return true;
  } catch {
    return false;
  }
}

async function commandStdout(command: string, timeout = 2000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("bash", ["-lc", command], { timeout });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

export async function GET() {
  const checkedAt = new Date().toISOString();
  const serverlessRuntime = Boolean(process.env.VERCEL);

  if (serverlessRuntime) {
    return NextResponse.json(
      {
        checkedAt,
        overallStatus: "warning",
        runtime: "vercel-serverless",
        gitnexus: {
          api: { ok: false, status: null, latencyMs: null, error: "Host-local service not reachable from Vercel runtime" },
          proxy: { ok: false, status: null, latencyMs: null, error: "Host-local service not reachable from Vercel runtime" },
          reposCount: 0,
          repos: [],
        },
        openhands: {
          status: "missing",
          installed: false,
          version: null,
          recommendation: "OpenHands and GitNexus are host-level tools. View local Mission Control runtime for live process state.",
        },
      },
      { headers: CORS_HEADERS }
    );
  }

  const [gitnexusApi, gitnexusProxy, reposResponse, openhandsInstalled, openhandsVersion] =
    await Promise.all([
      checkEndpoint("http://127.0.0.1:4747/api/health", 2500),
      checkEndpoint("http://127.0.0.1:8888/", 2500),
      fetch("http://127.0.0.1:4747/api/repos", { cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) return [] as Array<{ name?: string; path?: string }>;
          const data = (await r.json()) as Array<{ name?: string; path?: string }>;
          return Array.isArray(data) ? data : [];
        })
        .catch(() => [] as Array<{ name?: string; path?: string }>),
      commandExists("openhands"),
      commandStdout("openhands --version", 2000),
    ]);

  const openhandsStatus: "ok" | "missing" = openhandsInstalled ? "ok" : "missing";

  const payload = {
    checkedAt,
    overallStatus:
      gitnexusApi.ok && gitnexusProxy.ok ? "ok" : "warning",
    runtime: "local-host",
    gitnexus: {
      api: gitnexusApi,
      proxy: gitnexusProxy,
      reposCount: reposResponse.length,
      repos: reposResponse
        .map((repo) => ({
          name: repo.name ?? "unknown",
          path: repo.path ?? null,
        }))
        .slice(0, 10),
    },
    openhands: {
      status: openhandsStatus,
      installed: openhandsInstalled,
      version: openhandsVersion,
      recommendation: openhandsInstalled
        ? "OpenHands CLI available"
        : "Install with: uv tool install openhands --python 3.12",
    },
  };

  return NextResponse.json(payload, { headers: CORS_HEADERS });
}

