/**
 * Integration tests for the Auth module.
 *
 * Exercises the full Route → Middleware → Controller → Service flow with a
 * mocked Prisma client. Covers:
 *   - Validation (422) for malformed bodies
 *   - Success paths for register / login / refresh / logout / me
 *   - Bad credentials, unique-constraint conflicts, expired/invalid tokens
 *   - social sign-in being gone (the /auth/oauth/* routes 404)
 *   - Rate limiter does NOT swallow normal traffic in the test env
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { createPrismaDeepMock } from "../helpers/integrationApp.js";

const prisma = createPrismaDeepMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma }));

/** The sign-up document upload is the one auth path that touches storage. */
const uploadMock = jest.fn(async (input: { ownerId: string; fileName: string }) => ({
  key: `identity/${input.ownerId}/${input.fileName}`,
  publicUrl: "",
}));
jest.unstable_mockModule("../../storage/index.js", () => ({
  getStorage: () => ({ upload: uploadMock, delete: jest.fn(async () => undefined) }),
}));

const { hashPassword } = await import("../../lib/password.js");
const { signRefreshToken, hashToken } = await import("../../lib/jwt.js");
const { buildApp } = await import("../../app.js");
const app = buildApp();

const baseUser = (overrides: any = {}) => ({
  id: "user-1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "A",
  passwordHash: "to-be-set",
  status: "PENDING",
  rejectionReason: null,
  roles: [{ role: "ALUMNI" }],
  ...overrides,
});

const OTP = "123456";
const DOC_ID = "11111111-2222-4333-8444-555555555555";

/**
 * The sign-up identity document, already uploaded and waiting to be claimed.
 *
 * Every registration consumes one, so the happy path is the default here and
 * the tests that care about the claim override it. `updateMany` returning 1 is
 * the claim succeeding — the conditional update *is* the single-use guarantee.
 */
const identityDocumentIsClaimable = () => {
  prisma.pendingIdentityDocument.updateMany.mockResolvedValue({ count: 1 } as never);
  prisma.pendingIdentityDocument.findUnique.mockResolvedValue({
    id: DOC_ID,
    objectKey: `identity/${DOC_ID}/marksheet.jpg`,
  } as never);
};
beforeEach(identityDocumentIsClaimable);

/**
 * A complete, valid sign-up body. Sign-up requires a full profile (department,
 * degree, graduation year, birthday, phone, city, company, role), so tests
 * build from this and override or delete only the field under test — otherwise
 * an unrelated missing field would 422 before the assertion's code path runs.
 */
const registerBody = (overrides: Record<string, unknown> = {}) => ({
  email: "alice@example.com",
  password: "Strong#Pass1",
  otp: OTP,
  firstName: "Alice",
  lastName: "A",
  department: "Computer Science and Engineering",
  degree: "BE",
  graduationYear: 2020,
  birthDay: 14,
  birthMonth: 3,
  phone: "+91 9876543210",
  city: "Pune",
  currentCompany: "Infosys",
  currentRole: "SDE-2",
  linkedinUrl: "https://linkedin.com/in/alice",
  identityDocumentId: DOC_ID,
  ...overrides,
});

/** A profile with every mandatory field set — `profileComplete` should be true. */
const fullProfile = (overrides: Record<string, unknown> = {}) => ({
  department: "Computer Science and Engineering",
  degree: "BE",
  graduationYear: 2020,
  admissionYear: 2016,
  birthDay: 14,
  birthMonth: 3,
  phone: "+91 9876543210",
  city: "Pune",
  currentCompany: "Infosys",
  currentRole: "SDE-2",
  linkedinUrl: "https://linkedin.com/in/alice",
  identityDocumentId: DOC_ID,
  ...overrides,
});

const baseOtpRow = (overrides: any = {}) => ({
  id: "otp-1",
  email: "alice@example.com",
  codeHash: hashToken(OTP),
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  attempts: 0,
  createdAt: new Date(),
  ...overrides,
});

