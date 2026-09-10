-- Index the columns the nightly token sweep filters on.
--
-- `jobs/tokenCleanup.ts` runs a `deleteMany` over each of these tables every
-- night. None of the predicates was indexed, so each sweep was a sequential
-- scan of every token the platform had ever issued — cheap today, and quietly
-- proportional to lifetime logins.
--
-- Refresh and reset tokens are swept by *age*, because a row has to be both
-- spent and past the 30-day audit window before it may go; email OTPs are
-- swept on expiry, because a ten-minute code has no audit value.


-- CreateIndex
CREATE INDEX "EmailVerificationOtp_expiresAt_idx" ON "EmailVerificationOtp"("expiresAt");

-- CreateIndex
CREATE INDEX "RefreshToken_createdAt_idx" ON "RefreshToken"("createdAt");

-- CreateIndex
CREATE INDEX "PasswordResetToken_createdAt_idx" ON "PasswordResetToken"("createdAt");
