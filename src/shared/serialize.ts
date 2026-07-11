export function serializeBigInt<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, val: unknown) => (typeof val === "bigint" ? Number(val) : val)),
  ) as T;
}
