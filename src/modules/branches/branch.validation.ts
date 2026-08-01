import { z } from "zod";

// GST state code — 2-digit numeric (e.g. "24" for Gujarat), drives intra/inter-state tax (TDD §5.2).
const stateCode = z.string().trim().regex(/^\d{2}$/, "stateCode must be a 2-digit GST state code");

export const createBranchSchema = z.object({
  name: z.string().trim().min(1),
  code: z.string().trim().min(1),
  gstin: z.string().trim().min(1).optional(),
  stateCode,
  address: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).optional(),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  code: z.string().trim().min(1).optional(),
  gstin: z.string().trim().min(1).optional(),
  stateCode: stateCode.optional(),
  address: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).optional(),
});
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

export const listBranchesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).optional(),
  // Deliberately not z.coerce.boolean() — that treats the string "false" as truthy.
  isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export type ListBranchesQuery = z.infer<typeof listBranchesQuerySchema>;
