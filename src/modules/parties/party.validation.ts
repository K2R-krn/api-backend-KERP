import { z } from "zod";
import { GST_STATE_CODES } from "../../shared/constants.js";

const partyType = z.enum(["customer", "supplier", "both"]);

// Standard 15-char GSTIN shape (2-digit state code + 10-char PAN + entity/check chars). Not
// spec-locked, but a well-known external format — same category of "known list" as state_code.
const gstin = z.string().trim().length(15).regex(/^[0-9A-Z]{15}$/);

export const createPartySchema = z.object({
  type: partyType,
  name: z.string().trim().min(1),
  village: z.string().trim().min(1),
  mobile: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  gstin: gstin.optional(),
  stateCode: z.enum(GST_STATE_CODES),
  address: z.string().trim().min(1).optional(),
  // Paise, signed per TDD §18.1 (debit positive / credit negative) — not restricted to
  // nonnegative, since a prepaid customer can start with a credit (negative) balance.
  openingBalance: z.number().int().default(0),
});
export type CreatePartyInput = z.infer<typeof createPartySchema>;

export const updatePartySchema = z.object({
  type: partyType.optional(),
  name: z.string().trim().min(1).optional(),
  village: z.string().trim().min(1).optional(),
  mobile: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  gstin: gstin.optional(),
  stateCode: z.enum(GST_STATE_CODES).optional(),
  address: z.string().trim().min(1).optional(),
});
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;

export const listPartiesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).optional(),
  type: partyType.optional(),
  // Deliberately not z.coerce.boolean() — that treats the string "false" as truthy.
  isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export type ListPartiesQuery = z.infer<typeof listPartiesQuerySchema>;
