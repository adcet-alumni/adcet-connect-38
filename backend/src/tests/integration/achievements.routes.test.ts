/**
 * Integration tests for /api/v1/achievements.
 * Mirrors jobs/events: list, get-by-id, create/update/delete, ownership,
 * admin moderation with reasons.
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
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "APPROVED" } as any);
});

describe("/achievements", () => {
  it("401 anonymous list", async () => {
    const res = await request(app).get("/api/v1/achievements");
    expect(res.status).toBe(401);
  });

  it("200 list", async () => {
    prisma.achievement.findMany.mockResolvedValueOnce([{ id: "a1" } as any]);
    prisma.achievement.count.mockResolvedValueOnce(1);
    const res = await request(app)
      .get("/api/v1/achievements")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(200);
  });

  it("404 detail when missing", async () => {
    prisma.achievement.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .get("/api/v1/achievements/missing")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(404);
  });

  it("422 create with empty title", async () => {
    const res = await request(app)
      .post("/api/v1/achievements")
      .set("Authorization", bearer(userToken))
      .send({ title: "", description: "Some desc" });
    expect(res.status).toBe(422);
  });

  it("201 create", async () => {
    prisma.achievement.create.mockResolvedValueOnce({ id: "a2" } as any);
    const res = await request(app)
      .post("/api/v1/achievements")
      .set("Authorization", bearer(userToken))
      .send({ title: "Won Hackathon", description: "First place at XYZ" });
    expect(res.status).toBe(201);
  });

  /**
   * Stored XSS. `link` is rendered as an `<a href>` on the public achievement
   * page and in the admin moderation queue, so a non-http scheme stored here is
   * script that runs in a reader's — or an admin's — browser. `httpUrl` in
   * `lib/urls.ts` is what blocks it; `z.string().url()` did not.
   */
  it.each([
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
  ])("422 create with a %s link, and nothing is written", async (link) => {
    const res = await request(app)
      .post("/api/v1/achievements")
      .set("Authorization", bearer(userToken))
      .send({ title: "Won Hackathon", description: "First place at XYZ", link });
    expect(res.status).toBe(422);
    expect(prisma.achievement.create).not.toHaveBeenCalled();
  });

  it("422 when a hostile link is smuggled in through PATCH", async () => {
    const res = await request(app)
      .patch("/api/v1/achievements/a1")
      .set("Authorization", bearer(userToken))
      .send({ link: "javascript:alert(1)" });
    expect(res.status).toBe(422);
    expect(prisma.achievement.update).not.toHaveBeenCalled();
  });

  it("201 create with an ordinary https link", async () => {
    prisma.achievement.create.mockResolvedValueOnce({ id: "a3" } as any);
    const res = await request(app)
      .post("/api/v1/achievements")
      .set("Authorization", bearer(userToken))
      .send({ title: "Won Hackathon", description: "First place at XYZ", link: "https://news.example/x" });
    expect(res.status).toBe(201);
  });

  it("403 update someone else's achievement", async () => {
    prisma.achievement.findUnique.mockResolvedValueOnce({ id: "a1", userId: "u-other" } as any);
    const res = await request(app)
      .patch("/api/v1/achievements/a1")
      .set("Authorization", bearer(userToken))
      .send({ title: "Steal" });
    expect(res.status).toBe(403);
  });

/**
 * The alumni office recording somebody else's achievement. Two shapes, one
 * route: a member of the portal (the entry lands on *their* achievements), or a
 * plain name for someone who never registered.
 */
