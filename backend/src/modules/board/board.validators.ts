import { z } from "zod";

export const memberInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  authority: z.string().trim().min(1).max(100),
  designation: z.string().trim().min(1).max(300),
  photoKey: z.string().min(1).max(500).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const memberUpdateSchema = memberInputSchema.partial().extend({
  photoKey: z.union([z.string().min(1).max(500), z.null()]).optional(),
});

export const reorderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().min(0),
      }),
    )
    .min(1),
});
