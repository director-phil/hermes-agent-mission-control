import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool, type PoolConfig } from "pg";

export const PRISMA_PG_POOL_MAX = 1;
export const PRISMA_PG_IDLE_TIMEOUT_MILLIS = 3_000;
export const PRISMA_PG_CONNECTION_TIMEOUT_MILLIS = 2_000;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaPgPool: Pool | undefined;
};

const SAFE_ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_ERROR_CODE = /^(?:[A-Z0-9]{5}|E[A-Z0-9_]{1,31})$/;

export function normalizePrismaDatabaseUrl(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return databaseUrl;
  }

  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.append("connection_limit", "1");
  }

  return url.toString();
}

export function createPrismaPgPoolConfig(databaseUrl: string): PoolConfig {
  return {
    connectionString: databaseUrl,
    max: PRISMA_PG_POOL_MAX,
    // Release idle serverless sessions quickly while avoiding churn inside a short warm-runtime burst.
    idleTimeoutMillis: PRISMA_PG_IDLE_TIMEOUT_MILLIS,
    connectionTimeoutMillis: PRISMA_PG_CONNECTION_TIMEOUT_MILLIS,
    allowExitOnIdle: true,
  };
}

function safePrismaPgPoolErrorToken(value: unknown): string | undefined {
  if (typeof value !== "string" || !SAFE_ERROR_CLASS.test(value)) {
    return undefined;
  }

  return value;
}

function safePrismaPgPoolErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !SAFE_ERROR_CODE.test(value)) {
    return undefined;
  }

  return value;
}

function logPrismaPgPoolError(error: Error & { code?: unknown }) {
  const safeError = {
    class: safePrismaPgPoolErrorToken(error.constructor.name) ?? "Error",
    code: safePrismaPgPoolErrorCode(error.code),
  };

  console.warn("Prisma pg pool error", safeError);
}

function getPrismaPgPool(databaseUrl: string) {
  if (!globalForPrisma.prismaPgPool) {
    const pool = new Pool(createPrismaPgPoolConfig(databaseUrl));
    pool.on("error", logPrismaPgPoolError);
    globalForPrisma.prismaPgPool = pool;
  }

  return globalForPrisma.prismaPgPool;
}

export function createPrismaClient() {
  const databaseUrl = normalizePrismaDatabaseUrl(process.env.DATABASE_URL);

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Prisma client engine");
  }

  const adapter = new PrismaPg(getPrismaPgPool(databaseUrl));
  return new PrismaClient({ adapter });
}

export function getPrismaClient() {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }

  return globalForPrisma.prisma;
}

function createLazyPrismaClient() {
  return new Proxy({} as PrismaClient, {
    get(_target, property) {
      const client = getPrismaClient();
      const value = Reflect.get(client, property, client);

      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

export const prisma = createLazyPrismaClient();
