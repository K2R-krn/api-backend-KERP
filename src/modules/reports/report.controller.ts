import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as reportService from "./report.service.js";
import type { ReportActor } from "./report.service.js";
import { outstandingQuerySchema } from "./report.validation.js";

function actorFrom(req: Request): ReportActor {
  return { userId: req.auth!.userId, role: req.auth!.role };
}

// as_of defaults to today at UTC midnight when omitted — matched to voucherDate's own UTC-midnight
// representation (financial-year.ts) so the day-diff math in report.service.ts lines up. Unlike
// voucher_date (always caller/frontend-supplied, IST-default, never computed from the server
// clock — CLAUDE.md), there's no existing project convention for deriving "today" server-side;
// this is a deliberate, narrow exception for a read-only report, not a precedent to reuse
// elsewhere. Callers who need exact IST "today" should pass as_of explicitly.
function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function receivables(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(outstandingQuerySchema, req.query);
  const result = await reportService.getReceivables(
    { branchId: query.branch_id ?? null, asOf: query.as_of ?? todayUtcMidnight() },
    actorFrom(req),
  );
  res.json(success(serializeBigInt(result)));
}

export async function payables(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(outstandingQuerySchema, req.query);
  const result = await reportService.getPayables(
    { branchId: query.branch_id ?? null, asOf: query.as_of ?? todayUtcMidnight() },
    actorFrom(req),
  );
  res.json(success(serializeBigInt(result)));
}
