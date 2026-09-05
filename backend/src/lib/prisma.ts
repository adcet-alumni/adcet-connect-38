/**
 * Singleton PrismaClient. Reused across requests to avoid exhausting DB connections.
 */
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Pin the pool size in the connection string.
 *
 * Prisma reads `connection_limit` and `pool_timeout` from the URL and nowhere
 * else, and defaults the limit to `num_physical_cpus * 2 + 1` — so the same
 * image opens a different number of connections on a 2-core container than on
 * an 8-core one, and you find out by way of "Timed out fetching a new
 * connection from the connection pool" under load rather than at deploy time.
 *
 * Anything the operator already put in the URL wins: this only fills the gaps.
 */
export const withPoolSettings = (url: string): string => {
  try {
    const parsed = new URL(url);
    const defaults: Record<string, string> = {
      connection_limit: String(env.DATABASE_CONNECTION_LIMIT),
      pool_timeout: String(env.DATABASE_POOL_TIMEOUT),
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    // A URL Prisma will reject anyway — let it produce the error, not us.
    return url;
  }
};

const createClient = () => {
  const client = new PrismaClient({
    datasources: { db: { url: withPoolSettings(env.DATABASE_URL) } },
    // Queries are emitted as events rather than printed by Prisma, so the
    // slow-query threshold below applies in every environment instead of
    // production having no query visibility at all.
    log: [
      { emit: "event", level: "query" },
      { emit: "stdout", level: "warn" },
      { emit: "stdout", level: "error" },
    ],
  });

  client.$on("query", (e) => {
    if (e.duration >= env.DATABASE_SLOW_QUERY_MS) {
      logger.warn({ durationMs: e.duration, query: e.query, params: e.params }, "slow query");
      return;
    }
    // Every query, for local debugging — unchanged from before in practice,
    // since .env.development sets LOG_LEVEL=debug.
    if (env.NODE_ENV === "development") {
      logger.debug({ durationMs: e.duration, query: e.query }, "query");
    }
  });

  return client;
};

export const prisma = globalForPrisma.prisma ?? createClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
