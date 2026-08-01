import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as unitService from "./unit.service.js";
import type { UnitActor } from "./unit.service.js";
import { createUnitSchema, listUnitsQuerySchema, updateUnitSchema } from "./unit.validation.js";

// branchContext always runs before these controllers (see unit.routes.ts) and rejects the
// request before reaching here if auth/branchId are missing — safe to assert.
function actorFrom(req: Request): UnitActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId! };
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(createUnitSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await unitService.createUnit(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(listUnitsQuerySchema, req.query);
  const result = await unitService.listUnits(query);
  res.json(success(serializeBigInt(result.items), { total: result.total, page: result.page, limit: result.limit }));
}

export async function get(req: Request, res: Response): Promise<void> {
  const unit = await unitService.getUnit(req.params.id as string);
  res.json(success(serializeBigInt(unit)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(updateUnitSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await unitService.updateUnit(req.params.id as string, input, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const key = req.idempotencyKey!;
  try {
    const responseBody = await unitService.deleteUnit(req.params.id as string, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}
