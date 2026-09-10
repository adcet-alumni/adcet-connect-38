/**
 * Retention against a real Postgres.
 *
 * The guarantees these cover are the database's, not the code's, and a mock can
 * only assert that we sent the statements we wrote:
 *
 *  - the archive row and the deletion commit together, or neither does
 *  - `JobApplication` and `EventRsvp` really cascade, so no orphan children
 *    survive a purged parent
 *  - `(kind, sourceId)` really refuses a second archive of one posting, which
 *    is what stops a retried sweep counting a month twice
 *  - a job still on the board is never picked up by the sweep
 *
 * Skipped rather than failed where no database is reachable, matching
 * `jobLease.test.ts`; CI runs a Postgres service for exactly these.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const reachable = prisma
  ? await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false)
  : false;

const describeDb = reachable ? describe : describe.skip;

// The sweep's own module reads `lib/prisma.js`; point that at this client so
// the job and the assertions see one database.
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma: prisma as PrismaClient }));

const deleted: string[] = [];
let failNextDelete = false;
jest.unstable_mockModule("../../storage/index.js", () => ({
  getStorage: () => ({
    delete: async (key: string) => {
      if (failNextDelete) {
        failNextDelete = false;
        throw new Error("bucket unreachable");
      }
      deleted.push(key);
    },
  }),
}));

const { runJobRetention, runEventRetention } = await import("../../jobs/contentRetention.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const monthsAgo = (n: number) => {
  const d = new Date(NOW.getTime());
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};

/** Everything this suite creates is tagged so teardown can find it. */
const TAG = `retention-test-${randomUUID().slice(0, 8)}`;
const owned: { users: string[]; jobs: string[]; events: string[] } = {
  users: [],
  jobs: [],
  events: [],
};

const makeUser = async () => {
  const user = await prisma!.user.create({
    data: {
      email: `${randomUUID()}@${TAG}.test`,
      firstName: "Test",
      lastName: "Poster",
      passwordHash: "x",
      status: "APPROVED",
    },
  });
  owned.users.push(user.id);
  return user;
};

const makeJob = async (
  createdById: string,
  over: Partial<Parameters<typeof prisma.job.create>[0]["data"]> = {},
) => {
  const job = await prisma!.job.create({
    data: {
      title: `${TAG} job`,
      company: "Acme",
      description: "d",
      status: "APPROVED",
      departments: ["Computer Science and Engineering"],
      createdById,
      createdAt: daysAgo(60),
      ...over,
    } as never,
  });
  owned.jobs.push(job.id);
  return job;
};

const makeEvent = async (
  createdById: string,
  over: Partial<Parameters<typeof prisma.event.create>[0]["data"]> = {},
) => {
  const event = await prisma!.event.create({
    data: {
      title: `${TAG} event`,
      description: "d",
      status: "APPROVED",
      startsAt: monthsAgo(8),
      createdById,
      ...over,
    } as never,
  });
  owned.events.push(event.id);
  return event;
};

const cleanup = async () => {
  if (!prisma) return;
  await prisma.archivedContent.deleteMany({
    where: { sourceId: { in: [...owned.jobs, ...owned.events] } },
  });
  await prisma.job.deleteMany({ where: { id: { in: owned.jobs } } });
  await prisma.event.deleteMany({ where: { id: { in: owned.events } } });
  await prisma.user.deleteMany({ where: { id: { in: owned.users } } });
  owned.jobs.length = 0;
  owned.events.length = 0;
  owned.users.length = 0;
};

beforeAll(() => {
  deleted.length = 0;
});
afterEach(async () => {
  await cleanup();
  deleted.length = 0;
  failNextDelete = false;
});
afterAll(async () => {
  await cleanup();
  await prisma?.$disconnect();
});

