import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createPrismaPgPoolConfig,
  getPrismaClient,
  normalizePrismaDatabaseUrl,
  PRISMA_PG_CONNECTION_TIMEOUT_MILLIS,
  PRISMA_PG_IDLE_TIMEOUT_MILLIS,
  PRISMA_PG_POOL_MAX,
} from "../src/lib/prisma";

const secretUsername = "pool_user";
const secretPassword = "super-secret-password";
const originalDatabaseUrl = process.env.DATABASE_URL;

const prismaGlobals = globalThis as typeof globalThis & {
  prisma?: { $disconnect: () => Promise<void> };
  prismaPgPool?: {
    end: () => Promise<void>;
    emit: (event: "error", error: Error) => boolean;
    listenerCount: (event: "error") => number;
    options?: {
      allowExitOnIdle?: boolean;
      connectionString?: string;
      connectionTimeoutMillis?: number;
      idleTimeoutMillis?: number | null;
      max?: number;
    };
  };
};

async function resetPrismaGlobals() {
  await prismaGlobals.prisma?.$disconnect().catch(() => undefined);
  await prismaGlobals.prismaPgPool?.end().catch(() => undefined);
  delete prismaGlobals.prisma;
  delete prismaGlobals.prismaPgPool;
}

test.after(async () => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  await resetPrismaGlobals();
});

test("returns undefined when DATABASE_URL is absent", () => {
  assert.equal(normalizePrismaDatabaseUrl(undefined), undefined);
});

test("adds connection_limit=1 while preserving credentials and existing query params", () => {
  const original = new URL(
    `postgresql://${secretUsername}:${secretPassword}@db.example.com:5432/app?sslmode=require&schema=public`,
  );

  const normalized = normalizePrismaDatabaseUrl(original.toString());

  assert.ok(normalized);
  const parsed = new URL(normalized);
  assert.equal(parsed.protocol, original.protocol);
  assert.equal(parsed.host, original.host);
  assert.equal(parsed.pathname, original.pathname);
  assert.equal(parsed.username, original.username);
  assert.equal(parsed.password, original.password);
  assert.equal(parsed.searchParams.get("sslmode"), "require");
  assert.equal(parsed.searchParams.get("schema"), "public");
  assert.equal(parsed.searchParams.get("connection_limit"), "1");
});

test("preserves an explicit operator connection_limit", () => {
  const original = new URL(
    `postgres://${secretUsername}:${secretPassword}@db.example.com/app?connection_limit=7&sslmode=require`,
  );

  const normalized = normalizePrismaDatabaseUrl(original.toString());

  assert.ok(normalized);
  const parsed = new URL(normalized);
  assert.equal(parsed.searchParams.get("connection_limit"), "7");
  assert.equal(parsed.searchParams.get("sslmode"), "require");
  assert.equal(parsed.searchParams.getAll("connection_limit").length, 1);
});

test("leaves unparsable URLs on Prisma's standard error path", () => {
  const invalidUrl = "not a database url";

  assert.equal(normalizePrismaDatabaseUrl(invalidUrl), invalidUrl);
});

test("does not print or log database credentials while normalizing", () => {
  const original = new URL(`postgresql://${secretUsername}:${secretPassword}@db.example.com/app`);
  const messages: string[] = [];
  const originalConsole = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };

  console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  console.info = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => messages.push(args.map(String).join(" "));

  try {
    normalizePrismaDatabaseUrl(original.toString());
  } finally {
    console.error = originalConsole.error;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }

  const output = messages.join("\n");
  assert.equal(output.includes(secretUsername), false);
  assert.equal(output.includes(secretPassword), false);
});

test("pg pool config is bounded for serverless and does not depend on connection_limit", () => {
  const databaseUrl = `postgresql://${secretUsername}:${secretPassword}@db.example.com:6543/postgres?pgbouncer=true&connection_limit=7`;

  const config = createPrismaPgPoolConfig(databaseUrl);

  assert.equal(PRISMA_PG_POOL_MAX, 1);
  assert.equal(PRISMA_PG_IDLE_TIMEOUT_MILLIS, 3_000);
  assert.equal(PRISMA_PG_CONNECTION_TIMEOUT_MILLIS, 2_000);
  assert.equal(config.connectionString, databaseUrl);
  assert.equal(config.max, 1);
  assert.equal(config.idleTimeoutMillis, 3_000);
  assert.equal(config.connectionTimeoutMillis, 2_000);
  assert.equal(config.allowExitOnIdle, true);
});

test("reuses one global pg Pool and one global PrismaClient when DATABASE_URL exists", async () => {
  await resetPrismaGlobals();
  process.env.DATABASE_URL =
    `postgresql://${secretUsername}:${secretPassword}@db.example.com:6543/postgres?pgbouncer=true&connection_limit=7`;

  const first = getPrismaClient();
  const second = getPrismaClient();

  assert.equal(first, second);
  assert.ok(prismaGlobals.prismaPgPool);
  assert.equal(prismaGlobals.prisma, first);
  assert.equal(prismaGlobals.prismaPgPool.options?.max, 1);
  assert.equal(prismaGlobals.prismaPgPool.options?.idleTimeoutMillis, 3_000);
  assert.equal(prismaGlobals.prismaPgPool.options?.connectionTimeoutMillis, 2_000);
  assert.equal(prismaGlobals.prismaPgPool.options?.allowExitOnIdle, true);
  assert.match(prismaGlobals.prismaPgPool.options?.connectionString ?? "", /connection_limit=7/);

  await resetPrismaGlobals();
});