describe("POST /api/v1/auth/register/send-otp", () => {
  it("422 with a malformed email", async () => {
    const res = await request(app).post("/api/v1/auth/register/send-otp").send({ email: "nope" });
    expect(res.status).toBe(422);
  });

  it("409 when the email is already registered", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(baseUser() as any);
    const res = await request(app)
      .post("/api/v1/auth/register/send-otp")
      .send({ email: "alice@example.com" });
    expect(res.status).toBe(409);
  });

  it("202 issues a code and invalidates previous ones", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.deleteMany.mockResolvedValueOnce({ count: 1 } as any);
    prisma.emailVerificationOtp.create.mockResolvedValueOnce(baseOtpRow() as any);
    const res = await request(app)
      .post("/api/v1/auth/register/send-otp")
      .send({ email: "alice@example.com" });
    expect(res.status).toBe(202);
    expect(prisma.emailVerificationOtp.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "alice@example.com" }) }),
    );
  });
});

/**
 * The proof-of-study upload is the only endpoint in the application that
 * accepts bytes with no session behind it — sign-up collects the document
 * before the email is verified, which is before there is an account to own it.
 * These pin the four things that keep that from being an open door: the type
 * and the size are checked against what actually arrived, an empty body is
 * refused, and the caller is told an id rather than where the file went.
 */
describe("POST /api/v1/auth/register/identity-document", () => {
  const upload = (body: Buffer, contentType: string, fileName = "marksheet.jpg") =>
    request(app)
      .post(`/api/v1/auth/register/identity-document?fileName=${encodeURIComponent(fileName)}`)
      .set("Content-Type", contentType)
      .send(body);

  beforeEach(() => {
    prisma.pendingIdentityDocument.create.mockResolvedValue({ id: DOC_ID } as never);
    prisma.pendingIdentityDocument.update.mockResolvedValue({} as never);
  });

  it("201s without a session, and answers with an id — never a key", async () => {
    const res = await upload(Buffer.from("jpeg-bytes"), "image/jpeg");

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ documentId: DOC_ID });
    // Knowing where the file went would let a caller reach it directly; the id
    // is worth exactly one claim and nothing else.
    expect(JSON.stringify(res.body)).not.toMatch(/identity\//);
  });

  it("stores it under the private identity scope", async () => {
    await upload(Buffer.from("jpeg-bytes"), "image/jpeg");
    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "identity", contentType: "image/jpeg" }),
    );
  });

  it("400s a file type that is neither an image nor a PDF", async () => {
    const res = await upload(Buffer.from("MZ\x90\x00"), "application/x-msdownload", "run.exe");
    expect(res.status).toBe(400);
    expect(prisma.pendingIdentityDocument.create).not.toHaveBeenCalled();
  });

  it("400s an empty body", async () => {
    const res = await upload(Buffer.alloc(0), "image/png");
    expect(res.status).toBe(400);
  });

  /** There is no declared size to trust here — only the bytes that arrived. */
  it("400s a file over the scope's ceiling", async () => {
    const tooBig = Buffer.alloc(11 * 1024 * 1024, 1);
    const res = await upload(tooBig, "image/png");
    expect(res.status).toBe(400);
  });

  it("accepts a PDF", async () => {
    const res = await upload(Buffer.from("%PDF-1.4"), "application/pdf", "degree.pdf");
    expect(res.status).toBe(201);
  });

  /** Browsers append a charset; the check must not be defeated by one. */
  it("ignores a charset parameter on the content type", async () => {
    const res = await upload(Buffer.from("bytes"), "image/jpeg; charset=binary");
    expect(res.status).toBe(201);
  });
});

