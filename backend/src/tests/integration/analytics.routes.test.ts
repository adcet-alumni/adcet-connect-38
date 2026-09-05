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
 * department in the dashboard's dropdown threw `PrismaClientValidationError`
 * and blanked the whole payload — KPIs, trends and distributions, not just the
 * two series involved.
 *
 * These tests read the `where` the service asked Prisma for, the way
 * `person-select.test.ts` reads the `select`. That is deliberate: the deep mock
 * accepts any arguments, so a test that only asserts a 200 would have passed
 * against the broken code. The argument shape is where the bug lived, so the
 * argument shape is what gets pinned.
 */
describe("/analytics/admin/insights department filter", () => {
  const DEPT = "Computer Science and Engineering";

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: "admin-1", status: "APPROVED" } as any);
    for (const model of ["user", "event", "job", "donation", "achievement"] as const) {
      prisma[model].findMany.mockResolvedValue([] as any);
    }
    prisma.profile.count.mockResolvedValue(0);
    prisma.profile.groupBy.mockResolvedValue([] as any);
  });

  const insights = (query = "") =>
    request(app)
      .get(`/api/v1/analytics/admin/insights${query}`)
      .set("Authorization", bearer(adminToken));

  it("narrows events and jobs through the departments array", async () => {
    const res = await insights(`?department=${encodeURIComponent(DEPT)}`);
    expect(res.status).toBe(200);

    for (const model of [prisma.event, prisma.job]) {
      const where = (model.findMany.mock.calls[0][0] as any).where;
      expect(where.departments).toEqual({ has: DEPT });
      // The column this used to name does not exist on either model.
      expect(where).not.toHaveProperty("department");
    }
  });

  it("narrows alumni through the profile's own department column", async () => {
    await insights(`?department=${encodeURIComponent(DEPT)}`);
    const where = (prisma.user.findMany.mock.calls[0][0] as any).where;
    // `User` reaches a department through its profile — a scalar, not a list.
    expect(where.profile).toEqual({ department: DEPT });
  });

  it("applies no department clause at all when none is asked for", async () => {
    const res = await insights();
    expect(res.status).toBe(200);
    for (const model of [prisma.event, prisma.job]) {
      const where = (model.findMany.mock.calls[0][0] as any).where;
      expect(where).not.toHaveProperty("departments");
      expect(where).not.toHaveProperty("department");
    }
  });
});
