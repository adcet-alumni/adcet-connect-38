/**
 * When a job stops being shown, and when a job or event is deleted.
 *
 * One module because the three rules have to agree. A listing that hid
 * postings on one definition of "expired" while the sweep deleted them on
 * another would either purge a job still on the board or leave one on the
 * board forever — and the bug would only show up 45 days after a deploy.
 * Every caller — `jobs.service.ts`, `events.service.ts` and
 * `jobs/contentRetention.ts` — reads its predicate from here.
 *
 * `now` is always a parameter rather than a call to `new Date()` inside, so a
 * test can place a row on either side of a boundary without touching the clock.
 */
import type { Prisma } from "@prisma/client";
import { EVENT_RETENTION_MONTHS, JOB_RETENTION } from "../config/constants.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const daysBefore = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * DAY_MS);

/**
 * `now`, less `months` calendar months, clamped to the end of a short month.
 *
 * `setUTCMonth` alone does **not** do this — it rolls over. Six months before
 * 31 August is 31 February, which JavaScript resolves to 3 March, and a sweep
 * built on that would delete a batch of end-of-month events up to three days
 * early. Moving to the 1st before the arithmetic keeps the month subtraction
 * honest; clamping the day back on afterwards gives 28 February.
 */
export const monthsBefore = (now: Date, months: number): Date => {
  const d = new Date(now.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDayOfTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d;
};

/**
 * Jobs a member may see on the board.
 *
 * A posting is live while its **effective expiry** is in the future, which is
 * `expiresAt` when an admin set one and `createdAt + VISIBLE_DAYS` otherwise.
 * Expressed as an OR of those two cases because SQL has no `coalesce` inside a
 * Prisma `where`:
 *
 *   - `expiresAt` in the future  → visible, however old the posting is.
 *   - `expiresAt` in the past    → hidden, however new it is.
 *   - `expiresAt` unset          → visible for `VISIBLE_DAYS` from posting.
 *
 * Admins are not filtered by this: the board hides an expired posting, the
 * console still has to show it, and its poster still has to reach the
 * applications during the grace period before it is deleted.
 */
export const liveJobWhere = (now: Date): Prisma.JobWhereInput => ({
  OR: [
    { expiresAt: { gt: now } },
    { expiresAt: null, createdAt: { gt: daysBefore(now, JOB_RETENTION.VISIBLE_DAYS) } },
  ],
});

/** True when this job would be hidden from the board at `now`. */
export const isJobExpired = (
  job: { expiresAt?: Date | null; createdAt: Date },
  now: Date,
): boolean =>
  job.expiresAt
    ? job.expiresAt <= now
    : job.createdAt <= daysBefore(now, JOB_RETENTION.VISIBLE_DAYS);

/**
 * How long an expired posting survives before it is deleted.
 *
 * Derived rather than written as a third constant, so 30 and 45 cannot drift
 * apart: it is applied to the *effective* expiry, which is what makes
 * extending a posting with `expiresAt` postpone the deletion by exactly as much
 * as it postpones the hiding.
 */
const GRACE_DAYS = JOB_RETENTION.RETENTION_DAYS - JOB_RETENTION.VISIBLE_DAYS;

export const purgeableJobWhere = (now: Date): Prisma.JobWhereInput => {
  const graceEnd = daysBefore(now, GRACE_DAYS);
  return {
    OR: [
      { expiresAt: { lte: graceEnd } },
      {
        expiresAt: null,
        createdAt: { lte: daysBefore(now, JOB_RETENTION.RETENTION_DAYS) },
      },
    ],
  };
};

/**
 * Events retention should delete: finished more than
 * `EVENT_RETENTION_MONTHS` ago.
 *
 * `endsAt` decides it where the event declared one — a three-day reunion is
 * past when it ends, not when it opens — and `startsAt` where it did not.
 * An upcoming event is never swept, however long ago it was created, which is
 * why this reads the event's own dates and not `createdAt`.
 */
export const purgeableEventWhere = (now: Date): Prisma.EventWhereInput => {
  const cutoff = monthsBefore(now, EVENT_RETENTION_MONTHS);
  return {
    OR: [
      { endsAt: { lte: cutoff } },
      { endsAt: null, startsAt: { lte: cutoff } },
    ],
  };
};

/**
 * When a posting leaves the board, and when it is deleted.
 *
 * Returned to the poster on their own listing so an expiring job says so
 * *before* it disappears. The rule lives here rather than being mirrored in the
 * frontend, so there is one definition of the window and no second copy to
 * drift from it.
 */
export const jobRetentionDates = (job: { expiresAt?: Date | null; createdAt: Date }) => {
  const expiresOn =
    job.expiresAt ?? new Date(job.createdAt.getTime() + JOB_RETENTION.VISIBLE_DAYS * DAY_MS);
  return {
    expiresOn,
    /** The grace period the poster has to read the applications, then it goes. */
    purgesOn: new Date(expiresOn.getTime() + GRACE_DAYS * DAY_MS),
  };
};
