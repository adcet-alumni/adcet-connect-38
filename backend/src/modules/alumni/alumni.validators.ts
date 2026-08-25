import { z } from "zod";
import { paginationSchema } from "../../lib/pagination.js";

/**
 * Query strings carry no arrays, so multi-select filters arrive comma-separated
 * (`departments=Civil Engineering,Food Technology`). Values are matched exactly
 * against what is stored, and an unknown one simply narrows the result set —
 * the same lenient posture the other read filters take.
 */
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(item))
    .optional();

/**
 * `relevant` is the default and is computed per viewer (own department first,
 * then outwards from their own batch); the other two are the viewer-independent
 * orders, offered so a member can always fall back to a predictable listing.
 */
export const DIRECTORY_SORTS = ["relevant", "batch", "name"] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export const directoryQuery = paginationSchema.extend({
  sort: z.enum(DIRECTORY_SORTS).default("relevant"),
  q: z.string().optional(),
  city: z.string().optional(),
  company: z.string().optional(),
  department: z.string().optional(),
  departments: csv(z.string()),
  graduationYear: z.coerce.number().int().optional(),
  graduationYears: csv(z.coerce.number().int()),
  graduationYearMin: z.coerce.number().int().optional(),
  graduationYearMax: z.coerce.number().int().optional(),
});