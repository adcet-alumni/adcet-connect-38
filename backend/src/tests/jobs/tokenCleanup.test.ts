/**
 * The sweep must delete only tokens that can no longer authenticate anything,
 * and must keep a spent one long enough to be evidence.
 *
 * The subtle failure these are built around is the one the first version had:
 * deleting on expiry alone *looks* like it respects the audit window sitting
 * beside it, and does not. A refresh token lives seven days, so a row revoked
 * during a takeover expired — and was swept — three weeks before the 30-day
 * trail it was being kept for had run. The window has to gate the deletion, not
 * merely appear in it.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma: prismaMock }));

const { runTokenCleanup, AUDIT_WINDOW_DAYS } = await import("../../jobs/tokenCleanup.js");

const MODELS = ["refreshToken", "passwordResetToken", "emailVerificationOtp"] as const;
/** The two that carry an audit trail; OTPs deliberately do not. */
const AUDITED = ["refreshToken", "passwordResetToken"] as const;

const NOW = new Date("2026-09-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  for (const m of MODELS) {
    prismaMock[m].deleteMany.mockReset();
    prismaMock[m].deleteMany.mockResolvedValue({ count: 0 });
  }
});

/** The `where` each model was swept with. */
const whereFor = (model: (typeof MODELS)[number]) =>
  (prismaMock[model].deleteMany.mock.calls[0][0] as any).where;

/** Does this `where` match the row? Enough of Prisma's shape for these predicates. */
const matches = (where: any, row: Record<string, Date | null>): boolean => {
  const test = (clause: any): boolean =>
    Object.entries(clause).every(([field, cond]: [string, any]) => {
      const value = row[field] ?? null;
      if (cond?.not === null) return value !== null;
      if (cond?.lt) return value !== null && value < cond.lt;
      return false;
    });
  const { OR, ...rest } = where;
  if (Object.keys(rest).length > 0 && !test(rest)) return false;
  return OR ? OR.some(test) : true;
};

describe("runTokenCleanup", () => {
  it("sweeps all three token tables", async () => {
    prismaMock.refreshToken.deleteMany.mockResolvedValueOnce({ count: 7 });
    prismaMock.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 2 });
    prismaMock.emailVerificationOtp.deleteMany.mockResolvedValueOnce({ count: 5 });

    const out = await runTokenCleanup(AUDIT_WINDOW_DAYS, NOW);

    expect(out).toEqual({ refreshTokens: 7, passwordResetTokens: 2, emailOtps: 5 });
  });

  /**
   * The regression this file exists for. A token revoked yesterday has already
   * expired — refresh tokens live seven days — and must still be in the table
   * for an investigator to find.
   */
  it("keeps a token revoked yesterday, even though it expired long ago", async () => {
    await runTokenCleanup(AUDIT_WINDOW_DAYS, NOW);

    const row = {
      createdAt: new Date(NOW.getTime() - 8 * DAY),
      expiresAt: new Date(NOW.getTime() - DAY),
      revokedAt: new Date(NOW.getTime() - DAY),
    };
    expect(matches(whereFor("refreshToken"), row)).toBe(false);
  });

  it("deletes it once the audit window has run", async () => {
    await runTokenCleanup(AUDIT_WINDOW_DAYS, NOW);

    const row = {
      createdAt: new Date(NOW.getTime() - (AUDIT_WINDOW_DAYS + 1) * DAY),
      expiresAt: new Date(NOW.getTime() - AUDIT_WINDOW_DAYS * DAY),
      revokedAt: new Date(NOW.getTime() - AUDIT_WINDOW_DAYS * DAY),
    };
    expect(matches(whereFor("refreshToken"), row)).toBe(true);
  });

  it.each([
    ["expired long ago", { expiresAt: -1, revokedAt: null }],
    ["revoked but not yet expired", { expiresAt: +5, revokedAt: -1 }],
  ])("deletes an old token that is %s", async (_label, shape) => {
    await runTokenCleanup(AUDIT_WINDOW_DAYS, NOW);

    const row = {
      createdAt: new Date(NOW.getTime() - 40 * DAY),
      expiresAt: new Date(NOW.getTime() + shape.expiresAt * DAY),
      revokedAt: shape.revokedAt === null ? null : new Date(NOW.getTime() + shape.revokedAt * DAY),
    };
    expect(matches(whereFor("refreshToken"), row)).toBe(true);
  });

  /**
   * The safety property, and the reason `createdAt` cannot be the only rule: a
   * deployment with a long `JWT_REFRESH_TTL` would otherwise have its members
   * silently logged out by a cleanup job.
   */
  it("never deletes a token that could still authenticate, however old", async () => {
    await runTokenCleanup(AUDIT_WINDOW_DAYS, NOW);

    for (const model of AUDITED) {
      const stillLive = {
        createdAt: new Date(NOW.getTime() - 400 * DAY),
        expiresAt: new Date(NOW.getTime() + 30 * DAY),
        revokedAt: null,
        usedAt: null,
      };
      expect(matches(whereFor(model), stillLive)).toBe(false);
    }
  });

  it("drives each audited sweep off the indexed createdAt column", async () => {
    await runTokenCleanup(AUDIT_WINDOW_DAYS, NOW);

    for (const model of AUDITED) {
      const where = whereFor(model);
      // Not inside the OR: an OR branch cannot be the driving index scan, which
      // is the whole reason the nightly sweep was a sequential scan before.
      expect(where.createdAt.lt).toEqual(new Date(NOW.getTime() - AUDIT_WINDOW_DAYS * DAY));
      expect(where.OR).toHaveLength(2);
    }
  });

  it("honours a caller-supplied audit window", async () => {
    await runTokenCleanup(1, NOW);
    expect(whereFor("refreshToken").createdAt.lt).toEqual(new Date(NOW.getTime() - DAY));
  });

  /**
   * OTPs are the deliberate exception: ten minutes long, cleared on redemption
   * by `sendRegistrationOtp`, and a spent 6-digit code tells an investigation
   * nothing. Keeping them for a month would grow a table for no reason.
   */
  it("sweeps email OTPs on expiry alone, with no audit window", async () => {
    await runTokenCleanup(AUDIT_WINDOW_DAYS, NOW);

    const where = whereFor("emailVerificationOtp");
    expect(where).toEqual({ expiresAt: { lt: NOW } });
    expect(where.OR).toBeUndefined();
    expect(where.createdAt).toBeUndefined();
  });

  it("bounds every clause by time — an empty where would take live sessions", async () => {
    await runTokenCleanup(AUDIT_WINDOW_DAYS, NOW);

    for (const model of MODELS) {
      const where = whereFor(model);
      expect(Object.keys(where).length).toBeGreaterThan(0);
      // Every predicate names either an instant or "has been spent"; none is a
      // bare match-everything.
      const clauses = [...(where.OR ?? []), ...(where.createdAt ? [{ createdAt: where.createdAt }] : []),
        ...(where.expiresAt ? [{ expiresAt: where.expiresAt }] : [])];
      expect(clauses.length).toBeGreaterThan(0);
      for (const clause of clauses) {
        const [bound] = Object.values(clause) as any[];
        expect(bound.lt instanceof Date || bound.not === null).toBe(true);
      }
    }
  });
});
