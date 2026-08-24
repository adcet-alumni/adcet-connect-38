/**
 * Zod schemas for Alumni Collaboration requests.
 *
 * One table backs every collaboration kind, so this file — not the database —
 * is what makes the right subset of columns mandatory per `type`. A
 * discriminated union on `type` gives each kind its own required fields while
 * still parsing into one row shape, and adding a kind means adding one member
 * to `collaborationInputSchema` rather than touching the service at all.
 */
import { z } from "zod";
import { booleanQueryParam, paginationSchema } from "../../lib/pagination.js";
import { departmentListSchema } from "../../lib/departments.js";
import { COLLABORATION_TYPES } from "../../config/constants.js";

export { COLLABORATION_TYPES, type CollaborationTypeName } from "../../config/constants.js";

/** Empty string from an untouched form input means "not provided". */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined));

const optionalEmail = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  z.string().email().max(200).optional(),
);

/** Fields every collaboration kind collects. */
const baseFields = {
  title: z.string().trim().min(3).max(200),
  organization: optionalText(200),
  /** Empty list = open to every department, matching events and jobs. */
  departments: departmentListSchema,
  mode: z.enum(["ON_CAMPUS", "ONLINE", "HYBRID"]).optional(),
  description: optionalText(5000),
  attachmentKey: optionalText(500),
  attachmentName: optionalText(255),
  contactEmail: optionalEmail,
  contactPhone: optionalText(30),
};

const placementSchema = z.object({
  ...baseFields,
  type: z.literal("PLACEMENT"),
  candidatesRequired: z.coerce.number().int().min(1).max(100000),
  jobRole: optionalText(200),
  /** CTC in lakhs per annum. */
  packageLpa: z.coerce.number().min(0).max(1000),
  driveDate: z.coerce.date(),
  eligibility: optionalText(2000),
});

const workshopSchema = z.object({
  ...baseFields,
  type: z.literal("WORKSHOP"),
  subject: z.string().trim().min(2).max(200),
  durationValue: z.coerce.number().int().min(1).max(365),
  durationUnit: z.enum(["HOURS", "DAYS"]),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  expectedParticipants: z.coerce.number().int().min(1).max(100000).optional(),
});

/**
 * The catch-all kind. It adds no fields of its own — what makes an `OTHER`
 * request legible is the description, so that is the one thing promoted from
 * optional to required here (a bare title would leave the office with nothing
 * to act on), and `startDate` carries the preferred date under a different
 * label. Anything that turns out to be common enough to deserve its own form
 * graduates to a named kind.
 */
const otherSchema = z.object({
  ...baseFields,
  type: z.literal("OTHER"),
  description: z.string().trim().min(20).max(5000),
  /** Optional "when would suit you", shown as the preferred date. */
  startDate: z.coerce.date().optional(),
});

/**
 * Cross-field checks hang off the union, not off a member: `.refine()` turns a
 * member into a `ZodEffects`, which `discriminatedUnion` refuses to accept.
 */
export const collaborationInputSchema = z
  .discriminatedUnion("type", [placementSchema, workshopSchema, otherSchema])
  .superRefine((d, ctx) => {
    if (d.type === "WORKSHOP" && d.endDate && d.endDate < d.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date cannot be before the start date",
        path: ["endDate"],
      });
    }
  });
export type CollaborationInput = z.infer<typeof collaborationInputSchema>;

export const listQuerySchema = paginationSchema.extend({
  type: z.enum(COLLABORATION_TYPES).optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  q: z.string().max(200).optional(),
  /** Restrict to the caller's own requests, at any status. */
  mine: booleanQueryParam,
});
export type CollaborationListQuery = z.infer<typeof listQuerySchema>;

export const moderationSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().max(1000).optional(),
});
