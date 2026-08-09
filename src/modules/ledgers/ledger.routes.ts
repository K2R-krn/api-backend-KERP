import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import * as ledgerController from "./ledger.controller.js";

export const ledgerRouter = Router();

// Ledger statement view (TDD §33). No branchContext here — a ledger's branch is a property of the
// ledger being viewed, not an acting branch the request declares; the object-level check
// (assertBranchAccess against the ledger's own branch_id) lives in ledger.service.ts instead.
ledgerRouter.get("/:ledgerId/statement", authenticate, requireCap("report:view"), ledgerController.statement);
