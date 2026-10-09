/**
 * Retention for jobs and events.
 *
 * A job posting is deleted 45 days after it went up (15 days after it stopped
 * being shown); a past event is deleted six months after it finished. Both
 * predicates live in `lib/retention.ts` alongside the one the listings use, so
 * the board and the sweep cannot disagree about what "expired" means.
 *
 * ## What makes a deletion here safe
 *
 * Four things, and each is load-bearing:
 *
 *  1. **The numbers survive the row.** The admin dashboard buckets jobs and
 *     events by month, status and department, and the CSV exports list what was
 *     posted. So every purge writes an `ArchivedContent` row carrying exactly
 *     those dimensions — and the application and RSVP counts, read *before* the
 *     cascade removes them. What it does not carry is the reason the row went:
 *     descriptions, attachments, applications, RSVPs, résumés, contact details.
 *
 *  2. **The archive and the delete are one transaction.** Written separately,
 *     a crash between them either loses a month's numbers or leaves a row that
 *     will be counted again on the next sweep. `$transaction` makes them a
 *     single fact; `(kind, sourceId)` is unique, so even a retry that somehow
 *     re-ran a committed archive is refused rather than double-counted.
 *
 *  3. **Storage objects go first, and their failure stops the row.** A job's
 *     attachment and its applicants' résumés are only reachable through the
 *     keys on those rows. Delete the row first and the keys are gone while the
 *     files remain — orphaned in the bucket with nothing left that knows their
 *     names. So this deletes the objects first and, if any of them fails,
 *     leaves the row for the next sweep to retry. The cost of that ordering is
 *     the opposite failure — a deleted file whose row survives — which is
 *     recoverable, unlike an orphan nobody can find. `resumeCleanup` deletes
 *     the same résumé keys on a longer clock and tolerates them being gone.
 *
 *  4. **One row at a time, and a bounded batch.** A single transaction around
 *     the whole sweep would hold locks on every purged job for its duration and
 *     roll back the lot on one bad row. Per row, a failure costs that row and
 *     the sweep carries on; `MAX_PER_RUN` bounds what one tick can do.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { getStorage } from "../storage/index.js";
import { purgeableEventWhere, purgeableJobWhere } from "../lib/retention.js";

/**
 * Rows one tick will purge, per kind.
 *
 * Retention is a slow-moving backlog: after the first sweep clears whatever the
 * table had accumulated, a day's worth is a handful. The cap exists so the
 * *first* run on a long-lived database cannot hold the worker — and its lease —
 * for hours. Whatever it leaves is picked up tomorrow.
 */
const MAX_PER_RUN = 500;

export interface RetentionResult {
  /** Rows matching the retention predicate that this run looked at. */
  scanned: number;
  /** Rows archived and deleted. */
  purged: number;
  /** Rows left for the next sweep, because something about them failed. */
  failed: number;
}

const empty = (): RetentionResult => ({ scanned: 0, purged: 0, failed: 0 });

const fullName = (u?: { firstName: string; lastName: string } | null) =>
  u ? `${u.firstName} ${u.lastName}`.trim() || null : null;

/**
 * Delete every object in `keys`, or throw.
 *
 * "Already gone" is success: `resumeCleanup` may have removed a résumé on its
 * own clock, and a retried sweep re-deletes what it deleted last time. Only a
 * genuine failure — the bucket unreachable, permissions — must stop the row,
 * which is why this rejects rather than logging and continuing.
 */
const deleteObjects = async (keys: (string | null | undefined)[]): Promise<number> => {
  const storage = getStorage();
  const present = keys.filter((k): k is string => !!k);
  for (const key of present) await storage.delete(key);
  return present.length;
};

/* -------------------------------------------------------------------------- */
/*  Jobs                                                                      */
/* -------------------------------------------------------------------------- */

