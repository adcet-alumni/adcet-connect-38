/**
 * Branch coverage for analytics aggregations.
 * Hits null/empty grouping rows, the year-sort comparator's nullable branch,
 * and admin-vs-public overview shapes.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../../lib/prisma.js", () => ({ prisma: prismaMock }));

const sendBulkEmailsMock = jest.fn(async () => ({ sent: 2, failed: 0 }));
jest.unstable_mockModule("../../../lib/mailer.js", () => ({ sendBulkEmails: sendBulkEmailsMock }));
jest.unstable_mockModule("../../../lib/email-templates.js", () => ({
  wrapHtmlEmail: (_t: string, b: string) => b,
}));
jest.unstable_mockModule("../../../storage/index.js", () => ({
  getStorage: () => ({ presignDownload: jest.fn(async () => "http://storage/url") }),
}));

const svc = await import("../../../modules/analytics/analytics.service.js");

beforeEach(() => {
  Object.values(prismaMock).forEach((m: any) =>
    m && typeof m === "object" ? Object.values(m).forEach((fn: any) => fn?.mockReset?.()) : null,
  );
});

describe("analytics.service — overview", () => {
  it("uses 0 when donation aggregate _sum.amount is null", async () => {
    prismaMock.user.count.mockResolvedValueOnce(10);
    prismaMock.userRole.count.mockResolvedValueOnce(8);
    prismaMock.event.count.mockResolvedValueOnce(2);
    prismaMock.job.count.mockResolvedValueOnce(3);
    prismaMock.achievement.count.mockResolvedValueOnce(4);
    prismaMock.donation.aggregate.mockResolvedValueOnce({ _sum: { amount: null }, _count: 0 });
    const out = await svc.overview();
    expect(out.totalDonationsAmount).toBe(0);
    expect(out.totalUsers).toBe(10);
  });

  it("forwards aggregate amount when present", async () => {
    prismaMock.user.count.mockResolvedValueOnce(0);
    prismaMock.userRole.count.mockResolvedValueOnce(0);
    prismaMock.event.count.mockResolvedValueOnce(0);
    prismaMock.job.count.mockResolvedValueOnce(0);
    prismaMock.achievement.count.mockResolvedValueOnce(0);
    prismaMock.donation.aggregate.mockResolvedValueOnce({ _sum: { amount: 5000 }, _count: 5 });
    const out = await svc.overview();
    expect(out.totalDonationsAmount).toBe(5000);
  });
});

describe("analytics.service — alumniByYear", () => {
  it("filters out null years and sorts ascending (handles undefined years)", async () => {
    prismaMock.profile.groupBy.mockResolvedValueOnce([
      { graduationYear: 2021, _count: { _all: 3 } },
      { graduationYear: null, _count: { _all: 99 } },
      { graduationYear: 2018, _count: { _all: 5 } },
    ]);
    const out = await svc.alumniByYear();
    expect(out.map((r) => r.year)).toEqual([2018, 2021]);
  });

  it("empty group returns empty array", async () => {
    prismaMock.profile.groupBy.mockResolvedValueOnce([]);
    expect(await svc.alumniByYear()).toEqual([]);
  });
});

describe("analytics.service — departmentBreakdown", () => {
  it("maps grouped rows to {department, count}", async () => {
    prismaMock.profile.groupBy.mockResolvedValueOnce([
      { department: "CS", _count: { _all: 4 } },
      { department: "EE", _count: { _all: 2 } },
    ]);
    const out = await svc.departmentBreakdown();
    expect(out).toEqual([
      { department: "CS", count: 4 },
      { department: "EE", count: 2 },
    ]);
  });
});

describe("analytics.service — adminOverview", () => {
  it("returns the pending counters in parallel", async () => {
    prismaMock.user.count.mockResolvedValueOnce(1);
    prismaMock.event.count.mockResolvedValueOnce(2);
    prismaMock.job.count.mockResolvedValueOnce(3);
    prismaMock.achievement.count.mockResolvedValueOnce(4);
    prismaMock.collaborationRequest.groupBy.mockResolvedValueOnce([
      { type: "PLACEMENT", _count: { _all: 5 } },
      { type: "WORKSHOP", _count: { _all: 6 } },
    ]);
    expect(await svc.adminOverview()).toEqual({
      pendingUsers: 1,
      pendingEvents: 2,
      pendingJobs: 3,
      pendingAchievements: 4,
      // Keyed by collaboration type, so a kind added to COLLABORATION_TYPES
      // gets a sidebar badge without a new field on this payload.
      pendingCollaboration: { PLACEMENT: 5, WORKSHOP: 6, OTHER: 0 },
      pendingPlacements: 5,
      pendingWorkshops: 6,
    });
  });

  it("counts every collaboration kind, including the catch-all", async () => {
    prismaMock.user.count.mockResolvedValueOnce(0);
    prismaMock.event.count.mockResolvedValueOnce(0);
    prismaMock.job.count.mockResolvedValueOnce(0);
    prismaMock.achievement.count.mockResolvedValueOnce(0);
    prismaMock.collaborationRequest.groupBy.mockResolvedValueOnce([
      { type: "OTHER", _count: { _all: 3 } },
    ]);

    const out = await svc.adminOverview();
    expect(out.pendingCollaboration).toEqual({ PLACEMENT: 0, WORKSHOP: 0, OTHER: 3 });
  });

  it("reports zero for a collaboration type with nothing pending", async () => {
    prismaMock.user.count.mockResolvedValueOnce(0);
    prismaMock.event.count.mockResolvedValueOnce(0);
    prismaMock.job.count.mockResolvedValueOnce(0);
    prismaMock.achievement.count.mockResolvedValueOnce(0);
    // groupBy returns no row at all for a type with no pending requests, which
    // must read as 0 rather than leaving the sidebar badge undefined.
    prismaMock.collaborationRequest.groupBy.mockResolvedValueOnce([
      { type: "PLACEMENT", _count: { _all: 2 } },
    ]);
    const out = await svc.adminOverview();
    expect(out.pendingPlacements).toBe(2);
    expect(out.pendingWorkshops).toBe(0);
  });
});
describe("analytics.service — adminInsights", () => {
  /*
   * The five trend queries aggregate in Postgres, so what is left to unit-test
   * here is the transformation: grouped `(month, status, count)` rows into the
   * KPIs, series and distributions the dashboard draws. Whether the SQL groups
   * and filters correctly — UTC month boundaries, admins excluded, a donation
   * bucketed by `paidAt` but filtered by `createdAt`, `= ANY(departments)` — is
   * only answerable against a real database, and lives in
   * `tests/modules/analytics/insights.test.ts`.
   */
  const stubTrendQueries = () => {
    prismaMock.$queryRaw
      // users
      .mockResolvedValueOnce([
        { month: "2024-01", status: "APPROVED", count: 3 },
        { month: "2024-01", status: "PENDING", count: 1 },
        { month: "2024-02", status: "APPROVED", count: 2 },
      ])
      // events
      .mockResolvedValueOnce([{ month: "2024-01", status: "APPROVED", count: 1 }])
      // jobs — one open, one closed, in the same month and status
      .mockResolvedValueOnce([
        { month: "2024-02", status: "APPROVED", isClosed: false, count: 4 },
        { month: "2024-02", status: "APPROVED", isClosed: true, count: 2 },
      ])
      // donations — a settled batch and an unsettled one
      .mockResolvedValueOnce([
        { month: "2024-02", status: "RECEIVED", count: 2, amount: 5000 },
        { month: "2024-02", status: "PLEDGED", count: 1, amount: 900 },
      ])
      // achievements
      .mockResolvedValueOnce([{ month: "2024-03", status: "APPROVED", count: 1 }]);
  };

  const stubAggregates = () => {
    prismaMock.profile.count.mockResolvedValueOnce(42);
    prismaMock.eventRsvp.count.mockResolvedValueOnce(3);
    prismaMock.profile.groupBy
      .mockResolvedValueOnce([{ department: "Computer Science and Engineering", _count: { _all: 10 } }])
      .mockResolvedValueOnce([{ graduationYear: 2020, _count: { _all: 5 } }])
      .mockResolvedValueOnce([{ currentCompany: "TCS", _count: { _all: 7 } }])
      .mockResolvedValueOnce([{ city: "Pune", _count: { _all: 8 } }]);
  };

  it("sums grouped rows into KPIs", async () => {
    stubTrendQueries();
    stubAggregates();

    const out = await svc.adminInsights({});

    expect(out.kpis.totalAlumni).toBe(42);
    // Every status counts as a registration; only APPROVED counts as approved.
    expect(out.kpis.newRegistrations).toBe(6);
    expect(out.kpis.newUsersApproved).toBe(5);
    // One COUNT(*) over the matching events' RSVPs, not a per-event subquery.
    expect(out.kpis.totalRsvps).toBe(3);
    expect(out.kpis.jobs).toBe(6);
    expect(out.kpis.openJobs).toBe(4);
    // Pledges reach neither the count nor the amount.
    expect(out.kpis.donationsReceived).toBe(2);
    expect(out.kpis.donationAmount).toBe(5000);
  });

  it("collapses statuses into one point per month, oldest first", async () => {
    stubTrendQueries();
    stubAggregates();

    const out = await svc.adminInsights({});

    expect(out.trends.registrations).toEqual([
      { month: "2024-01", count: 4 },
      { month: "2024-02", count: 2 },
    ]);
    expect(out.trends.jobs).toEqual([{ month: "2024-02", count: 6 }]);
    // The donation series carries revenue and counts only what settled.
    expect(out.trends.donations).toEqual([{ month: "2024-02", count: 2, amount: 5000 }]);
  });

  it("collapses months into the status distributions", async () => {
    stubTrendQueries();
    stubAggregates();

    const out = await svc.adminInsights({});

    expect(out.distributions.jobStatus).toEqual([{ label: "APPROVED", value: 6 }]);
    expect(out.distributions.donationStatus).toEqual(
      expect.arrayContaining([
        { label: "RECEIVED", value: 2 },
        { label: "PLEDGED", value: 1 },
      ]),
    );
    expect(out.distributions.topCities[0]).toEqual({ label: "Pune", value: 8 });
  });
});

describe("analytics.service — sendAlumniBulkEmail", () => {
  it("returns 0 recipients when nothing matches", async () => {
    prismaMock.profile.findMany.mockResolvedValueOnce([]);
    const out = await svc.sendAlumniBulkEmail("admin-1", { filters: {}, subject: "Hi", html: "<p>x</p>" });
    expect(out).toEqual({ recipientCount: 0, sent: 0, failed: 0 });
    expect(sendBulkEmailsMock).not.toHaveBeenCalled();
  });

  it("sends to matched alumni and records an audit log", async () => {
    prismaMock.profile.findMany.mockResolvedValueOnce([
      { user: { email: "a@x.com", firstName: "A", lastName: "One" } },
      { user: { email: "b@x.com", firstName: "B", lastName: "Two" } },
    ]);
    prismaMock.auditLog.create.mockResolvedValueOnce({});
    const out = await svc.sendAlumniBulkEmail("admin-1", {
      filters: { company: "TCS" },
      subject: "Hello {{firstName}}",
      html: "<p>Hi {{name}}</p>",
    });
    expect(out.recipientCount).toBe(2);
    expect(sendBulkEmailsMock).toHaveBeenCalled();
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });
});
