/**
 * Integration tests for /api/v1/donations.
 *
 * The flow under test has no payment gateway: a member declares a payment they
 * made off-portal, and an admin verifies or rejects it. So what these pin is
 * the *gate* on each half — a member may file and withdraw their own claim and
 * nothing more; approving, rejecting and reading the ledger are admin-only —
 * plus the two rules that make a claim safe to accept at all (a reference is
 * mandatory, and a proof key must belong to the caller).
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { createPrismaDeepMock, makeToken, bearer } from "../helpers/integrationApp.js";

const prisma = createPrismaDeepMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma }));

const { buildApp } = await import("../../app.js");
const { invalidateSettings } = await import("../../lib/settings.js");
const app = buildApp();

const userToken = makeToken({ sub: "user-1" });
const adminToken = makeToken({ sub: "admin-1", roles: ["ADMIN"] });

beforeEach(() => {
  prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "APPROVED" } as any);
  // The settings registry caches for ten seconds; a whole suite runs inside
  // that window, so one test's payment details would otherwise be the next
  // test's.
  invalidateSettings();
});

describe("/donations/campaigns", () => {
  it("200 list returns raised amounts", async () => {
    prisma.donationCampaign.findMany.mockResolvedValueOnce([{ id: "c1" } as any]);
    prisma.donationCampaign.count.mockResolvedValueOnce(1);
    prisma.donation.groupBy.mockResolvedValueOnce([
      { campaignId: "c1", _sum: { amount: 5000 } } as any,
    ]);
    const res = await request(app)
      .get("/api/v1/donations/campaigns")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(200);
    expect(res.body.items[0].raisedAmount).toBe(5000);
  });

  it("404 single campaign missing", async () => {
    prisma.donationCampaign.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .get("/api/v1/donations/campaigns/x")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(404);
  });

  it("403 non-admin cannot create campaign", async () => {
    const res = await request(app)
      .post("/api/v1/donations/campaigns")
      .set("Authorization", bearer(userToken))
      .send({
        title: "Library Fund",
        description: "Buy new books for the library this year.",
        goalAmount: 100000,
        startsAt: new Date().toISOString(),
      });
    expect(res.status).toBe(403);
  });

  it("422 create with invalid goal amount", async () => {
    const res = await request(app)
      .post("/api/v1/donations/campaigns")
      .set("Authorization", bearer(adminToken))
      .send({
        title: "X",
        description: "shortttt",
        goalAmount: -10,
        startsAt: new Date().toISOString(),
      });
    expect(res.status).toBe(422);
  });

  it("201 admin creates a campaign", async () => {
    prisma.donationCampaign.create.mockResolvedValueOnce({ id: "c1" } as any);
    const res = await request(app)
      .post("/api/v1/donations/campaigns")
      .set("Authorization", bearer(adminToken))
      .send({
        title: "Library Fund",
        description: "Buy new books for the library this year.",
        goalAmount: 100000,
        startsAt: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
  });
});

describe("/donations — submit, verify, reject", () => {
  const validBody = (over: Record<string, unknown> = {}) => ({
    amount: 5000,
    reference: "UTR402318795412",
    paymentMethod: "UPI",
    paidAt: new Date().toISOString(),
    ...over,
  });

  /** The office has published a UPI ID; without one, submitting is refused. */
  const paymentConfigured = () =>
    prisma.appSetting.findMany.mockResolvedValue([
      { key: "donationUpiId", value: JSON.stringify("adcet@sbi") },
    ] as any);

  beforeEach(() => {
    paymentConfigured();
  });

  it("422 submit without a transaction reference — there would be nothing to verify", async () => {
    const res = await request(app)
      .post("/api/v1/donations")
      .set("Authorization", bearer(userToken))
      .send(validBody({ reference: undefined }));
    expect(res.status).toBe(422);
  });

  it("422 submit with a payment date in the future", async () => {
    const res = await request(app)
      .post("/api/v1/donations")
      .set("Authorization", bearer(userToken))
      .send(validBody({ paidAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }));
    expect(res.status).toBe(422);
  });

  it("409 when the same transaction reference has already been claimed", async () => {
    prisma.donation.findUnique.mockResolvedValueOnce({ id: "d-existing" } as any);
    const res = await request(app)
      .post("/api/v1/donations")
      .set("Authorization", bearer(userToken))
      .send(validBody());
    expect(res.status).toBe(409);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  /**
   * A proof key is `donation-proof/<ownerId>/…`. Accepting somebody else's
   * would attach their bank screenshot to this donation and hand it to an
   * admin — the key is a path, not a capability.
   */
  it("400 when the proof key belongs to another account", async () => {
    prisma.donation.findUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/v1/donations")
      .set("Authorization", bearer(userToken))
      .send(validBody({ proofKey: "donation-proof/someone-else/abc-shot.png" }));
    expect(res.status).toBe(400);
  });

  it("201 files the claim as PLEDGED — never as money", async () => {
    prisma.donation.findUnique.mockResolvedValueOnce(null);
    prisma.$transaction.mockImplementationOnce(async (fn: any) =>
      fn({
        donation: { create: jest.fn(async (args: any) => ({ id: "d1", ...args.data })) },
        donationLedgerEntry: { create: jest.fn(async () => ({})) },
      }),
    );
    const res = await request(app)
      .post("/api/v1/donations")
      .set("Authorization", bearer(userToken))
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PLEDGED");
    // Normalised on the way in, so one transfer cannot be claimed twice.
    expect(res.body.reference).toBe("UTR402318795412");
  });

  it("403 a member cannot approve their own donation", async () => {
    const res = await request(app)
      .post("/api/v1/donations/d1/approve")
      .set("Authorization", bearer(userToken))
      .send({});
    expect(res.status).toBe(403);
  });

  it("403 a member cannot reject one either", async () => {
    const res = await request(app)
      .post("/api/v1/donations/d1/reject")
      .set("Authorization", bearer(userToken))
      .send({ reason: "not mine" });
    expect(res.status).toBe(403);
  });

  it("422 an admin must say why they are rejecting — the donor is emailed it", async () => {
    const res = await request(app)
      .post("/api/v1/donations/d1/reject")
      .set("Authorization", bearer(adminToken))
      .send({ reason: "no" });
    expect(res.status).toBe(422);
  });

  /**
   * A receipted gift is money in the account and a PDF in somebody's inbox.
   * Rejecting it would archive it for deletion in 30 days.
   */
  it("400 an admin cannot reject a gift that was already verified", async () => {
    prisma.donation.findUnique.mockResolvedValueOnce({
      id: "d1",
      status: "RECEIVED",
      amount: 5000,
    } as any);
    const res = await request(app)
      .post("/api/v1/donations/d1/reject")
      .set("Authorization", bearer(adminToken))
      .send({ reason: "Cheque bounced last week." });
    expect(res.status).toBe(400);
  });

  it("403 non-admin cannot list all donations", async () => {
    const res = await request(app)
      .get("/api/v1/donations")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(403);
  });

  it("200 admin lists donations and anonymises rows flagged anonymous", async () => {
    prisma.donation.findMany.mockResolvedValueOnce([
      { id: "d1", isAnonymous: true, user: { id: "u1", firstName: "Real", lastName: "Name" } } as any,
      { id: "d2", isAnonymous: false, user: { id: "u2", firstName: "John", lastName: "Doe" } } as any,
    ]);
    prisma.donation.count.mockResolvedValueOnce(2);
    const res = await request(app)
      .get("/api/v1/donations")
      .set("Authorization", bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.items[0].user.firstName).toBe("Anonymous");
    expect(res.body.items[1].user.firstName).toBe("John");
  });

  it("403 a member cannot withdraw somebody else's submission", async () => {
    prisma.donation.findUnique.mockResolvedValueOnce({
      id: "d1",
      userId: "someone-else",
      status: "PLEDGED",
    } as any);
    const res = await request(app)
      .post("/api/v1/donations/d1/withdraw")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(403);
  });

  /** Withdrawal stops at the decision — the row now carries what they were told. */
  it("400 a member cannot withdraw once the office has decided", async () => {
    prisma.donation.findUnique.mockResolvedValueOnce({
      id: "d1",
      userId: "user-1",
      status: "REJECTED",
    } as any);
    const res = await request(app)
      .post("/api/v1/donations/d1/withdraw")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(400);
  });
});

