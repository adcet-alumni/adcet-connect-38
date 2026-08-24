/**
 * Integration tests for /api/v1/profiles. The /me routes don't require
 * approval (so even pending users can edit their profile), but reading
 * another user's profile is gated by requireApproved.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { createPrismaDeepMock, makeToken, bearer } from "../helpers/integrationApp.js";

const prisma = createPrismaDeepMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma }));

const { buildApp } = await import("../../app.js");
const app = buildApp();

const token = makeToken({ sub: "user-1" });

describe("/profiles/me", () => {
  it("401 anonymous", async () => {
    const res = await request(app).get("/api/v1/profiles/me");
    expect(res.status).toBe(401);
  });

  it("404 when profile row missing", async () => {
    prisma.profile.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .get("/api/v1/profiles/me")
      .set("Authorization", bearer(token));
    expect(res.status).toBe(404);
  });

  it("200 returns profile", async () => {
    prisma.profile.findUnique.mockResolvedValueOnce({ id: "p1", userId: "user-1" } as any);
    const res = await request(app)
      .get("/api/v1/profiles/me")
      .set("Authorization", bearer(token));
    expect(res.status).toBe(200);
  });

  it("422 PATCH with bad URL", async () => {
    const res = await request(app)
      .patch("/api/v1/profiles/me")
      .set("Authorization", bearer(token))
      .send({ linkedinUrl: "ftp://nope" });
    expect(res.status).toBe(422);
  });

  it("200 PATCH upserts", async () => {
    prisma.profile.upsert.mockResolvedValueOnce({ id: "p1" } as any);
    const res = await request(app)
      .patch("/api/v1/profiles/me")
      .set("Authorization", bearer(token))
      .send({ city: "Pune" });
    expect(res.status).toBe(200);
  });
});

/**
 * A PATCH names the fields it changes. Everything it does not name has to
 * survive it: the transforms behind `updateProfileSchema` used to fold an
 * absent key into `null`, so `PATCH { showLinkedin: false }` also erased the
 * member's department, batch, birthday and every link on file.
 */
describe("/profiles/me — a partial update stays partial", () => {
  it("touches only the fields the request names", async () => {
    prisma.profile.upsert.mockResolvedValueOnce({ userId: "user-1" } as any);

    const res = await request(app)
      .patch("/api/v1/profiles/me")
      .set("Authorization", bearer(token))
      .send({ showLinkedin: false });

    expect(res.status).toBe(200);
    const data = (prisma.profile.upsert.mock.calls[0][0] as any).update;
    expect(data).toEqual({ showLinkedin: false });
    for (const untouched of [
      "department", "graduationYear", "admissionYear", "degree",
      "birthDay", "birthMonth", "linkedinUrl", "githubUrl", "twitterUrl",
      "websiteUrl", "bio", "phone", "city", "country",
    ]) {
      expect(data).not.toHaveProperty(untouched);
    }
  });

  it("still clears a field the request sends empty", async () => {
    prisma.profile.upsert.mockResolvedValueOnce({ userId: "user-1" } as any);

    await request(app)
      .patch("/api/v1/profiles/me")
      .set("Authorization", bearer(token))
      .send({ linkedinUrl: "", graduationYear: "", city: null });

    const data = (prisma.profile.upsert.mock.calls[0][0] as any).update;
    expect(data.linkedinUrl).toBeNull();
    expect(data.graduationYear).toBeNull();
    expect(data.city).toBeNull();
  });
});

