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
 * Revoked and used rows are kept for `AUDIT_WINDOW_DAYS` rather than deleted on
 * sight: "this refresh token was revoked at 04:12" is the trail you want after
 * a suspected account takeover, and it is worthless if the row vanished the
 * moment it was revoked.
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
): Promise<TokenCleanupResult> => {
  const now = new Date();
  const auditCutoff = new Date(now.getTime() - auditWindowDays * 24 * 60 * 60 * 1000);

  const [refreshTokens, passwordResetTokens, emailOtps] = await Promise.all([
    prisma.refreshToken.deleteMany({
      where: {
        OR: [
          // Expired: cannot be exchanged, whatever its revocation state.
          { expiresAt: { lt: now } },
          // Revoked, and old enough that the trail has served its purpose.
          { revokedAt: { lt: auditCutoff } },
        ],
      },
    }),
    prisma.passwordResetToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: auditCutoff } }],
      },
    }),
    // These are short-lived by design and carry no audit value once consumed —
    // `auth.service.ts` already clears a user's codes when one is redeemed.
    prisma.emailVerificationOtp.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { consumedAt: { lt: auditCutoff } }],
      },
    }),
  ]);

  const result = {
    refreshTokens: refreshTokens.count,
    passwordResetTokens: passwordResetTokens.count,
    emailOtps: emailOtps.count,
  };
  logger.info(result, "token cleanup complete");
  return result;
};
