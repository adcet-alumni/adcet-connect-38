/**
 * Time-limited leases on background jobs, so exactly one process runs a given
 * tick however many are up.
 *
 * See the `JobLease` model for why this is a lease in a table rather than
 * `pg_try_advisory_lock`: advisory locks belong to a connection, and Prisma
 * hands out pooled ones, so the unlock can land on a different connection than
 * the lock did.
 */
import { hostname } from "node:os";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

/** Every job that takes a lease. One place, so two jobs cannot collide on a name. */
export const JOB_LEASES = {
  eventReminders: "event-reminders",
  geoBackfill: "geo-backfill",
  resumeCleanup: "resume-cleanup",
} as const;

export type JobName = (typeof JOB_LEASES)[keyof typeof JOB_LEASES];

/** Identifies the holder in the table. Debugging aid — never read for logic. */
const owner = () => `${hostname()}#${process.pid}`;

export interface LeaseOutcome {
  /** False when another process held the lease; the tick was skipped, not failed. */
  ran: boolean;
}

/**
 * Run `fn` if this process can claim `name`'s lease, otherwise skip the tick.
 *
 * `leaseMs` should exceed the job's worst-case runtime: it is the window in
 * which a process that dies mid-run blocks its successor. Too short and two
 * workers overlap; too long and a crash stalls the job. It is not a timeout —
 * nothing interrupts `fn`.
 */
export const withJobLease = async (
  name: JobName,
  leaseMs: number,
  fn: () => Promise<unknown>,
): Promise<LeaseOutcome> => {
  const holder = owner();
  const lockedUntil = new Date(Date.now() + leaseMs);

  /*
   * One statement, so the claim is atomic without a transaction. The `WHERE` on
   * the `DO UPDATE` is what makes it a test-and-set: a row whose lease is still
   * live fails the predicate, the update affects nothing, and this caller is
   * told it did not get the lease. Exactly one concurrent caller sees 1.
   */
  const claimed = await prisma.$executeRaw`
    INSERT INTO "JobLease" ("name", "lockedUntil", "lockedBy", "updatedAt")
    VALUES (${name}, ${lockedUntil}, ${holder}, now())
    ON CONFLICT ("name") DO UPDATE
      SET "lockedUntil" = EXCLUDED."lockedUntil",
          "lockedBy"    = EXCLUDED."lockedBy",
          "updatedAt"   = now()
      WHERE "JobLease"."lockedUntil" IS NULL
         OR "JobLease"."lockedUntil" < now()`;

  if (claimed === 0) {
    logger.debug({ job: name }, "job lease held elsewhere — skipping this tick");
    return { ran: false };
  }

  try {
    await fn();
  } finally {
    // Released even when the job throws: a failed run must not block the next
    // one until the lease expires. Only the holder clears it, so a run that
    // overran its lease and was taken over cannot release the new holder's.
    await prisma
      .$executeRaw`
        UPDATE "JobLease"
        SET "lockedUntil" = NULL, "lastRunAt" = now(), "updatedAt" = now()
        WHERE "name" = ${name} AND "lockedBy" = ${holder}`
      .catch((err: unknown) => logger.error({ err, job: name }, "failed to release job lease"));
  }

  return { ran: true };
};
