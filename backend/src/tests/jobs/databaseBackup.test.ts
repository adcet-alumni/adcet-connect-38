/**
 * The monthly backup.
 *
 * Three things have to hold, and none of them is about `pg_dump` working:
 *
 *  - it is **off unless asked for**, because a dump is the whole platform in
 *    one object and must never appear somewhere by default;
 *  - it is **idempotent per calendar month**, which is what lets a daily tick
 *    stand in for a monthly schedule without drifting or double-running; and
 *  - a `DatabaseBackup` row **always means the object exists** — the row is
 *    written after the upload, never before, and a failure anywhere leaves no
 *    row so the next day retries.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma: prismaMock }));

const uploadMock = jest.fn(async () => ({ key: "backup/2026-09/abc-adcet-2026-09.dump", publicUrl: "" }));
const deleteMock = jest.fn(async (_k: string) => undefined);
jest.unstable_mockModule("../../storage/index.js", () => ({
  getStorage: () => ({ upload: uploadMock, delete: deleteMock }),
}));

/** Stands in for `pg_dump`: writes a file, or fails, as the test asks. */
let dumpBehaviour: "ok" | "missing-binary" | "version-mismatch" | "empty" = "ok";
jest.unstable_mockModule("node:child_process", () => ({
  spawn: () => {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    const child = {
      stderr: { on: (_e: string, cb: (c: Buffer) => void) => { stderrCb = cb; } },
      on: (event: string, cb: (arg?: unknown) => void) => {
        (handlers[event] ??= []).push(cb);
        return child;
      },
    };
    let stderrCb: ((c: Buffer) => void) | null = null;
    setImmediate(() => {
      if (dumpBehaviour === "missing-binary") {
        const err = Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" });
        handlers.error?.forEach((cb) => cb(err));
        return;
      }
      if (dumpBehaviour === "version-mismatch") {
        stderrCb?.(Buffer.from("pg_dump: error: aborting because of server version mismatch"));
        handlers.close?.forEach((cb) => cb(1));
        return;
      }
      handlers.close?.forEach((cb) => cb(0));
    });
    return child;
  },
}));

const statMock = jest.fn(async () => ({ size: 5_000_000 }));
const rmMock = jest.fn(async () => undefined);
jest.unstable_mockModule("node:fs/promises", () => ({
  mkdtemp: async (p: string) => `${p}xyz`,
  rm: rmMock,
  stat: statMock,
  readFile: async () => Buffer.from("dump-bytes"),
}));

const { runDatabaseBackup, periodOf } = await import("../../jobs/databaseBackup.js");
const { env } = await import("../../config/env.js");

const NOW = new Date("2026-09-11T02:00:00.000Z");
const enabled = (on: boolean) => {
  (env as { DB_BACKUP_ENABLED: boolean }).DB_BACKUP_ENABLED = on;
};

beforeEach(() => {
  dumpBehaviour = "ok";
  uploadMock.mockClear();
  deleteMock.mockClear();
  rmMock.mockClear();
  statMock.mockClear();
  statMock.mockResolvedValue({ size: 5_000_000 } as never);
  Object.values(prismaMock).forEach((m: any) =>
    m && typeof m === "object" ? Object.values(m).forEach((fn: any) => fn?.mockReset?.()) : null,
  );
  prismaMock.databaseBackup.findMany.mockResolvedValue([]);
  enabled(true);
});

describe("periodOf", () => {
  it("is the UTC calendar month", () => {
    expect(periodOf(new Date("2026-09-11T23:30:00.000Z"))).toBe("2026-09");
    // A local-time reading would put this in October west of UTC.
    expect(periodOf(new Date("2026-10-01T00:30:00.000Z"))).toBe("2026-10");
  });
});

