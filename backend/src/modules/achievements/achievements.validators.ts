import { z } from "zod";
import { booleanQueryParam, paginationSchema } from "../../lib/pagination.js";
import { httpUrl } from "../../lib/urls.js";

export const achievementInputSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().min(5).max(10000),
  category: z.string().max(80).optional(),
  occurredOn: z.coerce.date().optional(),
  imageKey: z.string().optional(),
  attachmentKey: z.string().optional(),
  // Accept an empty string from the form and treat it as "no link".
  // `httpUrl` — not `z.string().url()` — because this link is rendered as an
  // anchor on the public achievement page and in the moderation queue an admin
  // clicks through; see `lib/urls.ts`.
  link: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    httpUrl(2000).optional(),
  ),
});

/** An achiever's LinkedIn, typed by an admin — same `http(s)`-only rule as `link`. */
const optionalLinkedin = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  httpUrl(500).optional(),
);

/**
 * What an admin may add on top of the alumnus form, when recording somebody
 * else's achievement.
 *
 * Exactly one of `userId` / `achieverName` identifies the achiever: a member
 * of the portal (the entry then lives on *their* achievements, and the byline
 * and LinkedIn come from their profile), or a plain name for someone who never
 * registered. Accepting both would leave two answers to "whose is this?", and
 * accepting neither files an achievement about the admin.
 *
 * These fields exist only on the admin route. The alumnus-facing
 * `achievementInputSchema` has no `userId`, so a member cannot file an
 * achievement under somebody else's name by adding a field to their request.
 */
export const adminAchievementInputSchema = achievementInputSchema
  .extend({
    userId: z.string().uuid().optional(),
    achieverName: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().min(2).max(120).optional(),
    ),
    /** Blank means "use the member's profile link", which stays live. */
    achieverLinkedinUrl: optionalLinkedin,
  })
  .superRefine((d, ctx) => {
    if (!d.userId === !d.achieverName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["achieverName"],
        message: "Name the achiever: pick an alumnus, or type a name — one or the other",
      });
    }
  });

/** Admins may also correct the achiever fields; members never see them. */
export const achievementUpdateSchema = achievementInputSchema.partial().extend({
  achieverName: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.union([z.string().trim().min(2).max(120), z.null()]).optional(),
  ),
  achieverLinkedinUrl: z.preprocess(
    (v) => (v === "" || v === null ? null : v),
    z.union([httpUrl(500), z.null()]).optional(),
  ),
});

export const listQuerySchema = paginationSchema.extend({
  q: z.string().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  userId: z.string().uuid().optional(),
  /** Restrict to the caller's own submissions, at any moderation status. */
  mine: booleanQueryParam,
});

export const moderationSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().max(1000).optional(),
});