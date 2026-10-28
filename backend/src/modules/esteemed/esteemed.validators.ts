import { z } from "zod";

export const ESTEEMED_CATEGORIES = ["leadership", "entrepreneurs", "civil_services"] as const;

export const alumnusInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  batch: z.number().int().min(1900).max(2100),
  position: z.string().trim().min(1).max(500),
  photoKey: z.string().min(1).max(500),
  category: z.enum(ESTEEMED_CATEGORIES),
  sortOrder: z.number().int().min(0).optional(),
});

export const alumnusUpdateSchema = alumnusInputSchema.partial();

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

export const listQuerySchema = z.object({
  category: z.enum(ESTEEMED_CATEGORIES).optional(),
});