describe("/achievements/admin", () => {
  const body = {
    title: "National Innovation Award 2026",
    description: "Recognised for a low-cost water purification unit.",
  };

  it("403 for a member — whose achievement it is, is an admin's call", async () => {
    const res = await request(app)
      .post("/api/v1/achievements/admin")
      .set("Authorization", bearer(userToken))
      .send({ ...body, achieverName: "Someone Else" });
    expect(res.status).toBe(403);
    expect(prisma.achievement.create).not.toHaveBeenCalled();
  });

  it("422 when the achiever is not named at all", async () => {
    const res = await request(app)
      .post("/api/v1/achievements/admin")
      .set("Authorization", bearer(adminToken))
      .send(body);
    expect(res.status).toBe(422);
  });

  it("422 when both an alumnus and a name are given", async () => {
    const res = await request(app)
      .post("/api/v1/achievements/admin")
      .set("Authorization", bearer(adminToken))
      .send({
        ...body,
        userId: "11111111-1111-4111-8111-111111111111",
        achieverName: "Someone Else",
      });
    expect(res.status).toBe(422);
  });

  it("files it under the named alumnus, approved and without a stand-in name", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "admin-1", status: "APPROVED" } as any);
    prisma.achievement.create.mockResolvedValue({ id: "a1" } as any);

    const res = await request(app)
      .post("/api/v1/achievements/admin")
      .set("Authorization", bearer(adminToken))
      .send({ ...body, userId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(201);
    const data = (prisma.achievement.create.mock.calls[0][0] as any).data;
    expect(data.userId).toBe("11111111-1111-4111-8111-111111111111");
    // Their account is the byline, so there is no name to store alongside it.
    expect(data.achieverName).toBeNull();
    // The admin is the moderation step; queueing it for themselves is a click
    // with no decision in it.
    expect(data.status).toBe("APPROVED");
  });

  it("404 when that alumnus does not exist", async () => {
    // This route is requireAuth + requireAdmin — the role comes from the token,
    // so the only `user.findUnique` it makes is the achiever lookup.
    prisma.user.findUnique.mockResolvedValue(null as any);

    const res = await request(app)
      .post("/api/v1/achievements/admin")
      .set("Authorization", bearer(adminToken))
      .send({ ...body, userId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(404);
    expect(prisma.achievement.create).not.toHaveBeenCalled();
  });

  it("files a non-member entry under the admin, with the typed name and link", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "admin-1", status: "APPROVED" } as any);
    prisma.achievement.create.mockResolvedValue({ id: "a1" } as any);

    const res = await request(app)
      .post("/api/v1/achievements/admin")
      .set("Authorization", bearer(adminToken))
      .send({
        ...body,
        achieverName: "Dr. S. R. Kulkarni",
        achieverLinkedinUrl: "https://linkedin.com/in/srk",
      });

    expect(res.status).toBe(201);
    const data = (prisma.achievement.create.mock.calls[0][0] as any).data;
    // Somebody has to own the row; the byline is the name.
    expect(data.userId).toBe("admin-1");
    expect(data.achieverName).toBe("Dr. S. R. Kulkarni");
    expect(data.achieverLinkedinUrl).toBe("https://linkedin.com/in/srk");
  });

  it("422 on a javascript: link, like every other stored URL", async () => {
    const res = await request(app)
      .post("/api/v1/achievements/admin")
      .set("Authorization", bearer(adminToken))
      .send({
        ...body,
        achieverName: "Dr. S. R. Kulkarni",
        achieverLinkedinUrl: "javascript:alert(1)",
      });
    expect(res.status).toBe(422);
  });
});

/**
 * The LinkedIn shown next to an achievement's byline. The API decides it — the
 * page only renders what arrives — so these pin the decision itself.
 */
