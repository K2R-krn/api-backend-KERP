import type { Prisma } from "@prisma/client";
import { runTransaction } from "../../db/client.js";
import { writeAudit, type Tx } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { decimalToBigInt } from "../../shared/decimal.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import type { Role } from "../../shared/types.js";
import type { CloseDayInput, ReopenDayInput } from "./day-close.validation.js";

export interface DayCloseActor {
  userId: string;
  role: Role;
  branchId: string;
}

function requireSystemLedger(value: string | null, ledger: string): string {
  if (value == null) throw new ConflictError("SYSTEM_LEDGER_NOT_CONFIGURED", { ledger });
  return value;
}

function formatISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================================
// §35.5 — the day-close advisory lock. This is the SOLE place pg_advisory_xact_lock is called for
// this purpose: DAY_CLOSE_LOCK_NAMESPACE is not exported, so no other call site can reimplement
// the raw key derivation and drift from it. Every caller — assertNotPastDayClose below, and
// closeDay/reopenDay directly — resolves through this one function.
// ============================================================================

const DAY_CLOSE_LOCK_NAMESPACE = 483_205_106; // fixed int4, private to this lock's purpose (§35.5).

async function acquireDayLock(tx: Tx, branchId: string, voucherDate: Date): Promise<void> {
  const key = `${branchId}|${formatISODate(voucherDate)}`;
  // The two-key overload is pg_advisory_xact_lock(int4, int4) — Prisma sends a bare JS number as
  // bigint, which resolves to the WRONG overload (there's also a single-key bigint form) and 42883s.
  // Explicit ::int4 cast pins it to the two-key form. Separately, pg_advisory_xact_lock returns
  // void, which $queryRaw cannot deserialize ("Failed to deserialize column of type 'void'") — the
  // lock is taken for its side effect only, so $executeRaw (result discarded) is correct here, not
  // a workaround (both verified against the real dev DB).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DAY_CLOSE_LOCK_NAMESPACE}::int4, hashtext(${key}))`;
}

// ============================================================================
// assertNotPastDayClose — TDD §20/§35.4/§35.5. Real implementation, replacing the Iteration-3
// no-op stub that used to live in sale.service.ts. Every caller — editSale, cancelSale (both
// pre-existing), and confirmSale/confirmPurchase/confirmPayment (new this iteration, §35.4) —
// still only ever calls this one function; zero shape change at those call sites beyond the call
// itself where it was missing.
// ============================================================================

export async function assertNotPastDayClose(tx: Tx, branchId: string, voucherDate: Date): Promise<void> {
  await acquireDayLock(tx, branchId, voucherDate);

  const lastClosed = await tx.dayClose.findFirst({
    where: { branchId, status: "closed" },
    orderBy: { closeDate: "desc" },
    select: { closeDate: true },
  });
  if (lastClosed && voucherDate <= lastClosed.closeDate) {
    // Renamed from the Iteration-3 stub's planned SALE_DATE_LOCKED_BY_DAY_CLOSE: this guard now
    // also blocks purchases and payments (§35.4), so the code can no longer be sale-specific.
    throw new ConflictError("VOUCHER_DATE_LOCKED_BY_DAY_CLOSE", { lastClosedDate: formatISODate(lastClosed.closeDate) });
  }
}

// ============================================================================
// §35.7 — GST-filed-period reopen guard. Mirrors T-6's original assertNotPastDayClose stub
// exactly: GSTR filing-period tracking is Iteration 6 scope, so no such state exists yet. Written
// for real (not `if (false)` inlined at the call site) so Iteration 6 only has to give this body a
// real query — reopenDay's call site and this function's error contract never change.
// ============================================================================

