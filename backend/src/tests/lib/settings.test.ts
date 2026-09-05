/**
 * The settings registry is the source of truth for defaults; the AppSetting
 * table holds only overrides. These cover the read-through cache added because
 * `getSetting` was querying on every feed post — a table of a handful of rows
 * that changes a few times a year, read on a write path.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createPrismaMock } from "../helpers/prismaMock.js";

const prismaMock = createPrismaMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma: prismaMock }));

const settings = await import("../../lib/settings.js");

beforeEach(() => {
  prismaMock.appSetting.findMany.mockReset();
  prismaMock.appSetting.upsert.mockReset();
  prismaMock.appSetting.findMany.mockResolvedValue([]);
  settings.invalidateSettings();
});

describe("settings cache", () => {
  it("falls back to the registry default when no row exists", async () => {
    expect(await settings.getSetting("feedPostsPerMonth")).toBe(
      settings.SETTINGS.feedPostsPerMonth.default,
    );
  });

  it("reads a stored override", async () => {
    prismaMock.appSetting.findMany.mockResolvedValue([
      { key: "feedPostsPerMonth", value: "25" },
    ]);
    expect(await settings.getSetting("feedPostsPerMonth")).toBe(25);
  });

  it("serves repeat reads from the cache instead of the database", async () => {
    await settings.getSetting("feedPostsPerMonth");
    await settings.getSetting("feedPostsPerMonth");
    await settings.getAllSettings();

    expect(prismaMock.appSetting.findMany).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed read", async () => {
    // Otherwise one blip would pin the instance to the defaults for the whole
    // TTL, silently ignoring every configured override.
    prismaMock.appSetting.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(settings.getSetting("feedPostsPerMonth")).rejects.toThrow("db down");

    prismaMock.appSetting.findMany.mockResolvedValue([
      { key: "feedPostsPerMonth", value: "7" },
    ]);
    expect(await settings.getSetting("feedPostsPerMonth")).toBe(7);
  });

  it("shows an admin their own write immediately", async () => {
    prismaMock.appSetting.findMany.mockResolvedValue([
      { key: "feedPostsPerMonth", value: "10" },
    ]);
    expect(await settings.getSetting("feedPostsPerMonth")).toBe(10);

    // The write lands, and the read that follows it must not come from the
    // copy cached a moment earlier.
    prismaMock.appSetting.findMany.mockResolvedValue([
      { key: "feedPostsPerMonth", value: "30" },
    ]);
    const after = await settings.setSettings({ feedPostsPerMonth: 30 }, "admin-1");

    expect(after.feedPostsPerMonth).toBe(30);
    expect(await settings.getSetting("feedPostsPerMonth")).toBe(30);
  });

  it("rejects a value that fails its schema before writing anything", async () => {
    await expect(settings.setSettings({ feedPostsPerMonth: -5 })).rejects.toThrow();
    expect(prismaMock.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("uses the default when a stored value is unparseable", async () => {
    prismaMock.appSetting.findMany.mockResolvedValue([
      { key: "feedPostsPerMonth", value: "not json" },
    ]);
    expect(await settings.getSetting("feedPostsPerMonth")).toBe(
      settings.SETTINGS.feedPostsPerMonth.default,
    );
  });
});