describe("GET /donations/stats", () => {
  it("403 for a member — the ledger's totals are the office's", async () => {
    const res = await request(app)
      .get("/api/v1/donations/stats")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(403);
  });

  /**
   * The totals are a separate query precisely so they survive pagination. If
   * they ever went back to being derived from a page of rows, this is what
   * would notice: the page is empty and the totals are not.
   */
  it("reports totals over the whole filtered set, not a page of it", async () => {
    prisma.donation.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 121500 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 4000 } } as never);
    prisma.$queryRaw.mockResolvedValueOnce([{ count: BigInt(5) }] as never);
    prisma.donation.count.mockResolvedValueOnce(2);
    prisma.donation.groupBy
      .mockResolvedValueOnce([{ campaignId: "c1", _sum: { amount: 9000 }, _count: { _all: 3 } }] as never)
      .mockResolvedValueOnce([{ campaignId: "c1", _sum: { amount: 9000 } }] as never);
    prisma.donationCampaign.findMany.mockResolvedValueOnce([{ id: "c1", title: "Library" }] as never);

    const res = await request(app)
      .get("/api/v1/donations/stats")
      .set("Authorization", bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalReceived: 121500,
      thisMonthReceived: 4000,
      // A bigint from COUNT(DISTINCT) has to reach JSON as a number.
      donorCount: 5,
      pendingCount: 2,
      byCampaign: [{ campaignId: "c1", title: "Library", received: 9000, count: 3 }],
    });
  });

  /**
   * The card counts what still needs deciding. An admin who has filtered the
   * ledger to RECEIVED must still see submissions piling up behind them.
   */
  it("counts pending submissions regardless of the status filter", async () => {
    prisma.donation.aggregate.mockResolvedValue({ _sum: { amount: 0 } } as never);
    prisma.$queryRaw.mockResolvedValue([{ count: BigInt(0) }] as never);
    prisma.donation.count.mockResolvedValue(7);
    prisma.donation.groupBy.mockResolvedValue([] as never);
    prisma.donationCampaign.findMany.mockResolvedValue([] as never);

    const res = await request(app)
      .get("/api/v1/donations/stats?status=RECEIVED")
      .set("Authorization", bearer(adminToken));

    expect(res.body.pendingCount).toBe(7);
    const countWhere = (prisma.donation.count.mock.calls.at(-1)![0] as { where: Record<string, unknown> }).where;
    expect(countWhere.status).toBe("PLEDGED");
  });
});

