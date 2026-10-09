/**
 * Donations, from the browser's side.
 *
 * There is no payment gateway: a donor pays against the QR the alumni office
 * publishes, then tells us what they paid. So every type here describes a
 * *claim* until an admin has matched it against the college's bank statement —
 * which is why `PLEDGED` is labelled "Awaiting verification" and not "Pending
 * payment", and why nothing on either surface calls an unverified row a gift.
 *
 * Deliberately import-free below the type imports so the backend's
 * `tests/lib/donations.test.ts` can load it and fail the build when
 * `DONATION_PAYMENT_METHODS` drifts from `config/constants.ts`.
 */

/** Mirrors `DONATION_PAYMENT_METHODS` in the backend's `config/constants.ts`. */
export const DONATION_PAYMENT_METHODS = ["UPI", "BANK_TRANSFER"] as const;

export type DonationPaymentMethod = (typeof DONATION_PAYMENT_METHODS)[number];

/** How each method reads in a dropdown — the two the office publishes. */
export const PAYMENT_METHOD_LABELS: Record<DonationPaymentMethod, string> = {
  UPI: "UPI — scanned the QR",
  BANK_TRANSFER: "Bank transfer",
};

/**
 * A method as read back from a stored row, which may predate the list above.
 * Falls back to the raw value rather than blanking the field.
 */
export const paymentMethodLabel = (method?: string | null): string =>
  method ? PAYMENT_METHOD_LABELS[method as DonationPaymentMethod] ?? method : "—";

export type DonationStatus = "PLEDGED" | "RECEIVED" | "REJECTED" | "CANCELLED";

/**
 * What each status means to the person reading it.
 *
 * `PLEDGED` is the one worth getting right: to the donor it means "we have your
 * details and the office is checking them", not "your payment failed" and not
 * "thank you for your gift".
 */
export const STATUS_LABELS: Record<DonationStatus, string> = {
  PLEDGED: "Awaiting verification",
  RECEIVED: "Verified",
  REJECTED: "Not verified",
  CANCELLED: "Withdrawn",
};

/** Inline text colour — the donor's own list, where the status is a word in a line. */
export const STATUS_TONE: Record<DonationStatus, string> = {
  PLEDGED: "text-amber-600",
  RECEIVED: "text-accent",
  REJECTED: "text-destructive",
  CANCELLED: "text-muted-foreground",
};

/** `<Badge>` classes — the admin ledger and the review dialog, which both chip it. */
export const STATUS_BADGE: Record<DonationStatus, string> = {
  PLEDGED: "bg-amber-500/15 text-amber-600 border-0",
  RECEIVED: "bg-accent/15 text-accent border-0",
  REJECTED: "bg-destructive/15 text-destructive border-0",
  CANCELLED: "bg-muted text-muted-foreground border-0",
};

/** Where a donor pays — `GET /donations/payment-details`. */
export interface PaymentDetails {
  upiId: string;
  payeeName: string;
  qrKey: string;
  bankDetails: string;
  instructions: string;
  /** False until the office has published at least one way to pay. */
  configured: boolean;
}

/** A gift as the donor sees it on `/dashboard/donations`. */
export interface MyDonation {
  id: string;
  amount: number;
  status: DonationStatus;
  createdAt: string;
  paidAt?: string | null;
  verifiedAt?: string | null;
  paymentMethod?: string | null;
  reference?: string | null;
  receiptNo?: string | null;
  receiptKey?: string | null;
  rejectionReason?: string | null;
  /** What the gift was earmarked for; null means the general fund. */
  campaign?: { id: string; title: string } | null;
}

/**
 * A donation as the alumni office sees it — one shape for the ledger table, the
 * verification queue and the review dialog, because all three read the same row
 * from `GET /donations` and drifting copies of it was how a field ended up
 * fetched by the server and drawn by nobody.
 *
 * Every field here is rendered somewhere. `Donation` carries more (`currency`,
 * `archivedAt`, `campaignId`), and this deliberately does not: adding one back
 * means deciding where it appears.
 */
export interface AdminDonation {
  id: string;
  amount: number;
  status: DonationStatus;
  createdAt: string;
  /** What the donor declared. */
  reference?: string | null;
  paymentMethod?: string | null;
  paidAt?: string | null;
  message?: string | null;
  isAnonymous?: boolean;
  proofKey?: string | null;
  /** Snapshotted at submission, so a later profile edit can't rewrite a receipt. */
  donorName?: string | null;
  donorEmail?: string | null;
  campaign?: { id: string; title: string } | null;
  user: { id: string | null; firstName: string; lastName: string; email?: string };
  /** The office's decision. */
  receiptNo?: string | null;
  receiptKey?: string | null;
  verifiedAt?: string | null;
  verifiedBy?: { id: string; firstName: string; lastName: string } | null;
  rejectionReason?: string | null;
  /** Append-only audit trail — submitted, verified, rejected, receipt sent. */
  ledgerEntries?: DonationLedgerEntry[];
}

export interface DonationLedgerEntry {
  id: string;
  entryType: string;
  note?: string | null;
  createdAt: string;
}

/**
 * `GET /donations/stats` — the ledger's header totals.
 *
 * Computed server-side over the whole filtered set rather than from the rows on
 * screen, because the ledger is paginated and a total that meant "page 3" would
 * be worse than no total.
 */
export interface DonationStats {
  totalReceived: number;
  thisMonthReceived: number;
  donorCount: number;
  pendingCount: number;
  byCampaign: { campaignId: string | null; title: string; received: number; count: number }[];
}

/** A fundraising campaign a donor can earmark their gift for. */
export interface Campaign {
  id: string;
  title: string;
  description: string;
  goalAmount: number;
  raisedAmount?: number;
  startsAt: string;
  endsAt?: string | null;
  isActive: boolean;
}

export const formatINR = (n: number) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

/**
 * A UPI deep link, so a donor on a phone can pay without scanning their own
 * screen. Built only when there is a VPA to pay to — `upi://` with an empty
 * `pa` opens an app that cannot do anything.
 */
export const upiPayUrl = (d: Pick<PaymentDetails, "upiId" | "payeeName">, amount?: number) => {
  if (!d.upiId) return null;
  const params = new URLSearchParams({ pa: d.upiId, cu: "INR" });
  if (d.payeeName) params.set("pn", d.payeeName);
  if (amount && amount > 0) params.set("am", String(amount));
  return `upi://pay?${params.toString()}`;
};
