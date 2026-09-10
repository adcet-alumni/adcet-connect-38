import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../../lib/prisma.js", () => ({ prisma: prismaMock }));
const notifyMock = jest.fn(async () => undefined);
jest.unstable_mockModule("../../../modules/notifications/notifications.service.js", () => ({
  notify: notifyMock,
  create: jest.fn(),
}));

const svc = await import("../../../modules/jobs/jobs.service.js");

const ALUMNI = { sub: "u-1", roles: ["ALUMNI"] as any };
const ADMIN = { sub: "admin-1", roles: ["ADMIN"] as any };

beforeEach(() => {
  Object.values(prismaMock).forEach((m: any) =>
    m && typeof m === "object" ? Object.values(m).forEach((fn: any) => fn?.mockReset?.()) : null,
  );
  notifyMock.mockClear();
});

describe("modules/jobs/service — list", () => {
  it("non-admin caller is forced to status=APPROVED", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([]);
    prismaMock.job.count.mockResolvedValueOnce(0);
    await svc.list({ page: 1, pageSize: 10 } as any, ALUMNI);
    const where = (prismaMock.job.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toBe("APPROVED");
  });

  it("admin can request a specific status", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([]);
    prismaMock.job.count.mockResolvedValueOnce(0);
    await svc.list({ page: 1, pageSize: 10, status: "PENDING" } as any, ADMIN);
    const where = (prismaMock.job.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toBe("PENDING");
  });

  it("returns paginated shape", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([{ id: "j-1" }]);
    prismaMock.job.count.mockResolvedValueOnce(1);
    const out = await svc.list({ page: 1, pageSize: 10 } as any, ADMIN);
    expect(out).toMatchObject({
      items: [{ id: "j-1" }],
      pagination: { total: 1, page: 1, pageSize: 10, totalPages: 1 },
    });
  });
});

/**
 * A posting drops off the board 30 days after it goes up and is deleted at 45.
 * The gap is deliberate — the poster reads the applications during it — so what
 * these pin is that the *board* respects the window while the console does not,
 * and that nothing can be applied to once it has closed.
 */
