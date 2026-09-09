/**
 * Branch coverage for the donations service.
 *
 * The rules worth pinning here all follow from there being no payment gateway:
 * a submission is a claim (so it lands PLEDGED, never money), one transaction
 * reference belongs to one gift, a proof key is not a capability, and only an
 * admin's approval mints a receipt. The campaign filters and the public honour
 * roll are the same as before and pinned the same way.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../../lib/prisma.js", () => ({ prisma: prismaMock }));

const sendEmail = jest.fn(async () => ({}) as never);
jest.unstable_mockModule("../../../lib/mailer.js", () => ({ sendEmail }));
jest.unstable_mockModule("../../../lib/receipt.js", () => ({
  generateReceiptPdf: jest.fn(async () => Buffer.from("%PDF-1.4")),
}));
const storageMock = { upload: jest.fn(async () => ({ key: "receipt/u-9/r.pdf" })), delete: jest.fn(async () => undefined) };
jest.unstable_mockModule("../../../storage/index.js", () => ({ getStorage: () => storageMock }));

const svc = await import("../../../modules/donations/donations.service.js");
const { invalidateSettings } = await import("../../../lib/settings.js");

/** The office has published a UPI ID, so submissions are accepted. */
const paymentConfigured = () =>
  prismaMock.appSetting.findMany.mockResolvedValue([
    { key: "donationUpiId", value: JSON.stringify("adcet@sbi") },
  ]);

beforeEach(() => {
  Object.values(prismaMock).forEach((m: any) =>
    m && typeof m === "object" ? Object.values(m).forEach((fn: any) => fn?.mockReset?.()) : null,
  );
  sendEmail.mockClear();
  // The registry caches for ten seconds — longer than this whole file runs.
  invalidateSettings();
  paymentConfigured();
});

describe("donations.service — listCampaigns", () => {
  it("no filters → empty where, no groupBy when there are no campaigns", async () => {
    prismaMock.donationCampaign.findMany.mockResolvedValueOnce([]);
    prismaMock.donationCampaign.count.mockResolvedValueOnce(0);
    const out = await svc.listCampaigns({ page: 1, pageSize: 10 } as any);
    expect(prismaMock.donation.groupBy).not.toHaveBeenCalled();
    expect(out.items).toEqual([]);
  });

  it("active=true forwards isActive filter and merges raisedAmount per campaign", async () => {
    prismaMock.donationCampaign.findMany.mockResolvedValueOnce([
      { id: "c-1" },
      { id: "c-2" },
    ]);
    prismaMock.donationCampaign.count.mockResolvedValueOnce(2);
    prismaMock.donation.groupBy.mockResolvedValueOnce([
      { campaignId: "c-1", _sum: { amount: 1000 } },
      { campaignId: "c-2", _sum: { amount: null } }, // null branch → 0
    ]);
    const out = await svc.listCampaigns({ page: 1, pageSize: 10, active: true } as any);
    const findArg = prismaMock.donationCampaign.findMany.mock.calls[0][0] as any;
    expect(findArg.where.isActive).toBe(true);
    expect(out.items[0].raisedAmount).toBe(1000);
    expect(out.items[1].raisedAmount).toBe(0);
  });
});

