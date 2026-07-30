import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

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

async function seedAccountGroups(tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) {
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

async function seedUnits(tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) {
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

async function seedCompanyProfile(tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) {
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

async function seedSuperAdmin(tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) {
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

async function seedLedgers(
  tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  accountGroupIdByName: Map<string, string>,
) {
  const expenseGroupId = accountGroupIdByName.get("Direct/Indirect Expenses");
  if (!expenseGroupId) {
    throw new Error("Direct/Indirect Expenses account group not found — seed account_groups first");
  }

  const ledgers = [
    { name: "Round Off" },
    { name: "Stock Loss/Adjustment" },
  ] as const;

  for (const ledger of ledgers) {
    const existing = await tx.ledger.findFirst({
      where: { name: ledger.name, branchId: null, deletedAt: null },
    });
    if (!existing) {
      await tx.ledger.create({
        data: {
          name: ledger.name,
          accountGroupId: expenseGroupId,
          branchId: null,
          openingBalance: 0n,
        },
      });
    }
    console.log(`ledger: ${existing ? "exists" : "created"} — ${ledger.name}`);
  }
}

async function main() {
  await prisma.$transaction(
    async (tx) => {
      const accountGroupIdByName = await seedAccountGroups(tx);
      await seedUnits(tx);
      await seedCompanyProfile(tx);
      await seedSuperAdmin(tx);
      await seedLedgers(tx, accountGroupIdByName);
    },
    {
      timeout: 20000, // 20s — generous margin for ~20 round trips over network
      maxWait: 10000, // time allowed waiting for a transaction slot
    },
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