describe("modules/jobs/service — the 30-day window", () => {
  const whereOf = () => (prismaMock.job.findMany.mock.calls[0][0] as any).where;

  const listAs = async (caller: typeof ALUMNI | typeof ADMIN) => {
    prismaMock.job.findMany.mockResolvedValueOnce([]);
    prismaMock.job.count.mockResolvedValueOnce(0);
    await svc.list({ page: 1, pageSize: 10 } as any, caller);
  };

  it("filters a member's listing to live postings", async () => {
    await listAs(ALUMNI);
    const where = whereOf();
    // The predicate itself is pinned in `lib/retention.test.ts`; here it only
    // has to be present, and to be the one from that module.
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toHaveProperty("expiresAt.gt");
    expect(where.OR[1]).toMatchObject({ expiresAt: null });
    expect(where.OR[1].createdAt.gt).toBeInstanceOf(Date);
  });

  /**
   * The console has to show what the board is hiding: an admin moderating or
   * reporting on postings must see the expired ones, and so must the poster
   * reaching their applications in the grace period.
   */
  it("does not filter an admin's listing", async () => {
    await listAs(ADMIN);
    expect(whereOf().OR).toBeUndefined();
  });

  it("sets the window 30 days back", async () => {
    await listAs(ALUMNI);
    const cutoff: Date = whereOf().OR[1].createdAt.gt;
    const days = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(30, 1);
  });

  it("refuses an application to a posting past its window", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({
      id: "j-old",
      status: "APPROVED",
      isClosed: false,
      expiresAt: null,
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    await expect(
      svc.apply("j-old", "u-2", { resumeKey: "resume/u-2/cv.pdf" }),
    ).rejects.toMatchObject({ status: 403 });
    // Nothing was written — a stale link must not create an application to a
    // posting that is about to be deleted.
    expect(prismaMock.jobApplication.upsert).not.toHaveBeenCalled();
  });

  it("accepts an application to a posting inside its window", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({
      id: "j-new",
      status: "APPROVED",
      isClosed: false,
      expiresAt: null,
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      createdById: "u-1",
      title: "Backend Engineer",
      company: "Acme",
    });
    prismaMock.jobApplication.upsert.mockResolvedValueOnce({ id: "a-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce(null);

    await svc.apply("j-new", "u-2", { resumeKey: "resume/u-2/cv.pdf" });

    expect(prismaMock.jobApplication.upsert).toHaveBeenCalled();
  });

  /** An extension postpones the hiding, so it must postpone the refusal too. */
  it("accepts an application to an old posting an admin extended", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({
      id: "j-ext",
      status: "APPROVED",
      isClosed: false,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      createdById: "u-1",
      title: "Backend Engineer",
      company: "Acme",
    });
    prismaMock.jobApplication.upsert.mockResolvedValueOnce({ id: "a-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce(null);

    await svc.apply("j-ext", "u-2", { resumeKey: "resume/u-2/cv.pdf" });

    expect(prismaMock.jobApplication.upsert).toHaveBeenCalled();
  });
});

/**
 * The poster's own list is the one place an expiring posting is announced. It
 * is deliberately *not* filtered by the window — the author reads applications
 * during the grace period — so instead each row says when it leaves the board
 * and when it will be deleted.
 */
describe("modules/jobs/service — myPostedJobs", () => {
  const DAY = 24 * 60 * 60 * 1000;

  const listMine = async (job: Record<string, unknown>) => {
    prismaMock.job.findMany.mockResolvedValueOnce([job]);
    prismaMock.job.count.mockResolvedValueOnce(1);
    const out = await svc.myPostedJobs(ALUMNI, { page: 1, pageSize: 10 } as any);
    return out.items[0] as any;
  };

  it("shows the poster their own expired postings", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([]);
    prismaMock.job.count.mockResolvedValueOnce(0);
    await svc.myPostedJobs(ALUMNI, { page: 1, pageSize: 10 } as any);
    const where = (prismaMock.job.findMany.mock.calls[0][0] as any).where;
    // Owner only — and no retention filter, or the grace period would be
    // useless to the person it exists for.
    expect(where).toEqual({ createdById: "u-1" });
  });

  it("dates a live posting's exit from the board 30 days after it went up", async () => {
    const createdAt = new Date(Date.now() - 2 * DAY);
    const row = await listMine({ id: "j-1", createdAt, expiresAt: null });

    expect(row.isExpired).toBe(false);
    expect(row.expiresOn.getTime()).toBe(createdAt.getTime() + 30 * DAY);
    // ...and its deletion 15 days after that.
    expect(row.purgesOn.getTime()).toBe(createdAt.getTime() + 45 * DAY);
  });

  it("flags an expired posting and dates its deletion", async () => {
    const createdAt = new Date(Date.now() - 35 * DAY);
    const row = await listMine({ id: "j-2", createdAt, expiresAt: null });

    expect(row.isExpired).toBe(true);
    expect(row.purgesOn.getTime()).toBeGreaterThan(Date.now());
  });

  it("dates an extended posting from the extension, not from when it was posted", async () => {
    const createdAt = new Date(Date.now() - 200 * DAY);
    const expiresAt = new Date(Date.now() + 10 * DAY);
    const row = await listMine({ id: "j-3", createdAt, expiresAt });

    expect(row.isExpired).toBe(false);
    expect(row.expiresOn.getTime()).toBe(expiresAt.getTime());
    expect(row.purgesOn.getTime()).toBe(expiresAt.getTime() + 15 * DAY);
  });
});

describe("modules/jobs/service — branch coverage extras", () => {
  it("list applies all optional filters at once", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([]);
    prismaMock.job.count.mockResolvedValueOnce(0);
    await svc.list(
      {
        page: 1,
        pageSize: 10,
        company: "Acme",
        location: "Pune",
        employmentType: "FULL_TIME",
        isRemote: true,
        q: "node",
      } as any,
      ADMIN,
    );
    const where = (prismaMock.job.findMany.mock.calls[0][0] as any).where;
    expect(where.company.contains).toBe("Acme");
    expect(where.location.contains).toBe("Pune");
    expect(where.employmentType).toBe("FULL_TIME");
    expect(where.isRemote).toBe(true);
    expect(where.OR).toHaveLength(3);
  });

  it("getById 404 when missing", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getById("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("update 404 when missing, 403 when non-owner non-admin, ok for owner", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update(ALUMNI, "x", {} as any)).rejects.toMatchObject({ status: 404 });

    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    await expect(svc.update(ALUMNI, "j-1", {} as any)).rejects.toMatchObject({ status: 403 });

    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "u-1" });
    prismaMock.job.update.mockResolvedValueOnce({});
    await expect(svc.update(ALUMNI, "j-1", {} as any)).resolves.toBeDefined();
  });

  it("remove 404 / 403 / admin-allowed branches", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove(ALUMNI, "x")).rejects.toMatchObject({ status: 404 });

    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    await expect(svc.remove(ALUMNI, "j-1")).rejects.toMatchObject({ status: 403 });

    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    prismaMock.job.delete.mockResolvedValueOnce({});
    await expect(svc.remove(ADMIN, "j-1")).resolves.toBeUndefined();
  });

  it("apply upserts on (job, user) compound key", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", status: "APPROVED", isClosed: false, createdById: "poster", title: "X", company: "Y" });
    prismaMock.jobApplication.upsert.mockResolvedValueOnce({ id: "ja-1" });
    await svc.apply("j-1", "u-1", { resumeKey: "k", coverLetter: "hi" });
    const arg = prismaMock.jobApplication.upsert.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ jobId_userId: { jobId: "j-1", userId: "u-1" } });
  });

  it("listApplications: 404 missing, 403 non-owner, allowed for owner & admin", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);
    await expect(svc.listApplications(ALUMNI, "x")).rejects.toMatchObject({ status: 404 });

    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    await expect(svc.listApplications(ALUMNI, "j-1")).rejects.toMatchObject({ status: 403 });

    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "u-1" });
    prismaMock.jobApplication.findMany.mockResolvedValueOnce([]);
    await svc.listApplications(ALUMNI, "j-1");
    expect(prismaMock.jobApplication.findMany).toHaveBeenCalled();

    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    prismaMock.jobApplication.findMany.mockResolvedValueOnce([]);
    await svc.listApplications(ADMIN, "j-1");
    expect(prismaMock.jobApplication.findMany).toHaveBeenCalledTimes(2);
  });

  it("moderate APPROVED clears reason and notifies", async () => {
    prismaMock.job.update.mockResolvedValueOnce({
      id: "j-1", title: "T", company: "Acme", createdById: "u-1",
    });
    await svc.moderate("j-1", "APPROVED");
    expect((prismaMock.job.update.mock.calls[0][0] as any).data.rejectionReason).toBeNull();
    expect(notifyMock).toHaveBeenCalled();
  });

  it("moderate REJECTED includes reason in body when provided", async () => {
    prismaMock.job.update.mockResolvedValueOnce({
      id: "j-1", title: "T", company: "Acme", createdById: "u-1",
    });
    await svc.moderate("j-1", "REJECTED", "Spam");
    expect(notifyMock.mock.calls[0][1].body).toContain("Spam");
  });
});

