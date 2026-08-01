import { Prisma } from "@prisma/client";

// Prisma.Decimal (used for numeric(p,s) columns, e.g. products.gst_rate) has its own toJSON()
// that JSON.stringify invokes *before* handing the value to a replacer — by the time a replacer
// sees it, it's already a string ("18"), indistinguishable from a genuine string field. So
// Decimal must be converted to a plain number in a pre-pass, ahead of the stringify below.
//
// Permanent consequence, not a bug: toNumber() strips trailing zeros ("18.00" -> 18, "5.50" ->
// 5.5). The value is exact — numeric(5,2)-shaped magnitudes are within float precision — but the
// API never returns pre-formatted decimal places. Callers (the web frontend) must format to the
// appropriate precision at display time (18 -> "18.00%"), same discipline as money-in-paise.
// See TDD §22.2.
function decimalsToNumbers(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toNumber();
  if (Array.isArray(value)) return value.map(decimalsToNumbers);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decimalsToNumbers(v)]));
  }
  return value;
}

export function serializeBigInt<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(decimalsToNumbers(value), (_key, val: unknown) => (typeof val === "bigint" ? Number(val) : val)),
  ) as T;
}