describe("donations.service — getCampaign", () => {
  it("404 when not found", async () => {
    prismaMock.donationCampaign.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getCampaign("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("returns 0 raised when aggregate is empty", async () => {
    prismaMock.donationCampaign.findUnique.mockResolvedValueOnce({ id: "c-1" });
    prismaMock.donation.aggregate.mockResolvedValueOnce({ _sum: { amount: null }, _count: 0 });
    const out = await svc.getCampaign("c-1");
    expect(out.raisedAmount).toBe(0);
    expect(out.donorCount).toBe(0);
  });

  it("forwards aggregated values when present", async () => {
    prismaMock.donationCampaign.findUnique.mockResolvedValueOnce({ id: "c-1" });
    prismaMock.donation.aggregate.mockResolvedValueOnce({ _sum: { amount: 250 }, _count: 3 });
    const out = await svc.getCampaign("c-1");
    expect(out).toMatchObject({ raisedAmount: 250, donorCount: 3 });
  });
});

describe("donations.service — listDonations", () => {
  it("anonymises donations flagged isAnonymous=true and keeps others intact", async () => {
    prismaMock.donation.findMany.mockResolvedValueOnce([
      { id: "d-1", isAnonymous: true, user: { id: "u-1", firstName: "Alice", lastName: "A" } },
      { id: "d-2", isAnonymous: false, user: { id: "u-2", firstName: "Bob", lastName: "B" } },
    ]);
    prismaMock.donation.count.mockResolvedValueOnce(2);
    const out = await svc.listDonations({ page: 1, pageSize: 10 } as any);
    expect(out.items[0].user).toEqual({ id: null, firstName: "Anonymous", lastName: "" });
    expect(out.items[1].user.firstName).toBe("Bob");
  });

  it("forwards campaignId / status filters", async () => {
    prismaMock.donation.findMany.mockResolvedValueOnce([]);
    prismaMock.donation.count.mockResolvedValueOnce(0);
    await svc.listDonations({ page: 1, pageSize: 10, campaignId: "c-1", status: "RECEIVED" } as any);
    const where = (prismaMock.donation.findMany.mock.calls[0][0] as any).where;
    expect(where).toEqual({ campaignId: "c-1", status: "RECEIVED" });
  });
});

describe("donations.service — submit", () => {
  const donor = { id: "u-9", firstName: "Alice", lastName: "A", email: "alice@adcet.in" };
  const input = (over: Record<string, unknown> = {}) => ({
    amount: 5000,
    reference: "UTR402318795412",
    paymentMethod: "UPI" as const,
    paidAt: new Date(Date.now() - 86_400_000),
    ...over,
  });

  /** Runs the create transaction against the same mock the service would get. */
  const runTx = () =>
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));

  it("files the claim as PLEDGED with the donor snapshot and the reference", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(donor);
    prismaMock.donation.findUnique.mockResolvedValueOnce(null);
    prismaMock.donation.create.mockResolvedValueOnce({ id: "d-1", amount: 5000 });
    prismaMock.donationLedgerEntry.create.mockResolvedValueOnce({});
    runTx();

    await svc.submit("u-9", input({ message: "For the library" }));

    const created = (prismaMock.donation.create.mock.calls[0][0] as any).data;
    expect(created).toMatchObject({
      userId: "u-9",
      // A claim, never money — only `approve` may change this.
      status: "PLEDGED",
      reference: "UTR402318795412",
      paymentMethod: "UPI",
      donorName: "Alice A",
      donorEmail: "alice@adcet.in",
    });
    expect(created.receiptNo).toBeUndefined();
  });

  /**
   * The acknowledgement is the one thing standing between a donor and the
   * belief that the portal has their money.
   */
  it("emails an acknowledgement that is explicitly not a receipt", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(donor);
    prismaMock.donation.findUnique.mockResolvedValueOnce(null);
    prismaMock.donation.create.mockResolvedValueOnce({ id: "d-1", amount: 5000 });
    prismaMock.donationLedgerEntry.create.mockResolvedValueOnce({});
    runTx();

    await svc.submit("u-9", input());

    const mail = sendEmail.mock.calls[0][0] as any;
    expect(mail.to).toBe("alice@adcet.in");
    expect(mail.text).toMatch(/not a receipt/i);
    expect(mail.attachments).toBeUndefined();
  });

  it("409s a transaction reference somebody has already claimed", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(donor);
    prismaMock.donation.findUnique.mockResolvedValueOnce({ id: "d-existing" });

    await expect(svc.submit("u-9", input())).rejects.toMatchObject({ status: 409 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  /**
   * A proof key is `donation-proof/<ownerId>/…` — a path, not a capability.
   * Taking one at face value would attach another member's bank screenshot to
   * this donation and hand it to the verifying admin.
   */
  it("refuses a proof key belonging to another account", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(donor);
    prismaMock.donation.findUnique.mockResolvedValueOnce(null);

    await expect(
      svc.submit("u-9", input({ proofKey: "donation-proof/someone-else/x.png" })),
    ).rejects.toMatchObject({ status: 400 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to take a claim before the office has published a way to pay", async () => {
    prismaMock.appSetting.findMany.mockResolvedValue([]);
    invalidateSettings();
    prismaMock.user.findUnique.mockResolvedValueOnce(donor);

    await expect(svc.submit("u-9", input())).rejects.toMatchObject({ status: 400 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  describe("campaign selection", () => {
    const openCampaign = (over: Record<string, unknown> = {}) => ({
      id: "c-1",
      title: "Laboratory Modernisation Drive",
      isActive: true,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      ...over,
    });

    const submitFor = (campaignId?: string) => {
      prismaMock.user.findUnique.mockResolvedValueOnce(donor);
      prismaMock.donation.findUnique.mockResolvedValueOnce(null);
      prismaMock.donation.create.mockResolvedValueOnce({ id: "d-1", amount: 5000 });
      prismaMock.donationLedgerEntry.create.mockResolvedValueOnce({});
      runTx();
      return svc.submit("u-9", input({ campaignId }));
    };

    it("records the chosen campaign on the donation", async () => {
      prismaMock.donationCampaign.findUnique.mockResolvedValueOnce(openCampaign());
      await submitFor("c-1");

      const created = (prismaMock.donation.create.mock.calls[0][0] as any).data;
      expect(created.campaignId).toBe("c-1");
      // The ledger note names the cause, so reconciliation doesn't need a join.
      const note = (prismaMock.donationLedgerEntry.create.mock.calls[0][0] as any).data.note;
      expect(note).toContain("Laboratory Modernisation Drive");
    });

    it("treats an omitted campaign as a general-fund gift", async () => {
      await submitFor(undefined);
      const created = (prismaMock.donation.create.mock.calls[0][0] as any).data;
      expect(created.campaignId).toBeNull();
      expect(prismaMock.donationCampaign.findUnique).not.toHaveBeenCalled();
    });

    it("404s on a campaign that does not exist", async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce(donor);
      prismaMock.donationCampaign.findUnique.mockResolvedValueOnce(null);
      await expect(svc.submit("u-9", input({ campaignId: "gone" }))).rejects.toMatchObject({
        status: 404,
      });
    });

    it.each([
      ["archived", { isActive: false }],
      ["not yet open", { startsAt: new Date(Date.now() + 86_400_000) }],
      ["already closed", { endsAt: new Date(Date.now() - 86_400_000) }],
      ])("refuses a campaign that is %s, and files nothing", async (_label, over) => {
      prismaMock.user.findUnique.mockResolvedValueOnce(donor);
      prismaMock.donationCampaign.findUnique.mockResolvedValueOnce(openCampaign(over));

      await expect(
        svc.submit("u-9", input({ campaignId: "c-1" })),
      ).rejects.toMatchObject({ status: 400 });

      expect(prismaMock.donation.create).not.toHaveBeenCalled();
    });
  });
});

describe("donations.service — approve", () => {
  const pledged = (over: Record<string, unknown> = {}) => ({
    id: "d-1",
    userId: "u-9",
    amount: 5000,
    currency: "INR",
    status: "PLEDGED",
    reference: "UTR402318795412",
    paymentMethod: "UPI",
    paidAt: new Date(),
    createdAt: new Date("2026-03-01"),
    receiptNo: null,
    donorName: "Alice A",
    donorEmail: "alice@adcet.in",
    ...over,
  });

  const runApprove = (row: Record<string, unknown>) => {
    prismaMock.donation.findUnique.mockResolvedValueOnce(row);
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.donation.update.mockResolvedValue({ ...row, status: "RECEIVED" });
    prismaMock.donationLedgerEntry.create.mockResolvedValue({});
    // The receipt claim-lock, then the row `sendReceipt` reads back.
    prismaMock.donation.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.donation.findUnique.mockResolvedValueOnce({
      ...row,
      status: "RECEIVED",
      user: { firstName: "Alice", lastName: "A", email: "alice@adcet.in" },
    });
    return svc.approve("admin-1", "d-1");
  };

  it("mints a receipt number, records who verified it, and emails the PDF", async () => {
    await runApprove(pledged());

    const data = (prismaMock.donation.update.mock.calls[0][0] as any).data;
    expect(data.status).toBe("RECEIVED");
    expect(data.verifiedById).toBe("admin-1");
    expect(data.verifiedAt).toBeInstanceOf(Date);
    expect(data.receiptNo).toMatch(/^ADCET\/2026\//);

    const mail = sendEmail.mock.calls.at(-1)![0] as any;
    expect(mail.subject).toMatch(/receipt/i);
    expect(mail.attachments?.[0].contentType).toBe("application/pdf");
  });

  /**
   * An admin who rejected the wrong row needs a way back, and the archive
   * clock has to stop with it or the purge job would still delete the gift.
   */
  it("undoes a rejection: clears the reason and the archive clock", async () => {
    await runApprove(pledged({ status: "REJECTED", rejectionReason: "wrong ref", archivedAt: new Date() }));

    const data = (prismaMock.donation.update.mock.calls[0][0] as any).data;
    expect(data.rejectionReason).toBeNull();
    expect(data.archivedAt).toBeNull();
  });

  /** A double-click must not 4xx after the first press sent the receipt. */
  it("is idempotent on an already-verified gift, and does not re-send the receipt", async () => {
    prismaMock.donation.findUnique.mockResolvedValueOnce(pledged({ status: "RECEIVED" }));
    const out = await svc.approve("admin-1", "d-1");
    expect((out as any).status).toBe("RECEIVED");
    expect(prismaMock.donation.update).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses a submission the donor withdrew", async () => {
    prismaMock.donation.findUnique.mockResolvedValueOnce(pledged({ status: "CANCELLED" }));
    await expect(svc.approve("admin-1", "d-1")).rejects.toMatchObject({ status: 400 });
  });
});

describe("donations.service — reject", () => {
  const pledged = (over: Record<string, unknown> = {}) => ({
    id: "d-1",
    userId: "u-9",
    amount: 5000,
    status: "PLEDGED",
    reference: "UTR402318795412",
    donorName: "Alice A",
    donorEmail: "alice@adcet.in",
    ...over,
  });

  it("archives the claim with the reason, and emails the donor that reason", async () => {
    prismaMock.donation.findUnique.mockResolvedValueOnce(pledged());
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.donation.update.mockResolvedValueOnce({
      ...pledged({ status: "REJECTED", rejectionReason: "No matching credit." }),
    });
    prismaMock.donationLedgerEntry.create.mockResolvedValueOnce({});

    await svc.reject("admin-1", "d-1", "No matching credit.");

    const data = (prismaMock.donation.update.mock.calls[0][0] as any).data;
    expect(data.status).toBe("REJECTED");
    expect(data.rejectionReason).toBe("No matching credit.");
    // The purge job sweeps on this column; without it the row is never removed.
    expect(data.archivedAt).toBeInstanceOf(Date);
    expect(data.verifiedAt).toBeNull();

    const mail = sendEmail.mock.calls.at(-1)![0] as any;
    expect(mail.to).toBe("alice@adcet.in");
    expect(mail.text).toContain("No matching credit.");
  });

  /**
   * Money already in the account, and a receipt already in somebody's inbox.
   * Archiving it would schedule that record for deletion in thirty days.
   */
  it("refuses to reject a gift that was already verified and receipted", async () => {
    prismaMock.donation.findUnique.mockResolvedValueOnce(pledged({ status: "RECEIVED" }));
    await expect(svc.reject("admin-1", "d-1", "changed my mind")).rejects.toMatchObject({
      status: 400,
    });
    expect(prismaMock.donation.update).not.toHaveBeenCalled();
  });
});

describe("donations.service — cancelOwn", () => {
  it("lets a donor withdraw their own claim while it is undecided", async () => {
    prismaMock.donation.findUnique.mockResolvedValueOnce({ id: "d-1", userId: "u-9", status: "PLEDGED", amount: 100 });
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.donation.update.mockResolvedValueOnce({ id: "d-1", status: "CANCELLED" });
    prismaMock.donationLedgerEntry.create.mockResolvedValueOnce({});

    const out = await svc.cancelOwn("u-9", "d-1");
    expect((out as any).status).toBe("CANCELLED");
  });

  it("403s somebody else's claim", async () => {
    prismaMock.donation.findUnique.mockResolvedValueOnce({ id: "d-1", userId: "other", status: "PLEDGED" });
    await expect(svc.cancelOwn("u-9", "d-1")).rejects.toMatchObject({ status: 403 });
  });

  /** Withdrawal stops at the decision — the row carries what they were told. */
  it("400s once the office has decided", async () => {
    prismaMock.donation.findUnique.mockResolvedValueOnce({ id: "d-1", userId: "u-9", status: "REJECTED" });
    await expect(svc.cancelOwn("u-9", "d-1")).rejects.toMatchObject({ status: 400 });
  });
});

/**
 * The public honour roll. What matters here is what is *left out* — anonymous
 * gifts, unpaid pledges and unapproved accounts — because the endpoint has no
 * session behind it and the result lands on the landing page.
 */
describe("donations.service — topDonors", () => {
  beforeEach(() => svc.invalidateTopDonors());

  const groupedRows = [
    { userId: "u-1", _sum: { amount: 250000 } },
    { userId: "u-2", _sum: { amount: 90000 } },
  ];
  const userRows = [
    { id: "u-2", firstName: "Bob", lastName: "Kulkarni", profile: { avatarKey: null, graduationYear: 2016 } },
    { id: "u-1", firstName: "Alice", lastName: "Patil", profile: { avatarKey: "avatar/a.png", graduationYear: 2020 } },
  ];

  it("counts only received, non-anonymous gifts from approved accounts", async () => {
    prismaMock.donation.groupBy.mockResolvedValueOnce(groupedRows);
    prismaMock.user.findMany.mockResolvedValueOnce(userRows);

    await svc.topDonors(12);

    const args: any = prismaMock.donation.groupBy.mock.calls.at(-1)![0];
    expect(args.where).toMatchObject({
      status: "RECEIVED",
      isAnonymous: false,
      user: { status: "APPROVED" },
    });
    expect(args.orderBy).toEqual({ _sum: { amount: "desc" } });
    expect(args.take).toBe(12);
  });

  it("keeps the largest-first order even though findMany returns its own", async () => {
    prismaMock.donation.groupBy.mockResolvedValueOnce(groupedRows);
    prismaMock.user.findMany.mockResolvedValueOnce(userRows);

    const out = await svc.topDonors(12);

    expect(out.map((d) => [d.name, d.amount])).toEqual([
      ["Alice Patil", 250000],
      ["Bob Kulkarni", 90000],
    ]);
    // The name and photo come from the account, not the frozen donorName —
    // that is what makes the roll follow the alumni data.
    expect(out[0].avatarKey).toBe("avatar/a.png");
    expect(out[0].graduationYear).toBe(2020);
  });

  it("drops a donor whose account has since vanished", async () => {
    prismaMock.donation.groupBy.mockResolvedValueOnce(groupedRows);
    prismaMock.user.findMany.mockResolvedValueOnce([userRows[1]]);

    const out = await svc.topDonors(12);
    expect(out.map((d) => d.id)).toEqual(["u-1"]);
  });

  it("returns nothing, and asks for no users, when nobody has given yet", async () => {
    prismaMock.donation.groupBy.mockResolvedValueOnce([]);

    expect(await svc.topDonors(12)).toEqual([]);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  /**
   * Clearing the cache from *inside* the transaction leaves a window: a public
   * read that lands after the clear but before the commit repopulates it from
   * pre-commit rows, and the stale ranking then sits there for five minutes.
   * The clear has to happen once the write is durable.
   */
  it("drops the cache after the commit, so a read racing the transaction cannot re-stale it", async () => {
    prismaMock.donation.groupBy.mockResolvedValue(groupedRows);
    prismaMock.user.findMany.mockResolvedValue(userRows);
    prismaMock.donation.findUnique.mockResolvedValue({
      id: "d-1",
      userId: "u-9",
      amount: 5000,
      status: "PLEDGED",
      createdAt: new Date(),
      donorEmail: "alice@adcet.in",
      user: { firstName: "Alice", lastName: "A", email: "alice@adcet.in" },
    });
    prismaMock.donation.update.mockResolvedValue({ id: "d-1", amount: 5000, status: "RECEIVED" });
    prismaMock.donation.updateMany.mockResolvedValue({ count: 0 }); // receipt already claimed
    prismaMock.donationLedgerEntry.create.mockResolvedValue({});
    // A visitor loads the landing page after the write has been issued but
    // before it commits — the exact window an in-transaction clear leaves open.
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      const result = await fn(prismaMock);
      await svc.topDonorsCached(12);
      return result;
    });

    await svc.approve("admin-1", "d-1");
    expect(prismaMock.donation.groupBy).toHaveBeenCalledTimes(1);

    await svc.topDonorsCached(12);
    expect(prismaMock.donation.groupBy).toHaveBeenCalledTimes(2);
  });

  it("caches per limit, and a settled payment drops the cache", async () => {
    prismaMock.donation.groupBy.mockResolvedValue(groupedRows);
    prismaMock.user.findMany.mockResolvedValue(userRows);

    await svc.topDonorsCached(12);
    await svc.topDonorsCached(12);
    expect(prismaMock.donation.groupBy).toHaveBeenCalledTimes(1);

    svc.invalidateTopDonors();
    await svc.topDonorsCached(12);
    expect(prismaMock.donation.groupBy).toHaveBeenCalledTimes(2);
  });
});
