export type Role = "super_admin" | "admin" | "employee" | "accountant";

export const ROLES: readonly Role[] = ["super_admin", "admin", "employee", "accountant"];

export interface AuthContext {
  userId: string;
  role: Role;
  branchId?: string;
}