describe("POST /api/v1/auth/register", () => {
  it("422 when required fields are missing", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({ email: "bad" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNPROCESSABLE");
  });

  it("201 + tokens on first-time registration with a valid OTP", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    const res = await request(app).post("/api/v1/auth/register").send(registerBody());
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("alice@example.com");
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  /**
   * Privilege escalation. `registerSchema` has no `role` field, so a `role` in
   * the body is an unknown key Zod drops, and `register()` hardcodes ALUMNI.
   * Neither an outright "ADMIN" nor one of the two roles that used to be
   * accepted may reach the UserRole row that gets created.
   */
  it.each(["ADMIN", "STUDENT", "RECRUITER", "alumni"])(
    "ignores a client-supplied role of %s and always creates an ALUMNI",
    async (role) => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
      prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
      prisma.user.create.mockResolvedValueOnce(baseUser() as any);
      prisma.refreshToken.create.mockResolvedValueOnce({} as any);

      const res = await request(app).post("/api/v1/auth/register").send(registerBody({ role }));

      expect(res.status).toBe(201);
      expect(res.body.user.roles).toEqual(["ALUMNI"]);
      const created = (prisma.user.create as any).mock.calls.at(-1)[0];
      expect(created.data.roles).toEqual({ create: { role: "ALUMNI" } });
    },
  );

  it("registers as PENDING so a new account has no access before approval", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    // A status in the body must be ignored the same way a role is.
    await request(app).post("/api/v1/auth/register").send(registerBody({ status: "APPROVED" }));

    const created = (prisma.user.create as any).mock.calls.at(-1)[0];
    expect(created.data.status).toBe("PENDING");
  });

  it("derives admissionYear from the graduation year and the degree's length", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    // B.E. is a 4-year course, so graduating in 2020 implies admission in 2016.
    await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ degree: "BE", graduationYear: 2020 }));

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profile: {
            create: expect.objectContaining({ admissionYear: 2016, graduationYear: 2020 }),
          },
        }),
      }),
    );
  });

  it("derives a 2-year gap for a master's degree", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ degree: "ME", graduationYear: 2020 }));

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profile: { create: expect.objectContaining({ admissionYear: 2018 }) },
        }),
      }),
    );
  });

  it("stores the birthday as day + month, never a year", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ birthDay: 14, birthMonth: 3 }));

    const created = (prisma.user.create as any).mock.calls[0][0].data.profile.create;
    expect(created).toMatchObject({ birthDay: 14, birthMonth: 3 });
    expect(created).not.toHaveProperty("birthYear");
  });

  it("422 when the OTP is missing", async () => {
    const body = registerBody();
    delete (body as any).otp;
    const res = await request(app).post("/api/v1/auth/register").send(body);
    expect(res.status).toBe(422);
  });

  it.each([
    "department",
    "degree",
    "graduationYear",
    "birthDay",
    "birthMonth",
    "phone",
    "city",
    "currentCompany",
    "currentRole",
    // LinkedIn is deliberately absent: it stopped being mandatory when sign-up
    // began asking for a document instead. `identityDocumentId` took its place.
    "identityDocumentId",
  ])("422 when the mandatory field %s is missing", async (field) => {
    const body = registerBody();
    delete (body as any)[field];
    const res = await request(app).post("/api/v1/auth/register").send(body);
    expect(res.status).toBe(422);
  });

  it("422 when a mandatory text field is only whitespace", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ city: "   ", currentCompany: "  " }));
    expect(res.status).toBe(422);
  });

  it("422 on an impossible birth date", async () => {
    // 31 April doesn't exist.
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ birthMonth: 4, birthDay: 31 }));
    expect(res.status).toBe(422);
  });

  it("accepts 29 February — a real birthday, just not every year", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ birthMonth: 2, birthDay: 29 }));
    expect(res.status).toBe(201);
  });

  it("400 when the OTP is wrong (and the attempt is counted)", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    const res = await request(app).post("/api/v1/auth/register").send(registerBody({ otp: "999999" }));
    expect(res.status).toBe(400);
    expect(prisma.emailVerificationOtp.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: { increment: 1 } } }),
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("400 when the OTP has expired", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(
      baseOtpRow({ expiresAt: new Date(Date.now() - 1000) }) as any,
    );
    const res = await request(app).post("/api/v1/auth/register").send(registerBody());
    expect(res.status).toBe(400);
  });

  it("400 after too many incorrect attempts", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow({ attempts: 5 }) as any);
    const res = await request(app).post("/api/v1/auth/register").send(registerBody());
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Too many/);
  });

  it("422 on a rejected degree — ADCET awards B.E./B.Tech and M.E./M.Tech only", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(registerBody({ degree: "PHD" }));
    expect(res.status).toBe(422);
  });

  it("accepts a near-future graduation year (final-year students sign up early)", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ graduationYear: new Date().getFullYear() + 1 }));
    expect(res.status).toBe(201);
  });

  it("422 when graduationYear is far in the future (a typo, not a student)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ graduationYear: new Date().getFullYear() + 20 }));
    expect(res.status).toBe(422);
  });

  it("409 when the email is already registered", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(baseUser() as any);
    const res = await request(app).post("/api/v1/auth/register").send(registerBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("treats a differently-cased email as the same account", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(baseUser() as any);
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ email: "  ALICE@Example.COM  " }));

    // Lowercased at the validator boundary, so the duplicate check sees it.
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "alice@example.com" } }),
    );
    expect(res.status).toBe(409);
  });

  it("409 when the database rejects a duplicate email that raced past the check", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.22.0",
      }),
    );
    const res = await request(app).post("/api/v1/auth/register").send(registerBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("500 when Prisma throws an unexpected DB failure", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(
      baseOtpRow({ email: "bob@example.com" }) as any,
    );
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockRejectedValueOnce(new Error("DB down"));
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ email: "bob@example.com", firstName: "Bob", lastName: "B" }));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
  });
});

