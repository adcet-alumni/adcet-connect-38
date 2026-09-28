/**
 * Typed environment configuration.
 * All env access in the app should go through `env`.
 */
import "dotenv/config";
import { z } from "zod";

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Parse Cloudinary's own `cloudinary://<api_key>:<api_secret>@<cloud_name>` env format. */
const parseCloudinaryUrl = (url?: string): Partial<CloudinaryConfig> => {
  if (!url) return {};
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url.trim());
  if (!m) return {};
  return { apiKey: m[1], apiSecret: m[2], cloudName: m[3].replace(/\/.*$/, "") };
};

/** Explicit vars win over CLOUDINARY_URL so a single value can be overridden. */
const resolveCloudinary = (source: {
  CLOUDINARY_URL?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
}): CloudinaryConfig | null => {
  const fromUrl = parseCloudinaryUrl(source.CLOUDINARY_URL);
  const cloudName = source.CLOUDINARY_CLOUD_NAME || fromUrl.cloudName;
  const apiKey = source.CLOUDINARY_API_KEY || fromUrl.apiKey;
  const apiSecret = source.CLOUDINARY_API_SECRET || fromUrl.apiSecret;
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
};

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_PREFIX: z.string().default("/api/v1"),
  CORS_ORIGIN: z.string().default("*"),

  DATABASE_URL: z.string().url(),
  /**
   * Prisma connection-pool size **per process**.
   *
   * Prisma's own default is `num_physical_cpus * 2 + 1`, which means the pool
   * silently changes size when the container gets a different CPU allocation —
   * the one number you least want inferred from the host. Set it explicitly and
   * size it against Postgres `max_connections` divided by the number of
   * processes you run (API replicas + the worker), leaving headroom for
   * migrations and psql.
   *
   * A value already present in `DATABASE_URL` wins, so an operator can still
   * pass `?connection_limit=` directly.
   */
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).default(10),
  /** Seconds to wait for a free connection before giving up (Prisma default 10). */
  DATABASE_POOL_TIMEOUT: z.coerce.number().int().min(1).default(20),
  /**
   * Queries at or above this many milliseconds are logged at `warn`.
   * Production logged only `warn`/`error`, so there was no way to tell which
   * query was slow — only that something was.
   */
  DATABASE_SLOW_QUERY_MS: z.coerce.number().int().min(1).default(200),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),

  STORAGE_DRIVER: z.enum(["minio", "s3", "local", "cloudinary"]).default("minio"),
  STORAGE_BUCKET: z.string().default("adcet-alumni"),
  STORAGE_PUBLIC_BASE_URL: z.string().optional(),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  S3_PRESIGN_TTL: z.coerce.number().default(900),

  LOCAL_STORAGE_DIR: z.string().default("./uploads"),

  // === Cloudinary (STORAGE_DRIVER=cloudinary) ===
  // Either set CLOUDINARY_URL (the `cloudinary://key:secret@cloud` form copied
  // straight from the dashboard) or the three explicit vars below.
  CLOUDINARY_URL: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  /** Optional prefix applied to every object, e.g. `adcet/prod`. */
  CLOUDINARY_FOLDER: z.string().optional(),
  /** Upload scopes stored as Cloudinary `private` assets, reachable only via signed, expiring URLs. */
  CLOUDINARY_PRIVATE_SCOPES: z.string().default("resume,receipt"),
  CLOUDINARY_PRESIGN_TTL: z.coerce.number().default(900),

  /**
   * How long an uploaded résumé is kept before the retention job deletes the
   * stored object and stamps `JobApplication.resumeDeletedAt`.
   *
   * An env var rather than an admin setting on purpose: this is a data
   * retention commitment, not a day-to-day knob, and it should change through
   * a deploy that someone reviews.
   */
  RESUME_RETENTION_DAYS: z.coerce.number().int().min(1).default(180),

  LOG_LEVEL: z.string().default("info"),

  // === Database backup (jobs/databaseBackup.ts) ===
  /*
   * Off unless asked for. A dump is the whole platform in one object — every
   * password hash and email address — so it is never written anywhere by
   * default, and DEPLOY.md is explicit that the destination bucket must be
   * private with its own credentials.
   */
  /*
   * Parsed explicitly, not with `z.coerce.boolean()` — that applies JS
   * `Boolean()`, under which the string "false" is `true`. An env var that
   * turns a feature on when you set it to "false" is the wrong way round for
   * anything, and especially for this one.
   */
  DB_BACKUP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Monthly backups retained. 12 is a year; older ones are pruned. */
  DB_BACKUP_KEEP: z.coerce.number().int().min(1).max(120).default(12),
  /** Must be the same major version as the server. */
  PG_DUMP_PATH: z.string().default("pg_dump"),

  // === Donations ===
  // There is no payment gateway. A gift is paid off-portal against the UPI QR
  // the alumni office configures in the admin settings, then declared and
  // verified in-portal — so nothing here is a secret, only what goes on a
  // receipt. Public org details printed on receipts:
  ORG_NAME: z.string().default("Annasaheb Dange College of Engineering & Technology, Ashta"),
  ORG_ADDRESS: z.string().default("Ashta, Dist. Sangli, Maharashtra 416301"),

  // === Geocoding (alumni map) ===
  // Only reached by the backfill job, and only for cities the offline gazetteer
  // in `config/gazetteer.ts` doesn't already know. Set GEOCODER=none to keep the
  // deployment entirely offline — the map then shows gazetteer cities only.
  GEOCODER: z.enum(["none", "nominatim"]).default("nominatim"),
  GEOCODER_BASE_URL: z.string().default("https://nominatim.openstreetmap.org"),
  /** Nominatim's usage policy requires a contactable identifier here. */
  GEOCODER_USER_AGENT: z.string().default("ADCET-Alumni-Portal (alumni@adcet.in)"),
  /** Nominatim allows one request per second; the extra 100 ms is slack for clock jitter. */
  GEOCODER_MIN_INTERVAL_MS: z.coerce.number().default(1100),
  GEOCODER_TIMEOUT_MS: z.coerce.number().default(8000),
}).superRefine((v, ctx) => {
  const placeholderSecret = "change-me-32-chars-minimum-secret";
  if (v.NODE_ENV === "production") {
    for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const) {
      if (v[key] === placeholderSecret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is still the .env.example placeholder; generate a real secret before deploying to production.`,
        });
      }
    }
  }

  /*
   * `CORS_ORIGIN=*` becomes `origin: true` in app.ts, which reflects whatever
   * Origin the browser sent — and it is paired with `credentials: true`. That
   * combination is what allows any site to make authenticated cross-origin
   * calls on a signed-in member's behalf. It is a reasonable default for local
   * development and never a safe one in production, so production has to name
   * its origins.
   */
  if (v.NODE_ENV === "production" && v.CORS_ORIGIN.trim() === "*") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CORS_ORIGIN"],
      message:
        "CORS_ORIGIN must list the allowed origins in production — `*` combined with " +
        "credentials lets any site make authenticated requests as a signed-in member. " +
        "Set it to a comma-separated list, e.g. https://alumni.adcet.in",
    });
  }

  // Fail fast at boot rather than on the first upload attempt.
  if (v.STORAGE_DRIVER === "cloudinary" && !resolveCloudinary(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CLOUDINARY_URL"],
      message:
        "STORAGE_DRIVER=cloudinary requires CLOUDINARY_URL, or all of " +
        "CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET",
    });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Resolved Cloudinary credentials, or `null` when Cloudinary isn't configured. */
export const cloudinaryConfig = resolveCloudinary(env);