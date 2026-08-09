import type { Prisma } from "@prisma/client";
import * as argon2 from "argon2";
import { prisma, runTransaction } from "../src/db/client.js";

// Fixed id so the singleton row (TDD §5.6) is idempotent via upsert.
const COMPANY_PROFILE_ID = "00000000-0000-0000-0000-000000000001";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// TDD §6.1 standard seed set.
const ACCOUNT_GROUPS = [
  { name: "Customers / Receivables", tallyEquivalent: "Sundry Debtors", nature: "asset" },
  { name: "Suppliers / Payables", tallyEquivalent: "Sundry Creditors", nature: "liability" },
  { name: "Bank Accounts", tallyEquivalent: null, nature: "asset" },
  { name: "Cash-in-Hand", tallyEquivalent: null, nature: "asset" },
  { name: "Sales Accounts", tallyEquivalent: null, nature: "income" },
  { name: "Purchase Accounts", tallyEquivalent: null, nature: "expense" },
  { name: "Direct/Indirect Expenses", tallyEquivalent: null, nature: "expense" },
  { name: "Direct/Indirect Income", tallyEquivalent: null, nature: "income" },
  { name: "Duties & Taxes", tallyEquivalent: null, nature: "liability" },
  { name: "Capital", tallyEquivalent: null, nature: "equity" },
  { name: "Loans", tallyEquivalent: null, nature: "liability" },
  { name: "Fixed Assets", tallyEquivalent: null, nature: "asset" },
] as const;

// TDD §6.3 — standalone units, no conversion relationships assumed
// (bag weight varies by product at this shop; add per-product conversion units later if needed).
const UNITS = [
  { name: "Kilogram", symbol: "kg" },
  { name: "Bag", symbol: "bag" },
  { name: "Litre", symbol: "ltr" },
  { name: "Piece", symbol: "pc" },
] as const;

async function seedAccountGroups(tx: Prisma.TransactionClient) {
  const idByName = new Map<string, string>();
  for (const group of ACCOUNT_GROUPS) {
    const existing = await tx.accountGroup.findFirst({
      where: { name: group.name, deletedAt: null },
    });
    const row =
      existing ??
      (await tx.accountGroup.create({
        data: {
          name: group.name,
          tallyEquivalent: group.tallyEquivalent,
          nature: group.nature,
          isSystem: true,
        },
      }));
    idByName.set(group.name, row.id);
    console.log(`account_group: ${existing ? "exists" : "created"} — ${group.name}`);
  }
  return idByName;
}

async function seedUnits(tx: Prisma.TransactionClient) {
  for (const unit of UNITS) {
    const existing = await tx.unit.findFirst({
      where: { name: unit.name, deletedAt: null },
    });
    if (!existing) {
      await tx.unit.create({ data: { name: unit.name, symbol: unit.symbol } });
    }
    console.log(`unit: ${existing ? "exists" : "created"} — ${unit.name}`);
  }
}

async function seedCompanyProfile(tx: Prisma.TransactionClient) {
  const businessName = requireEnv("SEED_BUSINESS_NAME");
  const legalName = process.env.SEED_BUSINESS_LEGAL_NAME ?? null;

  const existing = await tx.companyProfile.findUnique({ where: { id: COMPANY_PROFILE_ID } });
  if (existing) {
    console.log("company_profile: exists — leaving as-is (edit via the app, not re-seeding)");
    return;
  }
  await tx.companyProfile.create({
    data: {
      id: COMPANY_PROFILE_ID,
      businessName,
      legalName,
      roundingMode: "none",
      fyStartMonth: 4,
    },
  });
  console.log(`company_profile: created — ${businessName}`);
}

