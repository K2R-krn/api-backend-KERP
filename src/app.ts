import express from "express";
import cors from "cors";
import { authenticate } from "./middleware/authenticate.js";
import { requireCap } from "./middleware/authorize.js";
import { branchContext } from "./middleware/branch-context.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { branchRouter } from "./modules/branches/branch.routes.js";
import { categoryRouter } from "./modules/categories/category.routes.js";
import { dayCloseRouter } from "./modules/day-close/day-close.routes.js";
import { ledgerRouter } from "./modules/ledgers/ledger.routes.js";
import { partyRouter } from "./modules/parties/party.routes.js";
import { paymentRouter } from "./modules/payments/payment.routes.js";
import { productRouter } from "./modules/products/product.routes.js";
import { purchaseRouter } from "./modules/purchases/purchase.routes.js";
import { reportRouter } from "./modules/reports/report.routes.js";
import { saleRouter } from "./modules/sales/sale.routes.js";
import { unitRouter } from "./modules/units/unit.routes.js";
import { userRouter } from "./modules/users/user.routes.js";
import { success } from "./shared/envelope.js";
import { errorHandler } from "./shared/error-handler.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json(success({ status: "ok" }));
});

// Auth endpoints are the on/off-ramp to everything below — none of them run through the
// authenticate/authorize/branch-context stack (a login has no token yet; refresh/logout present
// a refresh token, not an access token). See auth.controller.ts.
app.use("/api/v1/auth", authRouter);

// Diagnostic "whoami" route — exercises the full authenticate → authorize → branch-context
// order (TDD §9) end-to-end so the middleware stack has somewhere real to run.
app.get("/api/v1/me", authenticate, requireCap("report:view"), branchContext, (req, res) => {
  res.json(success({ userId: req.auth?.userId, role: req.auth?.role, branchId: req.auth?.branchId }));
});

// First real vertical slice (roadmap §4 step 7): full route → controller → service → Prisma
// stack, with authenticate → authorize → branchContext per route and idempotency middleware
// mounted per-write-route (see party.routes.ts) — validation and idempotency are endpoint-scoped,
// not global app.use() middleware, so nothing extra is mounted here for them.
app.use("/api/v1/parties", partyRouter);

// Roadmap §4 step 8 — the second master alongside Parties. Unlike Parties, products are a single
// shared catalog (no branch_id column, TDD §6.5); branchContext still runs per route purely to
// resolve the acting branch for the audit row, not to scope reads/writes.
app.use("/api/v1/products", productRouter);

// Roadmap §4 step 8 continued — Branches, Categories, Units. Branches is the root of
// multi-branch config (TDD §5.2) and deliberately skips branchContext (see branch.service.ts).
// Categories/Units are shared catalogs like Products (TDD §6.3/§6.4) and follow the same
// branchContext-for-audit-tagging-only pattern.
app.use("/api/v1/branches", branchRouter);
app.use("/api/v1/categories", categoryRouter);
app.use("/api/v1/units", unitRouter);

// Roadmap §4 step 8, final piece — Users (TDD §7.1/§7.3). The most security-sensitive module:
// creates the accounts that create everything else. user:manage is super_admin-only end to end
// (see authorize.ts); no branchContext, same root-of-config reasoning as Branches.
app.use("/api/v1/users", userRouter);

// Iteration 3 (TDD §24-29) — the atomic confirmSale/confirmPurchase/createDraft services (built
// and tested against the real dev DB in prior sessions) plus this session's read-side secondary
// features (§28.1 recall, §28.5 billing search — mounted on productRouter above, §28.6 printable
// payload) get their first HTTP wiring here.
app.use("/api/v1/sales", saleRouter);
app.use("/api/v1/purchases", purchaseRouter);

// Iteration 4 (TDD §30-32) — confirmPayment (standalone Receipt/Payment vouchers) + Fast Expense
// Entry, its thin wrapper (§31.5). remainingBalance (§32) has no HTTP endpoint of its own yet —
// it's a pure helper confirmPayment calls internally.
app.use("/api/v1/payments", paymentRouter);

// Iteration 4 continued — ledger statement view (§33) and outstanding/ageing report (§34). Both
// skip branchContext deliberately: their branch scoping is an object-level property of the target
// (a ledger, a bill), not an acting branch declared up front — see assertBranchAccess
// (shared/branch-access.ts) and each service's own comments.
app.use("/api/v1/ledgers", ledgerRouter);
app.use("/api/v1/reports", reportRouter);

// Iteration 4 continued — day-end cash reconciliation (§35): closeDay/reopenDay. Separate
// capabilities per role (cashCount:enter vs. cashClose:resolve), enforced per route.
app.use("/api/v1/day-close", dayCloseRouter);

app.use(errorHandler);
