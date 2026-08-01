import { z } from "zod";

// numeric(12,4) — up to 8 digits before the point, at most 4 decimal places. A base unit link
// with no factor (or vice versa) is unusable data, so require them together.
const conversionFactor = z
  .number()
  .positive()
  .refine((v) => Number.isInteger(Math.round(v * 10_000)), {
    message: "conversionFactor supports at most 4 decimal places",
  });

function requireBaseUnitPair<T extends { baseUnitId?: string; conversionFactor?: number }>(data: T): boolean {
  return (data.baseUnitId === undefined) === (data.conversionFactor === undefined);
}

const baseUnitPairMessage = {
  message: "baseUnitId and conversionFactor must be provided together",
  path: ["baseUnitId"],
};

export const createUnitSchema = z
  .object({
    name: z.string().trim().min(1),
    symbol: z.string().trim().min(1),
    baseUnitId: z.string().uuid().optional(),
    conversionFactor: conversionFactor.optional(),
  })
  .refine(requireBaseUnitPair, baseUnitPairMessage);
export type CreateUnitInput = z.infer<typeof createUnitSchema>;

export const updateUnitSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    symbol: z.string().trim().min(1).optional(),
    baseUnitId: z.string().uuid().optional(),
    conversionFactor: conversionFactor.optional(),
  })
  .refine(requireBaseUnitPair, baseUnitPairMessage);
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;

export const listUnitsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).optional(),
});
export type ListUnitsQuery = z.infer<typeof listUnitsQuerySchema>;
