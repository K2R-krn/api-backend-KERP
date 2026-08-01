import { z } from "zod";

const taxClassification = z.enum(["taxable", "exempt", "nil_rated", "non_gst"]);

// numeric(5,2) — up to 999.99, at most 2 decimal places. Never hardcode the GST slab set (rates
// change, e.g. Sept 2025) — this only enforces the column's shape, not a rate whitelist.
const gstRate = z
  .number()
  .nonnegative()
  .max(999.99)
  .refine((v) => Number.isInteger(Math.round(v * 100)), {
    message: "gstRate supports at most 2 decimal places",
  });

// Paise, bigint at rest — always nonnegative (unlike a party's openingBalance, a price is never
// signed).
const money = z.number().int().nonnegative();

export const createProductSchema = z.object({
  name: z.string().trim().min(1),
  hsnCode: z.string().trim().min(1).optional(),
  sku: z.string().trim().min(1).optional(),
  categoryId: z.string().uuid().optional(),
  unitId: z.string().uuid(),
  // Explicit on every create — category.default_gst_rate/default_tax_classification are
  // pre-fill-only (TDD §6.4), never a service-side fallback. Confirmed with user 2026-08-01.
  gstRate,
  taxClassification,
  priceIncludesGst: z.boolean().default(false),
  purchasePrice: money.default(0),
  salePrice: money.default(0),
  mrp: money.optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).optional(),
  hsnCode: z.string().trim().min(1).optional(),
  sku: z.string().trim().min(1).optional(),
  categoryId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  gstRate: gstRate.optional(),
  taxClassification: taxClassification.optional(),
  priceIncludesGst: z.boolean().optional(),
  purchasePrice: money.optional(),
  salePrice: money.optional(),
  mrp: money.optional(),
});
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Matches products(name) and products(hsn_code) indexes (TDD §6.5).
  search: z.string().trim().min(1).optional(),
  categoryId: z.string().uuid().optional(),
  // Deliberately not z.coerce.boolean() — that treats the string "false" as truthy.
  isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  // Date range filter over created_at (TDD §3.6 "date range filters where relevant").
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
