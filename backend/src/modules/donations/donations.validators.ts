import { z } from "zod";
import { paginationSchema, booleanQueryParam } from "../../lib/pagination.js";
import { DONATION_PAYMENT_METHODS } from "../../config/constants.js";

export const campaignInputSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().min(10).max(20000),
  goalAmount: z.coerce.number().int().min(1),
  currency: z.string().max(8).optional(),
  coverKey: z.string().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional(),
  isActive: z.boolean().optional(),
});

/**
 * A bank or UPI transaction reference (UTR/RRN), as the donor reads it off
 * their app. Normalised — upper-cased, inner whitespace removed — because it is
 * the column the unique index sits on: "abc 123" and "ABC123" are one payment,
 * and without this the same transfer could be claimed twice.
 */
const referenceSchema = z
  .string()
  .trim()
  .min(4, "Enter the transaction reference from your bank or UPI app")
  .max(80)
  .transform((v) => v.replace(/\s+/g, "").toUpperCase())
  .refine((v) => /^[A-Z0-9/_-]+$/.test(v), "A transaction reference is letters, digits, - / _ only");

/**
 * When the donor says the money left their account.
 *
 * A day of slack on the upper bound, because the browser sends a local date and
 * a donor east of UTC paying at 11pm is legitimately "tomorrow" here. The floor
 * exists so a typo'd year lands as a validation error rather than as a gift the
 * office has to hunt for in a statement from 2014.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const paidAtSchema = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now() + DAY_MS, "That date is in the future")
  .refine((d) => d.getTime() >= Date.now() - 365 * DAY_MS, "That payment is more than a year old — please contact the alumni office");

/**
 * Declare a gift that has already been paid off-portal.
 *
 * Every field here is the donor's own claim: there is no gateway to confirm any
 * of it, which is exactly why the row lands PLEDGED and an admin matches
 * `reference` against the bank statement before it becomes money.
 */
export const submitDonationSchema = z.object({
  amount: z.coerce.number().int().min(1).max(10_000_000),
  reference: referenceSchema,
  paymentMethod: z.enum(DONATION_PAYMENT_METHODS),
  paidAt: paidAtSchema,
  /** Screenshot of the payment, uploaded under the private `donation-proof` scope. */
  proofKey: z.string().max(500).optional(),
  message: z.string().max(1000).optional(),
  isAnonymous: z.boolean().optional(),
  /**
   * Which campaign the money is for. Omitted (or empty) means a general
   * donation to the alumni fund, which stays a valid choice — hence optional
   * rather than required.
   */
  campaignId: z.union([z.string().uuid(), z.literal("")]).optional()
    .transform((v) => (v ? v : undefined)),
});

/** An admin's note when confirming a gift against the bank record. */
export const approveDonationSchema = z.object({
  note: z.string().max(1000).optional(),
});

/**
 * Why a gift could not be confirmed. Required, and emailed to the donor
 * verbatim: a rejection they cannot act on is worse than none, because the
 * row is archived and gone in a month.
 */
export const rejectDonationSchema = z.object({
  reason: z.string().trim().min(5, "Tell the donor why — this is emailed to them").max(1000),
});

export const listCampaignsQuery = paginationSchema.extend({
  active: booleanQueryParam,
});

const ledgerFilters = {
  campaignId: z.string().uuid().optional(),
  status: z.enum(["PLEDGED", "RECEIVED", "REJECTED", "CANCELLED"]).optional(),
};

export const listDonationsQuery = paginationSchema.extend(ledgerFilters);

/** The header totals take the ledger's filters, but no page. */
export const donationStatsQuery = z.object(ledgerFilters);

/** Public honour roll. Capped so the anonymous endpoint can't page the ledger. */
export const topDonorsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(12),
});