describe("modules/jobs/service — getById / create / update / remove", () => {
  it("getById throws NotFound when missing", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getById("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("getById includes createdBy + counts", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1" });
    await svc.getById("j-1");
    const arg = prismaMock.job.findUnique.mock.calls[0][0] as any;
    expect(arg.include.createdBy).toBeDefined();
    expect(arg.include._count.select.applications).toBe(true);
  });

  it("create stamps createdById from caller", async () => {
    prismaMock.job.create.mockResolvedValueOnce({ id: "j-1" });
    await svc.create(ALUMNI, { title: "x" } as any);
    const arg = prismaMock.job.create.mock.calls[0][0] as any;
    expect(arg.data.createdById).toBe("u-1");
  });

  it("update: 404 if not found", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update(ALUMNI, "j-1", {} as any)).rejects.toMatchObject({ status: 404 });
  });

  it("update: 403 if non-owner & non-admin", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    await expect(svc.update(ALUMNI, "j-1", {} as any)).rejects.toMatchObject({ status: 403 });
  });

  it("update: owner can edit", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "u-1" });
    prismaMock.job.update.mockResolvedValueOnce({ id: "j-1" });
    await expect(svc.update(ALUMNI, "j-1", { title: "y" } as any)).resolves.toBeDefined();
  });

  it("update: admin can edit any job", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    prismaMock.job.update.mockResolvedValueOnce({ id: "j-1" });
    await expect(svc.update(ADMIN, "j-1", {} as any)).resolves.toBeDefined();
  });

  it("remove: 403 for non-owner non-admin", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    await expect(svc.remove(ALUMNI, "j-1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("modules/jobs/service — moderate", () => {
  it("APPROVED clears rejectionReason and notifies the poster", async () => {
    prismaMock.job.update.mockResolvedValueOnce({
      id: "j-1",
      title: "Dev",
      company: "Acme",
      createdById: "u-1",
    });
    await svc.moderate("j-1", "APPROVED");
    expect(prismaMock.job.update.mock.calls[0][0]).toMatchObject({
      where: { id: "j-1" },
      data: { status: "APPROVED", rejectionReason: null },
    });
    expect(notifyMock).toHaveBeenCalledWith(
      "u-1",
      expect.objectContaining({ type: "job.approved", sendEmailToo: true }),
    );
  });

  it("REJECTED persists the reason and includes it in the notification body", async () => {
    prismaMock.job.update.mockResolvedValueOnce({
      id: "j-1",
      title: "Dev",
      company: "Acme",
      createdById: "u-1",
    });
    await svc.moderate("j-1", "REJECTED", "Spam");
    expect((prismaMock.job.update.mock.calls[0][0] as any).data.rejectionReason).toBe("Spam");
    expect(notifyMock).toHaveBeenCalledWith(
      "u-1",
      expect.objectContaining({ body: expect.stringContaining("Spam") }),
    );
  });
});

describe("modules/jobs/service — apply / applications", () => {
  it("apply upserts on the (job, user) compound key", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", status: "APPROVED", isClosed: false, createdById: "poster", title: "X", company: "Y" });
    prismaMock.jobApplication.upsert.mockResolvedValueOnce({ id: "ja-1" });
    await svc.apply("j-1", "u-1", { resumeKey: "k", coverLetter: "hi" });
    const arg = prismaMock.jobApplication.upsert.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ jobId_userId: { jobId: "j-1", userId: "u-1" } });
  });

  it("apply: 403 when job is closed", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", status: "APPROVED", isClosed: true, createdById: "poster" });
    await expect(svc.apply("j-1", "u-1", { resumeKey: "k" })).rejects.toMatchObject({ status: 403 });
  });

  it("apply: 404 when job missing", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);
    await expect(svc.apply("j-1", "u-1", { resumeKey: "k" })).rejects.toMatchObject({ status: 404 });
  });

  it("setClosed: owner can close, sets closedAt", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "u-1" });
    prismaMock.job.update.mockResolvedValueOnce({ id: "j-1", isClosed: true });
    await svc.setClosed(ALUMNI, "j-1", true);
    const arg = prismaMock.job.update.mock.calls[0][0] as any;
    expect(arg.data.isClosed).toBe(true);
    expect(arg.data.closedAt).toBeInstanceOf(Date);
  });

  it("setClosed: 403 for non-owner non-admin", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    await expect(svc.setClosed(ALUMNI, "j-1", true)).rejects.toMatchObject({ status: 403 });
  });

  it("listApplications: 403 if non-owner non-admin", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({ id: "j-1", createdById: "other" });
    await expect(svc.listApplications(ALUMNI, "j-1")).rejects.toMatchObject({ status: 403 });
  });

  it("listApplications: 404 if job missing", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);
    await expect(svc.listApplications(ADMIN, "j-1")).rejects.toMatchObject({ status: 404 });
  });
});