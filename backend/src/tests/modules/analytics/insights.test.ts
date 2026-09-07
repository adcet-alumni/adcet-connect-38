/**
 * `adminInsights` aggregates in Postgres via `$queryRaw`, so these tests run
 * against a real database. There is nothing useful to assert against a mock:
 * it would confirm we sent the SQL we wrote, not that Postgres buckets and
 * filters the way the dashboard needs.
 *
 * They cover the five things the SQL could plausibly get wrong, each of which
 * the previous JavaScript version got right by construction.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const reachable = db
  ? await db.$queryRaw`SELECT 1`.then(() => true).catch(() => false)
  : false;

// Skipped rather than failed where no database is reachable, so `npm test`
// stays runnable without one; CI runs a postgres service.
const describeDb = reachable ? describe : describe.skip;

const TAG = "insights-test";
const CSE = "Computer Science and Engineering";
const MECH = "Mechanical Engineering";
const at = (iso: string) => new Date(iso);

describeDb("adminInsights", () => {
  let insights: typeof import("../../../modules/analytics/analytics.service.js").adminInsights;

  // Children first: Event.createdById and Job.createdById are plain references,
  // not cascades, so the users cannot go until their rows do.
  const cleanup = async () => {
    await db!.$executeRaw`DELETE FROM "Event" WHERE title LIKE ${`${TAG}%`}`;
    await db!.$executeRaw`DELETE FROM "Job" WHERE title LIKE ${`${TAG}%`}`;
    await db!.$executeRaw`
      DELETE FROM "Donation"
      WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE ${`${TAG}%`})`;
    await db!.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
  };

  beforeAll(async () => {
    ({ adminInsights: insights } = await import("../../../modules/analytics/analytics.service.js"));
    await cleanup();

    const user = async (n: string, opts: {
      status?: "PENDING" | "APPROVED";
      admin?: boolean;
      department?: string;
      createdAt: Date;
    }) =>
      db!.user.create({
        data: {
          email: `${TAG}-${n}@example.test`,
          passwordHash: "x",
          firstName: TAG,
          lastName: n,
          status: opts.status ?? "APPROVED",
          createdAt: opts.createdAt,
          ...(opts.admin && { roles: { create: { role: "ADMIN" } } }),
          ...(opts.department && { profile: { create: { department: opts.department } } }),
        },
      });

    // An admin, who must not appear in any count.
    await user("admin", { admin: true, createdAt: at("2026-01-15T12:00:00Z") });
    // 23:00 UTC on the last day of January — the case a timezone-shifted
    // date_trunc would push into February.
    await user("edge", { department: CSE, createdAt: at("2026-01-31T23:00:00Z") });
    await user("pending", { status: "PENDING", department: CSE, createdAt: at("2026-02-10T09:00:00Z") });
    await user("mech", { department: MECH, createdAt: at("2026-02-11T09:00:00Z") });

    const owner = await user("owner", { department: CSE, createdAt: at("2026-03-01T09:00:00Z") });

    await db!.event.createMany({
      data: [
        // Aimed at CSE, and one open to everyone — the empty array must be
        // excluded from a department-specific view, not counted into all of them.
        { title: `${TAG}-cse`, description: "d", startsAt: at("2026-04-01T09:00:00Z"), departments: [CSE], status: "APPROVED", createdById: owner.id, createdAt: at("2026-03-05T09:00:00Z") },
        { title: `${TAG}-all`, description: "d", startsAt: at("2026-04-02T09:00:00Z"), departments: [], status: "PENDING", createdById: owner.id, createdAt: at("2026-03-06T09:00:00Z") },
      ],
    });

    await db!.job.createMany({
      data: [
        { title: `${TAG}-open`, company: "C", description: "d", departments: [CSE], status: "APPROVED", isClosed: false, createdById: owner.id, createdAt: at("2026-03-07T09:00:00Z") },
        { title: `${TAG}-shut`, company: "C", description: "d", departments: [CSE], status: "APPROVED", isClosed: true, createdById: owner.id, createdAt: at("2026-03-08T09:00:00Z") },
      ],
    });

    await db!.donation.createMany({
      data: [
        // Pledged in March, settled in April: counts toward April's revenue but
        // belongs to a March-bounded date filter.
        { userId: owner.id, amount: 500, status: "RECEIVED", createdAt: at("2026-03-20T09:00:00Z"), paidAt: at("2026-04-02T09:00:00Z") },
        // Never settled — must not reach the revenue KPI.
        { userId: owner.id, amount: 900, status: "PLEDGED", createdAt: at("2026-03-21T09:00:00Z") },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await db!.$disconnect();
  });

  /** Only the rows this test seeded — the database may hold dev seed data too. */
  const ours = (rows: { month: string; count: number }[], months: string[]) =>
    rows.filter((r) => months.includes(r.month));

  it("excludes admins from registration counts", async () => {
    const januarys = ours(
      (await insights({ from: at("2026-01-01T00:00:00Z"), to: at("2026-01-31T23:59:59Z") }))
        .trends.registrations,
      ["2026-01"],
    );
    // Two users were created in January; one of them is an admin.
    expect(januarys).toEqual([{ month: "2026-01", count: 1 }]);
  });

  it("buckets months in UTC, so 23:00 on the 31st stays in that month", async () => {
    const rows = (await insights({
      from: at("2026-01-25T00:00:00Z"),
      to: at("2026-02-05T00:00:00Z"),
    })).trends.registrations;
    expect(ours(rows, ["2026-02"])).toEqual([]);
    expect(ours(rows, ["2026-01"])).toEqual([{ month: "2026-01", count: 1 }]);
  });

  it("counts approved separately from total registrations", async () => {
    const { kpis } = await insights({
      from: at("2026-02-01T00:00:00Z"),
      to: at("2026-02-28T00:00:00Z"),
    });
    expect(kpis.newRegistrations).toBe(2);   // one PENDING, one APPROVED
    expect(kpis.newUsersApproved).toBe(1);
  });

  it("narrows events and jobs by the departments array, excluding open-to-all", async () => {
    const range = { from: at("2026-03-01T00:00:00Z"), to: at("2026-03-31T23:59:59Z") };
    const all = await insights(range);
    const cse = await insights({ ...range, department: CSE });
    const mech = await insights({ ...range, department: MECH });

    expect(all.kpis.events).toBe(2);   // the CSE one and the open-to-all one
    expect(cse.kpis.events).toBe(1);   // "aimed at CSE", not "visible to CSE"
    expect(mech.kpis.events).toBe(0);
    expect(cse.kpis.jobs).toBe(2);
  });

  it("counts only open jobs in openJobs", async () => {
    const { kpis } = await insights({
      from: at("2026-03-07T00:00:00Z"),
      to: at("2026-03-08T23:59:59Z"),
    });
    expect(kpis.jobs).toBe(2);
    expect(kpis.openJobs).toBe(1);
  });

  it("buckets a donation by when it settled, but filters by when it was created", async () => {
    const march = await insights({
      from: at("2026-03-15T00:00:00Z"),
      to: at("2026-03-31T23:59:59Z"),
    });
    // Created in March, so it passes the filter; paid in April, so that is the
    // month it lands in.
    expect(march.trends.donations).toEqual([{ month: "2026-04", count: 1, amount: 500 }]);
    // Only the settled gift reaches the revenue KPIs; the pledge does not.
    expect(march.kpis.donationsReceived).toBe(1);
    expect(march.kpis.donationAmount).toBe(500);
    // But the pledge still shows in the status distribution.
    expect(march.distributions.donationStatus).toEqual(
      expect.arrayContaining([
        { label: "RECEIVED", value: 1 },
        { label: "PLEDGED", value: 1 },
      ]),
    );
  });
});
