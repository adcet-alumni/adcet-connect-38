/**
 * Monthly database backup, uploaded to the configured object storage.
 *
 * ## What this is, and what it is not
 *
 * This is the **portable secondary**: one restorable `pg_dump` per calendar
 * month, in storage you control, that survives losing the database provider
 * account entirely. It is not a replacement for the provider's own automated
 * backups, and DEPLOY.md says so — a managed Postgres snapshot restores to a
 * point in time; this restores to the 1st of the month. Run both.
 *
 * ## Why it is a daily job that usually does nothing
 *
 * `worker.ts` schedules on a fixed interval, and "every 30 days" is not "every
 * month" — it drifts, and a restart resets the clock, so a monthly job built on
 * an interval eventually skips a month without anybody noticing. Instead this
 * runs daily and asks the database whether the current `YYYY-MM` already has a
 * `DatabaseBackup` row. That makes it idempotent across restarts, rolling
 * deploys and overlapping workers, and it self-heals: a month whose backup
 * failed has no row, so the next day tries again rather than waiting 30 days.
 *
 * ## Handling the dump safely
 *
 * A dump is the whole platform in one file — password hashes, email addresses,
 * phone numbers, every record. Three consequences:
 *
 *  - it is written to a private temp file with `0600` and deleted in a
 *    `finally`, so a crash mid-upload does not leave it on the container's disk;
 *  - it goes to the `backup` scope, which `/uploads` cannot name in either
 *    direction (`UNREACHABLE_UPLOAD_SCOPES`) — no admin session can reach one;
 *  - the row is written only *after* the upload succeeds, so a `DatabaseBackup`
 *    row always means an object exists.
 *
 * The dump is taken with `--format=custom`, which is compressed and restores
 * selectively with `pg_restore`. The `pg_dump` binary must be the same major
 * version as the server, which is the single most common way this job fails on
 * a first deploy; the error says so explicitly rather than surfacing as
 * "exited with code 1".
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { getStorage } from "../storage/index.js";
import { env } from "../config/env.js";
import { UPLOAD_MAX_BYTES } from "../config/constants.js";

export interface BackupResult {
  /** Why nothing was done, when nothing was done. */
  skipped?: "disabled" | "already-taken-this-month";
  period?: string;
  objectKey?: string;
  sizeBytes?: number;
  durationMs?: number;
}

/** `YYYY-MM` in UTC — the same key shape `PostQuotaUsage` uses. */
export const periodOf = (now: Date): string => now.toISOString().slice(0, 7);

/**
 * Query parameters Prisma understands and `libpq` does not.
 *
 * `DATABASE_URL` is a Prisma connection string — it carries `?schema=public`,
 * and `lib/prisma.ts` appends `connection_limit` and `pool_timeout` on top.
 * Handing that URL to `pg_dump` fails with `invalid URI query parameter`, which
 * is a confusing way to discover that the two tools do not share a dialect.
 */
const PRISMA_ONLY_PARAMS = [
  "schema",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "socket_timeout",
  "statement_cache_size",
  "sslidentity",
  "sslcert",
  "sslpassword",
];

/**
 * Split a Prisma connection string into what `pg_dump` can actually take.
 *
 * The schema is not dropped, it is *moved*: Prisma names it in the URL and
 * `pg_dump` names it with `--schema`, so a deployment that puts the tables
 * somewhere other than `public` still gets a dump of its own data rather than
 * an empty one.
 */
export const pgDumpTarget = (databaseUrl: string): { url: string; schema?: string } => {
  try {
    const parsed = new URL(databaseUrl);
    const schema = parsed.searchParams.get("schema") ?? undefined;
    for (const param of PRISMA_ONLY_PARAMS) parsed.searchParams.delete(param);
    return { url: parsed.toString(), schema };
  } catch {
    // Not a URL we can parse — let pg_dump produce the error rather than us.
    return { url: databaseUrl };
  }
};

/**
 * Run `pg_dump` into `filePath`, or throw with something an operator can act on.
 *
 * `spawn` rather than `exec`: the dump is written to a file by `pg_dump`
 * itself (`--file`), so nothing large passes through a shell buffer, and the
 * connection string is an argument rather than a string interpolated into a
 * command line.
 */
