/**
 * One rule, across every listing that names a person: a member-facing payload
 * carries who someone is, an admin-facing one may also carry how to reach them.
 *
 * Events, jobs and achievements all used to include `createdBy.email` /
 * `user.email` for any approved member, while the pages rendered nothing but a
 * name — so every event list quietly published the alumni office's address book.
 * These tests read the `select` the service asked Prisma for, because that is
 * where the decision lives: a payload cannot leak a column it never selected.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { createPrismaDeepMock, makeToken, bearer } from "../helpers/integrationApp.js";

const prisma = createPrismaDeepMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma }));

const { buildApp } = await import("../../app.js");
const app = buildApp();

const memberToken = makeToken({ sub: "user-1" });
const adminToken = makeToken({ sub: "admin-1", roles: ["ADMIN"] });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "APPROVED" } as any);
  prisma.event.count.mockResolvedValue(0);
  prisma.job.count.mockResolvedValue(0);
  prisma.achievement.count.mockResolvedValue(0);
  prisma.event.findMany.mockResolvedValue([]);
  prisma.job.findMany.mockResolvedValue([]);
  prisma.achievement.findMany.mockResolvedValue([]);
});

/** Whether the email column was selected on the person attached to a record. */
const emailSelected = (call: any, relation: string) =>
  (call.include?.[relation] ?? call.select?.[relation])?.select?.email;

describe("a person on a member-facing listing", () => {
  it("has a name, not an email — events", async () => {
    await request(app).get("/api/v1/events").set("Authorization", bearer(memberToken));

    const call = prisma.event.findMany.mock.calls[0][0] as any;
    expect(emailSelected(call, "createdBy")).toBe(false);
    expect(call.include.createdBy.select.firstName).toBe(true);
  });

  it("has a name, not an email — event detail", async () => {
    prisma.event.findUnique.mockResolvedValue({ id: "e1" } as any);
    await request(app).get("/api/v1/events/e1").set("Authorization", bearer(memberToken));

    expect(emailSelected(prisma.event.findUnique.mock.calls[0][0] as any, "createdBy")).toBe(false);
  });

  it("has a name, not an email — jobs", async () => {
    await request(app).get("/api/v1/jobs").set("Authorization", bearer(memberToken));

    expect(emailSelected(prisma.job.findMany.mock.calls[0][0] as any, "createdBy")).toBe(false);
  });

  it("has a name, not an email — job detail", async () => {
    prisma.job.findUnique.mockResolvedValue({ id: "j1" } as any);
    await request(app).get("/api/v1/jobs/j1").set("Authorization", bearer(memberToken));

    expect(emailSelected(prisma.job.findUnique.mock.calls[0][0] as any, "createdBy")).toBe(false);
  });

  it("has a name, not an email — achievement detail", async () => {
    prisma.achievement.findUnique.mockResolvedValue({ id: "a1", status: "APPROVED" } as any);
    await request(app).get("/api/v1/achievements/a1").set("Authorization", bearer(memberToken));

    expect(emailSelected(prisma.achievement.findUnique.mock.calls[0][0] as any, "user")).toBe(false);
  });
});

/**
 * The same routes, asked by an admin. They administer these accounts and write
 * to the people in them, so the address is theirs to see — the point of the
 * change is that it is a decision per caller, not a constant.
 */
describe("a person on an admin's view of the same record", () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue({ id: "admin-1", status: "APPROVED" } as any);
  });

  it("carries the email — event detail", async () => {
    prisma.event.findUnique.mockResolvedValue({ id: "e1" } as any);
    await request(app).get("/api/v1/events/e1").set("Authorization", bearer(adminToken));

    expect(emailSelected(prisma.event.findUnique.mock.calls[0][0] as any, "createdBy")).toBe(true);
  });

  it("carries the email — job detail", async () => {
    prisma.job.findUnique.mockResolvedValue({ id: "j1" } as any);
    await request(app).get("/api/v1/jobs/j1").set("Authorization", bearer(adminToken));

    expect(emailSelected(prisma.job.findUnique.mock.calls[0][0] as any, "createdBy")).toBe(true);
  });

  it("carries the email — achievement detail", async () => {
    prisma.achievement.findUnique.mockResolvedValue({ id: "a1", status: "APPROVED" } as any);
    await request(app).get("/api/v1/achievements/a1").set("Authorization", bearer(adminToken));

    expect(emailSelected(prisma.achievement.findUnique.mock.calls[0][0] as any, "user")).toBe(true);
  });

  it("carries the email on the moderation queues, which are admin-only", async () => {
    prisma.job.findMany.mockResolvedValue([]);
    await request(app).get("/api/v1/jobs/pending").set("Authorization", bearer(adminToken));

    expect(emailSelected(prisma.job.findMany.mock.calls[0][0] as any, "createdBy")).toBe(true);
  });
});
