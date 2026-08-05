import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { normalizePrismaDatabaseUrl } from "../src/lib/prisma";

const secretUsername = "pool_user";
const secretPassword = "super-secret-password";

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

test("Prisma source uses normalized datasource URL only when DATABASE_URL exists and globally reuses clients", async () => {
  const sourcePath = path.join(process.cwd(), "src/lib/prisma.ts");
  const routePath = path.join(process.cwd(), "src/app/api/cache/clear/route.ts");
  const [source, route] = await Promise.all([
    fs.readFile(sourcePath, "utf8"),
    fs.readFile(routePath, "utf8"),
  ]);

  assert.match(source, /normalizePrismaDatabaseUrl\(process\.env\.DATABASE_URL\)/);
  assert.match(source, /if \(!databaseUrl\)\s*{\s*return new PrismaClient\(\);\s*}/);
  assert.match(source, /datasources:\s*{\s*db:\s*{\s*url: databaseUrl,/);
  assert.match(source, /export const prisma = globalForPrisma\.prisma \?\? createPrismaClient\(\);/);
  assert.match(source, /globalForPrisma\.prisma = prisma;/);
  assert.doesNotMatch(source, /NODE_ENV !== ["']production["']/);
  assert.doesNotMatch(route, /new PrismaClient\(/);
  assert.doesNotMatch(route, /from ["']@prisma\/client["']/);
  assert.match(route, /import { prisma } from ["']@\/lib\/prisma["']/);
});