// Exported (unlike acquireDayLock) purely so the test suite can prove this genuinely runs and
// passes rather than being silently absent from reopenDay's call chain — no other production
// call site needs it besides reopenDay below.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- real signature for Iteration 6's future body; see comment above.
export async function assertGstPeriodNotFiled(_tx: Tx, _branchId: string, _closeDate: Date): Promise<void> {
  // No GST-filed-period state exists yet — every close_date is therefore always "not filed."
  // Once Iteration 6 lands GSTR filing-period tracking, replace this body with a real lookup and
  // throw ConflictError("REOPEN_BLOCKED_GST_PERIOD_FILED", { filedPeriod }) when closeDate falls
  // inside a period whose GSTR has been filed.
}

// ============================================================================
// §35.3 — opening_cash sourcing: the previous CLOSED day's actual_counted_cash, never its
// expected_closing_cash (that would silently absorb a prior shortfall). A branch's very first
// close ever needs an explicit, manually entered starting float — "supplied explicitly on that
// first call only" (§35.3): a RECLOSE of that same first date is not a new "first call", so it
// must reuse the value already pinned on the existing row, not re-derive or re-demand it — opening
// cash is what was physically in the till at the start of that business day, a fact that doesn't
// change just because the day's reconciliation was reopened and reclosed.
// ============================================================================

async function resolveOpeningCash(
  tx: Tx,
  branchId: string,
  closeDate: Date,
  existingOpeningCash: bigint | undefined,
  suppliedOpeningCash: number | undefined,
): Promise<bigint> {
  if (existingOpeningCash !== undefined) return existingOpeningCash;

  const previous = await tx.dayClose.findFirst({
    where: { branchId, status: "closed", closeDate: { lt: closeDate } },
    orderBy: { closeDate: "desc" },
    select: { actualCountedCash: true },
  });
  if (previous) return previous.actualCountedCash;
  if (suppliedOpeningCash === undefined) {
    throw new BadRequestError("OPENING_CASH_REQUIRED_FOR_FIRST_CLOSE");
  }
  return BigInt(suppliedOpeningCash);
}

// ============================================================================
// §35.2 — expected_closing_cash: one signed sum over ledger_postings, not four separately-queried
// categories re-derived from sales/payments headers (that would reintroduce the exact staleness
// risk CC-8 exists to prevent). voucher_type breakdown is grouped from the same query, display
// only — the total never depends on it, which is what makes a future Iteration 5 contra voucher
// land in this formula with zero code changes here.
// ============================================================================

interface CashPostingRow {
  voucherType: string;
  total: Prisma.Decimal;
}

async function computeExpectedClosingCash(
  tx: Tx,
  branchId: string,
  cashLedgerId: string,
  closeDate: Date,
  openingCash: bigint,
): Promise<{ expectedClosingCash: bigint; breakdown: { voucherType: string; total: bigint }[] }> {
  const rows = await tx.$queryRaw<CashPostingRow[]>`
    SELECT voucher_type AS "voucherType", SUM(amount) AS "total"
    FROM ledger_postings
    WHERE ledger_id = ${cashLedgerId}::uuid
      AND branch_id = ${branchId}::uuid
      AND voucher_date = ${closeDate}
    GROUP BY voucher_type
  `;
  const breakdown = rows.map((r) => ({ voucherType: r.voucherType, total: decimalToBigInt(r.total) }));
  const postingsSum = breakdown.reduce((acc, r) => acc + r.total, 0n);
  return { expectedClosingCash: openingCash + postingsSum, breakdown };
}

// ============================================================================
// closeDay — TDD §35.6. Covers first close, and reclose (re-running this after an Admin reopen);
// distinguished only by whether a day_closes row already exists for this (branch, close_date).
// ============================================================================

