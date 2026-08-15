import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { signAccessToken } from "../../shared/tokens.js";
import type { Role } from "../../shared/types.js";

// TDD §35.8: closeDay ("the operator enters the count") is open to any Payment-capable role;
// reopenDay ("Admin resolves discrepancies") is Admin/Super Admin only. Neither capability check
// lives in day-close.service.ts itself (services are HTTP-agnostic, CLAUDE.md) — it's entirely
// requireCap("cashCount:enter") / requireCap("cashClose:resolve") at the route layer (see
// day-close.routes.ts). Mirrors user.routes.test.ts: real authenticate + requireCap, real signed
// tokens, real (throwaway) DB users — proves the boundary actually rejects/admits by role.

function fakeReq(token: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined),
  } as unknown as Request;
}

const fakeRes = {} as Response;
const noopNext: NextFunction = () => undefined;

async function createTestUser(role: Role) {
  return prisma.user.create({
    data: {
      username: `dcroutetest_${role}_${randomUUID()}`,
      passwordHash: "unused",
      name: `Day Close Route Test ${role}`,
      role,
      isActive: true,
      mustChangePassword: false,
    },
  });
}

describe("day-close routes — cashCount:enter (close) / cashClose:resolve (reopen) authorization boundary", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("admits a real employee-role token to cashCount:enter — any Payment-capable role can close", async () => {
    const user = await createTestUser("employee");
    createdUserIds.push(user.id);
    const req = fakeReq(signAccessToken({ userId: user.id, role: "employee" }));

    await authenticate(req, fakeRes, noopNext);
    expect(() => requireCap("cashCount:enter")(req, fakeRes, noopNext)).not.toThrow();
  });

  it("blocks a real accountant-role token from cashCount:enter — not open to every role", async () => {
    const user = await createTestUser("accountant");
    createdUserIds.push(user.id);
    const req = fakeReq(signAccessToken({ userId: user.id, role: "accountant" }));

    await authenticate(req, fakeRes, noopNext);

    expect.assertions(1);
    try {
      requireCap("cashCount:enter")(req, fakeRes, noopNext);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INSUFFICIENT_ROLE");
    }
  });

  it("blocks a real employee-role token from cashClose:resolve — reopen is not open to the same roles as close", async () => {
    const user = await createTestUser("employee");
    createdUserIds.push(user.id);
    const req = fakeReq(signAccessToken({ userId: user.id, role: "employee" }));

    await authenticate(req, fakeRes, noopNext);

    expect.assertions(1);
    try {
      requireCap("cashClose:resolve")(req, fakeRes, noopNext);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INSUFFICIENT_ROLE");
    }
  });

  it("admits a real admin-role token to cashClose:resolve", async () => {
    const user = await createTestUser("admin");
    createdUserIds.push(user.id);
    const req = fakeReq(signAccessToken({ userId: user.id, role: "admin" }));

    await authenticate(req, fakeRes, noopNext);
    expect(() => requireCap("cashClose:resolve")(req, fakeRes, noopNext)).not.toThrow();
  });
});
