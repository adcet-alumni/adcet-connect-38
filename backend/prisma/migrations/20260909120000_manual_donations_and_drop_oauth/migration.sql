-- Two removals and one replacement, in one migration because they land together:
--
--  1. Social sign-in (Google / LinkedIn / GitHub) is gone, so `OAuthAccount`
--     has no writer left. Every account is now email + password.
--  2. Razorpay is gone: the college would not carry the gateway fee. A gift is
--     now paid off-portal against a UPI QR or bank transfer, declared by the
--     donor, and confirmed by an admin against the bank statement — so the
--     gateway's order/payment/signature columns are replaced by the donor's
--     own transaction reference plus the admin's decision.

-- ---------------------------------------------------------------------------
-- 1. Social sign-in
-- ---------------------------------------------------------------------------
ALTER TABLE "OAuthAccount" DROP CONSTRAINT "OAuthAccount_userId_fkey";
DROP TABLE "OAuthAccount";

-- ---------------------------------------------------------------------------
-- 2. Donations: gateway columns -> manual verification columns
-- ---------------------------------------------------------------------------
ALTER TYPE "DonationStatus" ADD VALUE 'REJECTED';

ALTER TABLE "Donation"
  ADD COLUMN "reference"       TEXT,
  ADD COLUMN "verifiedAt"      TIMESTAMP(3),
  ADD COLUMN "verifiedById"    TEXT,
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "archivedAt"      TIMESTAMP(3);

-- Carry the gateway payment id over as the transaction reference so historical
-- gifts keep the identifier they were reconciled by. Only the first row wins a
-- duplicate id: the new column is unique, and a duplicate there would be a
-- double-claim of one transaction.
UPDATE "Donation" d
   SET "reference" = d."razorpayPaymentId"
 WHERE d."razorpayPaymentId" IS NOT NULL
   AND d.id = (
     SELECT e.id FROM "Donation" e
      WHERE e."razorpayPaymentId" = d."razorpayPaymentId"
      ORDER BY e."createdAt" ASC, e.id ASC
      LIMIT 1
   );

-- Gifts already banked were verified by definition; date them from the payment
-- so the ledger does not show them as awaiting a decision that already happened.
UPDATE "Donation"
   SET "verifiedAt" = COALESCE("paidAt", "createdAt")
 WHERE "status" = 'RECEIVED' AND "verifiedAt" IS NULL;

DROP INDEX "Donation_razorpayOrderId_key";
DROP INDEX "Donation_razorpayPaymentId_idx";

ALTER TABLE "Donation"
  DROP COLUMN "provider",
  DROP COLUMN "razorpayOrderId",
  DROP COLUMN "razorpayPaymentId",
  DROP COLUMN "razorpaySignature";

CREATE UNIQUE INDEX "Donation_reference_key" ON "Donation"("reference");
CREATE INDEX "Donation_status_archivedAt_idx" ON "Donation"("status", "archivedAt");

ALTER TABLE "Donation"
  ADD CONSTRAINT "Donation_verifiedById_fkey"
  FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
