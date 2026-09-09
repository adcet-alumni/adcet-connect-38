/**
 * Per-scope upload ceiling, in bytes — and, since every scope appears here
 * exactly once, the frontend's list of upload scopes.
 *
 * Mirrors `UPLOAD_MAX_BYTES` in the backend's `config/constants.ts`, which is
 * where the limit is actually *enforced*: `/uploads/presign` rejects an
 * over-sized request and the S3 family signs the declared length into the
 * upload URL, so a caller that skips the form gains nothing. This copy only
 * lets a file picker say "too large" without a round trip.
 *
 * Deliberately import-free so the backend's `tests/lib/uploadLimits.test.ts`
 * can load it and fail the build when the two lists drift apart.
 */
export const MB = 1024 * 1024;

export const UPLOAD_MAX_BYTES = {
  avatar: 10 * MB,
  banner: 10 * MB,
  event: 10 * MB,
  achievement: 10 * MB,
  receipt: 10 * MB,
  resume: 10 * MB,
  "event-attachment": 10 * MB,
  "job-attachment": 10 * MB,
  // The composer offers 15 MB per file — see `MAX_ATTACHMENT_MB` in BulkEmailDialog.
  "email-attachment": 15 * MB,
  post: 10 * MB,
  // A newsletter is a print-quality PDF; the rest are single files off a phone.
  newsletter: 25 * MB,
  "newsletter-cover": 10 * MB,
  gallery: 10 * MB,
  collaboration: 10 * MB,
  // A screenshot off a UPI app, and the payee's QR image.
  "donation-proof": 10 * MB,
  "donation-qr": 5 * MB,
} as const satisfies Record<string, number>;

/** The scopes an upload can be filed under, mirroring `UPLOAD_SCOPES`. */
export type UploadScope = keyof typeof UPLOAD_MAX_BYTES;
