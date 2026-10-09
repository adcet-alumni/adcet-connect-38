/**
 * Retention deletes content permanently, so these tests are about the ways it
 * could go wrong rather than the happy path:
 *
 *  - numbers lost, because the archive was skipped or stamped with the wrong date
 *  - numbers counted twice, because a retried sweep re-archived a row
 *  - files orphaned, because the row was deleted before the objects it named
 *  - a whole sweep abandoned, because one row failed
 *
 * The archive/delete atomicity itself is a database guarantee and is tested
 * against a real Postgres in `contentRetention.db.test.ts`; here `$transaction`
 * is executed so the *contents* of that transaction can be asserted.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma: prismaMock }));

const storageDelete = jest.fn(async (_key: string) => undefined);
jest.unstable_mockModule("../../storage/index.js", () => ({
  getStorage: () => ({ delete: storageDelete }),
}));

const { runJobRetention, runEventRetention, runContentRetention } = await import(
  "../../jobs/contentRetention.js"
);

const NOW = new Date("2026-09-10T12:00:00.000Z");

/** A job old enough to purge, with an attachment and two applicants. */
const purgeableJob = (over: Record<string, unknown> = {}) => ({
  id: "job-1",
  title: "Backend Engineer",
  company: "Acme",
  location: "Pune",
  employmentType: "FULL_TIME",
  vacancies: 2,
  isClosed: false,
  closedAt: null,
  status: "APPROVED",
  departments: ["Computer Science and Engineering"],
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  attachmentKey: "job-attachment/u-1/jd.pdf",
  createdBy: { firstName: "Alice", lastName: "Patil" },
  applications: [
    { resumeKey: "resume/u-2/cv.pdf" },
    { resumeKey: "resume/u-3/cv.pdf" },
  ],
  ...over,
});

const purgeableEvent = (over: Record<string, unknown> = {}) => ({
  id: "evt-1",
  title: "Alumni Meet 2025",
  location: "Ashta",
  isOnline: false,
  chapterId: "chap-1",
  startsAt: new Date("2026-01-05T00:00:00.000Z"),
  endsAt: new Date("2026-01-06T00:00:00.000Z"),
  status: "APPROVED",
  departments: [],
  createdAt: new Date("2025-12-01T00:00:00.000Z"),
  coverKey: "event/u-1/cover.jpg",
  attachmentKey: null,
  createdBy: { firstName: "Bob", lastName: "Kulkarni" },
  _count: { rsvps: 42 },
  ...over,
});

/** Runs the transaction callback against the mock, as Prisma would. */
const runTx = () =>
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));

beforeEach(() => {
  storageDelete.mockReset();
  storageDelete.mockResolvedValue(undefined);
  Object.values(prismaMock).forEach((m: any) =>
    m && typeof m === "object" ? Object.values(m).forEach((fn: any) => fn?.mockReset?.()) : null,
  );
});