describe("runDatabaseBackup", () => {
  it("does nothing at all unless it is switched on", async () => {
    enabled(false);
    const out = await runDatabaseBackup(NOW);

    expect(out).toEqual({ skipped: "disabled" });
    // Not even a lookup: a dump must never appear anywhere by default.
    expect(prismaMock.databaseBackup.findUnique).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("takes and stores the month's backup", async () => {
    prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
    prismaMock.databaseBackup.create.mockResolvedValueOnce({});

    const out = await runDatabaseBackup(NOW);

    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "backup", fileName: "adcet-2026-09.dump" }),
    );
    expect(out).toMatchObject({ period: "2026-09", sizeBytes: 5_000_000 });
  });

  /** A daily tick standing in for a monthly schedule — most days do nothing. */
  it("skips a month that already has a backup", async () => {
    prismaMock.databaseBackup.findUnique.mockResolvedValueOnce({ period: "2026-09" });

    const out = await runDatabaseBackup(NOW);

    expect(out).toEqual({ skipped: "already-taken-this-month", period: "2026-09" });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  /**
   * The row is the claim that an object exists. Written before the upload, a
   * failed upload would leave a month permanently "done" and never retried.
   */
  it("writes the row only after the upload succeeds", async () => {
    prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
    const order: string[] = [];
    uploadMock.mockImplementationOnce(async () => {
      order.push("upload");
      return { key: "backup/2026-09/x.dump", publicUrl: "" };
    });
    prismaMock.databaseBackup.create.mockImplementationOnce(async () => {
      order.push("row");
      return {};
    });

    await runDatabaseBackup(NOW);

    expect(order).toEqual(["upload", "row"]);
  });

  it("records no row when the upload fails, so the next day retries", async () => {
    prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
    uploadMock.mockRejectedValueOnce(new Error("bucket unreachable") as never);

    await expect(runDatabaseBackup(NOW)).rejects.toThrow("bucket unreachable");
    expect(prismaMock.databaseBackup.create).not.toHaveBeenCalled();
  });

  /** The dump is the entire database; it never stays on the container's disk. */
  it("removes the temporary file even when the run fails", async () => {
    prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
    uploadMock.mockRejectedValueOnce(new Error("nope") as never);

    await expect(runDatabaseBackup(NOW)).rejects.toThrow();
    expect(rmMock).toHaveBeenCalledWith(
      expect.stringContaining("adcet-backup-"),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("refuses an empty dump rather than storing one", async () => {
    prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
    statMock.mockResolvedValueOnce({ size: 0 } as never);

    await expect(runDatabaseBackup(NOW)).rejects.toThrow(/empty/i);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  /** The commonest first-deploy failure deserves an error that names the cause. */
  it("says so when pg_dump is not installed", async () => {
    prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
    dumpBehaviour = "missing-binary";

    await expect(runDatabaseBackup(NOW)).rejects.toThrow(/postgresql-client|PG_DUMP_PATH/);
  });

  it("says so when pg_dump is the wrong major version", async () => {
    prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
    dumpBehaviour = "version-mismatch";

    await expect(runDatabaseBackup(NOW)).rejects.toThrow(/same major\s+version/);
  });

  describe("retention", () => {
    it("prunes past the keep count, object before row", async () => {
      prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
      prismaMock.databaseBackup.create.mockResolvedValueOnce({});
      prismaMock.databaseBackup.findMany.mockResolvedValueOnce([
        { id: "b-1", period: "2025-08", objectKey: "backup/2025-08/a.dump" },
      ]);
      prismaMock.databaseBackup.delete.mockResolvedValueOnce({});

      await runDatabaseBackup(NOW);

      const args = prismaMock.databaseBackup.findMany.mock.calls[0][0] as any;
      // Newest first, skipping the ones we keep — so `findMany` returns exactly
      // the surplus.
      expect(args.orderBy).toEqual({ period: "desc" });
      expect(args.skip).toBe(env.DB_BACKUP_KEEP);
      expect(deleteMock).toHaveBeenCalledWith("backup/2025-08/a.dump");
      expect(prismaMock.databaseBackup.delete).toHaveBeenCalledWith({ where: { id: "b-1" } });
    });

    it("keeps the row when its object could not be deleted", async () => {
      prismaMock.databaseBackup.findUnique.mockResolvedValueOnce(null);
      prismaMock.databaseBackup.create.mockResolvedValueOnce({});
      prismaMock.databaseBackup.findMany.mockResolvedValueOnce([
        { id: "b-1", period: "2025-08", objectKey: "backup/2025-08/a.dump" },
      ]);
      deleteMock.mockRejectedValueOnce(new Error("bucket unreachable") as never);

      // A prune failure must not fail the backup that was just taken.
      const out = await runDatabaseBackup(NOW);

      expect(out.period).toBe("2026-09");
      expect(prismaMock.databaseBackup.delete).not.toHaveBeenCalled();
    });
  });
});
