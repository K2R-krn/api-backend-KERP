import { describe, expect, it } from "vitest";
import { createUserSchema, updateUserSchema } from "./user.validation.js";

// Pure schema tests, no DB — the role/branchIds cross-field rules are the interesting logic here
// and don't need a network round-trip to exercise.

describe("createUserSchema", () => {
  it("requires branchIds for a non-super-admin role", () => {
    const result = createUserSchema.safeParse({
      username: "u1",
      name: "User One",
      role: "employee",
      initialPassword: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects branchIds on a super_admin", () => {
    const result = createUserSchema.safeParse({
      username: "u1",
      name: "User One",
      role: "super_admin",
      initialPassword: "password123",
      branchIds: ["11111111-1111-1111-1111-111111111111"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a super_admin with no branchIds", () => {
    const result = createUserSchema.safeParse({
      username: "u1",
      name: "User One",
      role: "super_admin",
      initialPassword: "password123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a non-super-admin with branchIds", () => {
    const result = createUserSchema.safeParse({
      username: "u1",
      name: "User One",
      role: "employee",
      initialPassword: "password123",
      branchIds: ["11111111-1111-1111-1111-111111111111"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate branchIds", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const result = createUserSchema.safeParse({
      username: "u1",
      name: "User One",
      role: "employee",
      initialPassword: "password123",
      branchIds: [id, id],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = createUserSchema.safeParse({
      username: "u1",
      name: "User One",
      role: "super_admin",
      initialPassword: "short",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateUserSchema", () => {
  it("allows role omitted with branchIds present (resolved against existing state in the service)", () => {
    const result = updateUserSchema.safeParse({ branchIds: ["11111111-1111-1111-1111-111111111111"] });
    expect(result.success).toBe(true);
  });

  it("rejects role=super_admin with branchIds present in the same request", () => {
    const result = updateUserSchema.safeParse({
      role: "super_admin",
      branchIds: ["11111111-1111-1111-1111-111111111111"],
    });
    expect(result.success).toBe(false);
  });

  // Regression: caught live via the smoke test, not by the service tests (which call the service
  // directly and never exercise this schema). A plain role change to a non-super-admin role, with
  // branchIds simply not mentioned, must pass schema validation and reach the service — which
  // resolves it against the user's *existing* branch rows. The schema has no DB access and must
  // not guess "omitted" means "empty".
  it("allows a non-super-admin role change with branchIds omitted entirely", () => {
    const result = updateUserSchema.safeParse({ role: "accountant" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-super-admin role change with branchIds explicitly empty", () => {
    const result = updateUserSchema.safeParse({ role: "accountant", branchIds: [] });
    expect(result.success).toBe(false);
  });

  it("has no username field at all — sending one is simply ignored, not an error", () => {
    const result = updateUserSchema.safeParse({ name: "New Name", username: "hacker" });
    expect(result.success).toBe(true);
    if (result.success) expect("username" in result.data).toBe(false);
  });
});