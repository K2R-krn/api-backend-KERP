import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { branchContext } from "../../middleware/branch-context.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as dayCloseController from "./day-close.controller.js";

export const dayCloseRouter = Router();

// closeDay (TDD §35.6/§35.8) — "the operator enters the count": any Payment-capable role.
dayCloseRouter.post(
  "/close",
  authenticate,
  requireCap("cashCount:enter"),
  branchContext,
  requireIdempotencyKey("day-close:close"),
  dayCloseController.close,
);

// reopenDay (TDD §35.6/§35.8) — "Admin resolves discrepancies": Admin/Super Admin only.
dayCloseRouter.post(
  "/reopen",
  authenticate,
  requireCap("cashClose:resolve"),
  branchContext,
  requireIdempotencyKey("day-close:reopen"),
  dayCloseController.reopen,
);
