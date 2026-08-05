import type { Tx } from "./audit.js";

export interface AllocateVoucherNumberParams {
  branchId: string;
  voucherType: string; // 'sale' | 'purchase' | 'receipt' | 'payment' | ... (TDD §5.5)
  financialYear: string; // caller derives via deriveFinancialYear before calling
  // Status as of formatVoucherNumber below (PROJECT_ROADMAP.md §9, provisional): currently
  // written and read back, but NOT consumed by the finalized display format, which derives the
  // voucher string fresh from branch.code + financialYear + sequenceNumber instead of reading
  // this column back. TDD §5.5's own example ("e.g. INV/MAIN/2025-26/") describes a
  // stored-template-then-append-number model that predates that format decision — this column is
  // the leftover shape of that earlier model, not an accidentally-unused field nobody noticed.
  // Kept live (not stripped from the row) since number_series is schema-locked from Phase 0 and a
  // future voucher type or a revised display format could still want a stored per-series prefix;
  // whether it ever will is genuinely open, not a planned use.
  defaultPrefix: string | null;
  actorId: string;
}

export interface AllocatedVoucherNumber {
  // See defaultPrefix above — populated from the row, but unconsumed by formatVoucherNumber today.
  prefix: string | null;
  sequenceNumber: number;
}

/**
 * TDD §5.5 / §26 step 7 — allocates the next sequential number for (branch, voucher_type,
 * financial_year), row-locked so concurrent confirms serialize instead of colliding.
 *
 * Deliberately NOT "SELECT ... FOR UPDATE, create if missing": FOR UPDATE locks nothing when the
 * row doesn't exist yet (there's no row to lock), so two concurrent transactions can both observe
 * "no row" and both attempt to create one. Whichever loses that race fails on the
 * ux_number_series_active partial unique index instead of serializing cleanly behind the winner —
 * exactly the kind of thing that won't show up in casual/single-request testing but will at real
 * counter volume (two tills confirming the branch's first sale of a new financial year at once).
 *
 * The fix: INSERT ... ON CONFLICT DO NOTHING first, unconditionally, so a matching row is
 * guaranteed to exist (created by whichever transaction wins; silently absorbed by whichever
 * loses — Postgres blocks the loser's INSERT until the winner commits, per normal unique-index
 * conflict behavior). The SELECT ... FOR UPDATE that follows then always finds a real row to lock
 * and increment, with no window where "row doesn't exist" is possible.
 *
 * Returns the raw prefix + sequence number, not a formatted invoice/voucher number string — the
 * exact display format (prefix template, zero-padding width) is a caller decision (§26 step 7
 * calls this "prefix from config", not further specified), kept out of this shared, race-fix-only
 * helper on purpose.
 */
export async function allocateVoucherNumber(tx: Tx, params: AllocateVoucherNumberParams): Promise<AllocatedVoucherNumber> {
  const { branchId, voucherType, financialYear, defaultPrefix, actorId } = params;

  await tx.$executeRaw`
    INSERT INTO number_series (branch_id, voucher_type, financial_year, prefix, created_by, updated_by)
    VALUES (${branchId}::uuid, ${voucherType}, ${financialYear}, ${defaultPrefix}, ${actorId}::uuid, ${actorId}::uuid)
    ON CONFLICT (branch_id, voucher_type, financial_year) WHERE deleted_at IS NULL DO NOTHING`;

  const rows = await tx.$queryRaw<{ id: string; prefix: string | null; current_number: number }[]>`
    SELECT id, prefix, current_number FROM number_series
    WHERE branch_id = ${branchId}::uuid
      AND voucher_type = ${voucherType}
      AND financial_year = ${financialYear}
      AND deleted_at IS NULL
    FOR UPDATE`;
  const row = rows[0];

  if (!row) {
    // Unreachable under normal (read-committed) transaction semantics: the INSERT above commits
    // to either creating this row or blocking on a concurrent insert of the same row until it's
    // visible, so a matching row always exists by the time this SELECT runs, inside the same tx.
    throw new Error(`number_series row missing for ${branchId}/${voucherType}/${financialYear} after insert`);
  }

  const sequenceNumber = row.current_number + 1;
  await tx.numberSeries.update({
    where: { id: row.id },
    data: { currentNumber: sequenceNumber, updatedBy: actorId },
  });

  return { prefix: row.prefix, sequenceNumber };
}

// PROVISIONAL — confirm before go-live (tracked in PROJECT_ROADMAP.md §9). Format:
// {branch.code}/{financialYear}/{sequenceNumber, zero-padded to 4 digits}, e.g.
// "BHM/2025-26/0001" or "MAIN/2025-26/0001". Deliberately takes no prefix argument — this is the
// decision point where number_series.prefix (see AllocateVoucherNumberParams.defaultPrefix above)
// goes unconsumed; the display string is derived fresh from branch.code + financialYear +
// sequenceNumber every call, never from the stored row. The single call site for every voucher
// type (sale now, purchase/receipt/payment later) so the format only ever needs changing here.
export function formatVoucherNumber(branchCode: string, financialYear: string, sequenceNumber: number): string {
  return `${branchCode}/${financialYear}/${String(sequenceNumber).padStart(4, "0")}`;
}
