import type { ZodType, ZodTypeDef } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Validates at the controller boundary (TDD §10) — services trust their inputs are already valid.
 *
 * The third type param pins Input to `any` rather than letting it default to T (i.e. Output).
 * Without this, TS unifies T against both the Output *and* Input slots of the schema argument,
 * and for any schema with a `.default()` field (where Input and Output differ) it silently
 * infers T as the Input shape — putting the defaulted field back to optional and defeating the
 * whole point of validating "produces a typed, trusted object" (see the .default() field above).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate: see doc comment above
export function parseWithSchema<T>(schema: ZodType<T, ZodTypeDef, any>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError(result.error.flatten());
  return result.data;
}
