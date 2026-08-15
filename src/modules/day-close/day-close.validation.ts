import { z } from "zod";

// Paise, bigint at rest. Nonnegative — a physical cash count/float is never negative.
const money = z.number().int().nonnegative();

// closeDay (TDD §35.6) — openingCash is optional: required only for a branch's very first-ever
// close (§35.3), rejected by the service if missing in that case; ignored (and recomputed from the
// previous closed day's actualCountedCash) on every subsequent close/reclose.
export const closeDaySchema = z.object({
  closeDate: z.coerce.date(),
  actualCountedCash: money,
  note: z.string().trim().min(1).optional(),
  openingCash: money.optional(),
});
export type CloseDayInput = z.infer<typeof closeDaySchema>;

// reopenDay (TDD §35.6/§35.8) — reason is mandatory, matching editSale/cancelSale's
// cancelReason-style requirement for an audited override.
export const reopenDaySchema = z.object({
  closeDate: z.coerce.date(),
  reason: z.string().trim().min(1),
});
export type ReopenDayInput = z.infer<typeof reopenDaySchema>;
