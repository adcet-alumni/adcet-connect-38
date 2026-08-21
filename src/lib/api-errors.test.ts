/**
 * A 404 must reach the page that renders it fast, and unmistakably. These two
 * helpers are what makes "this record is gone" different from "the API fell
 * over" everywhere a detail page loads something by id.
 */
import { describe, expect, it } from "vitest";
import { ApiError, isNotFoundError, shouldRetryQuery } from "./api";

describe("isNotFoundError", () => {
  it("recognises a 404 from the API", () => {
    expect(isNotFoundError(new ApiError("Not found", 404))).toBe(true);
  });

  it("does not mistake an outage or a permission error for a missing record", () => {
    expect(isNotFoundError(new ApiError("Server error", 500))).toBe(false);
    expect(isNotFoundError(new ApiError("Forbidden", 403))).toBe(false);
    // A dropped connection never reaches ApiError — it must not read as "gone".
    expect(isNotFoundError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});

describe("shouldRetryQuery", () => {
  it("gives up immediately on an answer the server will only repeat", () => {
    for (const status of [400, 403, 404, 409]) {
      expect(shouldRetryQuery(0, new ApiError("no", status))).toBe(false);
    }
  });

  it("still retries rate limiting and server-side failures", () => {
    expect(shouldRetryQuery(0, new ApiError("slow down", 429))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError("boom", 500))).toBe(true);
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
  });

  it("stops retrying transient failures after two attempts", () => {
    expect(shouldRetryQuery(1, new ApiError("boom", 503))).toBe(true);
    expect(shouldRetryQuery(2, new ApiError("boom", 503))).toBe(false);
  });
});
