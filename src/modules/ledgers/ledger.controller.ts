import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as ledgerService from "./ledger.service.js";
import type { LedgerStatementActor } from "./ledger.service.js";
import { ledgerStatementQuerySchema } from "./ledger.validation.js";

function actorFrom(req: Request): LedgerStatementActor {
  return { userId: req.auth!.userId, role: req.auth!.role };
}

export async function statement(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(ledgerStatementQuerySchema, req.query);
  const result = await ledgerService.getLedgerStatement(req.params.ledgerId as string, query, actorFrom(req));
  res.json(success(serializeBigInt(result)));
}
