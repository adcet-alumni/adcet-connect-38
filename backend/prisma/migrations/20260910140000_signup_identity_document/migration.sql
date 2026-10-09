-- Proof of being an alumnus, collected at sign-up.
--
-- Until now nothing on the account said whether the person had actually
-- studied here: an admin approving a registration had a name, a batch and a
-- department, all of them typed by the applicant. Sign-up now requires a
-- library card, marksheet, leaving certificate or degree certificate, and the
-- admin reviewing the account is shown it.
--
-- The upload happens before the email is verified, so there is no account to
-- own the object yet. `PendingIdentityDocument` is the bridge between the
-- anonymous upload and `register()`; `claimedAt` makes the exchange single-use,
-- and unclaimed rows are swept with their objects by the cleanup job.

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "identityDocumentKey" TEXT;
-- CreateTable
CREATE TABLE "PendingIdentityDocument" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    CONSTRAINT "PendingIdentityDocument_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "PendingIdentityDocument_objectKey_key" ON "PendingIdentityDocument"("objectKey");
-- CreateIndex
CREATE INDEX "PendingIdentityDocument_claimedAt_createdAt_idx" ON "PendingIdentityDocument"("claimedAt", "createdAt");
