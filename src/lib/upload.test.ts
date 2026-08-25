/**
 * The upload helper has to speak both dialects the backend can hand back:
 * a raw PUT (S3/MinIO/local) and Cloudinary's signed multipart POST.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("@/lib/api", () => ({ api: { post: (...args: unknown[]) => post(...args) } }));

const { uploadFile, uploadToPresigned, UPLOAD_MAX_BYTES } = await import("@/lib/upload");

const file = new File(["hello"], "photo.png", { type: "image/png" });
const ok = () => ({ ok: true, status: 200, text: async () => "" }) as Response;

beforeEach(() => {
  post.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ok()));
});

describe("uploadToPresigned", () => {
  it("PUTs the raw file when no method is given", async () => {
    await uploadToPresigned({ uploadUrl: "https://s3.test/obj", key: "avatar/u1/photo.png" }, file);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://s3.test/obj");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "image/png" });
    expect(init.body).toBe(file);
  });

  it("POSTs signed fields plus the file, and lets the browser set the boundary", async () => {
    await uploadToPresigned(
      {
        uploadUrl: "https://api.cloudinary.com/v1_1/demo/image/upload",
        key: "avatar/u1/photo.png",
        method: "POST",
        fields: { public_id: "avatar/u1/photo", timestamp: "123", signature: "sig", api_key: "k" },
      },
      file,
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cloudinary.com/v1_1/demo/image/upload");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();

    const form = init.body as FormData;
    expect(form.get("public_id")).toBe("avatar/u1/photo");
    expect(form.get("signature")).toBe("sig");
    expect(form.get("file")).toBe(file);
  });

  it("surfaces the provider's error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "Invalid signature" } }),
      }) as Response),
    );

    await expect(
      uploadToPresigned({ uploadUrl: "https://api.test/upload", key: "k", method: "POST" }, file),
    ).rejects.toThrow("Upload failed (400): Invalid signature");
  });
});

describe("uploadFile", () => {
  it("presigns with the file's metadata and returns the key to persist", async () => {
    post.mockResolvedValue({ uploadUrl: "https://s3.test/obj", key: "avatar/u1/abc-photo.png" });

    await expect(uploadFile(file, "avatar")).resolves.toBe("avatar/u1/abc-photo.png");
    expect(post).toHaveBeenCalledWith("/uploads/presign", {
      fileName: "photo.png",
      contentType: "image/png",
      scope: "avatar",
      // The backend caps this and (on S3/MinIO) signs it into the upload URL,
      // so the declared size must be the file's real length.
      size: file.size,
    });
  });

  it("refuses a file over the scope's ceiling without asking for a presign", async () => {
    const huge = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: UPLOAD_MAX_BYTES.avatar + 1 });

    await expect(uploadFile(huge, "avatar")).rejects.toThrow(/too large/);
    expect(post).not.toHaveBeenCalled();
  });
});
