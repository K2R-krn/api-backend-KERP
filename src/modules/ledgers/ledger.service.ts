import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { assertBranchAccess } from "../../shared/branch-access.js";
import { decimalToBigInt } from "../../shared/decimal.js";
import { NotFoundError } from "../../shared/errors.js";
import type { Role } from "../../shared/types.js";
import type { LedgerStatementQuery } from "./ledger.validation.js";

export interface LedgerStatementActor {
  userId: string;
  role: Role;
}

// The raw shape $queryRaw actually returns: lp.amount is a direct bigint-column select (comes back
// as a native JS bigint), but running_balance is a SUM() OVER window aggregate — Postgres returns
// numeric for that regardless of the underlying bigint column, so Prisma deserializes it as
// Prisma.Decimal (verified against the real dev DB, see shared/decimal.ts).
interface RawStatementRow {
  id: string;
  ledgerId: string;
  branchId: string;
  amount: bigint;
  voucherType: string;
  voucherId: string;
  voucherDate: Date;
  narration: string | null;
  createdAt: Date;
  runningBalance: Prisma.Decimal;
}

interface StatementRow {
  id: string;
  ledgerId: string;
  branchId: string;
  amount: bigint;
  voucherType: string;
  voucherId: string;
  voucherDate: Date;
  narration: string | null;
  createdAt: Date;
  runningBalance: bigint;
}

export interface LedgerStatement {
  ledger: { id: string; name: string; openingBalance: bigint };
  baseBalance: bigint;
  rows: StatementRow[];
}

// TDD §33 — read-only, no lock needed. No CC-8 filter (see §30): ledger_postings is append-only
// and already self-correcting for cancellations via the reversal rows cancelSale writes. Storage
// and computation here stay debit-positive throughout (§18.1) — sign-flip-by-ledger-nature is a
// presentation-layer concern for the frontend, not built here.
export async function getLedgerStatement(
  ledgerId: string,
  query: LedgerStatementQuery,
  actor: LedgerStatementActor,
): Promise<LedgerStatement> {
  const ledger = await prisma.ledger.findFirst({ where: { id: ledgerId, deletedAt: null } });
  if (!ledger) throw new NotFoundError("LEDGER_NOT_FOUND");

  await assertBranchAccess(actor, ledger.branchId);

  // Base balance — computed once, only when `from` is supplied; folds every posting strictly
  // before the range into a single figure. No range -> base is opening_balance directly.
  let baseBalance = ledger.openingBalance;
  if (query.from) {
    const prior = await prisma.ledgerPosting.aggregate({
      where: { ledgerId, voucherDate: { lt: query.from } },
      _sum: { amount: true },
    });
    baseBalance = ledger.openingBalance + (prior._sum.amount ?? 0n);
  }

  // §33's exact query shape. Sort key voucher_date, created_at, id in that order — voucher_date
  // alone isn't unique per day; id breaks any remaining tie deterministically so the same query
  // always reproduces the same running balance.
  const fromFilter = query.from ? Prisma.sql`AND lp.voucher_date >= ${query.from}` : Prisma.empty;
  const toFilter = query.to ? Prisma.sql`AND lp.voucher_date <= ${query.to}` : Prisma.empty;
  const rawRows = await prisma.$queryRaw<RawStatementRow[]>`
    SELECT lp.id, lp.ledger_id AS "ledgerId", lp.branch_id AS "branchId", lp.amount,
           lp.voucher_type AS "voucherType", lp.voucher_id AS "voucherId", lp.voucher_date AS "voucherDate",
           lp.narration, lp.created_at AS "createdAt",
           ${baseBalance} + SUM(lp.amount) OVER (
             ORDER BY lp.voucher_date, lp.created_at, lp.id
           ) AS "runningBalance"
    FROM ledger_postings lp
    WHERE lp.ledger_id = ${ledgerId}::uuid
      ${fromFilter}
      ${toFilter}
    ORDER BY lp.voucher_date, lp.created_at, lp.id
  `;
  const rows: StatementRow[] = rawRows.map((r) => ({ ...r, runningBalance: decimalToBigInt(r.runningBalance) }));

  return { ledger: { id: ledger.id, name: ledger.name, openingBalance: ledger.openingBalance }, baseBalance, rows };
}
