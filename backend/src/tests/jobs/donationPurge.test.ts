/**
 * Unit tests for the rejected-donation retention sweep.
 *
 * Two things must hold, and neither is obvious from the code alone: the sweep
 * touches only REJECTED rows past their archive window, and it deletes the
 * proof screenshot *before* the row — reversing that order would strand the
 * file in storage with nothing left pointing at it.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma: prismaMock }));
const storageDelete = jest.fn(async () => undefined);
jest.unstable_mockModule("../../storage/index.js", () => ({
  getStorage: () => ({ delete: storageDelete }),
}));

const { runDonationPurge } = await import("../../jobs/donationPurge.js");
const { DONATION_ARCHIVE_RETENTION_DAYS } = await import("../../config/constants.js");

beforeEach(() => {
  storageDelete.mockReset();
  storageDelete.mockResolvedValue(undefined);
  Object.values(prismaMock).forEach((m: any) =>
    m && typeof m === "object" ? Object.values(m).forEach((fn: any) => fn?.mockReset?.()) : null,
  );
});

describe("runDonationPurge", () => {
  it("sweeps only rejected rows archived before the cutoff", async () => {
    prismaMock.donation.findMany.mockResolvedValueOnce([]);
    await runDonationPurge();

    const where = (prismaMock.donation.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toBe("REJECTED");
    const cutoff: Date = where.archivedAt.lt;
    const expected = Date.now() - DONATION_ARCHIVE_RETENTION_DAYS * 86_400_000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
    // A row an admin later approved has `archivedAt` cleared; the null guard
    // keeps it out even before the status predicate does.
    expect(where.archivedAt.not).toBeNull();
  });

  it("deletes the proof file, then the row", async () => {
    prismaMock.donation.findMany.mockResolvedValueOnce([
      { id: "d1", proofKey: "donation-proof/u-1/shot.png" },
      { id: "d2", proofKey: null },
    ]);
    prismaMock.donation.delete.mockResolvedValue({} as never);

    const out = await runDonationPurge();

    expect(storageDelete).toHaveBeenCalledWith("donation-proof/u-1/shot.png");
    // The row with no screenshot still goes; only the file step is skipped.
    expect(storageDelete).toHaveBeenCalledTimes(1);
    expect(prismaMock.donation.delete).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ scanned: 2, deleted: 2, failed: 0 });
  });

  it("keeps the row when its file could not be deleted, so the next sweep retries", async () => {
    prismaMock.donation.findMany.mockResolvedValueOnce([
      { id: "d1", proofKey: "donation-proof/u-1/shot.png" },
      { id: "d2", proofKey: "donation-proof/u-2/shot.png" },
    ]);
    storageDelete.mockRejectedValueOnce(new Error("bucket unreachable") as never);
    prismaMock.donation.delete.mockResolvedValue({} as never);

    const out = await runDonationPurge();

    expect(prismaMock.donation.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.donation.delete).toHaveBeenCalledWith({ where: { id: "d2" } });
    expect(out).toEqual({ scanned: 2, deleted: 1, failed: 1 });
  });

  it("takes an explicit retention window", async () => {
    prismaMock.donation.findMany.mockResolvedValueOnce([]);
    await runDonationPurge(7);
    const cutoff: Date = (prismaMock.donation.findMany.mock.calls[0][0] as any).where.archivedAt.lt;
    expect(Math.abs(cutoff.getTime() - (Date.now() - 7 * 86_400_000))).toBeLessThan(5_000);
  });
});
