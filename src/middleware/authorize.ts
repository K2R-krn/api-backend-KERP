import type { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import type { Role } from "../shared/types.js";

/**
 * Mirrors Blueprint §4 (the starting RBAC matrix) narrowed by TDD §7.2's locked four-role
 * descriptions, which supersede Blueprint's "partial" cells for Employee/Admin. Review these
 * against Blueprint §4 — rows marked below are where the two docs diverge and a call was made.
 */
export type Capability =
  | "branch:manage" // Blueprint doesn't list branch CRUD explicitly; treated like user:manage (root-of-multi-branch, super_admin only).
  | "user:manage"
  | "product:write"
  | "product:read"
  | "party:write"
  | "party:read"
  | "sale:create"
  | "sale:editCancel"
  // OPEN ITEM: Blueprint §4 says Employee gets "partial" purchase rights; TDD §7.2's Employee
  // description omits purchases entirely (silence-as-exclusion vs. incomplete enumeration —
  // genuinely unclear which). Left restrictive (super_admin/admin only) pending a business
  // decision on whether counter staff record purchase deliveries — safer to loosen later than
  // to walk back access already relied on.
  | "purchase:create"
  | "payment:create"
  | "voucher:create" // contra/journal/notes — Blueprint: Admin ✅, Billing Operator ❌.
  | "stock:adjust"
  | "cashCount:enter" // Employee "enters cash count" only (TDD §7.2) — distinct from resolving the close.
  | "cashClose:resolve"
  | "report:view"
  | "auditLog:view"; // Blueprint: Admin "own branch" — branch scoping enforced by branchContext, not here.

const CAN: Record<Capability, Role[]> = {
  "branch:manage": ["super_admin"],
  "user:manage": ["super_admin"],
  "product:write": ["super_admin", "admin"],
  // Every role needs to look products up while working (billing, payments, reports) — same
  // reasoning as party:read.
  "product:read": ["super_admin", "admin", "employee", "accountant"],
  "party:write": ["super_admin", "admin"],
  // Every role needs to look customers/suppliers up while working (billing, payments, reports).
  "party:read": ["super_admin", "admin", "employee", "accountant"],
  "sale:create": ["super_admin", "admin", "employee"],
  "sale:editCancel": ["super_admin", "admin"],
  "purchase:create": ["super_admin", "admin"],
  "payment:create": ["super_admin", "admin", "employee"],
  "voucher:create": ["super_admin", "admin"],
  "stock:adjust": ["super_admin", "admin"],
  "cashCount:enter": ["super_admin", "admin", "employee"],
  "cashClose:resolve": ["super_admin", "admin"],
  "report:view": ["super_admin", "admin", "employee", "accountant"],
  "auditLog:view": ["super_admin", "admin"],
};

export const requireCap = (cap: Capability) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) throw new UnauthorizedError();
    if (!CAN[cap].includes(req.auth.role)) throw new ForbiddenError("INSUFFICIENT_ROLE");
    next();
  };