describe("runJobRetention", () => {
  it("archives the posting's reporting dimensions, then deletes it", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([purgeableJob()]);
    prismaMock.archivedContent.create.mockResolvedValueOnce({});
    prismaMock.job.delete.mockResolvedValueOnce({});
    runTx();

    const out = await runJobRetention(NOW);

    expect(out).toEqual({ scanned: 1, purged: 1, failed: 0 });
    const archived = (prismaMock.archivedContent.create.mock.calls[0][0] as any).data;
    expect(archived).toMatchObject({
      kind: "JOB",
      sourceId: "job-1",
      title: "Backend Engineer",
      company: "Acme",
      status: "APPROVED",
      departments: ["Computer Science and Engineering"],
      authorName: "Alice Patil",
      // Read before the cascade removed them.
      applicationCount: 2,
    });
    expect(prismaMock.job.delete).toHaveBeenCalledWith({ where: { id: "job-1" } });
  });

  /**
   * Every month bucket on the dashboard reads this column. Stamping it with
   * the purge date would move a July posting into September and silently
   * rewrite the year's chart.
   */
  it("carries the posting's own createdAt, not the purge date", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([purgeableJob()]);
    prismaMock.archivedContent.create.mockResolvedValueOnce({});
    prismaMock.job.delete.mockResolvedValueOnce({});
    runTx();

    await runJobRetention(NOW);

    const archived = (prismaMock.archivedContent.create.mock.calls[0][0] as any).data;
    expect(archived.createdAt).toEqual(new Date("2026-07-01T00:00:00.000Z"));
  });

  /**
   * The archive row and the deletion are one fact. Written outside a
   * transaction, a crash between them loses a month's numbers or leaves a row
   * that the next sweep counts again.
   */
  it("writes the archive and the delete inside one transaction", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([purgeableJob()]);
    const seen: string[] = [];
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      seen.push("tx:start");
      await fn({
        archivedContent: { create: async () => { seen.push("archive"); return {}; } },
        job: { delete: async () => { seen.push("delete"); return {}; } },
      });
      seen.push("tx:commit");
    });

    await runJobRetention(NOW);

    expect(seen).toEqual(["tx:start", "archive", "delete", "tx:commit"]);
  });

  /**
   * The attachment and the applicants' résumés are reachable only through the
   * keys on the rows about to be deleted. Delete the row first and the files
   * stay in the bucket with nothing left that knows their names.
   */
  it("deletes the attachment and every résumé before touching the row", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([purgeableJob()]);
    const order: string[] = [];
    storageDelete.mockImplementation(async (key: string) => {
      order.push(`storage:${key}`);
      return undefined;
    });
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      order.push("db");
      return fn(prismaMock);
    });
    prismaMock.archivedContent.create.mockResolvedValue({});
    prismaMock.job.delete.mockResolvedValue({});

    await runJobRetention(NOW);

    expect(order).toEqual([
      "storage:job-attachment/u-1/jd.pdf",
      "storage:resume/u-2/cv.pdf",
      "storage:resume/u-3/cv.pdf",
      "db",
    ]);
  });

  it("keeps the row when a file could not be deleted, so the next sweep retries", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([purgeableJob()]);
    storageDelete.mockRejectedValueOnce(new Error("bucket unreachable") as never);
    runTx();

    const out = await runJobRetention(NOW);

    expect(out).toEqual({ scanned: 1, purged: 0, failed: 1 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.job.delete).not.toHaveBeenCalled();
  });

  /** One bad row costs that row, not the sweep. */
  it("carries on past a row whose transaction fails", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([
      purgeableJob({ id: "job-1" }),
      purgeableJob({ id: "job-2" }),
      purgeableJob({ id: "job-3" }),
    ]);
    prismaMock.archivedContent.create.mockResolvedValue({});
    prismaMock.job.delete.mockResolvedValue({});
    let call = 0;
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      call += 1;
      if (call === 2) throw new Error("deadlock detected");
      return fn(prismaMock);
    });

    const out = await runJobRetention(NOW);

    expect(out).toEqual({ scanned: 3, purged: 2, failed: 1 });
  });

  it("bounds one run, leaving the rest of a backlog for tomorrow", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([]);
    await runJobRetention(NOW);
    const args = prismaMock.job.findMany.mock.calls[0][0] as any;
    expect(args.take).toBe(500);
    // Oldest first, so a backlog drains in the order it accumulated.
    expect(args.orderBy).toEqual({ createdAt: "asc" });
  });

  it("asks only for postings past their retention window", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([]);
    await runJobRetention(NOW);
    const where = (prismaMock.job.findMany.mock.calls[0][0] as any).where;
    // The predicate itself is pinned in `lib/retention.test.ts`; what matters
    // here is that the sweep uses it rather than a where-clause of its own.
    expect(where.OR).toHaveLength(2);
    expect(where.OR[1]).toMatchObject({ expiresAt: null });
  });

  it("does nothing, quietly, when nothing has expired", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([]);
    const out = await runJobRetention(NOW);
    expect(out).toEqual({ scanned: 0, purged: 0, failed: 0 });
    expect(storageDelete).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("handles a posting with no attachment and no applicants", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([
      purgeableJob({ attachmentKey: null, applications: [] }),
    ]);
    prismaMock.archivedContent.create.mockResolvedValueOnce({});
    prismaMock.job.delete.mockResolvedValueOnce({});
    runTx();

    const out = await runJobRetention(NOW);

    expect(storageDelete).not.toHaveBeenCalled();
    expect(out.purged).toBe(1);
    const archived = (prismaMock.archivedContent.create.mock.calls[0][0] as any).data;
    expect(archived.applicationCount).toBe(0);
  });

  /** A résumé `resumeCleanup` already removed is not a reason to keep the job. */
  it("treats an already-deleted résumé key as success", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([
      purgeableJob({ applications: [{ resumeKey: null }, { resumeKey: "resume/u-3/cv.pdf" }] }),
    ]);
    prismaMock.archivedContent.create.mockResolvedValueOnce({});
    prismaMock.job.delete.mockResolvedValueOnce({});
    runTx();

    const out = await runJobRetention(NOW);

    expect(storageDelete).toHaveBeenCalledTimes(2); // attachment + the one real key
    expect(out.purged).toBe(1);
    const archived = (prismaMock.archivedContent.create.mock.calls[0][0] as any).data;
    // The count is of applications, not of surviving résumés.
    expect(archived.applicationCount).toBe(2);
  });
});

