/**
 * Sweeps identity documents that no sign-up ever claimed.
 *
 * `POST /auth/register/identity-document` is the one upload endpoint with no
 * session in front of it — the file is collected before the account exists, so
 * there is nothing yet to authenticate. What stops that being a bucket anyone
 * can fill is this: an upload has `PENDING_UPLOAD_RETENTION_HOURS` to be
 * claimed by a registration, and after that it and its object are deleted.
 *
 * A *claimed* row is left alone. Its `objectKey` now also lives on a
 * `Profile.identityDocumentKey`, and deleting the object here would take the
 * admin's evidence with it. The claimed rows are the audit trail of what was
 * uploaded when, and they are tiny.
 *
 * Object first, row second — the same ordering as every other sweep in
 * `jobs/`: the key is only reachable through the row, so deleting the row first
 * would strand the file with nothing left naming it. A storage failure leaves
 * both for the next run.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { getStorage } from "../storage/index.js";
import { PENDING_UPLOAD_RETENTION_HOURS } from "../config/constants.js";

export interface PendingUploadCleanupResult {
  scanned: number;
  deleted: number;
  failed: number;
}

/** Bounded, for the same reason the retention sweep is: the first run may have a backlog. */
const MAX_PER_RUN = 500;

export const runPendingUploadCleanup = async (
  retentionHours: number = PENDING_UPLOAD_RETENTION_HOURS,
  now: Date = new Date(),
): Promise<PendingUploadCleanupResult> => {
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);
  const rows = await prisma.pendingIdentityDocument.findMany({
    where: { claimedAt: null, createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: MAX_PER_RUN,
    select: { id: true, objectKey: true },
  });

  let deleted = 0;
  let failed = 0;
  const storage = getStorage();
  for (const row of rows) {
    try {
      // A row whose upload failed before the key was written still carries the
      // `pending:` placeholder — there is no object to delete for those.
      if (!row.objectKey.startsWith("pending:")) await storage.delete(row.objectKey);
    } catch (err) {
      failed += 1;
      logger.warn(
        { err, id: row.id },
        "pending upload cleanup: storage delete failed; will retry next sweep",
      );
      continue;
    }
    try {
      await prisma.pendingIdentityDocument.delete({ where: { id: row.id } });
      deleted += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, id: row.id }, "pending upload cleanup: row delete failed");
    }
  }

  logger.info({ scanned: rows.length, deleted, failed }, "pending upload cleanup complete");
  return { scanned: rows.length, deleted, failed };
};
