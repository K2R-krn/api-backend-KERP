import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { assertBranchAccess } from "../../shared/branch-access.js";
import { decimalToBigInt } from "../../shared/decimal.js";
import { BadRequestError } from "../../shared/errors.js";
import type { Role } from "../../shared/types.js";

export interface ReportActor {
  userId: string;
  role: Role;
}

export interface OutstandingQueryInput {
  branchId: string | null;
  asOf: Date;
}

export type AgeingBucket = "0-30" | "31-60" | "61+";

interface OutstandingInvoiceRow {
  id: string;
  partyId: string;
  partyName: string;
  branchId: string;
  voucherDate: Date;
  documentNumber: string | null;
  remainingBalance: bigint;
  bucket: AgeingBucket;
}

interface PartySummaryRow {
  partyId: string;
  partyName: string;
  total: bigint;
  bucket0to30: bigint;
  bucket31to60: bigint;
  bucket61plus: bigint;
}

export interface OutstandingReport {
  asOf: Date;
  invoices: OutstandingInvoiceRow[];
  summary: PartySummaryRow[];
}

interface RawOutstandingRow {
  id: string;
  partyId: string;
  branchId: string;
  voucherDate: Date;
  documentNumber: string | null;
  remainingBalance: bigint;
}

// credit_udhar/credit_to_supplier are bigint columns, but `x - COALESCE(SUM(pa.amount), 0)` is a
// subtraction against a SUM() aggregate — Postgres returns numeric for that regardless of the
// underlying bigint columns, so Prisma deserializes remaining_balance as Prisma.Decimal, not a
// native bigint (same gotcha as the ledger statement's running_balance, verified against the real
// dev DB — see shared/decimal.ts).
interface SqlOutstandingRow {
  id: string;
  partyId: string;
  branchId: string;
  voucherDate: Date;
  documentNumber: string | null;
  remainingBalance: Prisma.Decimal;
}

function toRawOutstandingRows(rows: SqlOutstandingRow[]): RawOutstandingRow[] {
  return rows.map((r) => ({ ...r, remainingBalance: decimalToBigInt(r.remainingBalance) }));
}

// voucherDate/asOf are both SQL `date`-shaped values (UTC-midnight JS Dates, see
// financial-year.ts) — UTC getters keep the day-diff correct regardless of the machine's own
// timezone (this project runs from Nepal against a Mumbai DB).
function dayDiff(asOf: Date, voucherDate: Date): number {
  const MS_PER_DAY = 86_400_000;
  const asOfUtc = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const voucherUtc = Date.UTC(voucherDate.getUTCFullYear(), voucherDate.getUTCMonth(), voucherDate.getUTCDate());
  return Math.floor((asOfUtc - voucherUtc) / MS_PER_DAY);
}

// TDD §34 — 0-30 / 31-60 / 61+, non-overlapping cutoffs (day 30 belongs to the first bucket, not
// both). PROVISIONAL business convention per §34's own flag, not a confirmed accountant
// convention — carried through here unmodified, not silently settled.
function bucketFor(days: number): AgeingBucket {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  return "61+";
}

async function assertBranchParam(actor: ReportActor, branchId: string | null): Promise<void> {
  if (branchId === null && actor.role !== "super_admin") {
    // Consolidated cross-branch views are Super Admin only (TDD §7.2) — every other role must
    // name a branch it has access to.
    throw new BadRequestError("BRANCH_REQUIRED");
  }
  await assertBranchAccess(actor, branchId);
}

function buildReport(rows: RawOutstandingRow[], asOf: Date, nameById: Map<string, string>): OutstandingReport {
  const invoices: OutstandingInvoiceRow[] = rows.map((r) => ({
    id: r.id,
    partyId: r.partyId,
    partyName: nameById.get(r.partyId) ?? "",
    branchId: r.branchId,
    voucherDate: r.voucherDate,
    documentNumber: r.documentNumber,
    remainingBalance: r.remainingBalance,
    bucket: bucketFor(dayDiff(asOf, r.voucherDate)),
  }));

  const summaryMap = new Map<string, PartySummaryRow>();
  for (const inv of invoices) {
    let s = summaryMap.get(inv.partyId);
    if (!s) {
      s = { partyId: inv.partyId, partyName: inv.partyName, total: 0n, bucket0to30: 0n, bucket31to60: 0n, bucket61plus: 0n };
      summaryMap.set(inv.partyId, s);
    }
    s.total += inv.remainingBalance;
    if (inv.bucket === "0-30") s.bucket0to30 += inv.remainingBalance;
    else if (inv.bucket === "31-60") s.bucket31to60 += inv.remainingBalance;
    else s.bucket61plus += inv.remainingBalance;
  }

  return { asOf, invoices, summary: [...summaryMap.values()] };
}

