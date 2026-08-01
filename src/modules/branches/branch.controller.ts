import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as branchService from "./branch.service.js";
import type { BranchActor } from "./branch.service.js";
import { createBranchSchema, listBranchesQuerySchema, updateBranchSchema } from "./branch.validation.js";

// Branches routes don't run branchContext (see branch.service.ts) — branchId comes only from the
// authenticated user's token and may legitimately be absent.
function actorFrom(req: Request): BranchActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId };
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(createBranchSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await branchService.createBranch(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(listBranchesQuerySchema, req.query);
  const result = await branchService.listBranches(query, actorFrom(req));
  res.json(success(serializeBigInt(result.items), { total: result.total, page: result.page, limit: result.limit }));
}

export async function get(req: Request, res: Response): Promise<void> {
  const branch = await branchService.getBranch(req.params.id as string, actorFrom(req));
  res.json(success(serializeBigInt(branch)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(updateBranchSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await branchService.updateBranch(req.params.id as string, input, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const key = req.idempotencyKey!;
  try {
    const responseBody = await branchService.deactivateBranch(req.params.id as string, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}