/**
 * One uploaded document belongs to one account. The claim is a conditional
 * `updateMany` on `claimedAt`, so the database arbitrates a race rather than a
 * read-then-write in the service — these pin what the outcome has to be.
 */
describe("the identity document is single-use", () => {
  const registerWithOtp = () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(baseOtpRow() as any);
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    return request(app).post("/api/v1/auth/register").send(registerBody());
  };

  it("writes the claimed document's key onto the new profile", async () => {
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    const res = await registerWithOtp();

    expect(res.status).toBe(201);
    const profile = (prisma.user.create.mock.calls[0][0] as any).data.profile.create;
    expect(profile.identityDocumentKey).toBe(`identity/${DOC_ID}/marksheet.jpg`);
  });

  /** A second registration with the same id loses the race, and is told so. */
  it("400s a document that has already been claimed", async () => {
    prisma.pendingIdentityDocument.updateMany.mockResolvedValue({ count: 0 } as never);

    const res = await registerWithOtp();

    expect(res.status).toBe(400);
    // Nothing was created — the account must not exist without its evidence.
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  /**
   * The claim only matches rows inside the retention window, so an id from an
   * upload the cleanup job has not reached yet is still refused.
   */
  it("scopes the claim to unclaimed rows inside the retention window", async () => {
    prisma.user.create.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    await registerWithOtp();

    const where = (prisma.pendingIdentityDocument.updateMany.mock.calls.at(-1)![0] as any).where;
    expect(where.id).toBe(DOC_ID);
    expect(where.claimedAt).toBeNull();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  /** The OTP is spent first: a replayed code must not buy a second attempt. */
  it("consumes the OTP before claiming the document", async () => {
    prisma.pendingIdentityDocument.updateMany.mockResolvedValue({ count: 0 } as never);

    await registerWithOtp();

    expect(prisma.emailVerificationOtp.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consumedAt: expect.any(Date) }) }),
    );
  });
});

describe("POST /api/v1/auth/login", () => {
  it("422 when body is malformed", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: "no-at" });
    expect(res.status).toBe(422);
  });

  it("401 when the email is unknown", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "ghost@example.com", password: "whatever" });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/Invalid credentials/);
  });

  it("401 when the password is wrong", async () => {
    const passwordHash = await hashPassword("CorrectPassword#1");
    prisma.user.findUnique.mockResolvedValueOnce(baseUser({ passwordHash }) as any);
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "alice@example.com", password: "WrongPassword#1" });
    expect(res.status).toBe(401);
  });

  it("200 + tokens on success, lastLoginAt is updated", async () => {
    const passwordHash = await hashPassword("Strong#Pass1");
    prisma.user.findUnique.mockResolvedValueOnce(baseUser({ passwordHash }) as any);
    prisma.user.update.mockResolvedValueOnce({} as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "alice@example.com", password: "Strong#Pass1" });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
  });
});

