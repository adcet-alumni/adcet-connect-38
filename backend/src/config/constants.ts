/**
 * Application-wide constants. Centralized so they can be tuned in one place
 * and referenced across modules without magic strings.
 */

/**
 * The only two roles that exist. STUDENT and RECRUITER were removed by
 * migration `drop_student_recruiter_roles`.
 *
 * A role is **never** read from client input. Sign-up always creates ALUMNI
 * (see `auth.service.ts`), SSO does the same, and the only way to hold ADMIN
 * is for an existing admin to grant it via `POST /admin/users/:id/roles` or for
 * `seed-admin.ts` to bootstrap the first one.
 */
export const ROLES = {
  ALUMNI: "ALUMNI",
  ADMIN: "ADMIN",
} as const;

/** Every role name, for validating a role that arrives as a path parameter. */
export const ROLE_VALUES = ["ALUMNI", "ADMIN"] as const;

export type AppRoleName = (typeof ROLES)[keyof typeof ROLES];

export const APPROVAL = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
} as const;

export const RATE_LIMITS = {
  AUTH_WINDOW_MS: 15 * 60 * 1000,
  AUTH_MAX: 20,
  GLOBAL_WINDOW_MS: 60 * 1000,
  GLOBAL_MAX: 300,
} as const;

/**
 * The kinds of collaboration an alumnus can offer the college. One list, read
 * by the validators' discriminated union, the admin's pending counters and the
 * frontend's `COLLABORATION_KINDS` (mirrored in `src/lib/collaboration.ts`).
 * `OTHER` is the catch-all — see the enum's note in `schema.prisma`.
 */
export const COLLABORATION_TYPES = ["PLACEMENT", "WORKSHOP", "OTHER"] as const;
export type CollaborationTypeName = (typeof COLLABORATION_TYPES)[number];

export const UPLOAD_SCOPES = [
  "avatar", "banner", "event", "achievement", "receipt", "resume",
  "event-attachment", "job-attachment", "email-attachment", "post",
  "newsletter", "newsletter-cover", "gallery", "collaboration",
  "donation-proof", "donation-qr", "identity", "backup",
] as const;
export type UploadScope = (typeof UPLOAD_SCOPES)[number];

/**
 * Scopes the `/uploads` API must never name, in either direction.
 *
 * `backup` holds `pg_dump` output — every password hash, email address and
 * record on the platform in one object. Nothing in the portal reads or writes
 * one: `jobs/databaseBackup.ts` puts it there and a restore is done from
 * outside the application by whoever holds the bucket credentials. Excluding it
 * from the request schema means no route can even ask, which is a stronger
 * guarantee than an authorisation check that a future refactor could route
 * around.
 */
export const UNREACHABLE_UPLOAD_SCOPES = ["backup"] as const;

/** The scopes a client may name — everything the worker doesn't own privately. */
export const REQUESTABLE_UPLOAD_SCOPES = UPLOAD_SCOPES.filter(
  (s): s is Exclude<UploadScope, (typeof UNREACHABLE_UPLOAD_SCOPES)[number]> =>
    !(UNREACHABLE_UPLOAD_SCOPES as readonly string[]).includes(s),
);

/** Feed post media limits. Mirrored by the composer UI in the frontend. */
export const FEED_MEDIA = {
  MAX_IMAGES: 2,
  MAX_VIDEOS: 1,
  MAX_BYTES: 10 * 1024 * 1024,
  IMAGE_MIME_PREFIX: "image/",
  VIDEO_MIME_PREFIX: "video/",
} as const;

const MB = 1024 * 1024;

/**
 * Per-scope upload ceiling, in bytes — the server's own limit, not a hint.
 *
 * Bytes go browser -> storage, so the API never sees the file and a form check
 * alone is worth nothing: a caller can skip the form, ask `POST /uploads/presign`
 * for a URL and push a gigabyte through it. So the declared `size` is validated
 * here at the presign gate, and the S3 family *signs* it into the URL
 * (`content-length` is part of `X-Amz-SignedHeaders`), which is what makes the
 * declaration binding — an upload whose body is a different length fails the
 * signature check at the bucket. `POST /uploads/direct` re-checks the buffer it
 * actually received.
 *
 * Cloudinary has no equivalent signed size field: its hard ceiling has to be
 * set on the account/upload preset (see `CloudinaryStorage`). Mirrored by
 * `UPLOAD_MAX_BYTES` in `src/lib/upload.ts`.
 */
