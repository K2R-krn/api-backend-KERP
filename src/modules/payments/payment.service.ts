import { prisma, runTransaction } from "../../db/client.js";
import { assertNotPastDayClose } from "../day-close/day-close.service.js";
import { writeAudit, type Tx } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import { deriveFinancialYear } from "../../shared/financial-year.js";
import { allocateVoucherNumber, formatVoucherNumber } from "../../shared/number-series.js";
import type { Role } from "../../shared/types.js";
import type { AllocationInput, ConfirmPaymentInput, FastExpenseEntryInput } from "./payment.validation.js";

export interface PaymentActor {
  userId: string;
  role: Role;
  branchId: string;
}

function requireSystemLedger(value: string | null, ledger: string): string {
  if (value == null) throw new ConflictError("SYSTEM_LEDGER_NOT_CONFIGURED", { ledger });
  return value;
}

function requireAccountGroup(value: string | null, field: string): string {
  if (value == null) throw new ConflictError("SYSTEM_ACCOUNT_GROUP_NOT_CONFIGURED", { field });
  return value;
}

// ============================================================================
// remainingBalance — TDD §32. Pure formula, no locking, no guards: "how much of this invoice's
// credit portion is still unpaid," pulled from the header's stored credit_udhar/credit_to_supplier
// (never recomputed from lines, CC-3). Locking is entirely the caller's responsibility (§32.4) —
// confirmPayment takes the row lock (see the lock-discipline note in its own body below) BEFORE
// calling this, so by the time this runs the row is already stable for the duration of the tx and
// the allocations sum below reflects every payment that has already committed against it.
// ============================================================================

export async function remainingBalance(tx: Tx, target: { saleId: string } | { purchaseId: string }): Promise<bigint> {
  if ("saleId" in target) {
    const sale = await tx.sale.findUnique({ where: { id: target.saleId }, select: { creditUdhar: true } });
    if (!sale) {
      // Invariant: callers only ever reach here after confirming the row exists (§31.7 step 1,
      // via the batched lock query's row-diff) — not a domain AppError.
      throw new Error(`remainingBalance: sale ${target.saleId} not found`);
    }
    const agg = await tx.paymentAllocation.aggregate({ where: { saleId: target.saleId }, _sum: { amount: true } });
    return sale.creditUdhar - (agg._sum.amount ?? 0n);
  }
  const purchase = await tx.purchase.findUnique({ where: { id: target.purchaseId }, select: { creditToSupplier: true } });
  if (!purchase) {
    throw new Error(`remainingBalance: purchase ${target.purchaseId} not found`);
  }
  const agg = await tx.paymentAllocation.aggregate({ where: { purchaseId: target.purchaseId }, _sum: { amount: true } });
  return purchase.creditToSupplier - (agg._sum.amount ?? 0n);
}

// ============================================================================
// confirmPayment — TDD §31. One runTransaction, same idempotency/atomicity contract as
// confirmSale/confirmPurchase. Applies to both standalone Receipt and Payment vouchers.
// ============================================================================

interface LockedTarget {
  id: string;
  status: string;
  branchId: string;
}

