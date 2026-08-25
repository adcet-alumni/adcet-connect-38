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
] as const;
export type UploadScope = (typeof UPLOAD_SCOPES)[number];

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