export const UPLOAD_MAX_BYTES: Record<UploadScope, number> = {
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
  // A photo of a marksheet or a scanned certificate, off a phone.
  identity: 10 * MB,
  /*
   * Database dumps. Not reachable through `/uploads` at all — see
   * `UNREACHABLE_SCOPES` in `modules/uploads/uploads.service.ts` — so this
   * ceiling is only a sanity bound on what `jobs/databaseBackup.ts` will store
   * in one object. A dump larger than this is the signal to move to the
   * provider's own snapshots rather than to raise the number.
   */
  // 2047 rather than 2048: `DatabaseBackup.sizeBytes` is a PostgreSQL INTEGER
  // (max 2,147,483,647 = 2^31-1). 2048*MB = 2,147,483,648 = 2^31, which
  // overflows the column on insert and orphans the already-uploaded dump.
  backup: 2047 * MB,
};

/**
 * Alumni Collaboration attachment ceiling — one file per request, 10 MB.
 * The request forms check it for immediate feedback; `UPLOAD_MAX_BYTES` above
 * is what actually enforces it. Mirrored by
 * `COLLABORATION_ATTACHMENT_MAX_BYTES` in `src/lib/collaboration.ts`.
 */
export const COLLABORATION_ATTACHMENT_MAX_BYTES = UPLOAD_MAX_BYTES.collaboration;

/**
 * The official ADCET department names — the single source of truth for every
 * department-typed value the API accepts or stores. Mirrored verbatim by
 * `src/lib/departments.ts` on the frontend; the two lists must stay identical.
 *
 * These are the names as the college writes them. Earlier releases stored
 * abbreviations ("CSE", "E&TC", …); migration `rename_departments` rewrote the
 * stored values, so nothing outside that migration should reference the old
 * spellings.
 */
export const DEPARTMENTS = [
  "Mechanical Engineering",
  "Computer Science and Engineering",
  "Electrical Engineering",
  "Civil Engineering",
  "Aeronautical Engineering",
  "Food Technology",
  "Artificial Intelligence and Data Science",
  "Internet of Things and Cyber Security(CSE)",
  "Robotics and Artificial Intelligence",
  "Electronics and Telecommunication Engineering",
  "Automobile Engineering",
  "Mechanical and Automation Engineering",
] as const;
export type DepartmentName = (typeof DEPARTMENTS)[number];

/** Set form for O(1) membership checks in validators and services. */
export const DEPARTMENT_SET: ReadonlySet<string> = new Set(DEPARTMENTS);

/**
 * The degrees ADCET awards. `durationYears` is what lets sign-up ask only for
 * the graduation year and derive the admission year from it, so the two can
 * never contradict each other. Mirrored by `src/lib/degrees.ts`.
 */
export const DEGREES = [
  { value: "BE", label: "B.E. / B.Tech", durationYears: 4 },
  { value: "ME", label: "M.E. / M.Tech", durationYears: 2 },
] as const;

export type DegreeValue = (typeof DEGREES)[number]["value"];

export const DEGREE_VALUES = DEGREES.map((d) => d.value) as unknown as [
  DegreeValue,
  ...DegreeValue[],
];

/** Course length in years, keyed by degree. */
export const DEGREE_DURATION_YEARS: Record<DegreeValue, number> = Object.fromEntries(
  DEGREES.map((d) => [d.value, d.durationYears]),
) as Record<DegreeValue, number>;

/**
 * Admission year implied by a graduation year for a given degree. Sign-up no
 * longer collects it separately — see `DEGREES`.
 */
export const admissionYearFor = (degree: DegreeValue, graduationYear: number): number =>
  graduationYear - DEGREE_DURATION_YEARS[degree];

/** Earliest year the forms and validators will accept. */
export const MIN_ACADEMIC_YEAR = 1980;

/**
 * The regional chapters the platform ships with. Seeded on `npm run seed` and
 * on server boot so a fresh database always has them. Admins can create more
 * at runtime; none of them can ever be deleted (only archived).
 */
export const DEFAULT_CHAPTERS = [
  {
    slug: "pune",
    name: "Pune Chapter",
    city: "Pune",
    accent: "from-orange-500 to-amber-400",
    sortOrder: 1,
    blurb:
      "Our largest regional community — IT, automotive and manufacturing professionals who meet through reunions, tech talks and referral drives.",
  },
  {
    slug: "mumbai",
    name: "Mumbai Chapter",
    city: "Mumbai",
    accent: "from-cyan-500 to-sky-400",
    sortOrder: 2,
    blurb:
      "Alumni across finance, infrastructure, consulting and media in the MMR, connecting juniors to opportunities in the country's commercial capital.",
  },
  {
    slug: "bangalore",
    name: "Bangalore Chapter",
    city: "Bangalore",
    accent: "from-emerald-500 to-lime-400",
    sortOrder: 3,
    blurb:
      "Engineers, founders and researchers in India's technology hub, driving mentorship, internships and startup collaboration for ADCET students.",
  },
  {
    // Not a city — the catch-all for alumni outside the three regional hubs,
    // which is why `city` is null and the card shows no location line.
    slug: "global",
    name: "Global Chapter",
    city: null,
    accent: "from-indigo-500 to-violet-400",
    sortOrder: 4,
    blurb:
      "ADCET alumni working and studying outside India — from the Gulf and Europe to North America, Australia and East Asia — keeping the network reachable across time zones.",
  },
] as const;