export async function closeDay(input: CloseDayInput, actor: DayCloseActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(
    async (tx) => {
      await acquireDayLock(tx, actor.branchId, input.closeDate);

      const branch = await tx.branch.findFirst({ where: { id: actor.branchId, deletedAt: null } });
      if (!branch) throw new NotFoundError("BRANCH_NOT_FOUND");
      const cashLedgerId = requireSystemLedger(branch.cashLedgerId, "branch.cashLedgerId");

      const existing = await tx.dayClose.findUnique({
        where: { branchId_closeDate: { branchId: actor.branchId, closeDate: input.closeDate } },
      });
      if (existing?.status === "closed") {
        throw new ConflictError("DAY_ALREADY_CLOSED", { closeDate: formatISODate(input.closeDate) });
      }

      const openingCash = await resolveOpeningCash(tx, actor.branchId, input.closeDate, existing?.openingCash, input.openingCash);
      const { expectedClosingCash, breakdown } = await computeExpectedClosingCash(
        tx,
        actor.branchId,
        cashLedgerId,
        input.closeDate,
        openingCash,
      );
      const actualCountedCash = BigInt(input.actualCountedCash);
      const shortOver = actualCountedCash - expectedClosingCash;

      const before = existing ? serializeBigInt(existing) : null;
      const row = await tx.dayClose.upsert({
        where: { branchId_closeDate: { branchId: actor.branchId, closeDate: input.closeDate } },
        create: {
          branchId: actor.branchId,
          closeDate: input.closeDate,
          status: "closed",
          openingCash,
          expectedClosingCash,
          actualCountedCash,
          shortOver,
          note: input.note ?? null,
          closedAt: new Date(),
          closedBy: actor.userId,
        },
        update: {
          status: "closed",
          openingCash,
          expectedClosingCash,
          actualCountedCash,
          shortOver,
          note: input.note ?? null,
          closedAt: new Date(),
          closedBy: actor.userId,
          // A reclose supersedes the prior reopen — clear its trail (reopen_reason is
          // "nullable, required when status = reopened", so it goes back to null once closed).
          reopenReason: null,
          reopenedAt: null,
          reopenedBy: null,
        },
      });

      await writeAudit(tx, actor, {
        action: existing ? "update" : "create",
        entityType: "day_close",
        entityId: row.id,
        before,
        after: serializeBigInt(row),
      });

      const responseBody = success(serializeBigInt({ ...row, breakdown }));
      await completeIdempotencyKey(tx, idempotencyKey, responseBody);
      return responseBody;
    },
    // Same generous-timeout rationale as confirmSale/confirmPurchase/confirmPayment (CLAUDE.md:
    // remote-DB latency over the Nepal-to-Mumbai path).
    { timeout: 30_000 },
  );
}

// ============================================================================
// reopenDay — TDD §35.6/§35.8. Admin/Super Admin only (enforced at the route via
// requireCap("cashClose:resolve")), mandatory reason, audit before/after.
// ============================================================================

export async function reopenDay(input: ReopenDayInput, actor: DayCloseActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(
    async (tx) => {
      await acquireDayLock(tx, actor.branchId, input.closeDate);

      const existing = await tx.dayClose.findUnique({
        where: { branchId_closeDate: { branchId: actor.branchId, closeDate: input.closeDate } },
      });
      if (!existing) throw new NotFoundError("DAY_CLOSE_NOT_FOUND");
      if (existing.status !== "closed") {
        throw new ConflictError("DAY_NOT_CLOSED", { status: existing.status });
      }

      await assertGstPeriodNotFiled(tx, actor.branchId, input.closeDate);

      const before = serializeBigInt(existing);
      const row = await tx.dayClose.update({
        where: { id: existing.id },
        data: {
          status: "reopened",
          reopenReason: input.reason,
          reopenedAt: new Date(),
          reopenedBy: actor.userId,
        },
      });

      await writeAudit(tx, actor, {
        action: "update",
        entityType: "day_close",
        entityId: row.id,
        before,
        after: serializeBigInt(row),
      });

      const responseBody = success(serializeBigInt(row));
      await completeIdempotencyKey(tx, idempotencyKey, responseBody);
      return responseBody;
    },
    { timeout: 30_000 },
  );
}