describe("GET /donations/payment-details", () => {
  it("reports configured:false until the office publishes a way to pay", async () => {
    prisma.appSetting.findMany.mockResolvedValueOnce([]);
    const res = await request(app)
      .get("/api/v1/donations/payment-details")
      .set("Authorization", bearer(userToken));
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });

  it("401 without a session — this is where the money goes, not public copy", async () => {
    const res = await request(app).get("/api/v1/donations/payment-details");
    expect(res.status).toBe(401);
  });
});

/**
 * The one donations route with no session in front of it. It must answer
 * anonymously, cap what an anonymous caller can ask for, and hand back names
 * and totals only — never an email or a donation id.
 */
describe("GET /donations/public/top-donors", () => {
  beforeEach(() => {
    prisma.donation.groupBy.mockResolvedValue([{ userId: "u-1", _sum: { amount: 250000 } }] as any);
    prisma.user.findMany.mockResolvedValue([
      { id: "u-1", firstName: "Alice", lastName: "Patil", profile: { avatarKey: null, graduationYear: 2020 } },
    ] as any);
  });

  it("200s without a token", async () => {
    const res = await request(app).get("/api/v1/donations/public/top-donors?limit=12");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { id: "u-1", name: "Alice Patil", amount: 250000, avatarKey: null, graduationYear: 2020 },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/@|email/i);
  });

  it("422s a limit beyond the cap, so the ledger can't be paged anonymously", async () => {
    const res = await request(app).get("/api/v1/donations/public/top-donors?limit=500");
    expect(res.status).toBe(422);
  });
});