// §32.3 lock discipline, extended to confirmPayment's own multi-target allocation loop: batched
// FOR UPDATE per table (ORDER BY id — Postgres locks in that scan order), sales BEFORE purchases,
// fixed and followed by every call so two concurrent multi-target payments can't deadlock against
// each other. A requested id absent from the returned set is §31.7 step 1's NOT_FOUND, detected as
// a side effect of the batched query itself (a missing row simply returns fewer rows) rather than
// a second existence check.
//
// This is the only defense against a concurrent editSale/cancelSale racing this function's
// remainingBalance computation on the same sale/purchase row. No special-casing needed in
// editSale/cancelSale themselves — Postgres's ordinary implicit row lock on UPDATE (the same lock
// class SELECT ... FOR UPDATE takes) already serializes against them:
//   - If this transaction locks the row first, editSale/cancelSale's own UPDATE blocks on that row
//     until this transaction commits or rolls back, then proceeds against the post-commit row.
//     Their writes never need to re-read credit_udhar/status themselves (editSale recomputes
//     credit_udhar from values already read earlier in its own tx; cancelSale just sets status),
//     so blocking mid-transaction costs nothing correctness-wise.
//   - If editSale/cancelSale's UPDATE runs first, it holds the row lock until its own commit; this
//     SELECT ... FOR UPDATE then blocks until that commit, and reads the POST-edit/post-cancel row
//     — exactly the fresh state remainingBalance needs.
// No deadlock risk: editSale/cancelSale each touch at most one row in this lock's table (plus
// branch_stock, a disjoint table this function never locks), so they can never hold one row this
// function needs while waiting on a second row this function also holds — the two-resource cycle a
// deadlock requires can't form on this pairing.
async function lockAllocationTargets(
  tx: Tx,
  saleIds: string[],
  purchaseIds: string[],
): Promise<{ sales: Map<string, LockedTarget>; purchases: Map<string, LockedTarget> }> {
  const sales = new Map<string, LockedTarget>();
  if (saleIds.length > 0) {
    const rows = await tx.$queryRaw<{ id: string; status: string; branchId: string }[]>`
      SELECT id, status, branch_id AS "branchId" FROM sales
      WHERE id = ANY(${saleIds}::uuid[])
      ORDER BY id
      FOR UPDATE`;
    for (const row of rows) sales.set(row.id, row);
  }

  const purchases = new Map<string, LockedTarget>();
  if (purchaseIds.length > 0) {
    const rows = await tx.$queryRaw<{ id: string; status: string; branchId: string }[]>`
      SELECT id, status, branch_id AS "branchId" FROM purchases
      WHERE id = ANY(${purchaseIds}::uuid[])
      ORDER BY id
      FOR UPDATE`;
    for (const row of rows) purchases.set(row.id, row);
  }

  return { sales, purchases };
}

// §31.7 full check ordering, in order, for one allocation entry against its already-locked target.
async function validateAndBuildAllocation(
  tx: Tx,
  allocation: AllocationInput,
  direction: "receipt" | "payment",
  actorBranchId: string,
  locked: { sales: Map<string, LockedTarget>; purchases: Map<string, LockedTarget> },
): Promise<{ saleId: string | null; purchaseId: string | null; amount: bigint }> {
  const amount = BigInt(allocation.amount);
  const isSale = allocation.saleId !== undefined;
  const targetId = (isSale ? allocation.saleId : allocation.purchaseId)!;
  const targetMap = isSale ? locked.sales : locked.purchases;
  const targetLabel = isSale ? "saleId" : "purchaseId";

  // Step 1 — target-not-found, via the batched lock query's row-diff.
  const target = targetMap.get(targetId);
  if (!target) throw new NotFoundError("ALLOCATION_TARGET_NOT_FOUND", { [targetLabel]: targetId });

  // Step 2 — status guard (CC-8): only status='confirmed' targets are real outstanding debt.
  if (target.status !== "confirmed") {
    throw new ConflictError("ALLOCATION_TARGET_NOT_CONFIRMED", { [targetLabel]: targetId, status: target.status });
  }

  // Step 3 — branch guard.
  if (target.branchId !== actorBranchId) {
    throw new BadRequestError("ALLOCATION_TARGET_WRONG_BRANCH", { [targetLabel]: targetId });
  }

  // Step 4 — remainingBalance <= 0 rejection (nothing owed / negative-advance sale, §32.2/§32.5).
  const remaining = isSale ? await remainingBalance(tx, { saleId: targetId }) : await remainingBalance(tx, { purchaseId: targetId });
  if (remaining <= 0n) {
    throw new ConflictError("NOTHING_OUTSTANDING", { [targetLabel]: targetId, remainingBalance: remaining.toString() });
  }

  // Step 5 — over-allocation rejection.
  if (amount > remaining) {
    throw new BadRequestError("ALLOCATION_EXCEEDS_REMAINING_BALANCE", {
      [targetLabel]: targetId,
      remainingBalance: remaining.toString(),
      amount: amount.toString(),
    });
  }

  return { saleId: isSale ? targetId : null, purchaseId: isSale ? null : targetId, amount };
}

