// TDD §5.5 — a voucher_date before the FY start month belongs to the FY that began the previous
// calendar year (e.g. 15 Feb 2026 with fyStartMonth=4 → "2025-26"). One source of truth for this
// boundary, driven by company_profile.fy_start_month — never hardcode it elsewhere (§5.5, §21).
//
// voucherDate is a SQL `date` column (no time-of-day/timezone semantics); Prisma returns it as a
// JS Date at UTC midnight. Reading it with the UTC getters (not the local-timezone ones) is what
// keeps this correct regardless of the machine's own timezone — this project runs from Nepal
// (UTC+5:45) against a Mumbai DB, so a local-getter read of a UTC-midnight Date can land on the
// wrong calendar day.
export function deriveFinancialYear(voucherDate: Date, fyStartMonth: number): string {
  const year = voucherDate.getUTCFullYear();
  const month = voucherDate.getUTCMonth() + 1; // 1-12

  const startYear = month >= fyStartMonth ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYearShort}`;
}
