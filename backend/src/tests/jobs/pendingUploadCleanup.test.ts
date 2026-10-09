/**
 * `POST /auth/register/identity-document` is the only upload endpoint with no
 * session in front of it — the file is collected before the account exists. This
 * sweep is what bounds it, so what matters is that it deletes what nobody
 * claimed and, much more importantly, that it never touches what somebody did.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma: prismaMock }));
const storageDelete = jest.fn(async (_k: string) => undefined);
jest.unstable_mockModule("../../storage/index.js", () => ({
  getStorage: () => ({ delete: storageDelete }),
}));

const { runPendingUploadCleanup } = await import("../../jobs/pendingUploadCleanup.js");
const { PENDING_UPLOAD_RETENTION_HOURS } = await import("../../config/constants.js");

const NOW = new Date("2026-09-10T12:00:00.000Z");

beforeEach(() => {
  storageDelete.mockReset();
  storageDelete.mockResolvedValue(undefined);
  Object.values(prismaMock).forEach((m: any) =>
    m && typeof m === "object" ? Object.values(m).forEach((fn: any) => fn?.mockReset?.()) : null,
  );
});

describe("runPendingUploadCleanup", () => {
  /**
   * The claimed rows' keys also live on a `Profile.identityDocumentKey`.
   * Sweeping one would delete the evidence an admin approves accounts against —
   * this predicate is the only thing standing between the two.
   */
  it("only ever looks at unclaimed uploads past the window", async () => {
    prismaMock.pendingIdentityDocument.findMany.mockResolvedValueOnce([]);
    await runPendingUploadCleanup(PENDING_UPLOAD_RETENTION_HOURS, NOW);

    const args = prismaMock.pendingIdentityDocument.findMany.mock.calls[0][0] as any;
    expect(args.where.claimedAt).toBeNull();
    expect(args.where.createdAt.lt).toEqual(
      new Date(NOW.getTime() - PENDING_UPLOAD_RETENTION_HOURS * 60 * 60 * 1000),
    );
    // Oldest first and bounded, so a first run on a busy database can't hold
    // the worker's lease indefinitely.
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.take).toBe(500);
  });

  it("deletes the object, then the row", async () => {
    prismaMock.pendingIdentityDocument.findMany.mockResolvedValueOnce([
      { id: "p-1", objectKey: "identity/p-1/marksheet.jpg" },
    ]);
    const order: string[] = [];
    storageDelete.mockImplementation(async (key: string) => { order.push(`storage:${key}`); });
    prismaMock.pendingIdentityDocument.delete.mockImplementation(async () => {
      order.push("row");
      return {} as never;
    });

    const out = await runPendingUploadCleanup(PENDING_UPLOAD_RETENTION_HOURS, NOW);

    expect(order).toEqual(["storage:identity/p-1/marksheet.jpg", "row"]);
    expect(out).toEqual({ scanned: 1, deleted: 1, failed: 0 });
  });

  /**
   * A row whose upload failed before the key was written still carries the
   * `pending:` placeholder. There is no object behind it, and asking storage to
   * delete one would be a guaranteed failure that stalls the row forever.
   */
  it("skips storage for a row whose upload never produced a key", async () => {
    prismaMock.pendingIdentityDocument.findMany.mockResolvedValueOnce([
      { id: "p-2", objectKey: "pending:abc-123" },
    ]);
    prismaMock.pendingIdentityDocument.delete.mockResolvedValueOnce({} as never);

    const out = await runPendingUploadCleanup(PENDING_UPLOAD_RETENTION_HOURS, NOW);

    expect(storageDelete).not.toHaveBeenCalled();
    expect(out.deleted).toBe(1);
  });

  it("keeps the row when its object could not be deleted", async () => {
    prismaMock.pendingIdentityDocument.findMany.mockResolvedValueOnce([
      { id: "p-3", objectKey: "identity/p-3/card.png" },
    ]);
    storageDelete.mockRejectedValueOnce(new Error("bucket unreachable") as never);

    const out = await runPendingUploadCleanup(PENDING_UPLOAD_RETENTION_HOURS, NOW);

    expect(prismaMock.pendingIdentityDocument.delete).not.toHaveBeenCalled();
    expect(out).toEqual({ scanned: 1, deleted: 0, failed: 1 });
  });

  it("carries on past one bad row", async () => {
    prismaMock.pendingIdentityDocument.findMany.mockResolvedValueOnce([
      { id: "p-1", objectKey: "identity/p-1/a.jpg" },
      { id: "p-2", objectKey: "identity/p-2/b.jpg" },
    ]);
    storageDelete.mockRejectedValueOnce(new Error("nope") as never);
    prismaMock.pendingIdentityDocument.delete.mockResolvedValue({} as never);

    const out = await runPendingUploadCleanup(PENDING_UPLOAD_RETENTION_HOURS, NOW);

    expect(out).toEqual({ scanned: 2, deleted: 1, failed: 1 });
  });
});
