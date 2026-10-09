/**
 * The retention predicates decide when content disappears from the board and
 * when it is deleted for good, so what matters is the boundaries: a job one
 * hour either side of 30 days, and an event one day either side of six months.
 *
 * These are pure — every predicate takes `now` — so they can be tested at an
 * exact instant without touching the clock, and the same objects can be checked
 * against both the *visible* and the *purgeable* rule to prove the two never
 * overlap. That is the property that actually matters: a job the board is still
 * showing must never be a job the sweep is about to delete.
 */
import { describe, expect, it } from "@jest/globals";
import { EVENT_RETENTION_MONTHS, JOB_RETENTION } from "../../config/constants.js";
import {
  daysBefore,
  isJobExpired,
  liveJobWhere,
  monthsBefore,
  purgeableEventWhere,
  purgeableJobWhere,
} from "../../lib/retention.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Evaluates the OR-of-ANDs a Prisma `where` fragment describes, in memory. */
type Row = { expiresAt?: Date | null; createdAt?: Date; startsAt?: Date; endsAt?: Date | null };
const matches = (
  where: { OR: Record<string, unknown>[] },
  row: Row,
): boolean =>
  where.OR.some((clause) =>
    Object.entries(clause).every(([field, cond]) => {
      const value = (row as Record<string, unknown>)[field] as Date | null | undefined;
      if (cond === null) return value === null || value === undefined;
      const c = cond as { gt?: Date; lte?: Date };
      if (!value) return false;
      if (c.gt) return value > c.gt;
      if (c.lte) return value <= c.lte;
      return false;
    }),
  );

const visible = (row: Row) => matches(liveJobWhere(NOW) as never, row);
const purgeable = (row: Row) => matches(purgeableJobWhere(NOW) as never, row);
const eventPurgeable = (row: Row) => matches(purgeableEventWhere(NOW) as never, row);

describe("date arithmetic", () => {
  it("daysBefore walks back exact days", () => {
    expect(daysBefore(NOW, 30).toISOString()).toBe("2026-08-11T12:00:00.000Z");
  });

  it("monthsBefore lands on the calendar month, not 30-day blocks", () => {
    expect(monthsBefore(NOW, 6).toISOString()).toBe("2026-03-10T12:00:00.000Z");
  });

  /**
   * 31 August minus six months has no 31 February. Clamping to the end of the
   * month is what an office means by "six months after the event"; rolling
   * over into March would sweep a batch of events a few days early.
   */
  it("monthsBefore clamps a short month rather than rolling over", () => {
    const aug31 = new Date("2026-08-31T00:00:00.000Z");
    const back = monthsBefore(aug31, 6);
    expect(back.getUTCMonth()).toBe(1); // February
    expect(back.getUTCDate()).toBeLessThanOrEqual(29);
  });
});

describe("liveJobWhere — what the board shows", () => {
  it("shows a posting inside its 30-day window", () => {
    expect(visible({ expiresAt: null, createdAt: new Date(NOW.getTime() - 29 * DAY) })).toBe(true);
  });

  it("hides one an hour past 30 days", () => {
    const createdAt = new Date(NOW.getTime() - 30 * DAY - HOUR);
    expect(visible({ expiresAt: null, createdAt })).toBe(false);
  });

  it("still shows one an hour short of 30 days", () => {
    const createdAt = new Date(NOW.getTime() - 30 * DAY + HOUR);
    expect(visible({ expiresAt: null, createdAt })).toBe(true);
  });

  /** `expiresAt` is an override, not a second rule running alongside the age. */
  it("keeps an extended posting on the board long past 30 days", () => {
    const row = {
      expiresAt: new Date(NOW.getTime() + 10 * DAY),
      createdAt: new Date(NOW.getTime() - 200 * DAY),
    };
    expect(visible(row)).toBe(true);
  });

  it("hides a posting whose explicit expiry has passed, however new it is", () => {
    const row = {
      expiresAt: new Date(NOW.getTime() - HOUR),
      createdAt: new Date(NOW.getTime() - DAY),
    };
    expect(visible(row)).toBe(false);
  });
});

