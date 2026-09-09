/**
 * Lightweight Prisma mock factory.
 *
 * `jest.mock("../../lib/prisma.js", () => ({ prisma: createPrismaMock() }))` at
 * the top of any service test gives you a fully-stubbed Prisma client where
 * every model exposes the methods we actually use (`findUnique`, `findMany`,
 * `create`, `update`, `updateMany`, `delete`, `deleteMany`, `count`, `upsert`).
 *
 * Each method is a `jest.fn()` so individual tests can stub return values per
 * assertion (`prisma.user.findUnique.mockResolvedValue(...)`) without leaking
 * state across tests — the global Jest config sets `clearMocks: true`.
 *
 * Add new models here as they appear in `prisma/schema.prisma`.
 */
import { jest } from "@jest/globals";

const MODEL_METHODS = [
  "findUnique",
  "findFirst",
  "findMany",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

const MODELS = [
  "user",
  "userRole",
  "profile",
  "chapter",
  "chapterInvitation",
  "userPreferences",
  "refreshToken",
  "passwordResetToken",
  "emailVerificationOtp",
  "event",
  "eventRsvp",
  "job",
  "jobApplication",
  "achievement",
  "donation",
  "donationCampaign",
  "donationLedgerEntry",
  "auditLog",
  "notification",
  "newsItem",
  "newsletter",
  "galleryAlbum",
  "galleryPhoto",
  "supportMessage",
  "siteSection",
  "workExperience",
  "education",
  "skill",
  "profileSkill",
  "post",
  "postMedia",
  "postLike",
  "postComment",
  "postReport",
  "appSetting",
  "postQuotaUsage",
  "geoLocation",
  "collaborationRequest",
] as const;

export type MockedPrisma = {
  [K in (typeof MODELS)[number]]: { [M in (typeof MODEL_METHODS)[number]]: jest.Mock };
} & {
  $transaction: jest.Mock;
  /**
   * Aggregations that Prisma's query builder cannot express — `date_trunc`
   * month bucketing, chiefly — go through raw SQL. Stubbing this lets a unit
   * test pin how those rows are *transformed*; whether the SQL itself groups
   * and filters correctly is only answerable against a real database, which is
   * what the tests under `tests/modules/analytics/insights.test.ts` do.
   */
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
};

export const createPrismaMock = (): MockedPrisma => {
  const out = {} as any;
  for (const m of MODELS) {
    out[m] = {};
    for (const fn of MODEL_METHODS) out[m][fn] = jest.fn();
  }
  out.$queryRaw = jest.fn(async () => []);
  out.$executeRaw = jest.fn(async () => 0);
  // $transaction defaults to running each promise in the array sequentially.
  out.$transaction = jest.fn(async (arg: any) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    if (typeof arg === "function") return arg(out);
    return arg;
  });
  return out;
};