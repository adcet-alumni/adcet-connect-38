/**
 * The sweep must delete only tokens that can no longer authenticate anything,
 * and must keep a recently-revoked one long enough to be evidence.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma: prismaMock }));

const { runTokenCleanup, AUDIT_WINDOW_DAYS } = await import("../../jobs/tokenCleanup.js");

const MODELS = ["refreshToken", "passwordResetToken", "emailVerificationOtp"] as const;

beforeEach(() => {
  for (const m of MODELS) {
    prismaMock[m].deleteMany.mockReset();
    prismaMock[m].deleteMany.mockResolvedValue({ count: 0 });
  }
});

/** The `where` each model was swept with. */
const whereFor = (model: (typeof MODELS)[number]) =>
  (prismaMock[model].deleteMany.mock.calls[0][0] as any).where;

describe("runTokenCleanup", () => {
  it("sweeps all three token tables", async () => {
    prismaMock.refreshToken.deleteMany.mockResolvedValueOnce({ count: 7 });
    prismaMock.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 2 });
    prismaMock.emailVerificationOtp.deleteMany.mockResolvedValueOnce({ count: 5 });

    const out = await runTokenCleanup();

    expect(out).toEqual({ refreshTokens: 7, passwordResetTokens: 2, emailOtps: 5 });
  });

  it("deletes expired tokens whatever their revocation state", async () => {
    const before = Date.now();
    await runTokenCleanup();

    for (const model of MODELS) {
      const expired = whereFor(model).OR.find((c: any) => c.expiresAt);
      expect(expired.expiresAt.lt.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("keeps a revoked token for the audit window before removing it", async () => {
    await runTokenCleanup();

    // "This refresh token was revoked at 04:12" is the trail you want after a
    // suspected takeover, so revocation alone must not delete the row.
    const revoked = whereFor("refreshToken").OR.find((c: any) => c.revokedAt);
    expect(revoked).toBeDefined();
    const age = Date.now() - revoked.revokedAt.lt.getTime();
    expect(Math.round(age / 86_400_000)).toBe(AUDIT_WINDOW_DAYS);

    // A revoked-but-unexpired token is not matched by either clause, so it
    // survives — which is the whole point of the window.
    expect(whereFor("refreshToken").OR).toHaveLength(2);
  });

  it("honours a caller-supplied audit window", async () => {
    await runTokenCleanup(1);

    const revoked = whereFor("refreshToken").OR.find((c: any) => c.revokedAt);
    const age = Date.now() - revoked.revokedAt.lt.getTime();
    expect(Math.round(age / 86_400_000)).toBe(1);
  });

  it("never deletes a token that is merely unused", async () => {
    // Every clause must name a time bound; a bare `{ usedAt: { not: null } }`
    // or an empty `where` would take live sessions out with the dead ones.
    for (const model of MODELS) {
      await runTokenCleanup();
      const where = whereFor(model);
      expect(Object.keys(where)).toEqual(["OR"]);
      for (const clause of where.OR) {
        const [bound] = Object.values(clause) as any[];
        expect(bound.lt).toBeInstanceOf(Date);
      }
      prismaMock[model].deleteMany.mockClear();
    }
  });
});
