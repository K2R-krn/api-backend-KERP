import * as argon2 from "argon2";

/** Argon2id everywhere passwords are hashed (TDD §7.1/§11.1) — never call argon2 directly outside this file. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}