describe("/profiles/:userId", () => {
  it("403 when caller is not APPROVED", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: "user-1", status: "PENDING" } as any);
    const res = await request(app)
      .get("/api/v1/profiles/u-other")
      .set("Authorization", bearer(token));
    expect(res.status).toBe(403);
  });

  it("404 when profile is missing", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: "user-1", status: "APPROVED" } as any);
    prisma.profile.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .get("/api/v1/profiles/u-other")
      .set("Authorization", bearer(token));
    expect(res.status).toBe(404);
  });

  /**
   * A member sees another member's *page*, not their row. This endpoint used to
   * answer with the whole `Profile` plus `user.email`, which made it a
   * directory of phone numbers for anyone who read the API.
   */
  it("gives a member the page fields only — no phone, birthday or email", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: "user-1", status: "APPROVED" } as any);
    prisma.profile.findUnique.mockResolvedValueOnce({ userId: "u-other", showLinkedin: true } as any);

    await request(app).get("/api/v1/profiles/u-other").set("Authorization", bearer(token));

    const args = prisma.profile.findUnique.mock.calls[0][0] as any;
    // A select, not an include: the row is opt-in field by field.
    expect(args.include).toBeUndefined();
    for (const withheld of ["phone", "birthDay", "birthMonth", "rollNumber", "admissionYear", "locationId"]) {
      expect(args.select).not.toHaveProperty(withheld);
    }
    expect(args.select.user.select.email).toBe(false);
    // What a profile page is actually for is still there.
    for (const shown of ["department", "graduationYear", "currentCompany", "bio", "experiences", "skills"]) {
      expect(args.select).toHaveProperty(shown);
    }
  });

  it("still hands an admin the whole row — they administer these accounts", async () => {
    const adminToken = makeToken({ sub: "admin-1", roles: ["ADMIN"] });
    prisma.user.findUnique.mockResolvedValueOnce({ id: "admin-1", status: "APPROVED" } as any);
    prisma.profile.findUnique.mockResolvedValueOnce({ userId: "u-other", phone: "9999" } as any);

    const res = await request(app)
      .get("/api/v1/profiles/u-other")
      .set("Authorization", bearer(adminToken));

    expect(res.status).toBe(200);
    expect((prisma.profile.findUnique.mock.calls[0][0] as any).include).toBeDefined();
    expect(res.body.phone).toBe("9999");
  });

  it("hands the owner their own row, asking about themselves", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: "user-1", status: "APPROVED" } as any);
    prisma.profile.findUnique.mockResolvedValueOnce({ userId: "user-1", phone: "8888" } as any);

    const res = await request(app).get("/api/v1/profiles/user-1").set("Authorization", bearer(token));

    expect(res.body.phone).toBe("8888");
  });

  /**
   * `showLinkedin` is the owner's veto, so it has to hold on every surface that
   * hands the link to somebody else. Honouring it only on the directory card
   * would leave this endpoint as the way around it.
   */
  it("withholds the LinkedIn link of a member who switched it off", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: "user-1", status: "APPROVED" } as any);
    prisma.profile.findUnique.mockResolvedValueOnce({
      userId: "u-other",
      linkedinUrl: "https://linkedin.com/in/rohit",
      showLinkedin: false,
    } as any);

    const res = await request(app)
      .get("/api/v1/profiles/u-other")
      .set("Authorization", bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.linkedinUrl).toBeNull();
  });

  it("still shows it to the owner, and to anyone when it is on", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "APPROVED" } as any);

    prisma.profile.findUnique.mockResolvedValueOnce({
      userId: "user-1",
      linkedinUrl: "https://linkedin.com/in/self",
      showLinkedin: false,
    } as any);
    const own = await request(app)
      .get("/api/v1/profiles/user-1")
      .set("Authorization", bearer(token));
    expect(own.body.linkedinUrl).toBe("https://linkedin.com/in/self");

    prisma.profile.findUnique.mockResolvedValueOnce({
      userId: "u-other",
      linkedinUrl: "https://linkedin.com/in/asha",
      showLinkedin: true,
    } as any);
    const other = await request(app)
      .get("/api/v1/profiles/u-other")
      .set("Authorization", bearer(token));
    expect(other.body.linkedinUrl).toBe("https://linkedin.com/in/asha");
  });
});

describe("/profiles/me/experiences & educations", () => {
  it("422 with missing fields on experience", async () => {
    const res = await request(app)
      .post("/api/v1/profiles/me/experiences")
      .set("Authorization", bearer(token))
      .send({ company: "Acme" });
    expect(res.status).toBe(422);
  });

  it("404 add experience when profile missing", async () => {
    prisma.profile.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/v1/profiles/me/experiences")
      .set("Authorization", bearer(token))
      .send({
        company: "Acme",
        title: "Eng",
        startDate: new Date().toISOString(),
      });
    expect(res.status).toBe(404);
  });

  it("422 add education with year out of range", async () => {
    const res = await request(app)
      .post("/api/v1/profiles/me/educations")
      .set("Authorization", bearer(token))
      .send({ institution: "X", degree: "BE", startYear: 1700 });
    expect(res.status).toBe(422);
  });

  it("422 setSkills with too many entries", async () => {
    const skills = Array.from({ length: 51 }, (_, i) => `s${i}`);
    const res = await request(app)
      .put("/api/v1/profiles/me/skills")
      .set("Authorization", bearer(token))
      .send({ skills });
    expect(res.status).toBe(422);
  });
});