/**
 * Rejected-donation retention sweep.
 *
 * A gift the alumni office could not match against the bank statement is
 * *archived*, not deleted, so the donor has something to point at when they
 * come back with the right reference. That grace period is what this job ends:
 * `DONATION_ARCHIVE_RETENTION_DAYS` after `archivedAt`, the row and its proof
 * screenshot go for good.
 *
 * Two rules it must keep:
 *
 *  - **Only `REJECTED` rows.** `archivedAt` is written by `reject()` and
 *    cleared by `approve()`, so a rejection an admin later reversed is no
 *    longer visible here — but the status predicate is what makes that safe
 *    rather than merely likely, and it is why a received gift can never be
 *    swept by a stale timestamp.
 *  - **The file first, the row second.** Deleting the row first would strand
 *    the screenshot in storage with nothing left pointing at it. A storage
 *    failure skips the row and the next sweep retries it.
 *
 * Idempotent: a row deleted on one pass is gone from the next one's query.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { getStorage } from "../storage/index.js";
import { DONATION_ARCHIVE_RETENTION_DAYS } from "../config/constants.js";

export interface DonationPurgeResult {
  scanned: number;
  deleted: number;
  failed: number;
}

export const runDonationPurge = async (
  retentionDays: number = DONATION_ARCHIVE_RETENTION_DAYS,
): Promise<DonationPurgeResult> => {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.donation.findMany({
    where: { status: "REJECTED", archivedAt: { not: null, lt: cutoff } },
    select: { id: true, proofKey: true },
  });

  let deleted = 0;
  let failed = 0;
  const storage = getStorage();
  for (const row of rows) {
    try {
      if (row.proofKey) await storage.delete(row.proofKey);
    } catch (e) {
      failed += 1;
      logger.warn(
        { err: e, donationId: row.id, key: row.proofKey },
        "donation proof delete failed; will retry next sweep",
      );
      continue;
    }
    try {
      // Ledger entries cascade with the donation (`onDelete: Cascade`).
      await prisma.donation.delete({ where: { id: row.id } });
      deleted += 1;
    } catch (e) {
      failed += 1;
      logger.warn({ err: e, donationId: row.id }, "archived donation delete failed");
    }
  }

  logger.info(
    { scanned: rows.length, deleted, failed, retentionDays },
    "archived donation purge complete",
  );
  return { scanned: rows.length, deleted, failed };
};
