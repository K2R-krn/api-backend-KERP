import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { signAccessToken } from "../../shared/tokens.js";
import type { Role } from "../../shared/types.js";

// This module's entire attack surface hinges on user:manage being genuinely super_admin-only
// (TDD §7.1/§7.3 — this is the module that creates every other account). Every other module's
// test suite exercises its service layer directly and simply trusts authorize.ts's static
// CAN[...] config; here that's not enough on its own. These tests drive the REAL authenticate +
// requireCap("user:manage") middleware, with REAL signed access tokens for REAL (throwaway) DB
// users — no mocks — to prove the boundary actually rejects/admits by role, not just that the
// config table says it should.

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
      username: `routetest_${role}_${randomUUID()}`,
      passwordHash: "unused",
      name: `Route Test ${role}`,
      role,
      isActive: true,
      mustChangePassword: false,
    },
  });
}

describe("users routes — user:manage authorization boundary", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("blocks a real employee-role token from user:manage", async () => {
    const user = await createTestUser("employee");
    createdUserIds.push(user.id);
    const req = fakeReq(signAccessToken({ userId: user.id, role: "employee" }));

    await authenticate(req, fakeRes, noopNext);
    expect(req.auth?.role).toBe("employee");

    expect.assertions(3);
    try {
      requireCap("user:manage")(req, fakeRes, noopNext);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("INSUFFICIENT_ROLE");
    }
  });

  it("blocks a real admin-role token from user:manage too — only super_admin passes", async () => {
    const user = await createTestUser("admin");
    createdUserIds.push(user.id);
    const req = fakeReq(signAccessToken({ userId: user.id, role: "admin" }));

    await authenticate(req, fakeRes, noopNext);

    expect.assertions(1);
    try {
      requireCap("user:manage")(req, fakeRes, noopNext);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INSUFFICIENT_ROLE");
    }
  });

  it("blocks a real accountant-role token from user:manage", async () => {
    const user = await createTestUser("accountant");
    createdUserIds.push(user.id);
    const req = fakeReq(signAccessToken({ userId: user.id, role: "accountant" }));

    await authenticate(req, fakeRes, noopNext);

    expect.assertions(1);
    try {
      requireCap("user:manage")(req, fakeRes, noopNext);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INSUFFICIENT_ROLE");
    }
  });

  it("allows a real super_admin-role token through user:manage", async () => {
    const user = await createTestUser("super_admin");
    createdUserIds.push(user.id);
    const req = fakeReq(signAccessToken({ userId: user.id, role: "super_admin" }));

    await authenticate(req, fakeRes, noopNext);
    expect(() => requireCap("user:manage")(req, fakeRes, noopNext)).not.toThrow();
  });

  it("rejects a deactivated user's token at authenticate, even though the JWT is validly signed", async () => {
    const user = await createTestUser("super_admin");
    createdUserIds.push(user.id);
    const token = signAccessToken({ userId: user.id, role: "super_admin" });
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    const req = fakeReq(token);
    await expect(authenticate(req, fakeRes, noopNext)).rejects.toMatchObject({ code: "USER_INACTIVE" });
  });
});