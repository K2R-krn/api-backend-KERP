import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as partyService from "./party.service.js";
import type { PartyActor } from "./party.service.js";
import { createPartySchema, listPartiesQuerySchema, updatePartySchema } from "./party.validation.js";

// branchContext always runs before these controllers (see party.routes.ts) and rejects the
// request before reaching here if auth/branchId are missing — safe to assert.
function actorFrom(req: Request): PartyActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId! };
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(createPartySchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await partyService.createParty(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(listPartiesQuerySchema, req.query);
  const result = await partyService.listParties(query, actorFrom(req));
  // No bigint in scope today (listParties doesn't include the ledger relation), but serializing
  // unconditionally here — same as get() — means that stays true if the query ever changes,
  // instead of relying on today's query shape to keep it safe.
  res.json(
    success(serializeBigInt(result.items), { total: result.total, page: result.page, limit: result.limit }),
  );
}

export async function get(req: Request, res: Response): Promise<void> {
  const party = await partyService.getParty(req.params.id as string, actorFrom(req));
  // party.ledger.openingBalance is a bigint — JSON.stringify (via res.json) has no BigInt support.
  res.json(success(serializeBigInt(party)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(updatePartySchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await partyService.updateParty(req.params.id as string, input, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const key = req.idempotencyKey!;
  try {
    const responseBody = await partyService.deactivateParty(req.params.id as string, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}