test("requires DATABASE_URL before creating the client engine PrismaClient", async () => {
  await resetPrismaGlobals();
  delete process.env.DATABASE_URL;

  assert.throws(() => getPrismaClient(), /DATABASE_URL is required for Prisma client engine/);
  assert.equal(prismaGlobals.prisma, undefined);
  assert.equal(prismaGlobals.prismaPgPool, undefined);

  await resetPrismaGlobals();
});

test("does not print database credentials while building the adapter-backed client", async () => {
  await resetPrismaGlobals();
  process.env.DATABASE_URL = `postgresql://${secretUsername}:${secretPassword}@db.example.com/postgres`;

  const messages: string[] = [];
  const originalConsole = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };

  console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  console.info = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => messages.push(args.map(String).join(" "));

  try {
    getPrismaClient();
  } finally {
    console.error = originalConsole.error;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }

  const output = messages.join("\n");
  assert.equal(output.includes(secretUsername), false);
  assert.equal(output.includes(secretPassword), false);

  await resetPrismaGlobals();
});

test("Prisma generator uses client engine mode without dropping binary targets", async () => {
  const schema = await fs.readFile(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");

  assert.match(schema, /generator client\s*{[\s\S]*?provider\s*=\s*"prisma-client-js"/);
  assert.match(
    schema,
    /generator client\s*{[\s\S]*?binaryTargets\s*=\s*\["native", "linux-arm64-openssl-3\.0\.x"\]/,
  );
  assert.match(schema, /generator client\s*{[\s\S]*?engineType\s*=\s*"client"/);
});

test("global pg Pool has one safe error listener and does not leak credentials", async () => {
  await resetPrismaGlobals();
  process.env.DATABASE_URL =
    `postgresql://${secretUsername}:${secretPassword}@db.example.com:6543/postgres?pgbouncer=true`;

  getPrismaClient();
  getPrismaClient();

  const pool = prismaGlobals.prismaPgPool;
  assert.ok(pool);
  assert.equal(pool.listenerCount("error"), 1);

  const messages: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => messages.push(args);

  try {
    const error = new Error(
      `connection failed for postgresql://${secretUsername}:${secretPassword}@db.example.com:6543/postgres`,
    ) as Error & { code?: string };
    error.code = `bad-${secretPassword}`;

    assert.equal(pool.emit("error", error), true);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(pool.listenerCount("error"), 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.[0], "Prisma pg pool error");
  assert.deepEqual(messages[0]?.[1], { class: "Error", code: undefined });

  const output = JSON.stringify(messages);
  assert.equal(output.includes(secretUsername), false);
  assert.equal(output.includes(secretPassword), false);
  assert.equal(output.includes("db.example.com"), false);
  assert.equal(output.includes("connection failed"), false);
  assert.equal(output.includes("postgresql://"), false);

  await resetPrismaGlobals();
});

test("Prisma source uses adapter-backed pg Pool and cache clear keeps the shared client", async () => {
  const sourcePath = path.join(process.cwd(), "src/lib/prisma.ts");
  const routePath = path.join(process.cwd(), "src/app/api/cache/clear/route.ts");
  const [source, route] = await Promise.all([
    fs.readFile(sourcePath, "utf8"),
    fs.readFile(routePath, "utf8"),
  ]);

  assert.match(source, /normalizePrismaDatabaseUrl\(process\.env\.DATABASE_URL\)/);
  assert.match(source, /if \(!databaseUrl\)\s*{\s*throw new Error\(["']DATABASE_URL is required for Prisma client engine["']\);\s*}/);
  assert.match(source, /new Pool\(createPrismaPgPoolConfig\(databaseUrl\)\)/);
  assert.match(source, /pool\.on\(["']error["'], logPrismaPgPoolError\)/);
  assert.match(source, /new PrismaPg\(getPrismaPgPool\(databaseUrl\)\)/);
  assert.match(source, /new PrismaClient\(\{ adapter \}\)/);
  assert.match(source, /export const prisma = createLazyPrismaClient\(\);/);
  assert.match(source, /prismaPgPool: Pool \| undefined/);
  assert.doesNotMatch(source, /datasources:/);
  assert.doesNotMatch(source, /name:\s*["'`]/);
  assert.doesNotMatch(source, /NODE_ENV !== ["']production["']/);
  assert.doesNotMatch(route, /new PrismaClient\(/);
  assert.doesNotMatch(route, /from ["']@prisma\/client["']/);
  assert.match(route, /import { prisma } from ["']@\/lib\/prisma["']/);
});
