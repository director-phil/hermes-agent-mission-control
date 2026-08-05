import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

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

function createPrismaClient() {
  const databaseUrl = normalizePrismaDatabaseUrl(process.env.DATABASE_URL);

  if (!databaseUrl) {
    return new PrismaClient();
  }

  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

globalForPrisma.prisma = prisma;
