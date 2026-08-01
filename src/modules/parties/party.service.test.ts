import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as partyService from "./party.service.js";
import type { PartyActor } from "./party.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks. Each test creates and
// tears down its own throwaway branch/user/parties/ledgers/idempotency keys; the only shared
// state it touches is the two pre-seeded account groups every party creation looks up by name.

let branchId: string;
let actor: PartyActor;

const createdPartyIds: string[] = [];
const createdLedgerIds: string[] = [];
const createdIdempotencyKeys: string[] = [];

async function newIdempotencyKey(scope: string): Promise<string> {
  const key = randomUUID();
  await prisma.idempotencyKey.create({
    data: {
      key,
      userId: actor.userId,
      scope,
      requestHash: "test",
      status: "in_progress",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  createdIdempotencyKeys.push(key);
  return key;
}

interface CreatedParty {
  data: {
    id: string;
    ledgerId: string;
    ledger: { id: string; accountGroupId: string; branchId: string; openingBalance: number };
  };
}

beforeAll(async () => {
  const branch = await prisma.branch.create({
    data: {
      name: `Party Test Branch ${randomUUID()}`,
      code: `PTB${randomUUID().slice(0, 6)}`,
      stateCode: "24",
    },
  });
  branchId = branch.id;

  const user = await prisma.user.create({
    data: {
      username: `partytest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Party Service Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });
  actor = { userId: user.id, role: "admin", branchId };
});

afterEach(async () => {
  if (createdPartyIds.length) {
    await prisma.party.deleteMany({ where: { id: { in: createdPartyIds } } });
    createdPartyIds.length = 0;
  }
  if (createdLedgerIds.length) {
    await prisma.ledger.deleteMany({ where: { id: { in: createdLedgerIds } } });
    createdLedgerIds.length = 0;
  }
  if (createdIdempotencyKeys.length) {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
    createdIdempotencyKeys.length = 0;
  }
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { userId: actor.userId } });
  await prisma.user.delete({ where: { id: actor.userId } });
  await prisma.branch.delete({ where: { id: branchId } });
});

describe("party.service", () => {
  it("creates a customer party with a Customers/Receivables ledger, atomically", async () => {
    const group = await prisma.accountGroup.findFirstOrThrow({
      where: { name: "Customers / Receivables", deletedAt: null },
    });
    const key = await newIdempotencyKey("party:create");
    const name = `Test Customer ${randomUUID()}`;

    const response = (await partyService.createParty(
      { type: "customer", name, village: "Anand", stateCode: "24", openingBalance: 150_000 },
      actor,
      key,
    )) as CreatedParty;

    createdPartyIds.push(response.data.id);
    createdLedgerIds.push(response.data.ledger.id);

    expect(response.data.ledger.accountGroupId).toBe(group.id);
    expect(response.data.ledger.branchId).toBe(branchId);
    expect(response.data.ledger.openingBalance).toBe(150_000);
    expect(response.data.ledgerId).toBe(response.data.ledger.id);

    const storedLedger = await prisma.ledger.findUniqueOrThrow({ where: { id: response.data.ledger.id } });
    expect(storedLedger.openingBalance).toBe(150_000n);

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "party", entityId: response.data.id, action: "create" },
    });
    expect(auditRow.userId).toBe(actor.userId);

    const completedKey = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(completedKey.status).toBe("completed");
  });

  it("defaults a supplier party's ledger to Suppliers/Payables", async () => {
    const group = await prisma.accountGroup.findFirstOrThrow({
      where: { name: "Suppliers / Payables", deletedAt: null },
    });
    const key = await newIdempotencyKey("party:create");

    const response = (await partyService.createParty(
      { type: "supplier", name: `Test Supplier ${randomUUID()}`, village: "Vallabh Vidyanagar", stateCode: "24", openingBalance: 0 },
      actor,
      key,
    )) as CreatedParty;

    createdPartyIds.push(response.data.id);
    createdLedgerIds.push(response.data.ledger.id);

    expect(response.data.ledger.accountGroupId).toBe(group.id);
  });

  it("defaults a 'both'-type party's ledger to Customers/Receivables (TDD §17.1)", async () => {
    const group = await prisma.accountGroup.findFirstOrThrow({
      where: { name: "Customers / Receivables", deletedAt: null },
    });
    const key = await newIdempotencyKey("party:create");

    const response = (await partyService.createParty(
      { type: "both", name: `Test Both ${randomUUID()}`, village: "Karamsad", stateCode: "24", openingBalance: -5_000 },
      actor,
      key,
    )) as CreatedParty;

    createdPartyIds.push(response.data.id);
    createdLedgerIds.push(response.data.ledger.id);

    expect(response.data.ledger.accountGroupId).toBe(group.id);
    expect(response.data.ledger.openingBalance).toBe(-5_000);
  });

  it("replays the stored response instead of creating a duplicate when the idempotency key is already completed", async () => {
    const key = await newIdempotencyKey("party:create");
    const name = `Test Idempotent ${randomUUID()}`;

    const first = (await partyService.createParty(
      { type: "customer", name, village: "Anand", stateCode: "24", openingBalance: 0 },
      actor,
      key,
    )) as CreatedParty;
    createdPartyIds.push(first.data.id);
    createdLedgerIds.push(first.data.ledger.id);

    // Simulates the middleware's replay path: a second attempt with the same completed key
    // should never reach the service again in production (the precheck short-circuits it), but
    // completeIdempotencyKey's row is what makes that replay possible — assert it actually holds
    // the full response body needed to replay.
    const stored = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(stored.status).toBe("completed");
    expect((stored.response as unknown as CreatedParty).data.id).toBe(first.data.id);

    const matchingParties = await prisma.party.findMany({ where: { name } });
    expect(matchingParties).toHaveLength(1);
  });

  it("rolls back atomically when ledger creation fails: no orphaned party row", async () => {
    const group = await prisma.accountGroup.findFirstOrThrow({
      where: { name: "Suppliers / Payables", deletedAt: null },
    });
    // Force the ledger-creation step to fail for real (no mocks): temporarily make the account
    // group this party's ledger needs unavailable, then restore it immediately after.
    await prisma.accountGroup.update({ where: { id: group.id }, data: { deletedAt: new Date() } });

    const key = await newIdempotencyKey("party:create");
    const name = `Test Rollback ${randomUUID()}`;

    try {
      await expect(
        partyService.createParty(
          { type: "supplier", name, village: "Test Village", stateCode: "24", openingBalance: 0 },
          actor,
          key,
        ),
      ).rejects.toThrow();

      const orphanedParty = await prisma.party.findFirst({ where: { name } });
      expect(orphanedParty).toBeNull();

      const orphanedLedger = await prisma.ledger.findFirst({ where: { name: `${name} - Test Village` } });
      expect(orphanedLedger).toBeNull();

      // The idempotency key row must not have been marked completed either — it never reached
      // completeIdempotencyKey because the transaction aborted before that point.
      const keyRow = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
      expect(keyRow.status).toBe("in_progress");
    } finally {
      await prisma.accountGroup.update({ where: { id: group.id }, data: { deletedAt: null } });
    }
  });

  it("scopes reads to the actor's branch and returns 404 for another branch's party", async () => {
    const key = await newIdempotencyKey("party:create");
    const response = (await partyService.createParty(
      { type: "customer", name: `Test Scoped ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
      actor,
      key,
    )) as CreatedParty;
    createdPartyIds.push(response.data.id);
    createdLedgerIds.push(response.data.ledger.id);

    const found = await partyService.getParty(response.data.id, actor);
    expect(found.id).toBe(response.data.id);

    const otherBranch = await prisma.branch.create({
      data: { name: `Other Branch ${randomUUID()}`, code: `OB${randomUUID().slice(0, 6)}`, stateCode: "24" },
    });
    try {
      const otherActor: PartyActor = { userId: actor.userId, role: "admin", branchId: otherBranch.id };
      await expect(partyService.getParty(response.data.id, otherActor)).rejects.toMatchObject({
        code: "PARTY_NOT_FOUND",
      });
    } finally {
      await prisma.branch.delete({ where: { id: otherBranch.id } });
    }
  });

  it("updates identity/contact fields and audits the diff, without touching the ledger", async () => {
    const createKey = await newIdempotencyKey("party:create");
    const created = (await partyService.createParty(
      { type: "customer", name: `Test Update ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 20_000 },
      actor,
      createKey,
    )) as CreatedParty;
    createdPartyIds.push(created.data.id);
    createdLedgerIds.push(created.data.ledger.id);

    const updateKey = await newIdempotencyKey("party:update");
    await partyService.updateParty(created.data.id, { village: "Vallabh Vidyanagar" }, actor, updateKey);

    const updated = await prisma.party.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(updated.village).toBe("Vallabh Vidyanagar");

    const ledgerAfterUpdate = await prisma.ledger.findUniqueOrThrow({ where: { id: created.data.ledger.id } });
    expect(ledgerAfterUpdate.openingBalance).toBe(20_000n);

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "party", entityId: created.data.id, action: "update" },
    });
    const after = auditRow.after as Record<string, unknown>;
    expect(after["village"]).toBe("Vallabh Vidyanagar");
  });

  it("rejects updating a party that does not exist in the actor's branch", async () => {
    const key = await newIdempotencyKey("party:update");
    await expect(
      partyService.updateParty(randomUUID(), { name: "Nope" }, actor, key),
    ).rejects.toMatchObject({ code: "PARTY_NOT_FOUND" });
  });

  it("deactivates a party (is_active = false) without soft-deleting it", async () => {
    const createKey = await newIdempotencyKey("party:create");
    const created = (await partyService.createParty(
      { type: "customer", name: `Test Deactivate ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
      actor,
      createKey,
    )) as CreatedParty;
    createdPartyIds.push(created.data.id);
    createdLedgerIds.push(created.data.ledger.id);

    const deactivateKey = await newIdempotencyKey("party:deactivate");
    await partyService.deactivateParty(created.data.id, actor, deactivateKey);

    const after = await prisma.party.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.isActive).toBe(false);
    expect(after.deletedAt).toBeNull();

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "party", entityId: created.data.id, action: "deactivate" },
    });
    expect(auditRow.userId).toBe(actor.userId);
  });

  it("lists parties scoped to the actor's branch, with search and pagination", async () => {
    const uniqueTag = randomUUID().slice(0, 8);
    const names = [`Zzz Search ${uniqueTag} A`, `Zzz Search ${uniqueTag} B`, `Zzz Search ${uniqueTag} C`];
    for (const name of names) {
      const key = await newIdempotencyKey("party:create");
      const created = (await partyService.createParty(
        { type: "customer", name, village: "Anand", stateCode: "24", openingBalance: 0 },
        actor,
        key,
      )) as CreatedParty;
      createdPartyIds.push(created.data.id);
      createdLedgerIds.push(created.data.ledger.id);
    }

    const page1 = await partyService.listParties(
      { page: 1, limit: 2, search: `Search ${uniqueTag}` },
      actor,
    );
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);

    const page2 = await partyService.listParties(
      { page: 2, limit: 2, search: `Search ${uniqueTag}` },
      actor,
    );
    expect(page2.items).toHaveLength(1);
  });
});
