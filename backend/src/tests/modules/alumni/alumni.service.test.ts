/**
 * Branch-coverage tests for the Alumni search service: every conditional in
 * the dynamic `where` builder (q, city, company, department, year, year range
 * and combinations), the per-viewer relevance ordering, and the narrowed
 * payload a directory row is allowed to carry.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../../lib/prisma.js", () => ({ prisma: prismaMock }));
const svc = await import("../../../modules/alumni/alumni.service.js");

beforeEach(() => {
  Object.values(prismaMock).forEach((m: any) =>
    m && typeof m === "object" ? Object.values(m).forEach((fn: any) => fn?.mockReset?.()) : null,
  );
  prismaMock.profile.findMany.mockResolvedValue([]);
  prismaMock.profile.count.mockResolvedValue(0);
});

/** Nobody in particular — the filter tests are about the `where`, not the order. */
const ANON = { department: null, graduationYear: null };

/**
 * Exercised through `sort=name`, the viewer-independent order, so `where` is
 * the filter clause on its own rather than the relevance band's `AND` pair.
 */
const callWith = async (q: any) => {
  await svc.search({ page: 1, pageSize: 10, sort: "name", ...q }, ANON);
  return (prismaMock.profile.findMany.mock.calls.at(-1)![0] as any).where;
};

describe("modules/alumni/service — search where-builder", () => {
  it("baseline only filters approved users", async () => {
    const where = await callWith({});
    expect(where.user).toEqual({ status: "APPROVED" });
    expect(where.city).toBeUndefined();
  });

  it("applies city / company / department fuzzy filters", async () => {
    const where = await callWith({ city: "Pune", company: "Acme", department: "CS" });
    expect(where.city.contains).toBe("Pune");
    expect(where.currentCompany.contains).toBe("Acme");
    expect(where.department.contains).toBe("CS");
  });

  it("graduationYear exact match overrides ranges branch", async () => {
    const where = await callWith({ graduationYear: 2020 });
    expect(where.graduationYear).toBe(2020);
  });

  it("graduationYearMin only", async () => {
    const where = await callWith({ graduationYearMin: 2018 });
    expect(where.graduationYear).toEqual({ gte: 2018 });
  });

  it("graduationYearMax only", async () => {
    const where = await callWith({ graduationYearMax: 2022 });
    expect(where.graduationYear).toEqual({ lte: 2022 });
  });

  it("both min and max produce a range", async () => {
    const where = await callWith({ graduationYearMin: 2010, graduationYearMax: 2020 });
    expect(where.graduationYear).toEqual({ gte: 2010, lte: 2020 });
  });

  it("free-text search covers first name, last name and company — nothing else", async () => {
    const where = await callWith({ q: "alice" });
    expect(where.AND).toHaveLength(1);
    expect(where.AND[0].OR).toEqual([
      { user: { firstName: { contains: "alice", mode: "insensitive" } } },
      { user: { lastName: { contains: "alice", mode: "insensitive" } } },
      { currentCompany: { contains: "alice", mode: "insensitive" } },
    ]);
  });

  it("every word in a full name must match, so surnames narrow the result", async () => {
    const where = await callWith({ q: "alice kulkarni" });
    expect(where.AND).toHaveLength(2);
  });

  it("multi-select department and batch filters use an IN clause", async () => {
    const where = await callWith({
      departments: ["Civil Engineering", "Food Technology"],
      graduationYears: [2019, 2020],
    });
    expect(where.department).toEqual({ in: ["Civil Engineering", "Food Technology"] });
    expect(where.graduationYear).toEqual({ in: [2019, 2020] });
  });

  it("returns paginated shape", async () => {
    prismaMock.profile.findMany.mockResolvedValueOnce([{ id: "p-1" }]);
    prismaMock.profile.count.mockResolvedValueOnce(1);
    const out = await svc.search({ page: 1, pageSize: 10, sort: "name" } as any, ANON);
    expect(out.items).toHaveLength(1);
    expect(out.pagination.total).toBe(1);
  });
});

/**
 * The point of the default order: the same query has to answer differently for
 * two different members, or the directory is the same wall of names for
 * everyone. Nothing is filtered out by it — every band is a slice of the same
 * result set, and the counts add up to the same total.
 */