export const THEMES = ["default", "ocean", "sunset", "forest", "royal"] as const;
export type ThemeName = (typeof THEMES)[number];
/**
 * How a donor says they moved the money — the two ways the alumni office
 * publishes, and nothing else. The page offers a UPI QR and a bank account, so
 * offering NEFT, IMPS, RTGS, cash and cheque as separate answers only asked the
 * donor to classify a transfer the office reconciles the same way regardless.
 *
 * Not a gateway's method list: nothing here is observed, it is what the donor
 * said, and an admin confirms it against the bank statement before the gift
 * counts. `Donation.paymentMethod` is a plain string column, so rows written
 * when the list was longer still read back correctly.
 *
 * Mirrored by `DONATION_PAYMENT_METHODS` in `src/lib/donations.ts`.
 */
export const DONATION_PAYMENT_METHODS = ["UPI", "BANK_TRANSFER"] as const;
export type DonationPaymentMethod = (typeof DONATION_PAYMENT_METHODS)[number];

/**
 * How long a rejected donation stays readable before `jobs/donationPurge.ts`
 * deletes it and its proof file.
 *
 * A rejection is not a correction: the donor is told why, and may need to come
 * back with the right reference. The row is archived rather than removed so
 * that conversation has something to point at — and removed on a clock so the
 * ledger doesn't accumulate claims the office already dismissed.
 */
export const DONATION_ARCHIVE_RETENTION_DAYS = 30;

/**
 * How long a job posting lives.
 *
 * `VISIBLE_DAYS` is how long members see it in the listings; `RETENTION_DAYS`
 * is when `jobs/contentRetention.ts` deletes it. The gap between the two is
 * deliberate and not slack: an expired posting disappears from the board but
 * the alumnus who posted it can still open it and read the applications for
 * another fortnight, which is exactly when they are shortlisting.
 *
 * Both are measured from the posting's effective expiry — `Job.expiresAt` when
 * an admin has set one, otherwise `createdAt + VISIBLE_DAYS`. That is what
 * makes `expiresAt` an extension rather than a second, competing rule; see
 * `lib/retention.ts`, which is the only place either number is applied.
 */
export const JOB_RETENTION = {
  VISIBLE_DAYS: 30,
  /** Days after posting, when nothing has extended it. */
  RETENTION_DAYS: 45,
} as const;

/**
 * How long a past event is kept: six months after it finished.
 *
 * Measured from `endsAt` when the event declared one, otherwise `startsAt` — a
 * multi-day reunion is "past" when it ends, not when it opens. Upcoming events
 * are never swept, however long ago they were created.
 */
export const EVENT_RETENTION_MONTHS = 6;

/**
 * The proof of study sign-up asks for.
 *
 * Nothing on an account previously said whether the applicant had actually
 * been a student here — an admin approving one had a name, a batch and a
 * department, every one of them typed by the applicant. One of these documents
 * is now required, and shown to the admin reviewing the account.
 *
 * Mirrored by `IDENTITY_DOCUMENT_KINDS` in `src/lib/identity.ts`.
 */
export const IDENTITY_DOCUMENT_KINDS = [
  "Library card",
  "Marksheet",
  "Leaving certificate",
  "Degree certificate",
] as const;

/**
 * What an identity document may be.
 *
 * Deliberately narrow, and enforced on the *server* against the bytes' declared
 * type: this is the one upload endpoint with no session in front of it, so it
 * is also the one place an open door would let someone park arbitrary files in
 * the college's bucket.
 */
export const IDENTITY_DOCUMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;

/**
 * How long an uploaded document waits for the sign-up that will claim it.
 *
 * An abandoned registration leaves the object behind, and an unauthenticated
 * endpoint with no sweep behind it is a bucket anyone can fill. Generous enough
 * that a slow sign-up — an OTP email that took a while, a form filled in over
 * lunch — is never surprised by its own upload vanishing.
 */
export const PENDING_UPLOAD_RETENTION_HOURS = 24;