const runPgDump = (databaseUrl: string, filePath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const target = pgDumpTarget(databaseUrl);
    const child = spawn(
      env.PG_DUMP_PATH,
      [
        target.url,
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        ...(target.schema ? [`--schema=${target.schema}`] : []),
        `--file=${filePath}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      // Bounded: a pathological failure must not be able to grow this without limit.
      if (stderr.length < 8_000) stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `pg_dump not found at "${env.PG_DUMP_PATH}". Install the postgresql-client ` +
              "package in the worker image, or set PG_DUMP_PATH to its location.",
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const versionMismatch = /server version|aborting because of server version mismatch/i.test(
        stderr,
      );
      reject(
        new Error(
          versionMismatch
            ? `pg_dump refused the server's version — the client must be the same major ` +
              `version as Postgres. ${stderr.trim()}`
            : `pg_dump exited with code ${code}. ${stderr.trim()}`,
        ),
      );
    });
  });

/**
 * Delete the oldest backups beyond `DB_BACKUP_KEEP`.
 *
 * Object first, row second — the same ordering as every other sweep here: the
 * key is only reachable through the row, so deleting the row first would strand
 * the dump in the bucket with nothing left naming it. A storage failure leaves
 * both, and next month's run tries again.
 */
const pruneOldBackups = async (keep: number): Promise<number> => {
  const stale = await prisma.databaseBackup.findMany({
    orderBy: { period: "desc" },
    skip: keep,
    select: { id: true, period: true, objectKey: true },
  });

  let pruned = 0;
  const storage = getStorage();
  for (const row of stale) {
    try {
      await storage.delete(row.objectKey);
      await prisma.databaseBackup.delete({ where: { id: row.id } });
      pruned += 1;
    } catch (err) {
      logger.warn({ err, period: row.period }, "backup prune failed; will retry next month");
    }
  }
  return pruned;
};

export const runDatabaseBackup = async (now: Date = new Date()): Promise<BackupResult> => {
  if (!env.DB_BACKUP_ENABLED) return { skipped: "disabled" };

  const period = periodOf(now);
  const existing = await prisma.databaseBackup.findUnique({ where: { period } });
  if (existing) {
    // Still attempt to prune stale backups even when this month's is done,
    // so a transient storage failure during the original run doesn't leave
    // old dumps around until a new month begins.
    await pruneOldBackups(env.DB_BACKUP_KEEP).catch((err) =>
      logger.warn({ err }, "backup prune retry failed"),
    );
    return { skipped: "already-taken-this-month", period };
  }

  const startedAt = Date.now();
  const dir = await mkdtemp(path.join(tmpdir(), "adcet-backup-"));
  const fileName = `adcet-${period}.dump`;
  const filePath = path.join(dir, fileName);

  try {
    await runPgDump(env.DATABASE_URL, filePath);

    const { size } = await stat(filePath);
    if (size === 0) throw new Error("pg_dump produced an empty file");
    if (size > UPLOAD_MAX_BYTES.backup) {
      throw new Error(
        `Dump is ${Math.round(size / 1024 / 1024)} MB, over the ${Math.round(
          UPLOAD_MAX_BYTES.backup / 1024 / 1024,
        )} MB ceiling. Move to the database provider's own snapshots rather than raising it.`,
      );
    }

    const stored = await getStorage().upload({
      fileName,
      contentType: "application/octet-stream",
      scope: "backup",
      // Not a user id — backups belong to nobody, and the `/uploads` API cannot
      // name this scope in the first place.
      ownerId: period,
      body: await readFile(filePath),
    });

    const durationMs = Date.now() - startedAt;
    // Written last: a row must always mean the object is really there.
    // If the insert fails (e.g. integer overflow on sizeBytes, connection
    // error), delete the already-uploaded object so it does not become an
    // orphan that no retention sweep can ever reach.
    try {
      await prisma.databaseBackup.create({
        data: { period, objectKey: stored.key, sizeBytes: size, durationMs },
      });
    } catch (insertErr) {
      logger.error(
        { err: insertErr, objectKey: stored.key },
        "backup row insert failed — removing orphaned dump from storage",
      );
      await getStorage()
        .delete(stored.key)
        .catch((delErr) =>
          logger.error({ err: delErr, objectKey: stored.key }, "failed to clean up orphaned backup object"),
        );
      throw insertErr;
    }

    const pruned = await pruneOldBackups(env.DB_BACKUP_KEEP);
    logger.info(
      { period, objectKey: stored.key, sizeBytes: size, durationMs, pruned },
      "database backup complete",
    );
    return { period, objectKey: stored.key, sizeBytes: size, durationMs };
  } finally {
    // The dump is the entire database in one file; it does not stay on disk,
    // whatever happened above.
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
      logger.error({ err, dir }, "failed to remove the temporary backup directory"),
    );
  }
};