describe("modules/alumni/service — relevance ordering", () => {
  const VIEWER = { department: "Computer Science and Engineering", graduationYear: 2020 };

  /** The `where`/`orderBy` pairs the service asked for, band by band. */
  const bandsFor = async (viewer: any, q: any = {}) => {
    await svc.search({ page: 1, pageSize: 10, ...q }, viewer);
    return prismaMock.profile.count.mock.calls.map((c: any) => c[0].where);
  };

  it("puts the viewer's own department first, then everyone else, then the departmentless", async () => {
    const bands = await bandsFor(VIEWER);
    /** A band's department scope, with the batch half of it set aside. */
    const scope = (i: number) => {
      const band = { ...(bands[i].AND[1] as any) };
      delete band.graduationYear;
      return band;
    };

    for (const i of [0, 1, 2]) expect(scope(i)).toEqual({ department: VIEWER.department });
    for (const i of [3, 4, 5]) expect(scope(i)).toEqual({ NOT: { department: VIEWER.department } });
    // NOT: { department } is false for NULL in SQL, so those rows need a band
    // of their own or they would drop out of the directory entirely.
    for (const i of [6, 7, 8]) expect(scope(i)).toEqual({ department: null });
    expect(bands).toHaveLength(9);
  });

  it("walks out from the viewer's own batch: own year, then seniors, then juniors", async () => {
    await svc.search({ page: 1, pageSize: 10 }, VIEWER);
    const [own, juniors, undated] = prismaMock.profile.count.mock.calls
      .slice(0, 3)
      .map((c: any) => c[0].where.AND[1].graduationYear);

    // Descending from the viewer's own year covers "my batch, then the seniors".
    expect(own).toEqual({ lte: 2020 });
    expect(juniors).toEqual({ gt: 2020 });
    expect(undated).toBeNull();
  });

  it("orders each band on an indexed column, newest-first below the viewer's year", async () => {
    prismaMock.profile.count.mockResolvedValue(5);
    prismaMock.profile.findMany.mockResolvedValue([]);
    await svc.search({ page: 1, pageSize: 10 }, VIEWER);

    const first = prismaMock.profile.findMany.mock.calls[0][0] as any;
    expect(first.orderBy[0]).toEqual({ graduationYear: "desc" });
  });

  it("keeps the filters — a relevance band narrows the same result set", async () => {
    const bands = await bandsFor(VIEWER, { city: "Pune", q: "asha" });
    for (const where of bands) {
      expect(where.AND[0].user).toEqual({ status: "APPROVED" });
      expect(where.AND[0].city.contains).toBe("Pune");
      expect(where.AND[0].AND).toHaveLength(1);
    }
  });

  it("degrades to a plain listing for a viewer with no department or batch", async () => {
    const bands = await bandsFor({ department: null, graduationYear: null });
    expect(bands).toHaveLength(1);
    expect(bands[0].AND[1]).toEqual({});
  });

  it("reports the total across every band, and the basis it ordered by", async () => {
    prismaMock.profile.count.mockResolvedValue(4); // 9 bands × 4
    prismaMock.profile.findMany.mockResolvedValue([]);

    const out = await svc.search({ page: 1, pageSize: 10 }, VIEWER);
    expect(out.pagination.total).toBe(36);
    expect(out.relevance).toEqual(VIEWER);
  });

  it("skips whole bands that sit before the requested page", async () => {
    // 9 bands of 4; page 2 of 10 starts at offset 10, i.e. band 3 (0-indexed 2)
    // with 2 rows already behind it.
    prismaMock.profile.count.mockResolvedValue(4);
    prismaMock.profile.findMany.mockResolvedValue([]);

    await svc.search({ page: 2, pageSize: 10 }, VIEWER);

    const first = prismaMock.profile.findMany.mock.calls[0][0] as any;
    expect(first.skip).toBe(2);
    // Later bands start from the top of their own slice.
    const second = prismaMock.profile.findMany.mock.calls[1][0] as any;
    expect(second.skip).toBe(0);
  });

  it("stops asking once the page is full", async () => {
    prismaMock.profile.count.mockResolvedValue(50);
    prismaMock.profile.findMany.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `p-${i}` })));

    const out = await svc.search({ page: 1, pageSize: 10 }, VIEWER);
    expect(out.items).toHaveLength(10);
    expect(prismaMock.profile.findMany).toHaveBeenCalledTimes(1);
  });
});

/**
 * A directory row is read by every approved member, so it may carry only what
 * the card renders. Before this, `findMany` returned the whole Profile — phone
 * number, birthday and all — and the frontend simply didn't draw it.
 */
describe("modules/alumni/service — what a directory row may carry", () => {
  const ANON_VIEWER = { department: null, graduationYear: null };

  it("selects the card's fields and nothing else", async () => {
    await svc.search({ page: 1, pageSize: 10, sort: "name" } as any, ANON_VIEWER);
    const select = (prismaMock.profile.findMany.mock.calls[0][0] as any).select;

    expect(Object.keys(select).sort()).toEqual([
      "avatarKey", "city", "currentCompany", "currentRole", "department",
      "graduationYear", "id", "linkedinUrl", "showLinkedin", "user", "userId",
    ]);
    for (const leaked of ["phone", "birthDay", "birthMonth", "bio", "rollNumber", "githubUrl"]) {
      expect(select).not.toHaveProperty(leaked);
    }
    // The joined user is narrowed too — an email is never part of a listing.
    expect(select.user.select).toEqual({ id: true, firstName: true, lastName: true });
  });

  it("hides the LinkedIn link of anyone who switched it off, and drops the flag", async () => {
    prismaMock.profile.findMany.mockResolvedValueOnce([
      { id: "p-1", linkedinUrl: "https://linkedin.com/in/asha", showLinkedin: true },
      { id: "p-2", linkedinUrl: "https://linkedin.com/in/rohit", showLinkedin: false },
    ]);
    prismaMock.profile.count.mockResolvedValueOnce(2);

    const out = await svc.search({ page: 1, pageSize: 10, sort: "name" } as any, ANON_VIEWER);

    expect(out.items[0].linkedinUrl).toBe("https://linkedin.com/in/asha");
    expect(out.items[1].linkedinUrl).toBeNull();
    // The switch itself is nobody else's business.
    for (const item of out.items) expect(item).not.toHaveProperty("showLinkedin");
  });
});