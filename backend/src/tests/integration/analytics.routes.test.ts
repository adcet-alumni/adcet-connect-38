/**
 * Integration tests for /api/v1/analytics. The user-facing dashboard
 * endpoints require an APPROVED user; the admin overview also enforces ADMIN.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { createPrismaDeepMock, makeToken, bearer } from "../helpers/integrationApp.js";

const prisma = createPrismaDeepMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma }));

const { buildApp } = await import("../../app.js");
const app = buildApp();

const userToken = makeToken({ sub: "user-1" });
const adminToken = makeToken({ sub: "admin-1", roles: ["ADMIN"] });

beforeEach(() => {
  prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "APPROVED" } as any);
});

describe("/analytics", () => {
  it("401 anonymous", async () => {
    const res = await request(app).get("/api/v1/analytics/overview");
    expect(res.status).toBe(401);
  });

  it("200 overview aggregates counts", async () => {
    prisma.user.count.mockResolvedValueOnce(50);
    prisma.userRole.count.mockResolvedValueOnce(40);
    prisma.event.count.mockResolvedValueOnce(5);
    prisma.job.count.mockResolvedValueOnce(8);
    prisma.achievement.count.mockResolvedValueOnce(3);
    prisma.donation.aggregate.mockResolvedValueOnce({
      _sum: { amount: 12000 },
      _count: 7,
    } as any);
    const res = await request(app)
      .get("/api/v1/analytics/overview")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(200);
    expect(res.body.totalUsers).toBe(50);
    expect(res.body.totalDonationsAmount).toBe(12000);
  });

  it("200 alumniByYear sorts ascending", async () => {
    prisma.profile.groupBy.mockResolvedValueOnce([
      { graduationYear: 2022, _count: { _all: 3 } } as any,
      { graduationYear: 2020, _count: { _all: 5 } } as any,
    ]);
    const res = await request(app)
      .get("/api/v1/analytics/alumni-by-year")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(200);
    expect(res.body[0].year).toBe(2020);
  });

  it("403 non-admin cannot hit /admin/overview", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/admin/overview")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(403);
  });

  it("200 admin overview returns pending counters", async () => {
    prisma.user.count.mockResolvedValueOnce(2);
    prisma.event.count.mockResolvedValueOnce(1);
    prisma.job.count.mockResolvedValueOnce(0);
    prisma.achievement.count.mockResolvedValueOnce(4);
    prisma.collaborationRequest.groupBy.mockResolvedValueOnce([
      { type: "PLACEMENT", _count: { _all: 3 } },
    ] as any);
    const res = await request(app)
      .get("/api/v1/analytics/admin/overview")
      .set("Authorization", bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.pendingAchievements).toBe(4);
    expect(res.body.pendingPlacements).toBe(3);
    expect(res.body.pendingWorkshops).toBe(0);
  });
});

/**
 * The admin insights dashboard, filtered by department.
 *
 * `Event` and `Job` carry `departments: String[]`, not the single nullable
 * `department` column that migration `20260803150000_multi_department_targeting`
 * removed. `adminInsights` kept filtering on the old name, so picking any
 * department in the dashboard's dropdown blanked the whole payload — KPIs,
 * trends and distributions, not just the two series involved.
 *
 * The department semantics themselves are now asserted in
 * `tests/modules/analytics/insights.test.ts`, against a real database: those
 * filters moved into `$queryRaw` when the trends were pushed down to SQL, and
 * a mock cannot tell a working `= ANY(departments)` from a broken one — it
 * would confirm we sent the SQL we wrote. Postgres rejecting an unknown column
 * is what catches the original bug now, and only a real connection sees that.
 *
 * What stays here is the route's own contract: the filter is accepted, admin
 * only, and answers 200.
 */
describe("/analytics/admin/insights", () => {
  const DEPT = "Computer Science and Engineering";

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: "admin-1", status: "APPROVED" } as any);
    prisma.$queryRaw.mockResolvedValue([] as any);
    prisma.profile.count.mockResolvedValue(0 as any);
    prisma.eventRsvp.count.mockResolvedValue(0 as any);
    prisma.profile.groupBy.mockResolvedValue([] as any);
  });

  /**
   * Every value bound into the raw queries. The interpolated arguments are
   * `Prisma.Sql` fragments — composed clauses, each carrying its own bound
   * values — so a department arrives nested one level down, which is itself
   * the point: it is a parameter, never spliced into the SQL text.
   */
  const boundValues = () =>
    prisma.$queryRaw.mock.calls
      .flat()
      .flatMap((arg: any) => (arg && Array.isArray(arg.values) ? arg.values : []));

  const insights = (query = "", token = adminToken) =>
    request(app)
      .get(`/api/v1/analytics/admin/insights${query}`)
      .set("Authorization", bearer(token));

  it("403s a non-admin", async () => {
    const res = await insights("", userToken);
    expect(res.status).toBe(403);
  });

  it("200s with a department filter, and passes it to the aggregation", async () => {
    const res = await insights(`?department=${encodeURIComponent(DEPT)}`);
    expect(res.status).toBe(200);
    expect(boundValues()).toContain(DEPT);
  });

  it("200s with no filter, and binds no department", async () => {
    const res = await insights();
    expect(res.status).toBe(200);
    expect(boundValues()).not.toContain(DEPT);
  });

  it("returns the full payload shape even when everything is empty", async () => {
    const res = await insights();
    expect(Object.keys(res.body)).toEqual(["kpis", "trends", "distributions"]);
    expect(res.body.trends.registrations).toEqual([]);
    expect(res.body.kpis.newRegistrations).toBe(0);
  });
});