// Party name is a LIVE join against the parties master, deliberately not the sale/purchase
// header's frozen customerName snapshot — collections follow-up wants current contact info (a
// corrected name, a party record updated since the invoice was raised), unlike the printable
// invoice payload's frozen-at-issue-time snapshot (§28.6), a different use case entirely.
async function resolvePartyNames(partyIds: string[]): Promise<Map<string, string>> {
  if (partyIds.length === 0) return new Map();
  const parties = await prisma.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true } });
  return new Map(parties.map((p) => [p.id, p.name]));
}

// TDD §34 base query, sales side. status='confirmed' (CC-8) is mandatory — a cancelled sale's
// stale credit_udhar must never surface here.
async function fetchOutstandingSales(branchId: string | null): Promise<RawOutstandingRow[]> {
  const branchFilter = branchId ? Prisma.sql`AND s.branch_id = ${branchId}::uuid` : Prisma.empty;
  const rows = await prisma.$queryRaw<SqlOutstandingRow[]>`
    SELECT s.id, s.customer_id AS "partyId", s.branch_id AS "branchId", s.voucher_date AS "voucherDate",
           s.invoice_number AS "documentNumber",
           s.credit_udhar - COALESCE(SUM(pa.amount), 0) AS "remainingBalance"
    FROM sales s
    LEFT JOIN payment_allocations pa ON pa.sale_id = s.id
    WHERE s.status = 'confirmed'
      AND s.credit_udhar > 0
      ${branchFilter}
    GROUP BY s.id
    HAVING s.credit_udhar - COALESCE(SUM(pa.amount), 0) > 0
    ORDER BY s.voucher_date ASC
  `;
  return toRawOutstandingRows(rows);
}

// Mirrored for purchases/payables — credit_to_supplier, payment_allocations.purchase_id,
// voucher_number (purchases have no invoice_number column).
async function fetchOutstandingPurchases(branchId: string | null): Promise<RawOutstandingRow[]> {
  const branchFilter = branchId ? Prisma.sql`AND p.branch_id = ${branchId}::uuid` : Prisma.empty;
  const rows = await prisma.$queryRaw<SqlOutstandingRow[]>`
    SELECT p.id, p.supplier_id AS "partyId", p.branch_id AS "branchId", p.voucher_date AS "voucherDate",
           p.voucher_number AS "documentNumber",
           p.credit_to_supplier - COALESCE(SUM(pa.amount), 0) AS "remainingBalance"
    FROM purchases p
    LEFT JOIN payment_allocations pa ON pa.purchase_id = p.id
    WHERE p.status = 'confirmed'
      AND p.credit_to_supplier > 0
      ${branchFilter}
    GROUP BY p.id
    HAVING p.credit_to_supplier - COALESCE(SUM(pa.amount), 0) > 0
    ORDER BY p.voucher_date ASC
  `;
  return toRawOutstandingRows(rows);
}

export async function getReceivables(query: OutstandingQueryInput, actor: ReportActor): Promise<OutstandingReport> {
  await assertBranchParam(actor, query.branchId);
  const rows = await fetchOutstandingSales(query.branchId);
  const nameById = await resolvePartyNames([...new Set(rows.map((r) => r.partyId))]);
  return buildReport(rows, query.asOf, nameById);
}

export async function getPayables(query: OutstandingQueryInput, actor: ReportActor): Promise<OutstandingReport> {
  await assertBranchParam(actor, query.branchId);
  const rows = await fetchOutstandingPurchases(query.branchId);
  const nameById = await resolvePartyNames([...new Set(rows.map((r) => r.partyId))]);
  return buildReport(rows, query.asOf, nameById);
}
