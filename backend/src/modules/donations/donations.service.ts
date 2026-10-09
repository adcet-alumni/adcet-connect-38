/**
 * Donations, paid off-portal and verified by hand.
 *
 * There is no payment gateway — the college would not carry the fee — so the
 * shape of this module follows from one fact: **nothing a donor tells us about
 * a payment is evidence.** A submission is a claim. It lands `PLEDGED`, it is
 * worth nothing until an admin has matched its `reference` against the
 * college's bank statement, and only `approve()` turns it into money: that is
 * the single place a receipt number is minted, a PDF generated and an email
 * sent. `reject()` archives the claim with a reason the donor is told, and
 * `jobs/donationPurge.ts` deletes it (and its proof screenshot) after
 * `DONATION_ARCHIVE_RETENTION_DAYS`.
 */
import { prisma } from "../../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../lib/errors.js";
import { paginate, paginationMeta, type PaginationQuery } from "../../lib/pagination.js";
import { logger } from "../../lib/logger.js";
import { sendEmail } from "../../lib/mailer.js";
import {
  donationReceiptEmail,
  donationRejectedEmail,
  donationSubmittedEmail,
} from "../../lib/email-templates.js";
import { generateReceiptPdf } from "../../lib/receipt.js";
import { getStorage } from "../../storage/index.js";
import { getAllSettings } from "../../lib/settings.js";
import type { DonationPaymentMethod } from "../../config/constants.js";

type DonationStatus = "PLEDGED" | "RECEIVED" | "REJECTED" | "CANCELLED";

const makeReceiptNo = (donation: { id: string; createdAt?: Date }): string => {
  const year = (donation.createdAt ?? new Date()).getFullYear();
  const suffix = donation.id.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `ADCET/${year}/${suffix}`;
};

export const listCampaigns = async (q: PaginationQuery & { active?: boolean }) => {
  const where: Prisma.DonationCampaignWhereInput = {
    ...(q.active !== undefined && { isActive: q.active }),
  };
  const [items, total] = await Promise.all([
    prisma.donationCampaign.findMany({
      where,
      orderBy: { startsAt: "desc" },
      include: { _count: { select: { donations: true } } },
      ...paginate(q),
    }),
    prisma.donationCampaign.count({ where }),
  ]);
  // Add raised amount per campaign (single grouped query for efficiency).
  const ids = items.map((c) => c.id);
  const raised = ids.length
    ? await prisma.donation.groupBy({
        by: ["campaignId"],
        where: { campaignId: { in: ids }, status: "RECEIVED" },
        _sum: { amount: true },
      })
    : [];
  const raisedMap = new Map(raised.map((r) => [r.campaignId, r._sum.amount ?? 0]));
  return {
    items: items.map((c) => ({ ...c, raisedAmount: raisedMap.get(c.id) ?? 0 })),
    pagination: paginationMeta(total, q),
  };
};

export const getCampaign = async (id: string) => {
  const campaign = await prisma.donationCampaign.findUnique({ where: { id } });
  if (!campaign) throw NotFound();
  const sum = await prisma.donation.aggregate({
    where: { campaignId: id, status: "RECEIVED" },
    _sum: { amount: true },
    _count: true,
  });
  return { ...campaign, raisedAmount: sum._sum.amount ?? 0, donorCount: sum._count };
};

export const createCampaign = (data: Prisma.DonationCampaignUncheckedCreateInput) =>
  prisma.donationCampaign.create({ data });
export const updateCampaign = (id: string, data: Prisma.DonationCampaignUpdateInput) =>
  prisma.donationCampaign.update({ where: { id }, data });
export const deleteCampaign = async (id: string) => {
  await prisma.donationCampaign.delete({ where: { id } });
};

/**
 * Resolve the campaign a donation is earmarked for.
 *
 * Refuses anything a donor shouldn't be able to give to — archived campaigns,
 * ones that haven't opened, ones that have closed. Without this a stale page
 * (or a hand-crafted request) could pin money to a campaign the alumni office
 * has already wound up, and the mistake only surfaces at reconciliation.
 */
