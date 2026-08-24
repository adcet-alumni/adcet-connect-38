/**
 * The upload ceiling exists twice by necessity — the API enforces it, the
 * browser uses it to reject a file before asking for a presign — so this test
 * is what stops the two copies from drifting. It also pins the shape of the
 * enforcement, because the check is worth nothing if a caller can simply omit
 * the size or name a scope with no ceiling.
 */
import { describe, expect, it } from "@jest/globals";
import { UPLOAD_MAX_BYTES, UPLOAD_SCOPES } from "../../config/constants.js";
import { UPLOAD_MAX_BYTES as FRONTEND_MAX } from "../../../../src/lib/uploadLimits.js";
import { presignSchema } from "../../modules/uploads/uploads.validators.js";

describe("UPLOAD_MAX_BYTES", () => {
  it("is the same table the frontend checks against", () => {
    expect(FRONTEND_MAX).toEqual(UPLOAD_MAX_BYTES);
  });

  it("gives every scope a ceiling — a missing one would be an unbounded upload", () => {
    for (const scope of UPLOAD_SCOPES) {
      expect(typeof UPLOAD_MAX_BYTES[scope]).toBe("number");
      expect(UPLOAD_MAX_BYTES[scope]).toBeGreaterThan(0);
    }
    expect(Object.keys(UPLOAD_MAX_BYTES).sort()).toEqual([...UPLOAD_SCOPES].sort());
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
    const { size, ...withoutSize } = body();
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
