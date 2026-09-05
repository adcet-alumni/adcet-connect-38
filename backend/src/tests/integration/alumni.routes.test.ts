/**
 * Integration tests for /api/v1/alumni — directory search.
 *
 * The default order is per-viewer relevance, which asks per band; the
 * where-builder cases below pin `sort=name` so they see one plain query.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { createPrismaDeepMock, makeToken, bearer } from "../helpers/integrationApp.js";

const prisma = createPrismaDeepMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma }));

const { buildApp } = await import("../../app.js");
const app = buildApp();

const token = makeToken({ sub: "user-1" });

beforeEach(() => {
  prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "APPROVED" } as any);
});

describe("/alumni", () => {
  it("401 anonymous", async () => {
    const res = await request(app).get("/api/v1/alumni");
    expect(res.status).toBe(401);
  });

  it("403 when user is PENDING", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: "user-1", status: "PENDING" } as any);
    const res = await request(app).get("/api/v1/alumni").set("Authorization", bearer(token));
    expect(res.status).toBe(403);
  });

  it("422 when graduationYear is non-numeric garbage", async () => {
    const res = await request(app)
      .get("/api/v1/alumni?graduationYear=notanumber")
      .set("Authorization", bearer(token));
    expect(res.status).toBe(422);
  });

  it("200 returns search results", async () => {
    prisma.profile.findMany.mockResolvedValueOnce([
      { id: "p1", user: { id: "u1", firstName: "A", lastName: "B" } } as any,
    ]);
    prisma.profile.count.mockResolvedValueOnce(1);
    const res = await request(app)
      .get("/api/v1/alumni?q=eng&city=Pune&sort=name")
      .set("Authorization", bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("free text searches names and companies — never department or batch", async () => {
    prisma.profile.findMany.mockResolvedValueOnce([]);
    prisma.profile.count.mockResolvedValueOnce(0);
    await request(app)
      .get("/api/v1/alumni?q=asha%20infosys&sort=name")
      .set("Authorization", bearer(token));

    const where = (prisma.profile.findMany.mock.calls[0][0] as any).where;
    // One clause per word, so a full name has to match on both halves.
    expect(where.AND).toHaveLength(2);
    for (const clause of where.AND) {
      const fields = clause.OR.map((o: any) => Object.keys(o.user ?? o)[0]);
      expect(fields).toEqual(["firstName", "lastName", "currentCompany"]);
    }
    expect(JSON.stringify(where.AND)).not.toContain("department");
    expect(JSON.stringify(where.AND)).not.toContain("graduationYear");
  });

  it("multi-select filters OR within a filter and AND across them", async () => {
    prisma.profile.findMany.mockResolvedValueOnce([]);
    prisma.profile.count.mockResolvedValueOnce(0);
    await request(app)
      .get("/api/v1/alumni?departments=Civil%20Engineering,Food%20Technology&graduationYears=2019,2020&sort=name")
      .set("Authorization", bearer(token));

    const where = (prisma.profile.findMany.mock.calls[0][0] as any).where;
    expect(where.department).toEqual({ in: ["Civil Engineering", "Food Technology"] });
    expect(where.graduationYear).toEqual({ in: [2019, 2020] });
  });

  it("422 when a graduation year in the multi-select is garbage", async () => {
    const res = await request(app)
      .get("/api/v1/alumni?graduationYears=2019,nope")
      .set("Authorization", bearer(token));
    expect(res.status).toBe(422);
  });

  it("422 on an unknown sort", async () => {
    const res = await request(app)
      .get("/api/v1/alumni?sort=salary")
      .set("Authorization", bearer(token));
    expect(res.status).toBe(422);
  });
});

/**
 * The directory answers differently for each member: it opens on their own
 * department and batch. The basis comes from the caller's own profile — never
 * from the query string, or one member could order the directory as another.
 */
describe("/alumni — relevance", () => {
  beforeEach(() => {
    prisma.profile.findUnique.mockResolvedValue({
      department: "Computer Science and Engineering",
      graduationYear: 2020,
    } as any);
    prisma.profile.count.mockResolvedValue(0);
    prisma.profile.findMany.mockResolvedValue([]);
  });

  it("orders by the caller's own department and batch, and says so", async () => {
    const res = await request(app).get("/api/v1/alumni").set("Authorization", bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.relevance).toEqual({
      department: "Computer Science and Engineering",
      graduationYear: 2020,
    });
    // The basis was read for the caller, not for whoever the query names.
    expect(prisma.profile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });

  it("hides nobody — every band filters only on approved accounts", async () => {
    await request(app).get("/api/v1/alumni").set("Authorization", bearer(token));

    // Read off the reads: a first page issues no band counts, so `findMany` is
    // where the bands are visible. A band is a slice of the same result set,
    // never an extra filter on it — anything else would drop members out of
    // the directory depending on who was looking.
    const wheres = prisma.profile.findMany.mock.calls.map((c: any) => c[0].where);
    expect(wheres.length).toBeGreaterThan(1);
    for (const w of wheres) expect(w.AND[0].user).toEqual({ status: "APPROVED" });

    // And the total counts the same set, unbanded.
    const totalWhere = (prisma.profile.count.mock.calls[0][0] as any).where;
    expect(totalWhere.user).toEqual({ status: "APPROVED" });
    expect(totalWhere.AND).toBeUndefined();
  });

  it("returns a card, not a profile row", async () => {
    prisma.profile.count.mockResolvedValue(1);
    prisma.profile.findMany.mockResolvedValue([
      {
        id: "p1",
        userId: "u1",
        linkedinUrl: "https://linkedin.com/in/asha",
        showLinkedin: false,
        user: { id: "u1", firstName: "A", lastName: "B" },
      } as any,
    ]);

    const res = await request(app).get("/api/v1/alumni").set("Authorization", bearer(token));

    expect(res.status).toBe(200);
    // Switched off, so the link is not in the payload at all — and neither is
    // the switch.
    expect(res.body.items[0].linkedinUrl).toBeNull();
    expect(res.body.items[0]).not.toHaveProperty("showLinkedin");
    expect(res.body.items[0].user).not.toHaveProperty("email");
  });
});