describe("POST /api/v1/auth/refresh", () => {
  it("422 if refreshToken missing", async () => {
    const res = await request(app).post("/api/v1/auth/refresh").send({});
    expect(res.status).toBe(422);
  });

  it("401 when the token signature is invalid", async () => {
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "totally.not.a.jwt" });
    expect(res.status).toBe(401);
  });

  it("401 when the token row was revoked", async () => {
    const token = signRefreshToken("user-1");
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: "rt-1",
      userId: "user-1",
      tokenHash: hashToken(token),
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    const res = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: token });
    expect(res.status).toBe(401);
  });

  it("200 + rotated tokens on success", async () => {
    const token = signRefreshToken("user-1");
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: "rt-1",
      userId: "user-1",
      tokenHash: hashToken(token),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    prisma.user.findUnique.mockResolvedValueOnce(baseUser() as any);
    prisma.refreshToken.update.mockResolvedValueOnce({} as any);
    prisma.refreshToken.create.mockResolvedValueOnce({} as any);

    const res = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: token });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).not.toBe(token);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("204 even if the token is unknown (idempotent)", async () => {
    prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 } as any);
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refreshToken: "x".repeat(20) });
    expect(res.status).toBe(204);
  });
});

describe("GET /api/v1/auth/me", () => {
  it("401 without a bearer token", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
  });

  it("401 with an obviously invalid token", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
  });

  it("200 returns the public user payload", async () => {
    const { signAccessToken } = await import("../../lib/jwt.js");
    const access = signAccessToken({
      sub: "user-1",
      email: "alice@example.com",
      roles: ["ALUMNI"],
    });
    prisma.user.findUnique.mockResolvedValueOnce(baseUser() as any);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${access}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("alice@example.com");
  });

  it("reports profileComplete false for an account with an empty profile", async () => {
    const { signAccessToken } = await import("../../lib/jwt.js");
    const access = signAccessToken({ sub: "user-1", email: "alice@example.com", roles: ["ALUMNI"] });
    // What an account with an unfilled profile row looks like.
    prisma.user.findUnique.mockResolvedValueOnce(baseUser({ profile: {} }) as any);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${access}`);
    expect(res.body.profileComplete).toBe(false);
  });

  it("reports profileComplete true once every mandatory field is set", async () => {
    const { signAccessToken } = await import("../../lib/jwt.js");
    const access = signAccessToken({ sub: "user-1", email: "alice@example.com", roles: ["ALUMNI"] });
    prisma.user.findUnique.mockResolvedValueOnce(baseUser({ profile: fullProfile() }) as any);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${access}`);
    expect(res.body.profileComplete).toBe(true);
  });
});

