import express from "express";
import cors from "cors";
import { authenticate } from "./middleware/authenticate.js";
import { requireCap } from "./middleware/authorize.js";
import { branchContext } from "./middleware/branch-context.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { partyRouter } from "./modules/parties/party.routes.js";
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

app.use(errorHandler);
