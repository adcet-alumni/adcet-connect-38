/**
 * The lease is what makes running two workers safe rather than merely
 * unlikely, so these tests are about exclusion, not about the happy path.
 *
 * They run against a real Postgres when DATABASE_URL points at one, because
 * the guarantee lives in a single `INSERT … ON CONFLICT DO UPDATE … WHERE`
 * statement — a mock would only assert that we sent the SQL we wrote, not that
 * Postgres treats it as a test-and-set.
 */
import { afterAll, beforeEach, describe, expect, it } from "@jest/globals";
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

// Skipped rather than failed where no database is reachable, so `npm test`
// stays runnable without one; CI and local dev both have Postgres up.
const reachable = prisma
  ? await prisma
      .$queryRaw`SELECT 1`.then(() => true)
      .catch(() => false)
  : false;

const describeDb = reachable ? describe : describe.skip;

describeDb("withJobLease", () => {
  const NAME = "event-reminders";
  let withJobLease: typeof import("../../lib/jobLease.js").withJobLease;

  beforeEach(async () => {
    ({ withJobLease } = await import("../../lib/jobLease.js"));
    await prisma!.$executeRaw`DELETE FROM "JobLease" WHERE "name" = ${NAME}`;
  });

  afterAll(async () => {
    await prisma!.$executeRaw`DELETE FROM "JobLease" WHERE "name" = ${NAME}`;
    await prisma!.$disconnect();
  });

  it("runs the job and releases the lease afterwards", async () => {
    let ran = 0;
    const out = await withJobLease(NAME, 60_000, async () => { ran += 1; });

    expect(out.ran).toBe(true);
    expect(ran).toBe(1);

    const [row] = await prisma!.$queryRaw<{ lockedUntil: Date | null; lastRunAt: Date | null }[]>`
      SELECT "lockedUntil", "lastRunAt" FROM "JobLease" WHERE "name" = ${NAME}`;
    expect(row.lockedUntil).toBeNull();
    expect(row.lastRunAt).not.toBeNull();
  });

  it("lets exactly one of two concurrent callers run", async () => {
    let ran = 0;
    // Both claim before either releases, which is the overlap a rolling deploy
    // produces. Without the WHERE on the DO UPDATE, both would win.
    const hold = () => withJobLease(NAME, 60_000, async () => {
      ran += 1;
      await new Promise((r) => setTimeout(r, 50));
    });

    const [a, b] = await Promise.all([hold(), hold()]);

    expect(ran).toBe(1);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
  });

  it("releases the lease even when the job throws", async () => {
    await expect(
      withJobLease(NAME, 60_000, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");

    // A failed run must not block the next tick until the lease expires.
    const out = await withJobLease(NAME, 60_000, async () => undefined);
    expect(out.ran).toBe(true);
  });

  it("lets the next tick take over once an abandoned lease has expired", async () => {
    // A worker SIGKILLed mid-run cannot release anything; the expiry is what
    // stops the job wedging forever. Simulated by claiming with a lease that
    // has already lapsed.
    await prisma!.$executeRaw`
      INSERT INTO "JobLease" ("name", "lockedUntil", "lockedBy", "updatedAt")
      VALUES (${NAME}, now() - interval '1 minute', 'dead-worker#1', now())`;

    const out = await withJobLease(NAME, 60_000, async () => undefined);
    expect(out.ran).toBe(true);
  });

  it("does not take over a lease that is still live", async () => {
    await prisma!.$executeRaw`
      INSERT INTO "JobLease" ("name", "lockedUntil", "lockedBy", "updatedAt")
      VALUES (${NAME}, now() + interval '1 hour', 'busy-worker#1', now())`;

    let ran = 0;
    const out = await withJobLease(NAME, 60_000, async () => { ran += 1; });
    expect(out.ran).toBe(false);
    expect(ran).toBe(0);
  });
});
