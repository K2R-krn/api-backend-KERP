import type { Prisma } from "@prisma/client";

// Postgres's SUM()/window aggregates over a bigint column return `numeric`, not `bigint` — even
// when every operand is a whole-paise bigint — so Prisma deserializes the result as Prisma.Decimal,
// not a JS bigint (verified against the real dev DB, not assumed: SELECT SUM(x) OVER (...) FROM
// (SELECT 100::bigint) came back as a Decimal object, only a directly-selected bigint column comes
// back as a native bigint). Anything computed via SUM/subtraction across bigint columns in raw SQL
// needs this conversion before the money-as-bigint invariant holds again. Always a whole number of
// paise here — toFixed(0) is exact, never a real rounding operation.
export function decimalToBigInt(value: Prisma.Decimal): bigint {
  return BigInt(value.toFixed(0));
}