const resolveCampaign = async (campaignId: string | undefined) => {
  if (!campaignId) return null;
  const campaign = await prisma.donationCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw NotFound("Campaign not found");

  const now = new Date();
  if (!campaign.isActive) throw BadRequest("That campaign is no longer accepting donations.");
  if (campaign.startsAt > now) throw BadRequest("That campaign hasn't opened yet.");
  if (campaign.endsAt && campaign.endsAt < now) {
    throw BadRequest("That campaign has closed. Please choose another.");
  }
  return campaign;
};

/* -------------------------------------------------------------------------- */
/*  Where the money is actually paid                                          */
/* -------------------------------------------------------------------------- */

/**
 * The payee details the donations page prints: the QR, the UPI ID beside it,
 * and the bank account for anyone who would rather do a transfer.
 *
 * They live in `lib/settings.ts` rather than env because the alumni office
 * changes the account without a deploy. `configured` is false until at least
 * one way to pay is filled in, which is what stops the page rendering an empty
 * QR frame and a form asking donors to reference a payment they cannot make.
 */
export const paymentDetails = async () => {
  const s = await getAllSettings();
  const upiId = String(s.donationUpiId ?? "");
  const qrKey = String(s.donationQrKey ?? "");
  const bankDetails = String(s.donationBankDetails ?? "");
  return {
    upiId,
    payeeName: String(s.donationPayeeName ?? ""),
    qrKey,
    bankDetails,
    instructions: String(s.donationInstructions ?? ""),
    configured: Boolean(upiId || qrKey || bankDetails),
  };
};

/* -------------------------------------------------------------------------- */
/*  Submit -> verify -> receipt                                               */
/* -------------------------------------------------------------------------- */

export interface SubmitDonationInput {
  amount: number;
  reference: string;
  paymentMethod: DonationPaymentMethod;
  paidAt: Date;
  proofKey?: string;
  message?: string;
  isAnonymous?: boolean;
  campaignId?: string;
}

/**
 * File a donor's declaration that they have paid.
 *
 * The row lands `PLEDGED` — a claim awaiting the office, not a gift — and the
 * donor is emailed an acknowledgement that says so in as many words, because
 * the one thing that would go wrong here is a donor believing the portal has
 * their money. The donor's name and email are snapshotted so the eventual
 * receipt stays correct if they later edit their profile.
 *
 * `reference` is unique in the database. The lookup below is for the message,
 * not the guarantee: two concurrent submissions of one UTR both pass it, and
 * the constraint is what actually stops the second (P2002 -> 409).
 */
