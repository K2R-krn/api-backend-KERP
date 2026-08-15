import type { Request, Response } from "express";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import * as dayCloseService from "./day-close.service.js";
import type { DayCloseActor } from "./day-close.service.js";
import { closeDaySchema, reopenDaySchema } from "./day-close.validation.js";

// branchContext always runs before these controllers (see day-close.routes.ts) — safe to assert,
// same pattern as every other module's controller.
function actorFrom(req: Request): DayCloseActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId! };
}

export async function close(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(closeDaySchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await dayCloseService.closeDay(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function reopen(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(reopenDaySchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await dayCloseService.reopenDay(input, actorFrom(req), key);
    res.status(200).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}
