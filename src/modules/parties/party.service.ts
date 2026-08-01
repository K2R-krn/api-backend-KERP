import { Prisma } from "@prisma/client";
import { prisma, runTransaction } from "../../db/client.js";
import { writeAudit } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import type { Role } from "../../shared/types.js";
import type { CreatePartyInput, ListPartiesQuery, UpdatePartyInput } from "./party.validation.js";

export interface PartyActor {
  userId: string;
  role: Role;
  branchId: string;
}

const CUSTOMER_LEDGER_GROUP = "Customers / Receivables";
const SUPPLIER_LEDGER_GROUP = "Suppliers / Payables";

// A "both"-type party defaults to Customers/Receivables and lets the balance net, like Tally
// (TDD §17.1 note 2, locked — not re-derived here).
function ledgerGroupNameFor(type: CreatePartyInput["type"]): string {
  return type === "supplier" ? SUPPLIER_LEDGER_GROUP : CUSTOMER_LEDGER_GROUP;
}

export async function createParty(
  input: CreatePartyInput,
  actor: PartyActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    const group = await tx.accountGroup.findFirstOrThrow({
      where: { name: ledgerGroupNameFor(input.type), deletedAt: null },
    });

    // Ledger created first, party second, both in this one transaction (TDD §6.7) — the link is
    // one-directional (parties.ledger_id only, §6.2) so there's no circular-FK ordering problem.
    // Party ledgers are branch-scoped (branch_id = owning branch), same pattern as Cash/Bank.
    const ledger = await tx.ledger.create({
      data: {
        name: `${input.name} - ${input.village}`,
        accountGroupId: group.id,
        branchId: actor.branchId,
        openingBalance: BigInt(input.openingBalance),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });

    const party = await tx.party.create({
      data: {
        type: input.type,
        name: input.name,
        village: input.village,
        mobile: input.mobile ?? null,
        email: input.email ?? null,
        gstin: input.gstin ?? null,
        stateCode: input.stateCode,
        address: input.address ?? null,
        ledgerId: ledger.id,
        owningBranchId: actor.branchId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });

    // ledger.openingBalance is a bigint — serialize before it hits an audit Json column or an
    // HTTP response, both of which choke on raw BigInt (JSON.stringify has no BigInt support).
    const serialized = serializeBigInt({ ...party, ledger });

    await writeAudit(tx, actor, {
      action: "create",
      entityType: "party",
      entityId: party.id,
      after: serialized as unknown as Record<string, unknown>,
    });

    const responseBody = success(serialized);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function getParty(id: string, actor: PartyActor) {
  const party = await prisma.party.findFirst({
    where: { id, owningBranchId: actor.branchId, deletedAt: null },
    include: { ledger: true },
  });
  if (!party) throw new NotFoundError("PARTY_NOT_FOUND");
  return party;
}

export async function listParties(query: ListPartiesQuery, actor: PartyActor) {
  const where: Prisma.PartyWhereInput = {
    owningBranchId: actor.branchId,
    deletedAt: null,
    ...(query.type ? { type: query.type } : {}),
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { village: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.party.count({ where }),
    prisma.party.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  return { items, total, page: query.page, limit: query.limit };
}

export async function updateParty(
  id: string,
  input: UpdatePartyInput,
  actor: PartyActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.party.findFirst({ where: { id, owningBranchId: actor.branchId, deletedAt: null } });
    if (!before) throw new NotFoundError("PARTY_NOT_FOUND");

    const after = await tx.party.update({ where: { id }, data: { ...input, updatedBy: actor.userId } });

    await writeAudit(tx, actor, {
      action: "update",
      entityType: "party",
      entityId: id,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    });

    const responseBody = success(after);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function deactivateParty(id: string, actor: PartyActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.party.findFirst({ where: { id, owningBranchId: actor.branchId, deletedAt: null } });
    if (!before) throw new NotFoundError("PARTY_NOT_FOUND");

    const after = await tx.party.update({ where: { id }, data: { isActive: false, updatedBy: actor.userId } });

    await writeAudit(tx, actor, {
      action: "deactivate",
      entityType: "party",
      entityId: id,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    });

    const responseBody = success({ deactivated: true });
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}
