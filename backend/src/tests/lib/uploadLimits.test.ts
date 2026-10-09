/**
 * The upload ceiling exists twice by necessity — the API enforces it, the
 * browser uses it to reject a file before asking for a presign — so this test
 * is what stops the two copies from drifting. It also pins the shape of the
 * enforcement, because the check is worth nothing if a caller can simply omit
 * the size or name a scope with no ceiling.
 */
import { describe, expect, it } from "@jest/globals";
import {
  REQUESTABLE_UPLOAD_SCOPES,
  UNREACHABLE_UPLOAD_SCOPES,
  UPLOAD_MAX_BYTES,
  UPLOAD_SCOPES,
} from "../../config/constants.js";
import { UPLOAD_MAX_BYTES as FRONTEND_MAX } from "../../../../src/lib/uploadLimits.js";
import { presignSchema } from "../../modules/uploads/uploads.validators.js";

describe("UPLOAD_MAX_BYTES", () => {
  /*
   * The frontend's copy covers what a *browser* may upload, so it deliberately
   * omits the scopes only the worker writes: there is no picker for a database
   * dump, and shipping its ceiling to the client would just be noise.
   */
  it("is the same table the frontend checks against, for every scope a browser can use", () => {
    const browserScopes = Object.fromEntries(
      Object.entries(UPLOAD_MAX_BYTES).filter(
        ([scope]) => !UNREACHABLE_UPLOAD_SCOPES.includes(scope as never),
      ),
    );
    expect(FRONTEND_MAX).toEqual(browserScopes);
  });

  it("gives every scope a ceiling — a missing one would be an unbounded upload", () => {
    for (const scope of UPLOAD_SCOPES) {
      expect(typeof UPLOAD_MAX_BYTES[scope]).toBe("number");
      expect(UPLOAD_MAX_BYTES[scope]).toBeGreaterThan(0);
    }
    expect(Object.keys(UPLOAD_MAX_BYTES).sort()).toEqual([...UPLOAD_SCOPES].sort());
  });
});

/**
 * `backup` holds `pg_dump` output — every password hash, email address and
 * record on the platform in one object. Nothing in the portal reads or writes
 * one, so the API must not be able to *name* the scope: excluding it from the
 * request schema is a stronger guarantee than an authorisation check a future
 * refactor could route around.
 */
describe("scopes a request may name", () => {
  it("excludes the backup scope from the presign schema", () => {
    expect(REQUESTABLE_UPLOAD_SCOPES).not.toContain("backup");
    const parsed = presignSchema.safeParse({
      fileName: "dump",
      contentType: "application/octet-stream",
      scope: "backup",
      size: 1024,
    });
    expect(parsed.success).toBe(false);
  });

  it("still offers every other scope", () => {
    // Per-scope content rules (a résumé must be a PDF, a newsletter cover must
    // be an image) are pinned elsewhere; what matters here is only that
    // excluding `backup` excluded nothing else.
    const expected = UPLOAD_SCOPES.filter((s) => !UNREACHABLE_UPLOAD_SCOPES.includes(s as never));
    expect([...REQUESTABLE_UPLOAD_SCOPES]).toEqual(expected);
    expect(REQUESTABLE_UPLOAD_SCOPES).toHaveLength(UPLOAD_SCOPES.length - 1);
  });
});

describe("presignSchema", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    fileName: "a.png",
    contentType: "image/png",
    scope: "avatar",
    size: 1024,
    ...over,
  });

  it("requires a declared size", () => {
    const withoutSize = { ...body() } as Record<string, unknown>;
    delete withoutSize.size;
    expect(presignSchema.safeParse(withoutSize).success).toBe(false);
  });

  it("rejects a size over the scope's ceiling, and accepts one at it", () => {
    const max = UPLOAD_MAX_BYTES.avatar;
    expect(presignSchema.safeParse(body({ size: max + 1 })).success).toBe(false);
    expect(presignSchema.safeParse(body({ size: max })).success).toBe(true);
  });

  it("applies each scope's own ceiling, not one global number", () => {
    // 15 MB is fine as an email attachment and too big as an avatar.
    const size = UPLOAD_MAX_BYTES["email-attachment"];
    expect(presignSchema.safeParse(body({ size, scope: "email-attachment" })).success).toBe(true);
    expect(presignSchema.safeParse(body({ size, scope: "avatar" })).success).toBe(false);
  });

  it("rejects a zero or negative size", () => {
    for (const size of [0, -1]) {
      expect(presignSchema.safeParse(body({ size })).success).toBe(false);
    }
  });

  it("coerces the string the direct-upload query string carries", () => {
    const parsed = presignSchema.safeParse(body({ size: "2048" }));
    expect(parsed.success && parsed.data.size).toBe(2048);
  });
});
