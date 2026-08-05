import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runTransaction } from "../db/client.js";
import { allocateVoucherNumber } from "./number-series.js";

// TDD §22.1: against the real dev DB, no mocks — the row lock and the INSERT...ON CONFLICT race
// fix are exactly the things under test here.

let branchId: string;
const actorId = randomUUID();

beforeAll(async () => {
  const branch = await prisma.branch.create({
    data: { name: `NumberSeries Test Branch ${randomUUID()}`, code: `NS${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchId = branch.id;
});

afterAll(async () => {
  await prisma.numberSeries.deleteMany({ where: { branchId } });
  await prisma.branch.deleteMany({ where: { id: branchId } });

  const leftover = await prisma.branch.count({ where: { id: branchId } });
  if (leftover > 0) {
    throw new Error("number-series.test.ts left its test branch behind — cleanup did not fully succeed");
  }
});

describe("allocateVoucherNumber", () => {
  it("allocates sequential numbers within the same branch/voucherType/FY, reusing one row", async () => {
    const voucherType = `test_${randomUUID().slice(0, 8)}`;
    const financialYear = "2025-26";

    const first = await runTransaction((tx) =>
      allocateVoucherNumber(tx, { branchId, voucherType, financialYear, defaultPrefix: "TEST/", actorId }),
    );
    const second = await runTransaction((tx) =>
      allocateVoucherNumber(tx, { branchId, voucherType, financialYear, defaultPrefix: "TEST/", actorId }),
    );

    expect(first.sequenceNumber).toBe(1);
    expect(second.sequenceNumber).toBe(2);
    expect(first.prefix).toBe("TEST/");
    expect(second.prefix).toBe("TEST/");

    const rows = await prisma.numberSeries.findMany({ where: { branchId, voucherType, financialYear } });
    expect(rows).toHaveLength(1); // reused the same row across both calls, never created a duplicate
    expect(rows[0]?.currentNumber).toBe(2);
  });

  it("keeps independent sequences per financial year", async () => {
    const voucherType = `test_${randomUUID().slice(0, 8)}`;

    const fy1 = await runTransaction((tx) =>
      allocateVoucherNumber(tx, { branchId, voucherType, financialYear: "2025-26", defaultPrefix: null, actorId }),
    );
    const fy2 = await runTransaction((tx) =>
      allocateVoucherNumber(tx, { branchId, voucherType, financialYear: "2026-27", defaultPrefix: null, actorId }),
    );

    expect(fy1.sequenceNumber).toBe(1);
    expect(fy2.sequenceNumber).toBe(1); // new FY, independent series, not continued from fy1
  });

  it(
    "serializes two concurrent allocations against a brand-new series without collision or deadlock",
    async () => {
      const voucherType = `test_${randomUUID().slice(0, 8)}`;
      const financialYear = "2025-26";

      // Neither call has an existing number_series row to find — this is exactly the race window
      // the INSERT ... ON CONFLICT fix closes. A naive "SELECT ... FOR UPDATE, create if missing"
      // would let both transactions observe "no row" and both attempt to create one, and the
      // loser would fail on ux_number_series_active instead of serializing behind the winner.
      const [a, b] = await Promise.all([
        runTransaction((tx) =>
          allocateVoucherNumber(tx, { branchId, voucherType, financialYear, defaultPrefix: null, actorId }),
        ),
        runTransaction((tx) =>
          allocateVoucherNumber(tx, { branchId, voucherType, financialYear, defaultPrefix: null, actorId }),
        ),
      ]);

      const sequenceNumbers = [a.sequenceNumber, b.sequenceNumber].sort((x, y) => x - y);
      expect(sequenceNumbers).toEqual([1, 2]); // no duplicate, no gap, both calls succeeded

      const rows = await prisma.numberSeries.findMany({ where: { branchId, voucherType, financialYear } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.currentNumber).toBe(2);
    },
    30_000, // generous — two real transactions serializing over the remote DB connection (CLAUDE.md)
  );
});
