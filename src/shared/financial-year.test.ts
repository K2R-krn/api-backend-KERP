import { describe, expect, it } from "vitest";
import { deriveFinancialYear } from "./financial-year.js";

describe("deriveFinancialYear", () => {
  it("TDD §5.5 worked example: 15 Feb 2026, fyStartMonth 4 → 2025-26", () => {
    expect(deriveFinancialYear(new Date(Date.UTC(2026, 1, 15)), 4)).toBe("2025-26");
  });

  it("a date on the start month belongs to the FY beginning that year", () => {
    expect(deriveFinancialYear(new Date(Date.UTC(2026, 3, 1)), 4)).toBe("2026-27"); // 1 Apr 2026
  });

  it("the day before the start month belongs to the prior FY", () => {
    expect(deriveFinancialYear(new Date(Date.UTC(2026, 2, 31)), 4)).toBe("2025-26"); // 31 Mar 2026
  });

  it("respects a non-default fyStartMonth (e.g. January-start)", () => {
    expect(deriveFinancialYear(new Date(Date.UTC(2026, 0, 1)), 1)).toBe("2026-27");
  });

  it("reads UTC date components, not local-timezone ones", () => {
    // A UTC-midnight Date is what Prisma returns for a `date` column regardless of server
    // timezone — this must not drift to the previous/next day under a non-UTC local offset.
    const utcMidnight = new Date(Date.UTC(2026, 3, 1)); // 1 Apr 2026 00:00 UTC
    expect(deriveFinancialYear(utcMidnight, 4)).toBe("2026-27");
  });
});