describe("runEventRetention", () => {
  it("archives the event's dimensions and its RSVP count, then deletes it", async () => {
    prismaMock.event.findMany.mockResolvedValueOnce([purgeableEvent()]);
    prismaMock.archivedContent.create.mockResolvedValueOnce({});
    prismaMock.event.delete.mockResolvedValueOnce({});
    runTx();

    const out = await runEventRetention(NOW);

    expect(out).toEqual({ scanned: 1, purged: 1, failed: 0 });
    const archived = (prismaMock.archivedContent.create.mock.calls[0][0] as any).data;
    expect(archived).toMatchObject({
      kind: "EVENT",
      sourceId: "evt-1",
      title: "Alumni Meet 2025",
      status: "APPROVED",
      chapterId: "chap-1",
      authorName: "Bob Kulkarni",
      // Frozen before the cascade took the RSVP rows.
      rsvpCount: 42,
    });
    expect(archived.startsAt).toEqual(new Date("2026-01-05T00:00:00.000Z"));
    expect(prismaMock.event.delete).toHaveBeenCalledWith({ where: { id: "evt-1" } });
  });

  it("deletes the cover and the attachment before the row", async () => {
    prismaMock.event.findMany.mockResolvedValueOnce([
      purgeableEvent({ attachmentKey: "event-attachment/u-1/agenda.pdf" }),
    ]);
    const order: string[] = [];
    storageDelete.mockImplementation(async (key: string) => {
      order.push(key);
      return undefined;
    });
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      order.push("db");
      return fn(prismaMock);
    });
    prismaMock.archivedContent.create.mockResolvedValue({});
    prismaMock.event.delete.mockResolvedValue({});

    await runEventRetention(NOW);

    expect(order).toEqual(["event/u-1/cover.jpg", "event-attachment/u-1/agenda.pdf", "db"]);
  });

  it("keeps the event when its cover could not be deleted", async () => {
    prismaMock.event.findMany.mockResolvedValueOnce([purgeableEvent()]);
    storageDelete.mockRejectedValueOnce(new Error("bucket unreachable") as never);
    runTx();

    const out = await runEventRetention(NOW);

    expect(out).toEqual({ scanned: 1, purged: 0, failed: 1 });
    expect(prismaMock.event.delete).not.toHaveBeenCalled();
  });

  it("sweeps on the event's own dates, oldest first", async () => {
    prismaMock.event.findMany.mockResolvedValueOnce([]);
    await runEventRetention(NOW);
    const args = prismaMock.event.findMany.mock.calls[0][0] as any;
    expect(args.orderBy).toEqual({ startsAt: "asc" });
    expect(args.take).toBe(500);
    expect(args.where.OR).toHaveLength(2);
  });
});

describe("runContentRetention", () => {
  it("runs both halves and reports each", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([purgeableJob()]);
    prismaMock.event.findMany.mockResolvedValueOnce([purgeableEvent()]);
    prismaMock.archivedContent.create.mockResolvedValue({});
    prismaMock.job.delete.mockResolvedValue({});
    prismaMock.event.delete.mockResolvedValue({});
    runTx();

    const out = await runContentRetention(NOW);

    expect(out.jobs.purged).toBe(1);
    expect(out.events.purged).toBe(1);
  });

  /**
   * The two share nothing but a schedule. A jobs outage must not also cost the
   * events sweep its daily tick — the worker gives them one lease between them.
   */
  it("still sweeps events when the jobs half throws", async () => {
    prismaMock.job.findMany.mockRejectedValueOnce(new Error("connection lost") as never);
    prismaMock.event.findMany.mockResolvedValueOnce([purgeableEvent()]);
    prismaMock.archivedContent.create.mockResolvedValue({});
    prismaMock.event.delete.mockResolvedValue({});
    runTx();

    const out = await runContentRetention(NOW);

    expect(out.jobs).toEqual({ scanned: 0, purged: 0, failed: 0 });
    expect(out.events.purged).toBe(1);
  });
});
