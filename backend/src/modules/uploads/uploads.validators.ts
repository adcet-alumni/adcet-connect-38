import { z } from "zod";
import { UPLOAD_SCOPES, UPLOAD_MAX_BYTES, type UploadScope } from "../../config/constants.js";

export const presignSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(100),
    scope: z.enum(UPLOAD_SCOPES as unknown as [string, ...string[]]),
    /**
     * Byte length of the file about to be sent. Mandatory: it is the only
     * thing the API ever learns about a browser -> storage upload, and for the
     * S3 family it is signed into the URL, so an omitted size would mean an
     * unbounded upload. Coerced because `/uploads/direct` passes it in the
     * query string.
     */
    size: z.coerce.number().int().positive(),
  })
  .superRefine((d, ctx) => {
    const max = UPLOAD_MAX_BYTES[d.scope as UploadScope];
    if (max != null && d.size > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["size"],
        message: `File is too large — the limit for ${d.scope} uploads is ${Math.round(max / (1024 * 1024))} MB`,
      });
    }
  })
  .refine(
    (d) => d.scope !== "resume" || d.contentType === "application/pdf",
    { message: "Resume uploads must be application/pdf", path: ["contentType"] },
  )
  .refine(
    (d) => d.scope !== "newsletter" || d.contentType === "application/pdf",
    { message: "Newsletter uploads must be application/pdf", path: ["contentType"] },
  )
  .refine(
    (d) => d.scope !== "newsletter-cover" || d.contentType.startsWith("image/"),
    { message: "Newsletter covers must be an image", path: ["contentType"] },
  );

export const downloadSchema = z.object({
  key: z.string().min(1),
});