export async function confirmPayment(input: ConfirmPaymentInput, actor: PaymentActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(
    async (tx) => {
      // §35.4/§35.6 — retroactive guard extension: a NEW receipt/payment dated onto a closed day
      // is blocked, blanket scope (a pure-udhar-touching allocation still retroactively changes
      // that day's books). input.voucherDate is available unconditionally, so this is literally
      // the first statement in the transaction.
      await assertNotPastDayClose(tx, actor.branchId, input.voucherDate);

      const branch = await tx.branch.findFirst({ where: { id: actor.branchId, deletedAt: null } });
      if (!branch) throw new NotFoundError("BRANCH_NOT_FOUND");
      const companyProfile = await tx.companyProfile.findFirst({ where: { deletedAt: null } });
      if (!companyProfile) throw new ConflictError("COMPANY_PROFILE_NOT_CONFIGURED");

      const amount = BigInt(input.amount);

      // §31.6 direction pairing — locked as a service-level check. Fail fast, before any DB writes
      // (same posture as confirmSale step 1): receipt may only allocate against sale_id, payment
      // may only allocate against purchase_id.
      const allocations = input.allocations ?? [];
      for (const a of allocations) {
        if (input.direction === "receipt" && a.purchaseId !== undefined) {
          throw new BadRequestError("RECEIPT_CANNOT_ALLOCATE_TO_PURCHASE", { purchaseId: a.purchaseId });
        }
        if (input.direction === "payment" && a.saleId !== undefined) {
          throw new BadRequestError("PAYMENT_CANNOT_ALLOCATE_TO_SALE", { saleId: a.saleId });
        }
      }

      // §31.6 — sum(allocations.amount) <= amount; remainder is implicitly on-account.
      const allocationsSum = allocations.reduce((acc, a) => acc + BigInt(a.amount), 0n);
      if (allocationsSum > amount) {
        throw new BadRequestError("ALLOCATIONS_EXCEED_PAYMENT_AMOUNT", {
          allocationsSum: allocationsSum.toString(),
          amount: amount.toString(),
        });
      }

      // §31.1 — cash_bank_ledger_id server-side validation.
      const cashBankLedger = await tx.ledger.findFirst({ where: { id: input.cashBankLedgerId, deletedAt: null } });
      if (!cashBankLedger) throw new NotFoundError("CASH_BANK_LEDGER_NOT_FOUND");
      if (cashBankLedger.branchId !== null && cashBankLedger.branchId !== actor.branchId) {
        throw new BadRequestError("CASH_BANK_LEDGER_WRONG_BRANCH", { ledgerId: cashBankLedger.id });
      }
      const cashAccountGroupId = requireAccountGroup(companyProfile.cashAccountGroupId, "companyProfile.cashAccountGroupId");
      const bankAccountGroupId = requireAccountGroup(companyProfile.bankAccountGroupId, "companyProfile.bankAccountGroupId");
      if (cashBankLedger.accountGroupId !== cashAccountGroupId && cashBankLedger.accountGroupId !== bankAccountGroupId) {
        throw new BadRequestError("CASH_BANK_LEDGER_INVALID_GROUP", { ledgerId: cashBankLedger.id });
      }

      // party_id / counter_ledger_id — exactly one (Zod already enforces the shape); resolve the
      // ledger the non-cash side of the posting actually hits.
      let partyId: string | null = null;
      let counterLedgerId: string | null = null;
      let counterPostingLedgerId: string;
      if (input.partyId) {
        const party = await tx.party.findFirst({ where: { id: input.partyId, owningBranchId: actor.branchId, deletedAt: null } });
        if (!party) throw new NotFoundError("PARTY_NOT_FOUND");
        partyId = party.id;
        counterPostingLedgerId = party.ledgerId;
      } else {
        const ledger = await tx.ledger.findFirst({ where: { id: input.counterLedgerId!, deletedAt: null } });
        if (!ledger) throw new NotFoundError("COUNTER_LEDGER_NOT_FOUND");
        counterLedgerId = ledger.id;
        counterPostingLedgerId = ledger.id;
      }

      // §31.2 — voucher number, existing allocateVoucherNumber/formatVoucherNumber helpers, new
      // voucher_type values ('receipt'/'payment') under the same (branch, voucher_type,
      // financial_year) unique key — no collision with sale/purchase by construction.
      const financialYear = deriveFinancialYear(input.voucherDate, companyProfile.fyStartMonth);
      const allocated = await allocateVoucherNumber(tx, {
        branchId: actor.branchId,
        voucherType: input.direction,
        financialYear,
        defaultPrefix: null,
        actorId: actor.userId,
      });
      const voucherNumber = formatVoucherNumber(branch.code, financialYear, allocated.sequenceNumber);

      const payment = await tx.payment.create({
        data: {
          branchId: actor.branchId,
          voucherDate: input.voucherDate,
          voucherNumber,
          financialYear,
          direction: input.direction,
          partyId,
          cashBankLedgerId: cashBankLedger.id,
          counterLedgerId,
          amount,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          status: "confirmed",
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      });

      // §31.3 — two-line posting, sign per §18.1. receipt: Dr cash_bank_ledger_id, Cr counter/party
      // ledger; payment: reversed.
      const cashAmount = input.direction === "receipt" ? amount : -amount;
      const postings = [
        { ledgerId: cashBankLedger.id, amount: cashAmount },
        { ledgerId: counterPostingLedgerId, amount: -cashAmount },
      ];
      const postingSum = postings.reduce((acc, p) => acc + p.amount, 0n);
      if (postingSum !== 0n) {
        // Internal invariant failure — unreachable given the algebra above; not a domain AppError,
        // rolls back the transaction as a 500 (same posture as confirmSale/confirmPurchase).
        throw new Error(`ledger_postings for payment ${payment.id} do not sum to zero (got ${postingSum.toString()})`);
      }
      await tx.ledgerPosting.createMany({
        data: postings.map((p) => ({
          ledgerId: p.ledgerId,
          branchId: actor.branchId,
          amount: p.amount,
          voucherType: input.direction,
          voucherId: payment.id,
          voucherDate: input.voucherDate,
          createdBy: actor.userId,
        })),
      });

      // §31.6/§31.7 — payment allocation. Lock every referenced sale/purchase row (§32.3 fixed
      // order: sales ascending id, then purchases ascending id) BEFORE computing any
      // remainingBalance, then validate each entry in the locked §31.7 order.
      const allocationRows: { saleId: string | null; purchaseId: string | null; amount: bigint }[] = [];
      if (allocations.length > 0) {
        const saleIds = [...new Set(allocations.filter((a) => a.saleId !== undefined).map((a) => a.saleId!))].sort();
        const purchaseIds = [...new Set(allocations.filter((a) => a.purchaseId !== undefined).map((a) => a.purchaseId!))].sort();
        const locked = await lockAllocationTargets(tx, saleIds, purchaseIds);

        for (const a of allocations) {
          allocationRows.push(await validateAndBuildAllocation(tx, a, input.direction, actor.branchId, locked));
        }

        await tx.paymentAllocation.createMany({
          data: allocationRows.map((r) => ({ paymentId: payment.id, saleId: r.saleId, purchaseId: r.purchaseId, amount: r.amount })),
        });
      }

      // §31.4 — audit + idempotency, both inside this same tx. Always a create (payments have no
      // draft/edit mode, CC-5 doesn't apply) — reference-only per §13's transaction-entity rule.
      await writeAudit(tx, actor, {
        action: "create",
        entityType: "payment",
        entityId: payment.id,
        after: {
          direction: input.direction,
          voucherNumber,
          amount: amount.toString(),
          partyId,
          counterLedgerId,
          allocationCount: allocationRows.length,
        },
      });

      const responseAllocations = await tx.paymentAllocation.findMany({ where: { paymentId: payment.id } });
      const responseBody = success(serializeBigInt({ ...payment, allocations: responseAllocations }));
      await completeIdempotencyKey(tx, idempotencyKey, responseBody);
      return responseBody;
    },
    // Same generous-timeout rationale as confirmSale/confirmPurchase (CLAUDE.md: remote-DB
    // latency) — potentially heavier than confirmPurchase when multiple allocation targets lock.
    { timeout: 30_000 },
  );
}

// ============================================================================
// fastExpenseEntry — TDD §31.5. A thin wrapper over confirmPayment, not a separate service: one
// posting/idempotency/audit code path underneath. direction is fixed to 'payment',
// cash_bank_ledger_id defaults to the branch's cash ledger via the CC-7 FK (no picker),
// counter_ledger_id = the expense ledger, party_id = null.
// ============================================================================

export async function fastExpenseEntry(input: FastExpenseEntryInput, actor: PaymentActor, idempotencyKey: string): Promise<unknown> {
  const branch = await prisma.branch.findFirst({ where: { id: actor.branchId, deletedAt: null } });
  if (!branch) throw new NotFoundError("BRANCH_NOT_FOUND");
  const cashLedgerId = requireSystemLedger(branch.cashLedgerId, "branch.cashLedgerId");

  return confirmPayment(
    {
      direction: "payment",
      voucherDate: input.voucherDate,
      cashBankLedgerId: cashLedgerId,
      counterLedgerId: input.expenseLedgerId,
      amount: input.amount,
      reference: input.reference,
      notes: input.notes,
    },
    actor,
    idempotencyKey,
  );
}
