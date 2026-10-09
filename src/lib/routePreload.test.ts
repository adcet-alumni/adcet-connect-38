/**
 * The prefetcher is what keeps route splitting from being felt.
 *
 * What matters is not that it fetches, but that it fetches *once* and that a
 * link to a detail URL still finds the chunk registered under its parameterised
 * path — the two things that decide whether a click waits.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const load = async () => {
  vi.resetModules();
  return import("./routePreload");
};

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no requestIdleCallback; the module falls back to setTimeout,
  // which is what these tests drive.
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("cancelIdleCallback", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("preloadRoute", () => {
  it("fetches the chunk registered for the path", async () => {
    const { registerRoute, preloadRoute } = await load();
    const chunk = vi.fn(async () => ({ default: () => null }));
    registerRoute("/dashboard/profile", chunk);

    preloadRoute("/dashboard/profile");
    expect(chunk).toHaveBeenCalledTimes(1);
  });

  it("fetches once however often a link is hovered", async () => {
    const { registerRoute, preloadRoute } = await load();
    const chunk = vi.fn(async () => ({ default: () => null }));
    registerRoute("/dashboard/feed", chunk);

    preloadRoute("/dashboard/feed");
    preloadRoute("/dashboard/feed");
    preloadRoute("/dashboard/feed");
    expect(chunk).toHaveBeenCalledTimes(1);
  });

  /** `/dashboard/jobs/abc123` is served by the chunk filed under `.../jobs/`. */
  it("falls back to the longest registered prefix, so detail URLs still warm", async () => {
    const { registerRoute, preloadRoute } = await load();
    const list = vi.fn(async () => ({ default: () => null }));
    const detail = vi.fn(async () => ({ default: () => null }));
    registerRoute("/dashboard/jobs", list);
    registerRoute("/dashboard/jobs/", detail);

    preloadRoute("/dashboard/jobs/abc123");
    expect(detail).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it("does nothing for a path nothing is registered under", async () => {
    const { registerRoute, preloadRoute } = await load();
    const chunk = vi.fn(async () => ({ default: () => null }));
    registerRoute("/admin/reports", chunk);

    preloadRoute("/somewhere-else");
    expect(chunk).not.toHaveBeenCalled();
  });

  /**
   * A prefetch is speculative. Letting its rejection escape would surface a
   * chunk-load failure as an unhandled rejection long before the user has asked
   * for that page — and the real navigation retries the same import anyway.
   */
  it("swallows a failed prefetch, and lets a later one retry", async () => {
    const { registerRoute, preloadRoute } = await load();
    const chunk = vi.fn(async () => {
      throw new Error("offline");
    });
    registerRoute("/dashboard/feed", chunk);

    expect(() => preloadRoute("/dashboard/feed")).not.toThrow();
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(1));

    preloadRoute("/dashboard/feed");
    expect(chunk).toHaveBeenCalledTimes(2);
  });
});

describe("preloadGroup", () => {
  it("walks only the chunks under the prefix, one idle slot at a time", async () => {
    const { registerRoute, preloadGroup } = await load();
    const feed = vi.fn(async () => ({ default: () => null }));
    const profile = vi.fn(async () => ({ default: () => null }));
    const reports = vi.fn(async () => ({ default: () => null }));
    registerRoute("/dashboard/feed", feed);
    registerRoute("/dashboard/profile", profile);
    registerRoute("/admin/reports", reports);

    preloadGroup("/dashboard");

    // One per idle slot — twenty parallel requests would compete with the data
    // the page on screen is still loading.
    await vi.advanceTimersByTimeAsync(200);
    expect(feed).toHaveBeenCalledTimes(1);
    expect(profile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(profile).toHaveBeenCalledTimes(1);

    // The admin section is somebody else's prefix.
    await vi.advanceTimersByTimeAsync(1000);
    expect(reports).not.toHaveBeenCalled();
  });

  it("stops when the layout that started it unmounts", async () => {
    const { registerRoute, preloadGroup } = await load();
    const first = vi.fn(async () => ({ default: () => null }));
    const second = vi.fn(async () => ({ default: () => null }));
    registerRoute("/dashboard/a", first);
    registerRoute("/dashboard/b", second);

    const cancel = preloadGroup("/dashboard");
    await vi.advanceTimersByTimeAsync(200);
    expect(first).toHaveBeenCalledTimes(1);

    cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(second).not.toHaveBeenCalled();
  });

  it("skips what a hover already fetched", async () => {
    const { registerRoute, preloadGroup, preloadRoute } = await load();
    const chunk = vi.fn(async () => ({ default: () => null }));
    registerRoute("/dashboard/feed", chunk);

    preloadRoute("/dashboard/feed");
    preloadGroup("/dashboard");
    await vi.advanceTimersByTimeAsync(1000);

    expect(chunk).toHaveBeenCalledTimes(1);
  });
});
