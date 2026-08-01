import { ConflictError } from "./errors.js";

/**
 * Walks a self-referencing parent/base chain starting at candidateParentId, rejecting if it ever
 * reaches selfId — i.e. selfId would become its own ancestor, directly or via a chain. Only
 * relevant on update: a brand-new row can't yet be any existing row's ancestor, since its id isn't
 * known until after insert. Categories (parent_id) and units (base_unit_id) both have no DB-level
 * cycle guard (TDD §6.3/§6.4), so this is enforced here instead.
 */
export async function assertNoCycle(
  selfId: string,
  candidateParentId: string,
  getParentId: (id: string) => Promise<string | null>,
  conflictCode: string,
): Promise<void> {
  let current: string | null = candidateParentId;
  const visited = new Set<string>();
  while (current) {
    if (current === selfId) throw new ConflictError(conflictCode);
    if (visited.has(current)) return; // pre-existing cycle elsewhere in the chain — not this call's concern
    visited.add(current);
    current = await getParentId(current);
  }
}