describe("isJobExpired — the same rule, applied to one row", () => {
  it.each([
    ["fresh", { expiresAt: null, createdAt: new Date(NOW.getTime() - DAY) }, false],
    ["aged out", { expiresAt: null, createdAt: new Date(NOW.getTime() - 31 * DAY) }, true],
    ["extended", { expiresAt: new Date(NOW.getTime() + DAY), createdAt: new Date(NOW.getTime() - 90 * DAY) }, false],
    ["explicitly expired", { expiresAt: new Date(NOW.getTime() - DAY), createdAt: NOW }, true],
  ])("%s", (_label, job, expected) => {
    expect(isJobExpired(job as { expiresAt: Date | null; createdAt: Date }, NOW)).toBe(expected);
  });

  /**
   * `apply()` and the listing must agree exactly, or a member sees a posting
   * they are then refused — or worse, applies to one the board is hiding.
   */
  it("agrees with liveJobWhere at every boundary", () => {
    for (const days of [0, 29, 29.9, 30, 30.1, 31, 100]) {
      const row = { expiresAt: null, createdAt: new Date(NOW.getTime() - days * DAY) };
      expect(isJobExpired(row, NOW)).toBe(!visible(row));
    }
  });
});

describe("purgeableJobWhere — what the sweep deletes", () => {
  it("deletes a posting 45 days after it went up", () => {
    const createdAt = new Date(NOW.getTime() - (JOB_RETENTION.RETENTION_DAYS + 1) * DAY);
    expect(purgeable({ expiresAt: null, createdAt })).toBe(true);
  });

  it("leaves one at 44 days", () => {
    const createdAt = new Date(NOW.getTime() - 44 * DAY);
    expect(purgeable({ expiresAt: null, createdAt })).toBe(false);
  });

  /**
   * The whole point of the gap between 30 and 45: the poster can still open an
   * expired posting and read its applications while they shortlist.
   */
  it("leaves a posting that is hidden but still inside its grace period", () => {
    const createdAt = new Date(NOW.getTime() - 35 * DAY);
    const row = { expiresAt: null, createdAt };
    expect(visible(row)).toBe(false);
    expect(purgeable(row)).toBe(false);
  });

  /** Extending a posting has to postpone the deletion by the same amount. */
  it("does not delete an extended posting, even one 200 days old", () => {
    const row = {
      expiresAt: new Date(NOW.getTime() + DAY),
      createdAt: new Date(NOW.getTime() - 200 * DAY),
    };
    expect(purgeable(row)).toBe(false);
  });

  it("deletes an extended posting 15 days after the extension ran out", () => {
    const row = {
      expiresAt: new Date(NOW.getTime() - 16 * DAY),
      createdAt: new Date(NOW.getTime() - 300 * DAY),
    };
    expect(purgeable(row)).toBe(true);
  });

  /**
   * The safety property. Anything the board is still showing must be outside
   * the sweep's reach, at every age and under both expiry regimes — otherwise
   * a job could vanish from under someone reading it.
   */
  it("never marks a visible posting purgeable", () => {
    for (const days of [0, 1, 15, 29, 30, 31, 44, 45, 46, 100, 400]) {
      for (const expiresAt of [null, new Date(NOW.getTime() + DAY), new Date(NOW.getTime() - 20 * DAY)]) {
        const row = { expiresAt, createdAt: new Date(NOW.getTime() - days * DAY) };
        expect(visible(row) && purgeable(row)).toBe(false);
      }
    }
  });
});

describe("purgeableEventWhere — six months after it finished", () => {
  const monthsAgo = (n: number) => monthsBefore(NOW, n);

  it("deletes an event that ended seven months ago", () => {
    expect(eventPurgeable({ startsAt: monthsAgo(7), endsAt: monthsAgo(7) })).toBe(true);
  });

  it("leaves one that ended five months ago", () => {
    expect(eventPurgeable({ startsAt: monthsAgo(5), endsAt: monthsAgo(5) })).toBe(false);
  });

  /**
   * A multi-day event is past when it *ends*. Sweeping on `startsAt` would
   * delete a week-long reunion up to a week early.
   */
  it("measures from endsAt, not startsAt, when the event declared one", () => {
    const row = { startsAt: monthsAgo(7), endsAt: monthsAgo(5) };
    expect(eventPurgeable(row)).toBe(false);
  });

  it("falls back to startsAt when there is no endsAt", () => {
    expect(eventPurgeable({ startsAt: monthsAgo(7), endsAt: null })).toBe(true);
  });

  /** Retention is about the event's date, never how long ago it was created. */
  it("never deletes an upcoming event", () => {
    const row = { startsAt: new Date(NOW.getTime() + 30 * DAY), endsAt: null };
    expect(eventPurgeable(row)).toBe(false);
  });

  it("uses the configured window", () => {
    const justInside = monthsBefore(NOW, EVENT_RETENTION_MONTHS);
    expect(eventPurgeable({ startsAt: justInside, endsAt: null })).toBe(true);
    expect(
      eventPurgeable({ startsAt: new Date(justInside.getTime() + HOUR), endsAt: null }),
    ).toBe(false);
  });
});
