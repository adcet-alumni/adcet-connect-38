/**
 * Sweep spent authentication tokens.
 *
 * `RefreshToken`, `PasswordResetToken` and `EmailVerificationOtp` rows are
 * written on every login, reset and sign-up and were never deleted. One member
 * signing in twice a day leaves ~730 dead refresh rows a year, all of them
 * indexed and all of them scanned by the unique lookup on every token refresh.
 *
 * Only rows that can no longer authenticate anything are removed, so this is
 * not a policy decision the way résumé retention is — a revoked or expired
 * token is already refused by `auth.service.ts`, and deleting it changes
 * nothing a user can observe.
 *
 * ## Two rules, and why they are shaped this way
 *
 * **A row must be both spent *and* old.** The obvious predicate — "delete
 * anything expired" — silently defeats the audit window it sits beside: a
 * refresh token lives `JWT_REFRESH_TTL` (7 days by default), so a row revoked
 * during a takeover was expired, and therefore deleted, three weeks before the
 * 30-day trail it was being kept for had run. "This refresh token was revoked
 * at 04:12" is exactly what an incident review a fortnight later needs. So
 * `createdAt` decides *when* a row may go and the spent-ness decides *whether*
 * it may — a token still capable of authenticating is never touched, however
 * old, which is what keeps a deployment with a long `JWT_REFRESH_TTL` from
 * having its members quietly logged out by a cleanup job.
 *
 * **`createdAt` leads the predicate because it is the indexed one.** Each of
 * the three tables carries `@@index([createdAt])` for this sweep; without it a
 * nightly `deleteMany` on `expiresAt` is a sequential scan of every token the
 * platform has ever issued.
 *
 * Email OTPs are the exception to both: they live ten minutes, `register()`
 * already clears an address's codes when one is redeemed, and a spent 6-digit
 * code is worth nothing to an investigation. They go as soon as they expire.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/** How long a spent token stays readable for incident review. */
export const AUDIT_WINDOW_DAYS = 30;

export interface TokenCleanupResult {
  refreshTokens: number;
  passwordResetTokens: number;
  emailOtps: number;
}

export const runTokenCleanup = async (
  auditWindowDays = AUDIT_WINDOW_DAYS,
  now: Date = new Date(),
): Promise<TokenCleanupResult> => {
  const auditCutoff = new Date(now.getTime() - auditWindowDays * 24 * 60 * 60 * 1000);

  const [refreshTokens, passwordResetTokens, emailOtps] = await Promise.all([
    prisma.refreshToken.deleteMany({
      where: {
        // Old enough that the trail has served its purpose...
        createdAt: { lt: auditCutoff },
        // ...and unable to authenticate anything regardless.
        OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }],
      },
    }),
    prisma.passwordResetToken.deleteMany({
      where: {
        createdAt: { lt: auditCutoff },
        OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }],
      },
    }),
    // Ten-minute lifetime, no audit value once spent — and `sendRegistrationOtp`
    // already drops an address's older codes. Expiry alone is the whole rule.
    prisma.emailVerificationOtp.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);

  const result = {
    refreshTokens: refreshTokens.count,
    passwordResetTokens: passwordResetTokens.count,
    emailOtps: emailOtps.count,
  };
  logger.info(result, "token cleanup complete");
  return result;
};
