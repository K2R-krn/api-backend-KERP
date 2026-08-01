import { z } from "zod";

const taxClassification = z.enum(["taxable", "exempt", "nil_rated", "non_gst"]);

// numeric(5,2) — up to 999.99, at most 2 decimal places. Pre-fill-only convenience (TDD §6.4),
// never a service-side fallback — never hardcode the GST slab set here either (rates change).
const gstRate = z
  .number()
  .nonnegative()
  .max(999.99)
  .refine((v) => Number.isInteger(Math.round(v * 100)), {
    message: "defaultGstRate supports at most 2 decimal places",
  });

export const createCategorySchema = z.object({
  name: z.string().trim().min(1),
  parentId: z.string().uuid().optional(),
  defaultGstRate: gstRate.optional(),
  defaultTaxClassification: taxClassification.optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).optional(),
  parentId: z.string().uuid().optional(),
  defaultGstRate: gstRate.optional(),
  defaultTaxClassification: taxClassification.optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const listCategoriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).optional(),
  parentId: z.string().uuid().optional(),
});
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