async function seedSuperAdmin(tx: Prisma.TransactionClient) {
  const username = requireEnv("SEED_SUPER_ADMIN_USERNAME");
  const name = requireEnv("SEED_SUPER_ADMIN_NAME");
  const password = requireEnv("SEED_SUPER_ADMIN_PASSWORD");
  const email = process.env.SEED_SUPER_ADMIN_EMAIL ?? null;

  if (password.length < 8) {
    throw new Error("SEED_SUPER_ADMIN_PASSWORD must be at least 8 characters");
  }

  const existing = await tx.user.findFirst({
    where: { username, deletedAt: null },
  });
  if (existing) {
    console.log(`user: exists — ${username} (password left untouched)`);
    return;
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  await tx.user.create({
    data: {
      username,
      passwordHash,
      name,
      role: "super_admin",
      email,
      isActive: true,
      mustChangePassword: true,
    },
  });
  console.log(`user: created — ${username} (must_change_password = true)`);
}

// Shared (branch_id null) system ledgers the Sale/Purchase services post to (TDD §18.3, §26 step
// 10). Returns a name → id map so seedCompanyProfileSystemLedgers can link them without a second
// lookup pass.
async function seedLedgers(
  tx: Prisma.TransactionClient,
  accountGroupIdByName: Map<string, string>,
) {
  const expenseGroupId = accountGroupIdByName.get("Direct/Indirect Expenses");
  if (!expenseGroupId) {
    throw new Error("Direct/Indirect Expenses account group not found — seed account_groups first");
  }
  const salesGroupId = accountGroupIdByName.get("Sales Accounts");
  if (!salesGroupId) {
    throw new Error("Sales Accounts account group not found — seed account_groups first");
  }
  const purchasesGroupId = accountGroupIdByName.get("Purchase Accounts");
  if (!purchasesGroupId) {
    throw new Error("Purchase Accounts account group not found — seed account_groups first");
  }
  const dutiesGroupId = accountGroupIdByName.get("Duties & Taxes");
  if (!dutiesGroupId) {
    throw new Error("Duties & Taxes account group not found — seed account_groups first");
  }

  const ledgers = [
    { name: "Round Off", groupId: expenseGroupId },
    { name: "Stock Loss/Adjustment", groupId: expenseGroupId },
    { name: "Sales", groupId: salesGroupId },
    { name: "Purchases", groupId: purchasesGroupId },
    { name: "CGST", groupId: dutiesGroupId },
    { name: "SGST", groupId: dutiesGroupId },
    { name: "IGST", groupId: dutiesGroupId },
  ] as const;

  const idByName = new Map<string, string>();
  for (const ledger of ledgers) {
    const existing = await tx.ledger.findFirst({
      where: { name: ledger.name, branchId: null, deletedAt: null },
    });
    const row =
      existing ??
      (await tx.ledger.create({
        data: {
          name: ledger.name,
          accountGroupId: ledger.groupId,
          branchId: null,
          openingBalance: 0n,
        },
      }));
    idByName.set(ledger.name, row.id);
    console.log(`ledger: ${existing ? "exists" : "created"} — ${ledger.name}`);
  }
  return idByName;
}

// Links company_profile's system-ledger FKs (added alongside branches.cash_ledger_id) to the
// shared ledgers seeded above. Only fills columns that are still null — never overwrites an
// operator's manual reassignment.
async function seedCompanyProfileSystemLedgers(
  tx: Prisma.TransactionClient,
  ledgerIdByName: Map<string, string>,
) {
  const profile = await tx.companyProfile.findUnique({ where: { id: COMPANY_PROFILE_ID } });
  if (!profile) {
    console.log("company_profile: missing — skipping system ledger links");
    return;
  }

  const salesLedgerId = profile.salesLedgerId ?? ledgerIdByName.get("Sales");
  const purchasesLedgerId = profile.purchasesLedgerId ?? ledgerIdByName.get("Purchases");
  const cgstLedgerId = profile.cgstLedgerId ?? ledgerIdByName.get("CGST");
  const sgstLedgerId = profile.sgstLedgerId ?? ledgerIdByName.get("SGST");
  const igstLedgerId = profile.igstLedgerId ?? ledgerIdByName.get("IGST");
  const roundOffLedgerId = profile.roundOffLedgerId ?? ledgerIdByName.get("Round Off");

  if (
    profile.salesLedgerId &&
    profile.purchasesLedgerId &&
    profile.cgstLedgerId &&
    profile.sgstLedgerId &&
    profile.igstLedgerId &&
    profile.roundOffLedgerId
  ) {
    console.log("company_profile: system ledger links already set");
    return;
  }

  await tx.companyProfile.update({
    where: { id: COMPANY_PROFILE_ID },
    data: { salesLedgerId, purchasesLedgerId, cgstLedgerId, sgstLedgerId, igstLedgerId, roundOffLedgerId },
  });
  console.log("company_profile: linked sales/purchases/CGST/SGST/IGST/round-off ledgers");
}

// Links company_profile's cash/bank account-GROUP FKs (TDD §31.1 / CC-7 applied one level up —
// confirmPayment validates a caller-supplied cash_bank_ledger_id against these stored ids, never
// a live name lookup). Same skip-if-already-set posture as seedCompanyProfileSystemLedgers.
async function seedCompanyProfileAccountGroupRefs(tx: Prisma.TransactionClient, accountGroupIdByName: Map<string, string>) {
  const profile = await tx.companyProfile.findUnique({ where: { id: COMPANY_PROFILE_ID } });
  if (!profile) {
    console.log("company_profile: missing — skipping cash/bank account-group links");
    return;
  }

  const cashAccountGroupId = profile.cashAccountGroupId ?? accountGroupIdByName.get("Cash-in-Hand");
  const bankAccountGroupId = profile.bankAccountGroupId ?? accountGroupIdByName.get("Bank Accounts");

  if (profile.cashAccountGroupId && profile.bankAccountGroupId) {
    console.log("company_profile: cash/bank account-group links already set");
    return;
  }

  await tx.companyProfile.update({
    where: { id: COMPANY_PROFILE_ID },
    data: { cashAccountGroupId, bankAccountGroupId },
  });
  console.log("company_profile: linked Cash-in-Hand/Bank Accounts account groups");
}

// Backfill for branches created before branches.cash_ledger_id existed (branch.service.ts now
// creates this ledger inline for every new branch — this only covers pre-existing rows).
async function seedBranchCashLedgers(tx: Prisma.TransactionClient, accountGroupIdByName: Map<string, string>) {
  const cashGroupId = accountGroupIdByName.get("Cash-in-Hand");
  if (!cashGroupId) {
    throw new Error("Cash-in-Hand account group not found — seed account_groups first");
  }

  const branches = await tx.branch.findMany({ where: { cashLedgerId: null, deletedAt: null } });
  for (const branch of branches) {
    const ledger = await tx.ledger.create({
      data: {
        name: `Cash - ${branch.code}`,
        accountGroupId: cashGroupId,
        branchId: branch.id,
        openingBalance: 0n,
      },
    });
    await tx.branch.update({ where: { id: branch.id }, data: { cashLedgerId: ledger.id } });
    console.log(`branch cash ledger: created — ${branch.code}`);
  }
  if (branches.length === 0) {
    console.log("branch cash ledgers: all branches already linked");
  }
}

async function main() {
  await runTransaction(
    async (tx) => {
      const accountGroupIdByName = await seedAccountGroups(tx);
      await seedUnits(tx);
      await seedCompanyProfile(tx);
      await seedSuperAdmin(tx);
      const ledgerIdByName = await seedLedgers(tx, accountGroupIdByName);
      await seedCompanyProfileSystemLedgers(tx, ledgerIdByName);
      await seedCompanyProfileAccountGroupRefs(tx, accountGroupIdByName);
      await seedBranchCashLedgers(tx, accountGroupIdByName);
    },
    // Overrides the shared default (10s/5s) — round trips grew with the system-ledger backfill
    // (Iteration 3 confirmSale prerequisite); keep generous per the Mumbai↔Nepal latency note.
    { timeout: 20_000, maxWait: 10_000 },
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
