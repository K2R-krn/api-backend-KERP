import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { branchContext } from "../../middleware/branch-context.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as paymentController from "./payment.controller.js";

export const paymentRouter = Router();

// confirmPayment (TDD §31) — standalone Receipt/Payment vouchers, atomic.
paymentRouter.post(
  "/confirm",
  authenticate,
  requireCap("payment:create"),
  branchContext,
  requireIdempotencyKey("payment:confirm"),
  paymentController.confirm,
);

// Fast Expense Entry (TDD §31.5) — thin wrapper over confirmPayment, same capability.
paymentRouter.post(
  "/expense",
  authenticate,
  requireCap("payment:create"),
  branchContext,
  requireIdempotencyKey("payment:expense"),
  paymentController.expense,
);