export const submit = async (userId: string, data: SubmitDonationInput) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw NotFound("User not found");

  const details = await paymentDetails();
  if (!details.configured) {
    throw BadRequest("The alumni office has not published payment details yet. Please try again later.");
  }

  const campaign = await resolveCampaign(data.campaignId);
  const amount = Math.round(data.amount);
  const donorName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email;

  const clash = await prisma.donation.findUnique({
    where: { reference: data.reference },
    select: { id: true },
  });
  if (clash) {
    throw Conflict(
      "That transaction reference has already been submitted. If this is a second gift, use the reference of that payment.",
    );
  }

  // The proof screenshot must be the donor's own upload, not a key they typed:
  // `donation-proof/<ownerId>/...` is what `parseObjectKey` builds, and reading
  // one back is owner-or-admin only. Accepting somebody else's key here would
  // attach their screenshot to this donation and hand it to the admin.
  if (data.proofKey && !data.proofKey.startsWith(`donation-proof/${userId}/`)) {
    throw BadRequest("That proof file does not belong to this account.");
  }

  const donation = await prisma.$transaction(async (tx) => {
    const d = await tx.donation.create({
      data: {
        userId,
        campaignId: campaign?.id ?? null,
        amount,
        currency: "INR",
        message: data.message ?? null,
        isAnonymous: !!data.isAnonymous,
        status: "PLEDGED",
        donorName,
        donorEmail: user.email,
        reference: data.reference,
        paymentMethod: data.paymentMethod,
        paidAt: data.paidAt,
        proofKey: data.proofKey ?? null,
      },
    });
    await tx.donationLedgerEntry.create({
      data: {
        donationId: d.id,
        actorId: userId,
        entryType: "SUBMITTED",
        status: "PLEDGED",
        amount,
        proofKey: d.proofKey,
        note: campaign
          ? `${data.paymentMethod} ${data.reference} — ${campaign.title}`
          : `${data.paymentMethod} ${data.reference} — general fund`,
      },
    });
    return d;
  });

  // Best-effort: a mail outage must not lose a filed donation.
  try {
    const mail = donationSubmittedEmail({
      donorName,
      amount,
      reference: data.reference,
      method: data.paymentMethod,
      paidAt: data.paidAt,
      campaignTitle: campaign?.title ?? null,
    });
    await sendEmail({ to: user.email, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (e) {
    logger.error({ err: e, donationId: donation.id }, "failed to send donation acknowledgement");
  }

  return donation;
};

/**
 * Generate the PDF receipt, store it, and email it to the donor — exactly once.
 * Uses a conditional `updateMany` on `receiptSentAt` as a claim lock, so two
 * admins pressing Approve at the same moment don't both send. Best-effort: on
 * failure the lock is released so a later retry can complete it.
 */
const sendReceipt = async (donationId: string): Promise<void> => {
  const claim = await prisma.donation.updateMany({
    where: { id: donationId, status: "RECEIVED", receiptSentAt: null },
    data: { receiptSentAt: new Date() },
  });
  if (claim.count !== 1) return; // already sent (or not received yet)

  try {
    const d = await prisma.donation.findUnique({
      where: { id: donationId },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    if (!d) return;

    const donorName = d.donorName || `${d.user.firstName} ${d.user.lastName}`.trim() || "Donor";
    const donorEmail = d.donorEmail || d.user.email;
    const paidAt = d.paidAt ?? new Date();
    const receiptNo = d.receiptNo ?? makeReceiptNo(d);
    const fileName = `${receiptNo.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;

    const pdf = await generateReceiptPdf({
      receiptNo,
      donorName,
      donorEmail,
      amount: d.amount,
      currency: d.currency,
      reference: d.reference,
      method: d.paymentMethod,
      paidAt,
      verifiedAt: d.verifiedAt,
      message: d.message,
    });

    // Store the receipt so the admin can re-download it later.
    let receiptKey: string | undefined;
    try {
      const stored = await getStorage().upload({
        fileName,
        contentType: "application/pdf",
        scope: "receipt",
        ownerId: d.userId,
        body: pdf,
      });
      receiptKey = stored.key;
      await prisma.donation.update({ where: { id: d.id }, data: { receiptKey } });
    } catch (e) {
      logger.error({ err: e, donationId }, "failed to store donation receipt PDF");
    }

    const mail = donationReceiptEmail({
      donorName,
      amount: d.amount,
      currency: d.currency,
      receiptNo,
      reference: d.reference,
      method: d.paymentMethod,
      paidAt,
      message: d.message,
    });
    await sendEmail({
      to: donorEmail,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: [{ filename: fileName, content: pdf, contentType: "application/pdf" }],
    });

    await prisma.donationLedgerEntry.create({
      data: {
        donationId: d.id,
        entryType: "RECEIPT_SENT",
        status: "RECEIVED",
        amount: d.amount,
        receiptKey,
        note: `Receipt emailed to ${donorEmail}`,
      },
    });
  } catch (e) {
    logger.error({ err: e, donationId }, "failed to send donation receipt — releasing lock for retry");
    await prisma.donation
      .update({ where: { id: donationId }, data: { receiptSentAt: null } })
      .catch(() => undefined);
  }
};

/**
 * The admin has found this payment in the bank statement.
 *
 * This is the only transition that creates money: it mints the receipt number,
 * stamps who verified it and when, and hands off to `sendReceipt`. A rejected
 * gift may be approved after the fact — an admin who rejected the wrong row
 * needs a way back, and the archive clock (`archivedAt`) is cleared with it, so
 * the purge job no longer sees it.
 */
export const approve = async (adminId: string, id: string, note?: string) => {
  const existing = await prisma.donation.findUnique({ where: { id } });
  if (!existing) throw NotFound("Donation not found");
  if (existing.status === "RECEIVED") {
    // Idempotent rather than an error: a double-click must not 4xx an admin
    // after the first press already emailed the receipt.
    return existing;
  }
  if (existing.status === "CANCELLED") {
    throw BadRequest("The donor withdrew this submission. Ask them to submit it again.");
  }

  const donation = await prisma.$transaction(async (tx) => {
    const d = await tx.donation.update({
      where: { id },
      data: {
        status: "RECEIVED",
        verifiedAt: new Date(),
        verifiedById: adminId,
        receiptNo: existing.receiptNo ?? makeReceiptNo(existing),
        // The rejection is undone, not merely superseded: leaving the reason on
        // a received gift would put it on the donor's record for good.
        rejectionReason: null,
        archivedAt: null,
      },
    });
    await tx.donationLedgerEntry.create({
      data: {
        donationId: d.id,
        actorId: adminId,
        entryType: "VERIFIED",
        status: "RECEIVED",
        amount: d.amount,
        proofKey: d.proofKey,
        note: note ?? `Matched ${d.paymentMethod ?? "payment"} ${d.reference ?? ""}`.trim(),
      },
    });
    return d;
  });

  // Money just landed: the public honour roll may have a new leader. Dropped
  // *after* the commit — clearing inside the transaction leaves a window in
  // which a concurrent public read repopulates the cache from pre-commit data
  // and pins the stale ranking for another five minutes.
  invalidateTopDonors();
  await sendReceipt(donation.id);
  return prisma.donation.findUnique({ where: { id: donation.id } });
};

/**
 * The admin could not match this payment.
 *
 * Rejection is the decision on an *unverified claim*, so it is only available
 * from PLEDGED. A gift already receipted is money in the account and a PDF in
 * somebody's inbox; reversing that is an accounting matter, and archiving it
 * here would quietly delete the record of a receipt that exists in the world.
 */
export const reject = async (adminId: string, id: string, reason: string) => {
  const existing = await prisma.donation.findUnique({ where: { id } });
  if (!existing) throw NotFound("Donation not found");
  if (existing.status === "RECEIVED") {
    throw BadRequest(
      "This gift has already been verified and receipted. Rejecting it would archive a receipt the donor already holds — take it up with the alumni office instead.",
    );
  }
  if (existing.status === "REJECTED") return existing;

  const donation = await prisma.$transaction(async (tx) => {
    const d = await tx.donation.update({
      where: { id },
      data: {
        status: "REJECTED",
        rejectionReason: reason,
        archivedAt: new Date(),
        verifiedAt: null,
        verifiedById: adminId,
      },
    });
    await tx.donationLedgerEntry.create({
      data: {
        donationId: d.id,
        actorId: adminId,
        entryType: "REJECTED",
        status: "REJECTED",
        amount: d.amount,
        proofKey: d.proofKey,
        note: reason,
      },
    });
    return d;
  });

  invalidateTopDonors();

  try {
    const mail = donationRejectedEmail({
      donorName: donation.donorName || "Donor",
      amount: donation.amount,
      reference: donation.reference ?? "—",
      reason,
    });
    if (donation.donorEmail) {
      await sendEmail({
        to: donation.donorEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    }
  } catch (e) {
    logger.error({ err: e, donationId: id }, "failed to send donation rejection email");
  }

  return donation;
};

/**
 * A donor withdrawing their own submission, before the office has decided.
 *
 * Mirrors the collaboration rule: withdrawal stops at the decision. Once an
 * admin has verified or rejected it the row carries their finding, and the
 * donor deleting it would erase what they were told.
 */
export const cancelOwn = async (userId: string, id: string) => {
  const donation = await prisma.donation.findUnique({ where: { id } });
  if (!donation) throw NotFound("Donation not found");
  if (donation.userId !== userId) throw Forbidden();
  if (donation.status !== "PLEDGED") {
    throw BadRequest("The alumni office has already reviewed this submission.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const d = await tx.donation.update({ where: { id }, data: { status: "CANCELLED" } });
    await tx.donationLedgerEntry.create({
      data: {
        donationId: d.id,
        actorId: userId,
        entryType: "WITHDRAWN",
        status: "CANCELLED",
        amount: d.amount,
        note: "Withdrawn by the donor",
      },
    });
    return d;
  });
  return updated;
};

/** The ledger's filters, shared by the page query and the totals above it. */
const ledgerWhere = (q: {
  campaignId?: string;
  status?: DonationStatus;
}): Prisma.DonationWhereInput => ({
  ...(q.campaignId && { campaignId: q.campaignId }),
  ...(q.status && { status: q.status }),
});

export const listDonations = async (
  q: PaginationQuery & { campaignId?: string; status?: DonationStatus },
) => {
  const where = ledgerWhere(q);
  const [items, total] = await Promise.all([
    prisma.donation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        campaign: { select: { id: true, title: true } },
        verifiedBy: { select: { id: true, firstName: true, lastName: true } },
        ledgerEntries: { orderBy: { createdAt: "desc" }, take: 5 },
      },
      ...paginate(q),
    }),
    prisma.donation.count({ where }),
  ]);
  // Anonymise where required.
  const cleaned = items.map((d) =>
    d.isAnonymous ? { ...d, user: { id: null, firstName: "Anonymous", lastName: "" } } : d,
  );
  return { items: cleaned, pagination: paginationMeta(total, q) };
};

/**
 * The totals the admin ledger prints above itself.
 *
 * They exist as their own query because the ledger is paginated: computing them
 * from the rows on screen would have made "Total Received" mean "received on
 * page 3", which is worse than not showing it. Every figure honours the same
 * filters as the page below it, so the two always agree about what is being
 * looked at.
 *
 * `donorCount` is the one thing Prisma cannot express — there is no
 * `COUNT(DISTINCT)` in its query builder, and the alternatives (`groupBy` on
 * `userId`, or `findMany` with `distinct`) both return one row per donor to
 * Node just to measure the array. The filters are interpolated as parameters,
 * never as text.
 */
export interface DonationStats {
  /** Rupees received, all time, within the current filters. */
  totalReceived: number;
  /** Rupees received since the 1st of the current month. */
  thisMonthReceived: number;
  /** Distinct donors with at least one row in the filtered set. */
  donorCount: number;
  /** Submissions awaiting a decision — deliberately ignores the status filter. */
  pendingCount: number;
  /** Received totals per cause, largest first. `campaignId: null` is the general fund. */
  byCampaign: { campaignId: string | null; title: string; received: number; count: number }[];
}

export const stats = async (q: {
  campaignId?: string;
  status?: DonationStatus;
}): Promise<DonationStats> => {
  const where = ledgerWhere(q);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [allTime, thisMonth, donors, pendingCount, counted, received, campaigns] =
    await Promise.all([
      prisma.donation.aggregate({ where: { ...where, status: "RECEIVED" }, _sum: { amount: true } }),
      prisma.donation.aggregate({
        where: { ...where, status: "RECEIVED", createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "userId") AS count
          FROM "Donation"
         WHERE (${q.campaignId ?? null}::text IS NULL OR "campaignId" = ${q.campaignId ?? null}::text)
           AND (${q.status ?? null}::text IS NULL OR "status"::text = ${q.status ?? null}::text)
      `,
      // Deliberately not filtered by status: this card counts what still needs
      // deciding, and an admin who has filtered the ledger to RECEIVED still
      // has to see submissions piling up behind them.
      prisma.donation.count({
        where: { ...(q.campaignId && { campaignId: q.campaignId }), status: "PLEDGED" },
      }),
      // Two group-bys rather than one: `count` is every row matching the
      // filters, `received` only the money among them, and no single grouped
      // aggregate can express both.
      prisma.donation.groupBy({ by: ["campaignId"], where, _count: { _all: true } }),
      prisma.donation.groupBy({
        by: ["campaignId"],
        where: { ...where, status: "RECEIVED" },
        _sum: { amount: true },
      }),
      // Every campaign, unfiltered: there are a handful of them, and asking for
      // only the grouped ids would make this wait on the group-by above.
      prisma.donationCampaign.findMany({ select: { id: true, title: true } }),
    ]);

  const receivedMap = new Map(received.map((r) => [r.campaignId, r._sum.amount ?? 0]));
  const titles = new Map(campaigns.map((c) => [c.id, c.title]));

  return {
    totalReceived: allTime._sum.amount ?? 0,
    thisMonthReceived: thisMonth._sum.amount ?? 0,
    donorCount: Number(donors[0]?.count ?? 0),
    pendingCount,
    byCampaign: counted
      .map((g) => ({
        campaignId: g.campaignId,
        title: g.campaignId ? titles.get(g.campaignId) ?? "Unknown campaign" : "General fund",
        received: receivedMap.get(g.campaignId) ?? 0,
        count: g._count._all,
      }))
      .sort((a, b) => b.received - a.received),
  };
};

/* -------------------------------------------------------------------------- */
/*  Top donors — the public honour roll on the landing page                   */
/* -------------------------------------------------------------------------- */

export interface PublicDonor {
  /** User id — the list key; nothing else about the account is exposed. */
  id: string;
  name: string;
  /** Lifetime total of their **received** gifts, in rupees. */
  amount: number;
  avatarKey: string | null;
  graduationYear: number | null;
}

/**
 * The largest donors, summed per person, for the public landing page.
 *
 * Three rules make this safe to publish without a curated list to maintain:
 *
 *  1. **`isAnonymous` is the donor's veto.** A gift given anonymously is
 *     excluded from the sum entirely, so ticking that box on the donation form
 *     keeps a donor off this wall — and off it retroactively, since the total
 *     is recomputed from the rows every time.
 *  2. **Only `RECEIVED` money counts.** A `PLEDGED` row is an unverified claim
 *     any member can file in ten seconds, so counting it would let someone put
 *     their own name on the landing page for free — and a `REJECTED` one is a
 *     claim the office has already refused.
 *  3. **The name comes from the account, not the donation snapshot.** The
 *     `donorName` column is frozen at submission time for the receipt; this reads
 *     `User` and `Profile` live, so a renamed or newly photographed alumnus is
 *     shown correctly, and a new top gift reorders the list on its own.
 */
export const topDonors = async (limit = 12): Promise<PublicDonor[]> => {
  const grouped = await prisma.donation.groupBy({
    by: ["userId"],
    where: {
      status: "RECEIVED",
      isAnonymous: false,
      // Pending and rejected accounts are not published anywhere else either.
      user: { status: "APPROVED" },
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    take: limit,
  });
  if (grouped.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map((g) => g.userId) } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      profile: { select: { avatarKey: true, graduationYear: true } },
    },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  // Rebuilt in the grouped order — `findMany` does not preserve it.
  return grouped.flatMap((g) => {
    const user = byId.get(g.userId);
    const amount = g._sum.amount ?? 0;
    if (!user || amount <= 0) return [];
    return [{
      id: user.id,
      name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "ADCET Alumnus",
      amount,
      avatarKey: user.profile?.avatarKey ?? null,
      graduationYear: user.profile?.graduationYear ?? null,
    }];
  });
};

/**
 * Short-lived cache, keyed by `limit`, in front of `topDonors()`.
 *
 * The landing page is the most-hit page on the site and the honour roll changes
 * only when a payment settles, so a few minutes of staleness is invisible and
 * keeps a group-by off the hot path. Failures are not cached.
 */
const TOP_DONORS_TTL_MS = 5 * 60_000;
const topDonorsCache = new Map<number, { at: number; data: PublicDonor[] }>();

export const topDonorsCached = async (limit = 12): Promise<PublicDonor[]> => {
  const hit = topDonorsCache.get(limit);
  if (hit && Date.now() - hit.at < TOP_DONORS_TTL_MS) return hit.data;
  const data = await topDonors(limit);
  topDonorsCache.set(limit, { at: Date.now(), data });
  return data;
};

/** Drop the cached roll — called whenever a donation's status changes. */
export const invalidateTopDonors = () => topDonorsCache.clear();

/**
 * One donor's own giving history, newest first.
 *
 * Bounded, because an unbounded `findMany` is an unbounded `findMany` however
 * unlikely a large result feels — and this one joins a campaign per row. The
 * page renders the six most recent, so 50 is generous headroom rather than a
 * page size, and the response stays a plain array: adding pagination here
 * would change the shape for a list nobody scrolls.
 */
const MY_DONATIONS_LIMIT = 50;

export const myDonations = (userId: string) =>
  prisma.donation.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    // The card draws the cause's name, not the campaign — `include: true` was
    // shipping its description, goal, cover key and dates per row.
    include: { campaign: { select: { id: true, title: true } } },
    take: MY_DONATIONS_LIMIT,
  });