export const runJobRetention = async (now = new Date()): Promise<RetentionResult> => {
  const rows = await prisma.job.findMany({
    where: purgeableJobWhere(now),
    orderBy: { createdAt: "asc" },
    take: MAX_PER_RUN,
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      employmentType: true,
      vacancies: true,
      isClosed: true,
      closedAt: true,
      status: true,
      departments: true,
      createdAt: true,
      attachmentKey: true,
      createdBy: { select: { firstName: true, lastName: true } },
      // Both halves of what the archive needs from the children: how many there
      // were, and which files they point at. Read now, because the delete below
      // cascades them away.
      applications: { select: { resumeKey: true } },
    },
  });

  const result = { ...empty(), scanned: rows.length };

  for (const job of rows) {
    try {
      await deleteObjects([job.attachmentKey, ...job.applications.map((a) => a.resumeKey)]);
    } catch (err) {
      result.failed += 1;
      logger.warn(
        { err, jobId: job.id },
        "job retention: storage delete failed, keeping the row for the next sweep",
      );
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.archivedContent.create({
          data: {
            kind: "JOB",
            sourceId: job.id,
            title: job.title,
            authorName: fullName(job.createdBy),
            status: job.status,
            departments: job.departments,
            location: job.location,
            company: job.company,
            employmentType: job.employmentType,
            vacancies: job.vacancies,
            isClosed: job.isClosed,
            closedAt: job.closedAt,
            applicationCount: job.applications.length,
            // The posting's own date. Every month bucket on the dashboard reads
            // this column, so it must not become the purge date.
            createdAt: job.createdAt,
          },
        });
        // `JobApplication.jobId` is `onDelete: Cascade`, so the applications go
        // with it — which is why their count and their résumé keys were read
        // above rather than after.
        await tx.job.delete({ where: { id: job.id } });
      });
      result.purged += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({ err, jobId: job.id }, "job retention: archive+delete failed");
    }
  }

  logger.info({ ...result }, "job retention complete");
  return result;
};

/* -------------------------------------------------------------------------- */
/*  Events                                                                    */
/* -------------------------------------------------------------------------- */

export const runEventRetention = async (now = new Date()): Promise<RetentionResult> => {
  const rows = await prisma.event.findMany({
    where: purgeableEventWhere(now),
    orderBy: { startsAt: "asc" },
    take: MAX_PER_RUN,
    select: {
      id: true,
      title: true,
      location: true,
      isOnline: true,
      chapterId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      departments: true,
      createdAt: true,
      coverKey: true,
      attachmentKey: true,
      createdBy: { select: { firstName: true, lastName: true } },
      _count: { select: { rsvps: true } },
    },
  });

  const result = { ...empty(), scanned: rows.length };

  for (const event of rows) {
    try {
      await deleteObjects([event.coverKey, event.attachmentKey]);
    } catch (err) {
      result.failed += 1;
      logger.warn(
        { err, eventId: event.id },
        "event retention: storage delete failed, keeping the row for the next sweep",
      );
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.archivedContent.create({
          data: {
            kind: "EVENT",
            sourceId: event.id,
            title: event.title,
            authorName: fullName(event.createdBy),
            status: event.status,
            departments: event.departments,
            location: event.location,
            isOnline: event.isOnline,
            chapterId: event.chapterId,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            rsvpCount: event._count.rsvps,
            createdAt: event.createdAt,
          },
        });
        // `EventRsvp.eventId` cascades.
        await tx.event.delete({ where: { id: event.id } });
      });
      result.purged += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({ err, eventId: event.id }, "event retention: archive+delete failed");
    }
  }

  logger.info({ ...result }, "event retention complete");
  return result;
};

/**
 * Both halves, under one lease.
 *
 * Independently caught: a jobs failure must not cost the events sweep its
 * daily tick, since the two share nothing but a schedule.
 */
export const runContentRetention = async (
  now = new Date(),
): Promise<{ jobs: RetentionResult; events: RetentionResult }> => {
  const jobs = await runJobRetention(now).catch((err: unknown) => {
    logger.error({ err }, "job retention crashed");
    return empty();
  });
  const events = await runEventRetention(now).catch((err: unknown) => {
    logger.error({ err }, "event retention crashed");
    return empty();
  });
  return { jobs, events };
};
