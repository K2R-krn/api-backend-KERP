import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import * as reportController from "./report.controller.js";

export const reportRouter = Router();

// Outstanding / ageing report (TDD §34). No branchContext — branch_id is optional here (omitted =
// consolidated, super_admin only); the branch check (mandatory-for-non-super-admin, membership via
// assertBranchAccess) lives in report.service.ts, which can express that shape and branchContext
// cannot.
reportRouter.get("/receivables", authenticate, requireCap("report:view"), reportController.receivables);
reportRouter.get("/payables", authenticate, requireCap("report:view"), reportController.payables);