describe("POST /api/v1/auth/complete-profile", () => {
  const tokenFor = async (sub = "user-1") => {
    const { signAccessToken } = await import("../../lib/jwt.js");
    return signAccessToken({ sub, email: "alice@example.com", roles: ["ALUMNI"] });
  };

  /** The mandatory profile, minus the credential fields sign-up also collects. */
  const completeBody = (overrides: Record<string, unknown> = {}) => {
    const body: Record<string, unknown> = { ...registerBody() };
    for (const credentialField of ["email", "password", "otp", "firstName", "lastName"]) {
      delete body[credentialField];
    }
    return { ...body, ...overrides };
  };

  it("401 without a bearer token", async () => {
    const res = await request(app).post("/api/v1/auth/complete-profile").send(completeBody());
    expect(res.status).toBe(401);
  });

  it("422 when a mandatory field is missing", async () => {
    const body = completeBody();
    delete (body as any).department;
    const res = await request(app)
      .post("/api/v1/auth/complete-profile")
      .set("Authorization", `Bearer ${await tokenFor()}`)
      .send(body);
    expect(res.status).toBe(422);
  });

  it("fills the profile, derives admissionYear, and reports it complete", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(baseUser({ profile: {} }) as any);
    prisma.profile.upsert.mockResolvedValueOnce(fullProfile() as any);

    const res = await request(app)
      .post("/api/v1/auth/complete-profile")
      .set("Authorization", `Bearer ${await tokenFor()}`)
      .send(completeBody({ degree: "BE", graduationYear: 2020 }));

    expect(res.status).toBe(200);
    expect(res.body.profileComplete).toBe(true);
    expect(prisma.profile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        update: expect.objectContaining({ admissionYear: 2016, graduationYear: 2020 }),
      }),
    );
  });

  it("leaves the account PENDING — completing a profile is not approval", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(baseUser({ status: "PENDING", profile: {} }) as any);
    prisma.profile.upsert.mockResolvedValueOnce(fullProfile() as any);

    const res = await request(app)
      .post("/api/v1/auth/complete-profile")
      .set("Authorization", `Bearer ${await tokenFor()}`)
      .send(completeBody());

    expect(res.body.status).toBe("PENDING");
    // Nothing here may touch the approval status.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("422 on a department outside the official list", async () => {
    const res = await request(app)
      .post("/api/v1/auth/complete-profile")
      .set("Authorization", `Bearer ${await tokenFor()}`)
      .send(completeBody({ department: "CSE" }));
    expect(res.status).toBe(422);
  });
});

/**
 * Social sign-in is gone — Google, LinkedIn and GitHub were removed along with
 * the `OAuthAccount` table. This is what stops the routes coming back by
 * accident: a re-added provider registry would make these 404s into redirects.
 */
describe("social sign-in is removed", () => {
  it.each([
    "/api/v1/auth/oauth/google",
    "/api/v1/auth/oauth/linkedin",
    "/api/v1/auth/oauth/github",
    "/api/v1/auth/oauth/google/callback",
  ])("404 for %s", async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
  });

  it("email + password is the only way in", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({});
    // 422 (validation), not 404 — the password route is still there.
    expect(res.status).toBe(422);
  });
});

describe("Prisma error mapping", () => {
  it("P2002 unique-constraint surfaces as 409 via the error handler", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.emailVerificationOtp.findFirst.mockResolvedValueOnce(
      baseOtpRow({ email: "dup@example.com" }) as any,
    );
    prisma.emailVerificationOtp.update.mockResolvedValueOnce({} as any);
    prisma.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["email"] },
      }),
    );
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send(registerBody({ email: "dup@example.com", firstName: "Dup", lastName: "Lic" }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });
});
describe("Password reset & change flows", () => {
  it("202 forgot-password for any email (no enumeration)", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null as any);
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "unknown@example.com" });
    expect(res.status).toBe(202);
  });

  it("422 forgot-password with a malformed email", async () => {
    const res = await request(app).post("/api/v1/auth/forgot-password").send({ email: "nope" });
    expect(res.status).toBe(422);
  });

  it("400 reset-password with an invalid/expired token", async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValueOnce(null as any);
    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "0123456789abcdef", newPassword: "NewStrong#1" });
    expect(res.status).toBe(400);
  });

  it("422 reset-password with a too-short password", async () => {
    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "0123456789abcdef", newPassword: "short" });
    expect(res.status).toBe(422);
  });

  it("401 change-password without a bearer token", async () => {
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .send({ currentPassword: "x", newPassword: "NewStrong#1" });
    expect(res.status).toBe(401);
  });

  it("400 change-password with an incorrect current password", async () => {
    const { signAccessToken } = await import("../../lib/jwt.js");
    const access = signAccessToken({ sub: "user-1", email: "alice@example.com", roles: ["ALUMNI"] });
    prisma.user.findUnique.mockResolvedValueOnce({ id: "user-1", passwordHash: "$2a$12$invalidhashvalue" } as any);
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${access}`)
      .send({ currentPassword: "wrong", newPassword: "NewStrong#1" });
    expect(res.status).toBe(400);
  });
});