describe("/achievements — the byline's LinkedIn", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    title: "t",
    status: "APPROVED",
    achieverName: null,
    achieverLinkedinUrl: null,
    user: { id: "u1", firstName: "Asha", lastName: "K", profile: null },
    ...over,
  });

  it("uses the author's profile link when their switch allows it", async () => {
    prisma.achievement.findUnique.mockResolvedValue(
      row({ user: { id: "u1", firstName: "Asha", lastName: "K", profile: { linkedinUrl: "https://linkedin.com/in/asha", showLinkedin: true } } }) as any,
    );
    const res = await request(app).get("/api/v1/achievements/a1").set("Authorization", bearer(userToken));

    expect(res.body.linkedinUrl).toBe("https://linkedin.com/in/asha");
    // The profile itself is not part of the payload — only the decision is.
    expect(res.body.user).not.toHaveProperty("profile");
  });

  it("shows nothing when the author switched their link off", async () => {
    prisma.achievement.findUnique.mockResolvedValue(
      row({ user: { id: "u1", firstName: "Asha", lastName: "K", profile: { linkedinUrl: "https://linkedin.com/in/asha", showLinkedin: false } } }) as any,
    );
    const res = await request(app).get("/api/v1/achievements/a1").set("Authorization", bearer(userToken));
    expect(res.body.linkedinUrl).toBeNull();
  });

  it("still shows nothing when an admin typed one for a member who hid theirs", async () => {
    // "Don't show my LinkedIn" cannot mean "unless an admin adds it for me".
    prisma.achievement.findUnique.mockResolvedValue(
      row({
        achieverLinkedinUrl: "https://linkedin.com/in/asha",
        user: { id: "u1", firstName: "Asha", lastName: "K", profile: { linkedinUrl: null, showLinkedin: false } },
      }) as any,
    );
    const res = await request(app).get("/api/v1/achievements/a1").set("Authorization", bearer(userToken));
    expect(res.body.linkedinUrl).toBeNull();
  });

  it("uses the typed link for a non-member, never the filing admin's own", async () => {
    prisma.achievement.findUnique.mockResolvedValue(
      row({
        achieverName: "Dr. S. R. Kulkarni",
        achieverLinkedinUrl: "https://linkedin.com/in/srk",
        // The admin who filed it — their profile must not leak into the byline.
        user: { id: "admin-1", firstName: "Admin", lastName: "User", profile: { linkedinUrl: "https://linkedin.com/in/admin", showLinkedin: true } },
      }) as any,
    );
    const res = await request(app).get("/api/v1/achievements/a1").set("Authorization", bearer(userToken));
    expect(res.body.linkedinUrl).toBe("https://linkedin.com/in/srk");
  });

  it("is null, not an error, when there is no link anywhere", async () => {
    prisma.achievement.findUnique.mockResolvedValue(row() as any);
    const res = await request(app).get("/api/v1/achievements/a1").set("Authorization", bearer(userToken));
    expect(res.status).toBe(200);
    expect(res.body.linkedinUrl).toBeNull();
  });

  it("is absent from the public page — a profile link is not public content", async () => {
    prisma.achievement.findFirst.mockResolvedValue({
      id: "a1",
      title: "t",
      achieverName: "Dr. S. R. Kulkarni",
      user: { firstName: "Admin", lastName: "User" },
    } as any);

    const res = await request(app).get("/api/v1/achievements/public/a1");

    expect(res.status).toBe(200);
    // The name is public (it is the byline); the link is not.
    expect(res.body.achieverName).toBe("Dr. S. R. Kulkarni");
    expect(res.body.linkedinUrl).toBeUndefined();
    const select = (prisma.achievement.findFirst.mock.calls[0][0] as any).select;
    expect(select).not.toHaveProperty("achieverLinkedinUrl");
  });
});

  it("403 listPending for non-admin", async () => {
    const res = await request(app)
      .get("/api/v1/achievements/pending")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(403);
  });

  it("200 admin moderates approve", async () => {
    prisma.achievement.update.mockResolvedValueOnce({
      id: "a1",
      title: "Won",
      description: "First place",
      userId: "user-1",
      user: { firstName: "Alice", lastName: "A", email: "alice@adcet.in" },
    } as any);
    prisma.notification.create.mockResolvedValueOnce({} as any);
    prisma.siteSection.findUnique.mockResolvedValueOnce(null as any);
    const res = await request(app)
      .post("/api/v1/achievements/a1/moderate")
      .set("Authorization", bearer(adminToken))
      .send({ status: "APPROVED" });
    expect(res.status).toBe(200);
  });
});