describeDb("job retention against Postgres", () => {
  it("deletes an expired posting and leaves its numbers behind", async () => {
    const poster = await makeUser();
    const job = await makeJob(poster.id, { createdAt: daysAgo(60), vacancies: 3 });

    const out = await runJobRetention(NOW);
    expect(out.purged).toBeGreaterThanOrEqual(1);

    expect(await prisma!.job.findUnique({ where: { id: job.id } })).toBeNull();

    const archived = await prisma!.archivedContent.findUnique({
      where: { kind_sourceId: { kind: "JOB", sourceId: job.id } },
    });
    expect(archived).toMatchObject({
      title: `${TAG} job`,
      company: "Acme",
      status: "APPROVED",
      vacancies: 3,
      departments: ["Computer Science and Engineering"],
      authorName: "Test Poster",
    });
    // The posting's own month, which is what every dashboard bucket reads.
    expect(archived!.createdAt.toISOString().slice(0, 10)).toBe(
      daysAgo(60).toISOString().slice(0, 10),
    );
  });

  /**
   * `JobApplication.jobId` is `onDelete: Cascade`. If that ever changed, the
   * delete would fail on a foreign key rather than silently orphaning rows —
   * but the count has to be frozen *before* the cascade, and that is the half
   * this proves.
   */
  it("cascades the applications away and keeps their count", async () => {
    const poster = await makeUser();
    const applicantA = await makeUser();
    const applicantB = await makeUser();
    const job = await makeJob(poster.id, { createdAt: daysAgo(60) });
    await prisma!.jobApplication.createMany({
      data: [
        { jobId: job.id, userId: applicantA.id, resumeKey: "resume/a/cv.pdf" },
        { jobId: job.id, userId: applicantB.id, resumeKey: "resume/b/cv.pdf" },
      ],
    });

    await runJobRetention(NOW);

    expect(await prisma!.jobApplication.count({ where: { jobId: job.id } })).toBe(0);
    const archived = await prisma!.archivedContent.findUnique({
      where: { kind_sourceId: { kind: "JOB", sourceId: job.id } },
    });
    expect(archived!.applicationCount).toBe(2);
    // And the résumés went to storage's delete, not into an orphaned bucket.
    expect(deleted).toEqual(expect.arrayContaining(["resume/a/cv.pdf", "resume/b/cv.pdf"]));
  });

  /**
   * The idempotency guarantee. A sweep that committed its archive but crashed
   * before the process exited would, on a naive retry, add a second archive row
   * and inflate the month by one.
   */
  it("refuses a second archive of the same posting", async () => {
    const poster = await makeUser();
    const job = await makeJob(poster.id, { createdAt: daysAgo(60) });
    await runJobRetention(NOW);

    await expect(
      prisma!.archivedContent.create({
        data: {
          kind: "JOB",
          sourceId: job.id,
          title: "duplicate",
          status: "APPROVED",
          createdAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(
      await prisma!.archivedContent.count({ where: { kind: "JOB", sourceId: job.id } }),
    ).toBe(1);
  });

  /**
   * Atomicity, proven by breaking it: a transaction whose delete fails must
   * leave no archive row behind. Postgres enforces this, not the code — a
   * non-transactional version of the same sweep would leave the orphan.
   */
  it("rolls the archive back when the delete inside the transaction fails", async () => {
    const poster = await makeUser();
    const job = await makeJob(poster.id, { createdAt: daysAgo(60) });

    await expect(
      prisma!.$transaction(async (tx) => {
        await tx.archivedContent.create({
          data: {
            kind: "JOB",
            sourceId: job.id,
            title: "should not survive",
            status: "APPROVED",
            createdAt: job.createdAt,
          },
        });
        // Whatever goes wrong at this point — a deadlock, a lost connection —
        // the archive above must not outlive it.
        throw new Error("delete failed");
      }),
    ).rejects.toThrow("delete failed");

    expect(
      await prisma!.archivedContent.count({ where: { kind: "JOB", sourceId: job.id } }),
    ).toBe(0);
    // ...and the posting is still there for the next sweep.
    expect(await prisma!.job.findUnique({ where: { id: job.id } })).not.toBeNull();
  });

  it("leaves a posting still inside its window entirely alone", async () => {
    const poster = await makeUser();
    const fresh = await makeJob(poster.id, { createdAt: daysAgo(10) });
    const inGrace = await makeJob(poster.id, { createdAt: daysAgo(35) });

    await runJobRetention(NOW);

    expect(await prisma!.job.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await prisma!.job.findUnique({ where: { id: inGrace.id } })).not.toBeNull();
    expect(
      await prisma!.archivedContent.count({
        where: { sourceId: { in: [fresh.id, inGrace.id] } },
      }),
    ).toBe(0);
  });

  it("honours an extension, and sweeps once the extension has run out", async () => {
    const poster = await makeUser();
    const extended = await makeJob(poster.id, {
      createdAt: daysAgo(300),
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
    const lapsed = await makeJob(poster.id, {
      createdAt: daysAgo(300),
      expiresAt: daysAgo(20),
    });

    await runJobRetention(NOW);

    expect(await prisma!.job.findUnique({ where: { id: extended.id } })).not.toBeNull();
    expect(await prisma!.job.findUnique({ where: { id: lapsed.id } })).toBeNull();
  });

  it("keeps a posting whose file could not be deleted, and purges it on the next run", async () => {
    const poster = await makeUser();
    const job = await makeJob(poster.id, {
      createdAt: daysAgo(60),
      attachmentKey: "job-attachment/u/jd.pdf",
    });

    failNextDelete = true;
    const first = await runJobRetention(NOW);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect(await prisma!.job.findUnique({ where: { id: job.id } })).not.toBeNull();
    expect(
      await prisma!.archivedContent.count({ where: { kind: "JOB", sourceId: job.id } }),
    ).toBe(0);

    const second = await runJobRetention(NOW);
    expect(second.purged).toBeGreaterThanOrEqual(1);
    expect(await prisma!.job.findUnique({ where: { id: job.id } })).toBeNull();
  });
});

describeDb("event retention against Postgres", () => {
  it("deletes a long-past event, keeping its RSVP count", async () => {
    const organiser = await makeUser();
    const attendee = await makeUser();
    const event = await makeEvent(organiser.id, { startsAt: monthsAgo(8) });
    await prisma!.eventRsvp.create({ data: { eventId: event.id, userId: attendee.id } });

    await runEventRetention(NOW);

    expect(await prisma!.event.findUnique({ where: { id: event.id } })).toBeNull();
    expect(await prisma!.eventRsvp.count({ where: { eventId: event.id } })).toBe(0);
    const archived = await prisma!.archivedContent.findUnique({
      where: { kind_sourceId: { kind: "EVENT", sourceId: event.id } },
    });
    expect(archived).toMatchObject({ kind: "EVENT", rsvpCount: 1, status: "APPROVED" });
  });

  it("leaves an event that finished inside the retention window", async () => {
    const organiser = await makeUser();
    const recent = await makeEvent(organiser.id, { startsAt: monthsAgo(3) });

    await runEventRetention(NOW);

    expect(await prisma!.event.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  /** A long event is past when it ends, not when it opens. */
  it("measures from endsAt where the event declared one", async () => {
    const organiser = await makeUser();
    const longEvent = await makeEvent(organiser.id, {
      startsAt: monthsAgo(8),
      endsAt: monthsAgo(2),
    });

    await runEventRetention(NOW);

    expect(await prisma!.event.findUnique({ where: { id: longEvent.id } })).not.toBeNull();
  });

  it("never sweeps an upcoming event, however long ago it was created", async () => {
    const organiser = await makeUser();
    const upcoming = await makeEvent(organiser.id, {
      createdAt: monthsAgo(24),
      startsAt: new Date(NOW.getTime() + 30 * DAY),
    });

    await runEventRetention(NOW);

    expect(await prisma!.event.findUnique({ where: { id: upcoming.id } })).not.toBeNull();
  });
});
